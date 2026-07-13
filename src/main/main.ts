// Electron main: app lifecycle, dashboard + quick windows, global shortcut, IPC, shell-confirm bridge.
// ponytail: no tray icon for MVP (would need an .ico asset) — the taskbar icon + global shortcut cover it.
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initStore, loadMemories, allMemoryContents, addMemory, updateMemory, deleteMemory, loadMemoryTriples, addMemoryTriple, deleteMemoryTriple } from './store';
import { listSnapshots, restoreSnapshot } from './snapshots';
import { pluginListSnap, invalidatePluginCache } from './plugins';
import { setCronTasks, setDispatcher, startCronScheduler, validateCron } from './cron';
import { listCronTasks, addCronTask, updateCronTask, deleteCronTask, touchCronLastRun } from './store';
import { setTaskManagerForWatchers, ensureWatcher, listWatchers, startWatcher, stopWatcher } from './watcher';
import { getSettings, saveSettings } from './settings';
import { t, type Lang } from '../shared/i18n';
import { currentProvider } from './glm';
import { listSkills } from './skills';
import { mcp } from './mcp';
import { getBrand } from './brand';
import { binEnv } from './engines';
import { TaskManager, type TaskManagerEmitter } from './TaskManager';
import type { AgentEvent, AppSettings, ConfigSnapshot, Conversation, EngineKind, GitChange, GitCommit, GitDiffResult, GitSnapshot } from '../shared/types';

const execFileAsync = promisify(execFile);

// 兜底:未捕获异常/拒绝都记到 crash.log + stderr,避免 app 静默退出无从排查。
function logFatal(kind: string, e: unknown): void {
  const msg = `[${new Date().toISOString()}] ${kind}: ${(e as Error)?.stack ?? e}\n`;
  console.error(msg);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), msg);
  } catch {
    /* app 未就绪时 getPath 会抛,忽略 */
  }
}
process.on('uncaughtException', (e) => logFatal('uncaughtException', e));
process.on('unhandledRejection', (e) => logFatal('unhandledRejection', e));

let dashboardWin: BrowserWindow | null = null;
let quickWin: BrowserWindow | null = null;
let metricsWin: BrowserWindow | null = null;
let filesWin: BrowserWindow | null = null;
let arenaWin: BrowserWindow | null = null;
let taskManager: TaskManager;
let tray: Tray | null = null;
let quitting = false;

// MARK: shell-confirm bridge (main asks the dashboard window; user answers in a modal)
const pendingConfirms = new Map<string, (approved: boolean) => void>();
let confirmSeq = 0;

function confirm(cmd: string): Promise<boolean> {
  if (getSettings().approval === 'never') return Promise.resolve(true);
  const id = `c${process.pid}_${confirmSeq++}`;
  const win = dashboardWin;
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  win.webContents.send('confirm-request', { id, cmd });
  return new Promise((resolve) => pendingConfirms.set(id, resolve));
}

// Resolve every pending confirm as denied — used on cancel/delete so a parked Direct tool call
// (await ctx.confirm) doesn't hang forever on an unresolved Promise.
function drainConfirms(): void {
  for (const resolve of pendingConfirms.values()) resolve(false);
  pendingConfirms.clear();
}

// Send to a window that may be mid-destroy: ?. only guards a null win, not a destroyed webContents.
function safeSend(win: BrowserWindow | null, channel: string, data: unknown): void {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, data);
  } catch {
    /* webContents torn down between the two checks */
  }
}

const emitter: TaskManagerEmitter = {
  emitEvent(convId, ev: AgentEvent) {
    safeSend(dashboardWin, 'agent-event', { convId, ev });
    safeSend(quickWin, 'agent-event', { convId, ev });
    safeSend(arenaWin, 'agent-event', { convId, ev });
  },
  emitConversation(conv: Conversation) {
    safeSend(dashboardWin, 'conversation', conv);
    safeSend(quickWin, 'conversation', conv);
    safeSend(arenaWin, 'conversation', conv);
  },
  emitRemoved(convId) {
    safeSend(dashboardWin, 'conversation-removed', convId);
    safeSend(arenaWin, 'conversation-removed', convId);
  },
  confirm,
};

function createDashboard(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#1b1b1f',
    title: getBrand().productName,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // preload only uses contextBridge + ipcRenderer — both available sandboxed.
      webviewTag: true, // 主窗口聊天 tab 嵌文件浏览器,需要 <webview> 加载 file:///https:// 预览。
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

function createQuick(): BrowserWindow {
  const win = new BrowserWindow({
    width: 640,
    height: 240,
    resizable: true,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#1b1b1f',
    title: `${getBrand().productName} · Quick`,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'quick.html'));
  return win;
}

function toggleQuick(): void {
  if (quickWin && !quickWin.isDestroyed()) {
    quickWin.close();
    return;
  }
  quickWin = createQuick();
  quickWin.on('closed', () => (quickWin = null));
}

// Metrics 窗口(token 消耗 + agent 状态仪表盘)。已开则聚焦,不重复开。
// 名字刻意避开 dashboardWin/createDashboard —— 那是本 app 的主窗口。
function createMetricsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: '#1b1b1f',
    title: `${getBrand().productName} · Dashboard`,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'dashboard.html'));
  return win;
}
function toggleMetricsWindow(): void {
  if (metricsWin && !metricsWin.isDestroyed()) {
    metricsWin.focus();
    return;
  }
  metricsWin = createMetricsWindow();
  metricsWin.on('closed', () => (metricsWin = null));
}

// Files & Preview 窗口(cwd 文件树 + <webview> 浏览器,左右分屏)。
// webviewTag 必须显式开 —— 父页面要用 <webview> 加载 file:// / https:// 预览 agent 产物。
// 已开则聚焦并向 renderer 推 cwd(切目录);首开则 did-finish-load 后推一次。
function createFilesWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 700,
    minHeight: 420,
    backgroundColor: '#1b1b1f',
    title: `${getBrand().productName} · ${t(getSettings().lang, 'files.title')}`,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'files.html'));
  return win;
}
function toggleFilesWindow(cwd?: string): void {
  const push = () => { if (cwd) safeSend(filesWin, 'files-cwd', cwd); };
  if (filesWin && !filesWin.isDestroyed()) {
    filesWin.focus();
    push();
    return;
  }
  filesWin = createFilesWindow();
  filesWin.webContents.once('did-finish-load', push);
  filesWin.on('closed', () => (filesWin = null));
}

// Arena 窗口(同一 prompt 三引擎并跑对比)。已开则聚焦 + 推 cwd 换目录;首开 did-finish-load 后推一次。
function createArenaWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 720,
    minWidth: 800,
    minHeight: 460,
    backgroundColor: '#1b1b1f',
    title: `${getBrand().productName} · ${t(getSettings().lang, 'arena.title')}`,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'arena.html'));
  return win;
}
function toggleArenaWindow(cwd?: string): void {
  const push = () => { if (cwd) safeSend(arenaWin, 'arena-cwd', cwd); };
  if (arenaWin && !arenaWin.isDestroyed()) {
    arenaWin.focus();
    push();
    return;
  }
  arenaWin = createArenaWindow();
  arenaWin.webContents.once('did-finish-load', push);
  arenaWin.on('closed', () => (arenaWin = null));
}

// 文件树 readdir:一次一层,黑名单目录跳过(常见巨型/无关目录)。size 不返回(用不到,省一次 stat)。
function listDirAbs(absPath: string): { ok: boolean; entries?: import('../shared/types').DirEntry[]; error?: string } {
  try {
    const ents = fs.readdirSync(absPath, { withFileTypes: true });
    const out: import('../shared/types').DirEntry[] = [];
    for (const e of ents) {
      if (e.isSymbolicLink()) continue; // 防环 + 权限怪问题
      if (e.name.startsWith('.') && e.name !== '.') continue; // dotfiles 隐藏(.git/.vscode/.DS_Store…)
      if (DIR_BLACKLIST.has(e.name)) continue;
      out.push({ name: e.name, path: path.resolve(absPath, e.name), isDir: e.isDirectory() });
    }
    out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { ok: true, entries: out };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
const DIR_BLACKLIST = new Set(['node_modules', 'dist', 'build', '.next', '.cache', 'target', 'venv', '__pycache__', '.gradle']);

// Git 浏览:status + log 一次抓全(execFile 无 shell,binEnv 兜底 GUI 启动的稀疏 PATH)。
// ponytail: 不做缓存,renderer 每次切到 git tab 主动 refresh。大仓库也 <100ms。
async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: binEnv(), maxBuffer: 5 * 1024 * 1024 });
  return stdout;
}
async function gitSnapshotAsync(cwd: string): Promise<GitSnapshot> {
  try {
    const [branchOut, statusOut, logOut] = await Promise.all([
      runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      runGit(['status', '--porcelain=v1', '-b', '-uall'], cwd),
      runGit(['log', '-n', '30', '--pretty=format:%h|%an|%ad|%s', '--date=short'], cwd).catch(() => ''),
    ]);
    const branch = branchOut.trim();
    const changes: GitChange[] = [];
    for (const line of statusOut.split('\n')) {
      if (!line || line.startsWith('## ')) continue;
      const xy = line.slice(0, 2);
      const rest = line.slice(3);
      const filePath = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest; // R  old -> new 取新名
      const staged = xy[0] !== ' ' && xy[0] !== '?';
      const code = xy[1] !== ' ' ? xy[1] : xy[0]; // 工作区状态优先,否则索引状态
      changes.push({ path: filePath, code, staged });
    }
    const log: GitCommit[] = logOut
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, author, date, ...rest] = line.split('|');
        return { hash: hash ?? '', author: author ?? '', date: date ?? '', subject: rest.join('|') };
      });
    return { ok: true, branch, changes, log };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    // 不是 git 仓库时 rev-parse 会非零退出。
    return { ok: false, error: /not a git repository|unknown revision/i.test(msg) ? t(getSettings().lang, 'git.errRepo') : msg };
  }
}
async function gitDiffAsync(cwd: string, opts: { file?: string; hash?: string }): Promise<GitDiffResult> {
  try {
    let args: string[];
    if (opts.hash) args = ['show', opts.hash];
    else if (opts.file) args = ['diff', 'HEAD', '--', opts.file];
    else args = ['diff', 'HEAD'];
    const diff = await runGit(args, cwd);
    return { ok: true, diff };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// MARK: 托盘(程序生成的金色圆 icon,无需图标资源;关窗留托盘,全局热键常驻)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function num32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'ascii');
  return Buffer.concat([num32(data.length), t, data, num32(crc32(Buffer.concat([t, data])))]);
}
// 16×16 金色圆 PNG(运行时用 zlib 编码,免去图标资源文件)。
function makeTrayIcon() {
  const S = 16;
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0; // PNG filter: none
    for (let x = 0; x < S; x++) {
      const o = y * (S * 4 + 1) + 1 + x * 4;
      const dx = x - 7.5, dy = y - 7.5;
      const inside = dx * dx + dy * dy <= 36; // 半径 6 的圆
      raw[o] = 0xe8; raw[o + 1] = 0xb3; raw[o + 2] = 0x39; raw[o + 3] = inside ? 0xff : 0; // 金 #e8b339
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = pngChunk('IHDR', Buffer.concat([num32(S), num32(S), Buffer.from([8, 6, 0, 0, 0])])); // 8-bit RGBA
  const idat = pngChunk('IDAT', zlib.deflateSync(raw));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return nativeImage.createFromBuffer(Buffer.concat([sig, ihdr, idat, iend]), { width: S, height: S });
}

function showDashboard(): void {
  if (!dashboardWin || dashboardWin.isDestroyed()) dashboardWin = createDashboard();
  if (dashboardWin.isMinimized()) dashboardWin.restore();
  dashboardWin.show();
  dashboardWin.focus();
}

function buildTrayMenu(lang: Lang): Menu {
  return Menu.buildFromTemplate([
    { label: t(lang, 'tray.show'), click: () => showDashboard() },
    { label: t(lang, 'tray.quick'), click: () => toggleQuick() },
    { label: t(lang, 'dash.title'), click: () => toggleMetricsWindow() },
    { type: 'separator' },
    { label: t(lang, 'tray.quit'), click: () => { quitting = true; app.quit(); } },
  ]);
}
function createTray(): Tray {
  const tr = new Tray(makeTrayIcon());
  tr.setToolTip(getBrand().productName);
  tr.setContextMenu(buildTrayMenu(getSettings().lang));
  tr.on('click', () => showDashboard());
  return tr;
}
// 切语言后重建托盘菜单(save-settings 后调 —— 菜单是启动时 build 的,不重建不会跟随)。
function rebuildTrayMenu(): void {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu(getSettings().lang));
}

function registerIpc(): void {
  ipcMain.handle('get-conversations', () => taskManager.list());
  ipcMain.handle('new-conversation', (_e, cwd?: string, engine?: EngineKind) => {
    const conv = taskManager.newConversation(cwd || os.homedir(), engine);
    // 新会话:自动检测该 cwd 的 .kinet-watch.json,有就起 watcher。
    if (conv.cwd) ensureWatcher(conv.cwd);
    return conv;
  });
  ipcMain.handle('send', (_e, id: string, text: string) => {
    taskManager.send(id, text);
    return true;
  });
  ipcMain.handle('cancel', (_e, id: string) => {
    drainConfirms();
    return taskManager.cancel(id);
  });
  ipcMain.handle('delete-conversation', (_e, id: string) => {
    drainConfirms();
    return taskManager.deleteConversation(id);
  });
  ipcMain.handle('clear-conversation', (_e, id: string) => taskManager.clearConversation(id));
  ipcMain.handle('rename', (_e, id: string, title: string) => taskManager.rename(id, title));
  ipcMain.handle('set-cwd', (_e, id: string, cwd: string) => taskManager.setCwd(id, cwd));
  ipcMain.handle('set-engine', (_e, id: string, engine: EngineKind) => {
    taskManager.setEngine(id, engine);
    return true;
  });
  ipcMain.handle('set-model', (_e, id: string, model: string) => {
    taskManager.setModel(id, model);
    return true;
  });

  ipcMain.handle('get-settings', () => getSettings());
  ipcMain.handle('save-settings', (_e, s: AppSettings) => {
    saveSettings(s);
    rebuildTrayMenu(); // 语言切换后托盘菜单跟随
    return true;
  });
  ipcMain.handle('list-skills', () => listSkills());
  ipcMain.handle('list-mcp', () => mcp.snapshot());
  ipcMain.handle('get-brand', () => getBrand());

  // 系统文件夹选择器(renderer 无 Node,只能走 main 的 dialog)。
  ipcMain.handle('pick-directory', async () => {
    const win = dashboardWin && !dashboardWin.isDestroyed() ? dashboardWin : undefined;
    const r = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? '' : r.filePaths[0] ?? '';
  });

  // 读 cwd 内的文件(@文件 引用用)。限工作目录内,防 ../ 越界。
  ipcMain.handle('read-file', (_e, rel: string, cwd: string) => {
    const base = path.resolve(cwd || process.cwd());
    const full = path.resolve(base, rel || '');
    if (!full.startsWith(base)) return { ok: false, error: t(getSettings().lang, 'readfile.outOfPath') };
    try {
      const body = fs.readFileSync(full, 'utf8');
      return { ok: true, name: rel, content: body.length > 20000 ? body.slice(0, 20000) + '\n…[截断]' : body };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // Files 窗口编辑器:绝对路径读全文(无 20KB 截断、无 cwd 越界检查 —— 用户主动挑的文件)。
  ipcMain.handle('file-read', (_e, abs: string) => {
    try {
      const content = fs.readFileSync(abs, 'utf8');
      return { ok: true, content };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  // Files 窗口编辑器:绝对路径写全文。
  ipcMain.handle('file-write', (_e, abs: string, content: string) => {
    try {
      fs.writeFileSync(abs, content, 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  ipcMain.handle('test-connection', async (_e, s?: AppSettings) => {
    const snap: ConfigSnapshot = s
      ? { baseURL: s.baseURL, model: s.model, apiKey: s.apiKey, apiProtocol: s.apiProtocol, reasoning: 'none' }
      : (() => {
          const cur = getSettings();
          return {
            baseURL: cur.baseURL,
            model: cur.model,
            apiKey: cur.apiKey,
            apiProtocol: cur.apiProtocol,
            reasoning: 'none' as const,
          };
        })();
    try {
      await currentProvider(snap).streamComplete(
        [{ role: 'user', content: 'ping' }],
        [],
        snap,
        AbortSignal.timeout(20_000),
        () => {},
      );
      return { ok: true, message: t(getSettings().lang, 'testConn.ok') };
    } catch (e) {
      return { ok: false, message: (e as Error)?.message ?? String(e) };
    }
  });

  ipcMain.on('confirm-response', (_e, { id, approved }: { id: string; approved: boolean }) => {
    const resolve = pendingConfirms.get(id);
    if (resolve) {
      resolve(approved);
      pendingConfirms.delete(id);
    }
  });

  ipcMain.handle('quick-submit', async (_e, text: string) => {
    const conv = taskManager.newConversation(os.homedir());
    taskManager.send(conv.id, text);
    return conv.id;
  });
  ipcMain.handle('open-dashboard', () => {
    toggleMetricsWindow();
    return true;
  });
  ipcMain.handle('open-files', (_e, cwd?: string) => {
    toggleFilesWindow(cwd && cwd.trim() ? cwd.trim() : undefined);
    return true;
  });
  ipcMain.handle('open-arena', (_e, cwd?: string) => {
    toggleArenaWindow(cwd && cwd.trim() ? cwd.trim() : undefined);
    return true;
  });
  ipcMain.handle('list-dir', (_e, absPath: string) => listDirAbs(absPath));
  // 在用户默认浏览器里打开 URL(file:// / https:// 都行)。文件树右键「在浏览器中打开」用。
  ipcMain.handle('shell-open', (_e, url: string) => shell.openExternal(url));
  ipcMain.handle('git-snapshot', (_e, cwd: string) => gitSnapshotAsync(cwd));
  ipcMain.handle('git-diff', (_e, cwd: string, opts: { file?: string; hash?: string }) =>
    gitDiffAsync(cwd, opts),
  );
  // KINET.md 读写:rules tab 用。固定读 cwd/KINET.md,不接受相对路径(避免越界)。
  ipcMain.handle('read-rules', (_e, cwd: string) => {
    try {
      const full = path.join(cwd, 'KINET.md');
      const body = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
      return { ok: true, content: body };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('write-rules', (_e, cwd: string, content: string) => {
    try {
      if (!cwd || !fs.statSync(cwd).isDirectory()) return { ok: false, error: 'bad cwd' };
      fs.writeFileSync(path.join(cwd, 'KINET.md'), content ?? '', 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  // KINET-CONTEXT.md(项目级背景知识)读写:workbench 卡片「背景」按钮用。同 rules 路径约束。
  ipcMain.handle('read-context', (_e, cwd: string) => {
    try {
      const full = path.join(cwd, 'KINET-CONTEXT.md');
      const body = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
      return { ok: true, content: body };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('write-context', (_e, cwd: string, content: string) => {
    try {
      if (!cwd || !fs.statSync(cwd).isDirectory()) return { ok: false, error: 'bad cwd' };
      fs.writeFileSync(path.join(cwd, 'KINET-CONTEXT.md'), content ?? '', 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // 长期记忆导出:让用户选保存路径,写 JSON(version + memories[])。
  ipcMain.handle('memory-export', async () => {
    try {
      const mems = loadMemories().map((m) => ({ content: m.content }));
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const win = BrowserWindow.getFocusedWindow();
      const r = win
        ? await dialog.showSaveDialog(win, {
            defaultPath: `kinet-memory-${ts}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }],
          })
        : await dialog.showSaveDialog({
            defaultPath: `kinet-memory-${ts}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }],
          });
      if (r.canceled || !r.filePath) return { ok: false, error: 'canceled' };
      const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), memories: mems }, null, 2);
      fs.writeFileSync(r.filePath, payload, 'utf8');
      return { ok: true, path: r.filePath, count: mems.length };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // 长期记忆导入:让用户选 JSON 文件,读 → 容错解析(支持 {memories:[{content}]} 或字符串数组)
  // → 去重(已有 content 跳过)→ 逐条 addMemory。
  ipcMain.handle('memory-import', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const r = win
        ? await dialog.showOpenDialog(win, {
            properties: ['openFile'],
            filters: [{ name: 'JSON', extensions: ['json'] }],
          })
        : await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'JSON', extensions: ['json'] }],
          });
      if (r.canceled || !r.filePaths.length) return { ok: false, error: 'canceled' };
      const raw = fs.readFileSync(r.filePaths[0], 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const incoming: string[] = [];
      if (Array.isArray(parsed)) {
        for (const it of parsed) {
          if (typeof it === 'string') incoming.push(it);
          else if (it && typeof it === 'object' && typeof (it as { content?: unknown }).content === 'string')
            incoming.push((it as { content: string }).content);
        }
      } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { memories?: unknown }).memories)) {
        for (const it of (parsed as { memories: unknown[] }).memories) {
          if (it && typeof it === 'object' && typeof (it as { content?: unknown }).content === 'string')
            incoming.push((it as { content: string }).content);
        }
      } else {
        return { ok: false, error: 'unrecognized format' };
      }
      const existing = new Set(allMemoryContents());
      let imported = 0;
      let skipped = 0;
      for (const c of incoming) {
        const trimmed = c.trim();
        if (!trimmed) {
          skipped++;
          continue;
        }
        if (existing.has(trimmed)) {
          skipped++;
          continue;
        }
        addMemory(trimmed);
        existing.add(trimmed);
        imported++;
      }
      return { ok: true, imported, skipped };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // 长期记忆面板:列出(可按 convId 过滤) / 改单条 / 删单条。
  ipcMain.handle('memory-list', (_e, convId?: string) => {
    try {
      return { ok: true, items: loadMemories(convId) };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('memory-update', (_e, id: string, content: string) => {
    try {
      updateMemory(id, content);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('memory-delete', (_e, id: string) => {
    try {
      deleteMemory(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('memory-triples', (_e, convId?: string) => {
    try {
      return { ok: true, items: loadMemoryTriples(convId) };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('memory-triple-delete', (_e, id: string) => {
    try {
      deleteMemoryTriple(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('snapshot-list', (_e, cwd: string, convId?: string) => {
    try {
      return { ok: true, items: listSnapshots(cwd, convId) };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('snapshot-restore', (_e, cwd: string, id: string) => {
    try {
      return restoreSnapshot(cwd, id);
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  // Plugin SDK —— 用户扩展(<userData>/plugins/*):列出 / 强制重载(改完文件后刷一次)。
  ipcMain.handle('plugin-list', () => {
    try {
      return { ok: true, items: pluginListSnap() };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('plugin-reload', () => {
    try {
      invalidatePluginCache();
      const items = pluginListSnap();
      return { ok: true, count: items.length };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  // Cron —— 定时任务:list/add/update/delete/validate/runNow。
  ipcMain.handle('cron-list', () => {
    try {
      return { ok: true, items: listCronTasks() };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('cron-add', (_e, t: { id: string; cron: string; prompt: string; cwd?: string }) => {
    const v = validateCron(t.cron);
    if (!v.ok) return { ok: false, error: v.error };
    try {
      addCronTask(t);
      // 拉一遍内存态,跟 store 同步。
      setCronTasks(listCronTasks().map((r) => ({ id: r.id, cron: r.cron, prompt: r.prompt, cwd: r.cwd ?? undefined, enabled: r.enabled, lastRun: r.lastRun ?? undefined, createdAt: r.createdAt })));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('cron-update', (_e, id: string, patch: { cron?: string; prompt?: string; cwd?: string; enabled?: boolean }) => {
    if (patch.cron) {
      const v = validateCron(patch.cron);
      if (!v.ok) return { ok: false, error: v.error };
    }
    try {
      updateCronTask(id, patch);
      setCronTasks(listCronTasks().map((r) => ({ id: r.id, cron: r.cron, prompt: r.prompt, cwd: r.cwd ?? undefined, enabled: r.enabled, lastRun: r.lastRun ?? undefined, createdAt: r.createdAt })));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('cron-delete', (_e, id: string) => {
    try {
      deleteCronTask(id);
      setCronTasks(listCronTasks().map((r) => ({ id: r.id, cron: r.cron, prompt: r.prompt, cwd: r.cwd ?? undefined, enabled: r.enabled, lastRun: r.lastRun ?? undefined, createdAt: r.createdAt })));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('cron-validate', (_e, expr: string) => validateCron(expr));
  // Watch 模式:list/start/stop cwd 级 watcher。自动 ensure 走 new-conversation 路径。
  ipcMain.handle('watch-list', () => ({ ok: true, items: listWatchers() }));
  ipcMain.handle('watch-start', (_e, cwd: string) => {
    try {
      const ok = startWatcher(cwd);
      return { ok, error: ok ? undefined : 'No .kinet-watch.json or already running' };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('watch-stop', (_e, cwd: string) => {
    try {
      stopWatcher(cwd);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
}

// single instance — second launch just focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (dashboardWin) {
      if (dashboardWin.isMinimized()) dashboardWin.restore();
      dashboardWin.focus();
    }
  });

  app.whenReady().then(() => {
    // Windows 默认菜单条(File/Edit/View/Help)丑且无功能 → 全局清空,所有窗口都不显示。
    // devtools 仍可右键 Inspect 打开;reload/fullscreen 在生产 app 里也不需要快捷键。
    Menu.setApplicationMenu(null);
    // mic 权限放行 —— webkitSpeechRecognition 需要 media。Electron 默认拒绝会导致
    // onerror('not-allowed') → onend 立刻 fire,UI 上的 listening 态一闪就没。
    // 信任模型:本应用本地,用户自己点 🎤 才触发请求,放行 mic 即可。
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => {
      // media 涵盖 mic + camera;webkitSpeechRecognition 只触发 media。
      cb(perm === 'media');
    });
    initStore();
    taskManager = new TaskManager(emitter);
    taskManager.load();
    // Watch 模式:把 taskManager 注入 watcher(触发时起会话)+ 给所有现存会话的 cwd 起 watcher(若 .kinet-watch.json 存在)。
    setTaskManagerForWatchers(taskManager);
    for (const c of taskManager.list()) if (c.cwd) ensureWatcher(c.cwd);
    // 定时任务:从 store 装载 → 启动每分钟 tick 的调度器。dispatcher 起新会话并发 prompt。
    setCronTasks(listCronTasks().map((r) => ({
      id: r.id, cron: r.cron, prompt: r.prompt, cwd: r.cwd ?? undefined, enabled: r.enabled,
      lastRun: r.lastRun ?? undefined, createdAt: r.createdAt,
    })));
    setDispatcher((task) => {
      try {
        const conv = taskManager.newConversation(task.cwd || os.homedir());
        taskManager.send(conv.id, task.prompt);
        touchCronLastRun(task.id, Date.now());
      } catch (e) {
        console.warn('cron dispatch failed', e);
      }
    });
    startCronScheduler();
    registerIpc();
    mcp.connectAll(); // 后台连 MCP server(不阻塞首屏;Direct 引擎首轮会等 ≤2s)
    dashboardWin = createDashboard();
    tray = createTray();

    // Ctrl+Alt+Space on Windows (Cmd/Ctrl+Alt+Space cross-platform).
    globalShortcut.register('CommandOrControl+Alt+Space', toggleQuick);

    app.on('activate', () => showDashboard()); // mac Dock 点击:显示(或重建)主窗口
  });

  app.on('window-all-closed', () => {
    // 关窗即退出(close 真退)。托盘不再常驻 —— 全局热键只在 app 运行时生效。
    globalShortcut.unregisterAll();
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true; // 让 dashboard 的 close handler 放行 —— 否则 Cmd+Q / 系统退出会被 hide 拦截,退不出来
    globalShortcut.unregisterAll();
    mcp.dispose(); // 关掉所有 MCP 子进程
    tray?.destroy(); // 销毁托盘,否则 macOS 上进程残留、退不干净
  });
}
