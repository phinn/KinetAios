// Electron main: app lifecycle, dashboard + quick windows, global shortcut, IPC, shell-confirm bridge.
// ponytail: no tray icon for MVP (would need an .ico asset) — the taskbar icon + global shortcut cover it.
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import { initStore } from './store';
import { getSettings, saveSettings } from './settings';
import { currentProvider } from './glm';
import { listSkills } from './skills';
import { mcp } from './mcp';
import { TaskManager, type TaskManagerEmitter } from './TaskManager';
import type { AgentEvent, AppSettings, ConfigSnapshot, Conversation, EngineKind } from '../shared/types';

let dashboardWin: BrowserWindow | null = null;
let quickWin: BrowserWindow | null = null;
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
  },
  emitConversation(conv: Conversation) {
    safeSend(dashboardWin, 'conversation', conv);
    safeSend(quickWin, 'conversation', conv);
  },
  emitRemoved(convId) {
    safeSend(dashboardWin, 'conversation-removed', convId);
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
    title: 'KinetAios',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // preload only uses contextBridge + ipcRenderer — both available sandboxed.
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // 关窗不退出 → 隐藏到托盘(quitting=true 时才真关)。
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  return win;
}

function createQuick(): BrowserWindow {
  const win = new BrowserWindow({
    width: 640,
    height: 160,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#1b1b1f',
    title: 'KinetAios · Quick',
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

function createTray(): Tray {
  const t = new Tray(makeTrayIcon());
  t.setToolTip('KinetAios');
  t.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showDashboard() },
      { label: 'Quick 面板', click: () => toggleQuick() },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]),
  );
  t.on('click', () => showDashboard());
  return t;
}

function registerIpc(): void {
  ipcMain.handle('get-conversations', () => taskManager.list());
  ipcMain.handle('new-conversation', (_e, cwd?: string, engine?: EngineKind) =>
    taskManager.newConversation(cwd || os.homedir(), engine),
  );
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
    return true;
  });
  ipcMain.handle('list-skills', () => listSkills());
  ipcMain.handle('list-mcp', () => mcp.snapshot());

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
    if (!full.startsWith(base)) return { ok: false, error: '路径必须在工作目录内' };
    try {
      const body = fs.readFileSync(full, 'utf8');
      return { ok: true, name: rel, content: body.length > 20000 ? body.slice(0, 20000) + '\n…[截断]' : body };
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
      return { ok: true, message: '连接成功' };
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
    initStore();
    taskManager = new TaskManager(emitter);
    taskManager.load();
    registerIpc();
    mcp.connectAll(); // 后台连 MCP server(不阻塞首屏;Direct 引擎首轮会等 ≤2s)
    dashboardWin = createDashboard();
    tray = createTray();

    // Ctrl+Alt+Space on Windows (Cmd/Ctrl+Alt+Space cross-platform).
    globalShortcut.register('CommandOrControl+Alt+Space', toggleQuick);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) dashboardWin = createDashboard();
    });
  });

  app.on('window-all-closed', () => {
    // 有托盘:窗口全关也不退出,留在托盘 + 全局热键常驻。
  });

  app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    mcp.dispose(); // 关掉所有 MCP 子进程
  });
}
