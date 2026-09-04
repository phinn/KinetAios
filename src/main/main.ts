// Electron main: app lifecycle, dashboard + quick windows, global shortcut, IPC, shell-confirm bridge.
// ponytail: no tray icon for MVP (would need an .ico asset) — the taskbar icon + global shortcut cover it.
// ⚠️ 目录与品牌解耦:userData 永远固定为 KinetAios(不读 package.json/brand.json),
// 菜单栏/标题显示名从 brand.json 读。setPath 先钉死目录,之后 setName 随便改都不影响目录。
import { app as __app } from 'electron';
import __path from 'node:path';
import { getBrand } from './brand'; // ⚠️ 必须在这组 import 里:编译成 CJS 后 require 按声明顺序排放,
// 放后面的组会在 setPath/setName 语句之后才 require → TDZ "Cannot access before initialization"
const USERDATA_DIR = 'KinetAios';
__app.setPath('userData', __path.join(__app.getPath('appData'), USERDATA_DIR));
// 显示名(菜单栏/getName)与 getBrand 同源:userData/brand.json 外置覆盖 → 内嵌 dist/brand.json。
// 必须在 whenReady 前调;路径逻辑只此一份,别再手写 brand 解析。
__app.setName(getBrand().productName);
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, session, shell, Tray, webContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { initStore, loadMemories, allMemoryContents, addMemory, updateMemory, deleteMemory, loadMemoryTriples, tripleProvenance, addMemoryTriple, deleteMemoryTriple, loadTaskGraph, saveConversation, saveTurn, searchEnriched, arenaAggregate, setMemoryEmbedding, loadEvents } from './store';
import { saveCustomTool, loadCustomTools, deleteCustomTool, loadMemoryTimeline, decayMemories, dedupMemories, loadMemoryBlocks, updateMemoryBlock, loadEpisodicMemories, checkpointWal } from './store';
import { saveFact, loadFact, listFacts, deleteFact, factsAsBlock } from './store';
import { listTeamsForConv, convIdFromTeamId, listTeamMembers, loadTeamMember, upsertTeamMember, deleteTeam } from './store';
import { listSnapshots, restoreSnapshot } from './snapshots';
import { pluginListSnap, invalidatePluginCache, installPlugin, uninstallPlugin, togglePlugin, pluginPanelsSnap, savePluginEngineSettings } from './plugins';
import { setCronTasks, setDispatcher, startCronScheduler, stopCronScheduler, validateCron } from './cron';
import { listCronTasks, addCronTask, updateCronTask, deleteCronTask, touchCronLastRun } from './store';
import { setTaskManagerForWatchers, ensureWatcher, listWatchers, startWatcher, stopWatcher } from './watcher';
import { setTaskManager } from './main-instance';
import { getSettings, saveSettings, snapshot, balanceSnapshot } from './settings';
import { t, type Lang } from '../shared/i18n';
import { currentProvider } from './glm';
import { listSkills } from './skills';
import { mcp } from './mcp';
import { localMcpServer } from './mcp-server';
import { allTools } from './tools';
import { binEnv } from './engines';
import { TaskManager, type TaskManagerEmitter } from './TaskManager';
import { withSelfHidden } from './computer-use';
import { VoiceChat } from './VoiceChat';
import { getWeComBridge, setTaskManagerForWeCom } from './wecom';
import { getFeishuBridge, setTaskManagerForFeishu } from './feishu';
import type { AgentEvent, AppSettings, BudgetAlert, ConfigSnapshot, Conversation, ContextMode, CustomTool, EngineKind, GitActionKind, GitActionResult, GitChange, GitCommit, GitDiffResult, GitSnapshot, Pipeline, PromptTemplate, RuleConfig, Turn, ChatMsg, VoiceChatEventPayload } from '../shared/types';

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

// ⚠️ userData 目录名永远固定为 'KinetAios',不随 brand.json 改名变化 ——
// 用户数据(kinet.db/settings/plugins)终身只认这一个目录,避免改名后"数据丢失"假象。
// 显示名(窗口标题/通知/Dock)仍走 getBrand().productName,两者解耦。
// ⚠️ 只在 ud 不存在时单向搬迁 old→ud;绝不删除/覆盖任何已存在的 KinetAios 目录。
// 历史事故:旧版在两边并存时 rmSync(ud)(assumed KinetAios 是残留),导致源码运行
// 重新生成空 kinetaios-win 后,打包版启动直接删光用户全部数据(不进回收站)。
// setName 已提前到文件头部(所有 import 之前)。
try {
  const ud = app.getPath('userData');                       // .../KinetAios (setName 后)
  const old = path.join(path.dirname(ud), 'kinetaios-win'); // .../kinetaios-win
  if (fs.existsSync(old) && !fs.existsSync(ud)) {
    fs.renameSync(old, ud); // 单向迁移,仅目标不存在时;失败不阻塞启动,下次再试
  }
} catch { /* 迁移失败不阻塞启动;旧目录仍在,下次启动再试 */ }

// macOS 12 + Intel 上 GPU 渲染可能黑屏/白屏(Electron 31 已知问题)。
// 多重兜底:disableHardwareAcceleration + GPU 相关 commandLine 开关。
// 仅 macOS Intel(x64);Apple Silicon(arm64)GPU 驱动正常,保留硬件加速。
if (process.platform === 'darwin' && process.arch === 'x64') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

// ── V8 OOM 防护:老设备内存有限,渲染进程可能因大对话历史触发 Oilpan large allocation OOM ──
// V8 OOM guard: low-RAM machines can crash on large GC allocations in the renderer.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=2048 --max-semi-space-size=64');

// ── 系统路径安全检查:阻止渲染器读写敏感系统路径 ──
// System path guard: prevent renderer from reading/writing sensitive system paths.
// 虽然渲染器 contextIsolation,但万一被 XSS/prompt injection 攻破,这里是一道防线。
const BLOCKED_PATH_PREFIXES = process.platform === 'win32'
  ? ['c:\\windows\\system32', 'c:\\windows\\system', 'c:\\program files', 'c:\\program files (x86)']
  : ['/etc', '/usr', '/bin', '/sbin', '/boot', '/sys', '/proc', '/dev'];

function isBlockedSystemPath(absPath: string): boolean {
  const norm = path.resolve(absPath).toLowerCase();
  return BLOCKED_PATH_PREFIXES.some((p) => {
    const prefix = p.toLowerCase();
    return norm === prefix || norm.startsWith(prefix + path.sep);
  });
}

let dashboardWin: BrowserWindow | null = null;
let quickWin: BrowserWindow | null = null;
let metricsWin: BrowserWindow | null = null;
let filesWin: BrowserWindow | null = null;
let arenaWin: BrowserWindow | null = null;
let memoryGraphWin: BrowserWindow | null = null;
let taskManager: TaskManager;
let tray: Tray | null = null;
let voiceChatRef: VoiceChat | null = null; // P0: 供 before-quit 清理 WebSocket
let quitting = false;

// MARK: shell-confirm bridge (main asks the dashboard window; user answers in a modal)
const pendingConfirms = new Map<string, (approved: boolean) => void>();
let confirmSeq = 0;

// confirm 超时(5 分钟):防止 dashboard 窗口关闭/刷新后 confirm Promise 永久挂起,
// 导致 Direct 引擎的 AgentLoop 卡在 await ctx.confirm() 上 —— 既泄漏 Promise 又锁住会话。
const CONFIRM_TIMEOUT_MS = 300_000;

function confirm(cmd: string): Promise<boolean> {
  const s = getSettings();
  // 自动放行:approval=never 或 sandbox=fullAccess(完全访问 = 信任一切操作,与 CLI 引擎 bypassPermissions 对齐)。
  // / Auto-approve: approval=never OR sandbox=fullAccess (matches CLI engines' bypassPermissions).
  if (s.approval === 'never' || s.sandbox === 'fullAccess') return Promise.resolve(true);
  const id = `c${process.pid}_${confirmSeq++}`;
  const win = dashboardWin;
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  win.webContents.send('confirm-request', { id, cmd });
  return new Promise((resolve) => {
    // 超时自动 deny + 清理 / Auto-deny + cleanup on timeout
    const timer = setTimeout(() => {
      if (pendingConfirms.has(id)) {
        pendingConfirms.delete(id);
        resolve(false);
      }
    }, CONFIRM_TIMEOUT_MS);
    pendingConfirms.set(id, (approved) => {
      clearTimeout(timer);
      resolve(approved);
    });
  });
}

// Resolve every pending confirm as denied — used on cancel/delete so a parked Direct tool call
// (await ctx.confirm) doesn't hang forever on an unresolved Promise.
function drainConfirms(): void {
  for (const resolve of pendingConfirms.values()) resolve(false);
  pendingConfirms.clear();
}

// Send to a window that may be mid-destroy: ?. only guards a null win, not a destroyed webContents.
// renderer 可能已 crash/重载 — 标记哪些窗口的 render frame 已销毁,避免狂刷错误日志。
// Track which windows have a dead render frame to stop spamming events into the void.
const deadFrames = new WeakSet<BrowserWindow>();

function safeSend(win: BrowserWindow | null, channel: string, data: unknown): void {
  if (!win || win.isDestroyed()) return;
  if (deadFrames.has(win)) return; // render frame 已销毁,不再发送 / frame already gone
  const wc = win.webContents;
  if (wc.isDestroyed()) return;
  try {
    wc.send(channel, data);
  } catch {
    /* 同步异常:webContents torn down between the two checks / sync throw */
    deadFrames.add(win);
  }
  // wc.send 在某些 Electron 版本中异步 reject ("Render frame was disposed"),
  // 无法 try/catch 捕获;用 wc.on('did-start-navigation') 在重载时清除 deadFrames 标记。
}
// 广播瘦身:巨型会话(带截图/超长 answer,单 conv turns 可达 25MB)若每个事件
// 都整包 structured clone 过 IPC,流式期间 tool/status 连发 → 双进程 GC 风暴 →
// renderer 卡死/进程 gone(2026-08-24 两次卡死的根因)。
// renderer 侧已有 head 态兼容路径(LRU 保护 + ensureTurnsLoaded),所以这里
// 超阈值时剥掉 turns 只带最后一个 turn,让 renderer 走懒加载。
// Broadcast slimming: oversized convs are sent head-only; renderer lazy-loads turns.
const IPC_TURNS_CHAR_LIMIT = 600_000; // ~600KB 字符 ≈ 1.2MB UTF-16

const emitter: TaskManagerEmitter = {
  emitEvent(convId, ev: AgentEvent) {
    safeSend(dashboardWin, 'agent-event', { convId, ev });
    safeSend(quickWin, 'agent-event', { convId, ev });
    safeSend(arenaWin, 'agent-event', { convId, ev });
  },
  // Broadcast slimming: see IPC_TURNS_CHAR_LIMIT above.
  emitConversation(conv: Conversation) {
    // turnCount 归一化:turnCount 只在启动加载时由 SQL 聚合写入,运行期 push 新 turn
    // 从不更新 → 广播里 turnCount 恒为旧值,renderer 侧按 turnCount 判断"有新 turn"
    // 的合并逻辑永远不触发(用户消息不上屏)。turns 在内存时以真实长度为准,单一出口覆盖
    // send/goal/failTurn/delete 所有路径。
    // Normalize turnCount here: it's only seeded from SQL at load; keep it in sync
    // with in-memory turns so consumers can trust it on every broadcast.
    if (conv.turnsLoaded !== false) conv.turnCount = conv.turns.length;
    // directHistory(Direct 会话完整 LLM 消息,MB 级)永不进广播 —— 2026-08 卡死事故的
    // 同族载荷,turns 修了它漏了。上下文检查器走 get-conversation-context 按需拉;
    // renderer 只在引擎切换确认处读 .length,[] 语义足够。
    let payload: Conversation = { ...conv, directHistory: [] };
    if (conv.turnsLoaded !== false) {
      // 估重不打日志、不 stringify —— 只遍历字符串 length,O(n) 且零拷贝。
      let weight = 0;
      for (const t of conv.turns) {
        weight += (t.prompt?.length ?? 0) + (t.answer?.length ?? 0);
        if (t.steps) for (const s of t.steps) {
          weight += (s.args?.length ?? 0) + (s.result?.length ?? 0) + 64;
        }
      }
      if (weight > IPC_TURNS_CHAR_LIMIT) {
        const last = conv.turns[conv.turns.length - 1];
        payload = { ...payload, turns: last ? [last] : [], turnsLoaded: false };
      }
    }
    safeSend(dashboardWin, 'conversation', payload);
    safeSend(quickWin, 'conversation', payload);
    safeSend(arenaWin, 'conversation', payload);
  },
  emitRemoved(convId) {
    notifyLastAt.delete(convId); // P1: 会话删除即清,防 Map 无限累积
    safeSend(dashboardWin, 'conversation-removed', convId);
    safeSend(arenaWin, 'conversation-removed', convId);
  },
  confirm,
  // ── 任务完成通知(设置开关 notifyOnDone,默认关)──
  // 最小化/失焦时:系统通知(点击恢复窗口)+ 任务栏闪烁 + macOS dock bounce。
  // 30s 合并窗口:同一频道短时间多次完成只通知一次(防轰炸)。
  notifyDone(conv: Conversation, kind: 'done' | 'error', wasCancelled: boolean) {
    if (wasCancelled) return; // 用户主动取消不通知
    if (!getSettings().notifyOnDone) return;
    const win = dashboardWin;
    if (!win || win.isDestroyed()) return;
    // 用户正盯着任何一个 KinetAios 窗口看(聚焦且未最小化)→ 不打扰。
    // 只查 dashboard 会漏:用户盯着 quick 面板/Arena 看流式输出时,
    // dashboard 失焦会被误判"没人在看"→ 弹通知骚扰。
    const watching = [dashboardWin, quickWin, arenaWin].some(
      (w) => w && !w.isDestroyed() && !w.isMinimized() && w.isFocused(),
    );
    if (watching) return;
    // 30s 合并窗口:同一频道重复完成只通知首条
    const now = Date.now();
    const last = notifyLastAt.get(conv.id) ?? 0;
    if (now - last < 30_000) return;
    notifyLastAt.set(conv.id, now);
    const lang = getSettings().lang;
    const title = kind === 'error'
      ? `${getBrand().productName} · ${t(lang, 'notify.errorTitle')}`
      : `${getBrand().productName} · ${t(lang, 'notify.doneTitle')}`;
    // 正文:频道标题(customTitle 或首条 prompt 截断,与侧栏一致)+ 答案首行(≤80 字)
    const lastTurn = conv.turns[conv.turns.length - 1];
    const snippet = (kind === 'error' ? (lastTurn?.error ?? '') : (lastTurn?.answer ?? ''))
      .replace(/[#*`>\-\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const convTitle = conv.customTitle || conv.turns[0]?.prompt.slice(0, 40) || t(lang, 'notify.noTitle');
    const body = `${convTitle}${snippet ? '\n' + snippet : ''}`;
    try {
      const n = new Notification({ title, body: body.slice(0, 120) });
      n.on('click', () => { showDashboard(); });
      n.show();
    } catch { /* 通知权限被拒/系统不支持 → 静默 */ }
    // 任务栏闪烁(Windows)/ dock 无操作;聚焦后 Electron 自动停闪
    if (process.platform === 'win32') win.once('focus', () => win.flashFrame(false));
    win.flashFrame(true);
    if (process.platform === 'darwin') app.dock?.bounce('informational');
  },
};
// 通知合并窗口的状态:convId → 上次通知时间戳 / dedupe map for notifyDone
const notifyLastAt = new Map<string, number>();

// MARK: Team 事件广播(独立通道,不走 AgentEvent)
export function emitTeamEvent(teamId: string, ev: import('../shared/types').TeamEvent): void {
  safeSend(dashboardWin, 'team-event', { teamId, ev });
}

function createDashboard(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#1b1b1f',
    title: getBrand().productName,
    icon: appIcon(), // dev 模式下显示在任务栏/标题栏(打包后由 .exe 内嵌的 ico 接管)
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // preload only uses contextBridge + ipcRenderer — both available sandboxed.
      webviewTag: true, // 主窗口聊天 tab 嵌文件浏览器,需要 <webview> 加载 file:///https:// 预览。
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 渲染崩溃 / 无响应 — 停止所有运行中的 agent loop,避免向死掉的 renderer 狂发事件。
  // Renderer crash: stop all running agent loops to avoid spamming events into the void.
  win.webContents.on('render-process-gone', (_e, details) => {
    logFatal('render-process-gone', `reason=${details.reason} exitCode=${details.exitCode}`);
    deadFrames.add(win);
    // 停止所有 running 会话的 agent loop / Abort all running conversations.
    for (const conv of taskManager.list()) {
      if (conv.status === 'running') {
        try { taskManager.cancel(conv.id); } catch { /* already torn down */ }
      }
    }
    // 渲染进程崩溃/被杀后自动重载(1 秒延迟让 GC 回收旧 frame)。
    // Auto-reload after render process crash (1s delay lets GC reclaim the dead frame).
    // killed: 系统杀进程(Windows 常见,GPU 崩溃/资源压力)
    // oom: 内存不足
    // crashed: V8 崩溃
    if (details.reason === 'oom' || details.reason === 'crashed' || details.reason === 'killed') {
      setTimeout(() => {
        deadFrames.delete(win);
        if (!win.isDestroyed()) {
          win.webContents.reload();
        }
      }, 1000);
    }
  });
  // 卡死黑匣子:unresponsive 触发时 1)记录日志 2)sample 抓 renderer 全线程栈到
  // unresponsive-sample.txt(macOS)/ pslist(Windows)3)10s 后若恢复记 responsive。
  // 此前多次"卡死"crash.log 零 unresponsive 记录 —— 定性存疑,需现场证据。
  // Black box: on unresponsive, log + sample the renderer threads for autopsy.
  let unresponsiveSampling = false;
  win.webContents.on('unresponsive', () => {
    logFatal('unresponsive', 'webContents unresponsive');
    if (unresponsiveSampling) return;
    unresponsiveSampling = true;
    try {
      const outFile = path.join(app.getPath('userData'), 'unresponsive-sample.txt');
      if (process.platform === 'darwin') {
        // sample <pid> <dur> -file <path>;webContents 没 pid → 用 win.webContents
        // 的 getOSProcessId()(Electron 22+)。失败静默。
        const pid = win.webContents.getOSProcessId();
        if (pid) execFileSync('/usr/bin/sample', [String(pid), '3', '-mayDie', '-file', outFile], { timeout: 15000 });
      } else {
        fs.appendFileSync(outFile, `\n[${new Date().toISOString()}] win unresponsive (pid=${win.webContents.getOSProcessId()})\n`);
      }
    } catch (e) {
      try { fs.appendFileSync(path.join(app.getPath('userData'), 'unresponsive-sample.txt'), `sample failed: ${e}\n`); } catch { /* ignore */ }
    }
    // 10s 后若恢复记一笔,区分"短暂忙"与"永久死"。
    setTimeout(() => {
      if (!win.isDestroyed() && !win.webContents.isCrashed() && win.webContents.isLoading() === false) {
        // 没有可靠 API 判 responsive;用 ping 副作用不可行,只能记录观察窗口结束。
        fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), `[${new Date().toISOString()}] unresponsive +10s: win still alive\n`);
      }
      unresponsiveSampling = false;
    }, 10000);
  });
  // 页面重载时清除 deadFrames 标记,恢复事件推送。
  // Clear dead-frame flag on manual reload (Ctrl+R / navigation).
  win.webContents.on('did-start-navigation', (_e, _url, isInPlace) => {
    if (isInPlace) deadFrames.delete(win);
  });
  win.webContents.on('did-finish-load', () => deadFrames.delete(win));

  // 窗口关闭行为:根据设置决定点 ✕ 时是退出、最小化到任务栏、还是隐藏到托盘。
  win.on('close', (e) => {
    if (quitting) return; // 正在退出(Cmd+Q / 托盘退出)→ 放行
    const mode = getSettings().closeBehavior ?? 'quit';
    if (mode === 'minimize') {
      e.preventDefault();
      win.minimize();
    } else if (mode === 'tray') {
      e.preventDefault();
      win.hide();
    }
    // mode === 'quit' → 不拦截,正常走 window-all-closed → app.quit()
  });

  // 窗口刷新/导航前 drain:confirm modal 开着时用户按 F5,Promise 会永久挂起。
  // Drain before navigation (F5 / URL change) — pending confirms would hang forever.
  win.webContents.on('did-start-navigation', () => drainConfirms());

  return win;
}

// 应用图标:根据 settings.appIcon 选择对应图标文件。
// dev 跑 npm start 时给 BrowserWindow 用;打包后由 .exe/.app 内嵌的 icon 接管。missing 时不报错。
let _appIcon: ReturnType<typeof nativeImage.createFromPath> | undefined;
let _appIconKey: string | null = null; // 缓存当前 icon key,避免重复 load
function appIcon(): ReturnType<typeof nativeImage.createFromPath> | undefined {
  const s = getSettings();
  const key = (s.appIcon || 'k') + '|' + (getBrand().icon ?? '');
  if (_appIcon && _appIconKey === key) return _appIcon;
  _appIconKey = key;
  _appIcon = undefined;
  // icon key → file name 映射
  const iconFiles: Record<string, string> = {
    'default': 'icon.png',
    'bluepurple': 'icon-default-bluepurple.png',
    'k': 'icon-e1-K.png',
    'bg': 'icon-e1-bg.png',
    'd1': 'icon-d1.png',
    'd2': 'icon-d2.png',
    'd3': 'icon-d3.png',
    'd4': 'icon-d4.png',
  };
  // brand.json 的 icon 字段最高优先级:改品牌时图标跟着走(打包 exe 内嵌图标除外)。
  // / brand.json icon wins — follows the brand (except packaged exe's embedded icon).
  const brandIcon = getBrand().icon;
  const fileName = brandIcon || iconFiles[key] || iconFiles['k'];
  const resBase = process.resourcesPath ? path.join(process.resourcesPath, 'build') : '';
  // 打包后 process.resourcesPath/build/ 最可靠,排最前;dev 模式靠 __dirname/../../build/
  for (const candidate of [
    path.join(app.getPath('userData'), 'icons', fileName),  // 外置图标:brand.icon 可指向这里,打包版免重打包
    resBase ? path.join(resBase, fileName) : '',
    resBase ? path.join(resBase, 'icon.png') : '',
    path.join(__dirname, '..', '..', 'build', fileName),
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    path.join(__dirname, '..', 'resources', fileName),
    path.join(__dirname, '..', '..', 'src', 'resources', fileName),
    path.join(__dirname, '..', 'resources', 'icon.png'),
    path.join(__dirname, '..', '..', 'src', 'resources', 'icon.png'),
  ].filter(Boolean)) {
    try {
      if (fs.existsSync(candidate)) {
        _appIcon = nativeImage.createFromPath(candidate);
        if (!_appIcon.isEmpty()) {
          console.log(`[appIcon] loaded: ${candidate} (${_appIcon.getSize().width}x${_appIcon.getSize().height})`);
          return _appIcon;
        }
      }
    } catch {
      /* 路径不可达,试下一个 */
    }
  }
  return undefined;
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

    // ── 本地 vs 远程比较:ahead/behind/upstream ──
    // 从 status --porcelain 的 ## 行解析:`## main...origin/main [ahead 2, behind 1]`
    let ahead: number | undefined;
    let behind: number | undefined;
    let upstream: string | undefined;
    const headerLine = statusOut.split('\n')[0]; // ## branch...origin/branch [ahead N, behind M]
    if (headerLine.startsWith('## ')) {
      // 两种形态:有上游 `## main...origin/main [ahead 2]` / 无上游 `## main`
      const parts = headerLine.slice(3).split(' ');
      const dotsIdx = parts[0].indexOf('...');
      if (dotsIdx >= 0) {
        upstream = parts[0].slice(dotsIdx + 3);
        const aheadMatch = headerLine.match(/\[ahead\s+(\d+)/);
        const behindMatch = headerLine.match(/\[behind\s+(\d+)/);
        ahead = aheadMatch ? parseInt(aheadMatch[1], 10) : 0;
        behind = behindMatch ? parseInt(behindMatch[1], 10) : 0;
      }
    }
    // 检查是否有远程仓库
    let hasRemote = false;
    try {
      const remoteOut = await runGit(['remote'], cwd);
      hasRemote = remoteOut.trim().length > 0;
    } catch { /* 无 remote 不报错 */ }

    return { ok: true, branch, changes, log, ahead, behind, upstream, hasRemote };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    // 不是 git 仓库时 rev-parse 会非零退出。
    return { ok: false, error: /not a git repository|unknown revision/i.test(msg) ? t(getSettings().lang, 'git.errRepo') : msg };
  }
}
async function gitDiffAsync(cwd: string, opts: { file?: string; hash?: string; staged?: boolean }): Promise<GitDiffResult> {
  try {
    // git ref / path 安全字符校验:防 argument injection(如 --upload-pack)
    const safeRef = (s: string): boolean => /^[\w./~^@{}\[\]:\-]+$/.test(s);
    let args: string[];
    if (opts.hash) {
      if (!safeRef(opts.hash)) return { ok: false, error: `不安全的 git ref: "${opts.hash}"` };
      args = ['show', opts.hash];
    } else if (opts.file) {
      if (!safeRef(opts.file)) return { ok: false, error: `不安全的文件路径: "${opts.file}"` };
      // untracked 文件没有 index 记录,git diff 返回空 → 用 --no-index 对 /dev/null 生成"整文件新增"diff
      // / untracked files have no index entry; diff against /dev/null to show the whole file as new
      let untracked = false;
      try {
        const st = await runGit(['status', '--porcelain', '--', opts.file], cwd);
        untracked = st.trimStart().startsWith('??');
      } catch { /* status 失败按普通 diff 处理 */ }
      if (untracked) {
        // --no-index 有差异时退出码为 1,runGit 会抛错,这里单独容错取 stdout
        try {
          const diff = await runGit(['diff', '--no-index', '--', '/dev/null', opts.file], cwd);
          return { ok: true, diff };
        } catch (err) {
          const stdout = (err as { stdout?: string })?.stdout;
          if (typeof stdout === 'string' && stdout.includes('diff --git')) return { ok: true, diff: stdout };
          throw err;
        }
      }
      // 单文件:staged 看 index vs HEAD,unstaged 看 working tree vs index
      args = opts.staged
        ? ['diff', '--cached', '--', opts.file]
        : ['diff', '--', opts.file];
    }
    else args = ['diff', 'HEAD'];
    const diff = await runGit(args, cwd);
    return { ok: true, diff };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// ── Git 操作:stage / unstage / commit / pull / push / fetch / stash / checkout / discard ──
// 所有写操作都走这里,执行后 renderer 自动刷新 snapshot。
// 安全:file/branch/message 走 safeRef 校验,防 argument injection。
async function gitActionAsync(cwd: string, action: GitActionKind, opts?: { message?: string; file?: string; branch?: string }): Promise<GitActionResult> {
  try {
    const safeRef = (s: string): boolean => /^[\w./~^@{}\[\]:\-]+$/.test(s);
    let args: string[];
    let successMsg: string;
    switch (action) {
      case 'stageAll':
        args = ['add', '-A'];
        successMsg = t(getSettings().lang, 'git.actStageAllOk');
        break;
      case 'unstageAll':
        args = ['reset', 'HEAD', '--'];
        successMsg = t(getSettings().lang, 'git.actUnstageAllOk');
        break;
      case 'stageFile':
        if (!opts?.file || !safeRef(opts.file)) return { ok: false, error: `不安全的文件路径: "${opts?.file}"` };
        args = ['add', '--', opts.file];
        successMsg = t(getSettings().lang, 'git.actStageOk');
        break;
      case 'unstageFile':
        if (!opts?.file || !safeRef(opts.file)) return { ok: false, error: `不安全的文件路径: "${opts?.file}"` };
        args = ['reset', 'HEAD', '--', opts.file];
        successMsg = t(getSettings().lang, 'git.actUnstageOk');
        break;
      case 'commit':
        if (!opts?.message?.trim()) return { ok: false, error: t(getSettings().lang, 'git.actCommitNoMsg') };
        args = ['commit', '-m', opts.message];
        successMsg = t(getSettings().lang, 'git.actCommitOk');
        break;
      case 'amend':
        args = ['commit', '--amend', '--no-edit'];
        successMsg = t(getSettings().lang, 'git.actAmendOk');
        break;
      case 'pull':
        args = ['pull', '--ff-only'];
        successMsg = t(getSettings().lang, 'git.actPullOk');
        break;
      case 'push':
        args = ['push'];
        successMsg = t(getSettings().lang, 'git.actPushOk');
        break;
      case 'fetch':
        args = ['fetch', '--all', '--prune'];
        successMsg = t(getSettings().lang, 'git.actFetchOk');
        break;
      case 'stash':
        args = ['stash', 'push', '-u'];
        successMsg = t(getSettings().lang, 'git.actStashOk');
        break;
      case 'stashPop':
        args = ['stash', 'pop'];
        successMsg = t(getSettings().lang, 'git.actStashPopOk');
        break;
      case 'checkout':
        if (!opts?.branch || !safeRef(opts.branch)) return { ok: false, error: `不安全的分支名: "${opts?.branch}"` };
        args = ['checkout', opts.branch];
        successMsg = t(getSettings().lang, 'git.actCheckoutOk');
        break;
      case 'discard':
        // 危险:git checkout -- . + git clean -fd(只丢弃未跟踪+未暂存,不影响已暂存)
        args = ['checkout', '--', '.'];
        await runGit(args, cwd);
        await runGit(['clean', '-fd'], cwd);
        return { ok: true, message: t(getSettings().lang, 'git.actDiscardOk') };
      default:
        return { ok: false, error: `未知操作: ${action}` };
    }
    const stdout = await runGit(args, cwd);
    // pull/push/fetch 的输出有意义,截取尾部给用户看。
    const tail = stdout.trim().split('\n').slice(-3).join('\n');
    return { ok: true, message: successMsg + (tail ? `\n${tail}` : '') };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// MARK: 托盘(优先用应用图标;关窗留托盘,全局热键常驻)
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
// 托盘图标:优先用 build/icon.png resize 到 16×16(和应用图标统一);
// 打包后路径不可达 → 回退到运行时生成的金色圆 PNG(无需图标资源文件)。
function makeTrayIcon() {
  const s = getSettings();
  const key = s.appIcon || 'k';
  const iconFiles: Record<string, string> = {
    'default': 'icon.png',
    'bluepurple': 'icon-default-bluepurple.png',
    'k': 'icon-e1-K.png',
    'bg': 'icon-e1-bg.png',
    'd1': 'icon-d1.png',
    'd2': 'icon-d2.png',
    'd3': 'icon-d3.png',
    'd4': 'icon-d4.png',
  };
  const fileName = getBrand().icon || iconFiles[key] || iconFiles['k'];
  const resBase = process.resourcesPath ? path.join(process.resourcesPath, 'build') : '';
  // 尝试从图标文件加载(优先 resourcesPath/build/,然后 dev 路径)
  for (const candidate of [
    path.join(app.getPath('userData'), 'icons', fileName),  // 外置图标:brand.icon 可指向这里,打包版免重打包
    resBase ? path.join(resBase, fileName) : '',
    resBase ? path.join(resBase, 'icon.png') : '',
    path.join(__dirname, '..', '..', 'build', fileName),
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    path.join(__dirname, '..', 'resources', fileName),
    path.join(__dirname, '..', 'resources', 'icon.png'),
    path.join(__dirname, '..', '..', 'src', 'resources', fileName),
    path.join(__dirname, '..', '..', 'src', 'resources', 'icon.png'),
    path.join(__dirname, '..', 'resources', 'icon.ico'),
    path.join(__dirname, '..', '..', 'src', 'resources', 'icon.ico'),
    path.join(__dirname, '..', '..', 'build', 'icon.ico'),
  ].filter(Boolean)) {
    try {
      if (fs.existsSync(candidate)) {
        const full = nativeImage.createFromPath(candidate);
        if (!full.isEmpty()) return full.resize({ width: 16, height: 16 });
      }
    } catch { /* 回退到程序生成 */ }
  }
  // 回退:16×16 金色圆 PNG(运行时用 zlib 编码,免去图标资源文件)。
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

function showMemoryGraph(): void {
  if (memoryGraphWin && !memoryGraphWin.isDestroyed()) {
    memoryGraphWin.focus();
    return;
  }
  const lang = getSettings().lang;
  const win = new BrowserWindow({
    width: 900, height: 680,
    minWidth: 600, minHeight: 400,
    backgroundColor: '#1b1b1f',
    title: `${getBrand().productName} · ${t(lang, 'mgraph.title')}`,
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'memory-graph.html'));
  memoryGraphWin = win;
  win.on('closed', () => { memoryGraphWin = null; });
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

// ── Visual Inspector 采集脚本生成器(安全:坐标为纯数字,无注入面)──
// Collect script generator for Visual Inspector — numbers only, no injection surface.
// 从 files-pane.ts 搬到主进程,避免 renderer 传任意 script 字符串。
function buildCollectScript(x1: number, y1: number, x2: number, y2: number): string {
  return `(function() {
      var x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2};
      var w = x2 - x1, h = y2 - y1;
      if (w < 5 || h < 5) return null;
      var collected = [];
      var seen = new Set();
      var step = Math.min(20, Math.min(w, h) / 3);
      for (var px = x1 + step/2; px < x2; px += step) {
        for (var py = y1 + step/2; py < y2; py += step) {
          var els = document.elementsFromPoint(px, py);
          for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (seen.has(el)) continue;
            seen.add(el);
            var r = el.getBoundingClientRect();
            if (r.left + r.width/2 < x1 || r.left + r.width/2 > x2) continue;
            if (r.top + r.height/2 < y1 || r.top + r.height/2 > y2) continue;
            collected.push(extractInfo(el, r));
          }
        }
      }
      var deduped = {};
      var result = [];
      for (var j = 0; j < collected.length; j++) {
        var c = collected[j];
        var key = c.tag + '|' + c.className + '|' + c.textPreview.slice(0, 50);
        if (deduped[key]) {
          if (c.outerHTML.length > deduped[key].outerHTML.length) {
            var idx = result.indexOf(deduped[key]);
            result[idx] = c; deduped[key] = c;
          }
        } else { deduped[key] = c; result.push(c); }
      }
      function extractInfo(el, r) {
        var cs = window.getComputedStyle(el);
        var styles = {};
        var keys = ['color','background-color','font-size','font-weight','font-family','width','height','padding','margin','border','border-radius','display','position','text-align','line-height','letter-spacing','opacity','flex-direction','justify-content','align-items','gap'];
        for (var k = 0; k < keys.length; k++) { styles[keys[k]] = cs.getPropertyValue(keys[k]); }
        var path = [];
        var cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.body) {
          var sel = cur.tagName.toLowerCase();
          if (cur.id) sel += '#' + cur.id;
          else if (cur.className && typeof cur.className === 'string') {
            var cls = cur.className.trim().split(/\\s+/).slice(0, 2).join('.');
            if (cls) sel += '.' + cls;
          }
          var sib = cur, nth = 1;
          while ((sib = sib.previousElementSibling)) nth++;
          if (nth > 1) sel += ':nth-child(' + nth + ')';
          path.unshift(sel);
          cur = cur.parentElement;
        }
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          className: (typeof el.className === 'string' ? el.className : ''),
          textPreview: (el.textContent || '').trim().slice(0, 300),
          outerHTML: el.outerHTML.slice(0, 2000),
          computedStyle: styles,
          domPath: path.join(' > '),
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
        };
      }
      return result.length ? result : null;
    })();`;
}

function registerIpc(): void {
  // directHistory MB 级,不随列表下发;上下文检查器按需走 get-conversation-context。
  ipcMain.handle('get-conversations', () => taskManager.list().map((c) => ({ ...c, directHistory: [] })));

  // 懒加载:renderer 切频道时按需拉 turns(head 模式启动不载全文)
  // Lazy: renderer fetches turns on conversation switch.
  ipcMain.handle('get-turns', (_e, convId: string) => {
    const conv = taskManager.hydrate(convId);
    return conv ? conv.turns : [];
  });
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
  ipcMain.handle('set-sub-model', (_e, id: string, model: string) => {
    taskManager.setSubModel(id, model);
    return true;
  });
  // 切换会话的模型配置档 —— 写入 conv.profileId,DirectEngine 运行时读取。
  ipcMain.handle('set-conv-profile', (_e, id: string, profileId: string | null) => {
    taskManager.setConvProfile(id, profileId);
    return true;
  });
  // 上下文模式切换 —— standard / hifi,以后可扩展更多模式。
  ipcMain.handle('set-context-mode', (_e, id: string, mode: string) => {
    taskManager.setContextMode(id, mode as ContextMode);
    return true;
  });
  // 会话级替身画像开关。
  ipcMain.handle('set-persona-enabled', (_e, id: string, enabled: boolean) => {
    taskManager.setPersonaEnabled(id, enabled);
    return true;
  });
  // 会话级跨项目记忆开关(false = recall/注入只看本会话)。
  ipcMain.handle('set-cross-project-memory', (_e, id: string, enabled: boolean) => {
    taskManager.setCrossProjectMemory(id, enabled);
    return true;
  });

  ipcMain.handle('get-settings', () => getSettings());
  ipcMain.handle('save-settings', (_e, s: AppSettings) => {
    const old = getSettings();
    // Goal 监工参数归一化:防负数/NaN/非数组从渲染层漏进来(main 侧白名单式兜底)。
    const norm = (v: unknown, d: number): number => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
    s.goalSupervisorEnabled = Boolean(s.goalSupervisorEnabled);
    s.goalSupervisorModel = typeof s.goalSupervisorModel === 'string' ? s.goalSupervisorModel.trim() : '';
    s.goalProfileChain = Array.isArray(s.goalProfileChain) ? s.goalProfileChain.filter((x) => typeof x === 'string' && x) : [];
    s.goalMaxIterations = Math.max(1, Math.floor(norm(s.goalMaxIterations, 20)));
    s.goalMaxHours = norm(s.goalMaxHours, 0);
    s.goalMaxCostUSD = norm(s.goalMaxCostUSD, 0);
    saveSettings(s);
    rebuildTrayMenu(); // 语言切换后托盘菜单跟随
    // 多机协作:remote server 配置变化 → 刷新 MCP 远程连接。
    if (JSON.stringify(old.remoteMcpServers ?? []) !== JSON.stringify(s.remoteMcpServers ?? [])) {
      mcp.setRemoteServers(s.remoteMcpServers ?? []);
    }
    // 本机 MCP Server:enabled 变化 → 启停。空 token 时拒绝启动(mcp-server.start 会 reject)。
    if (s.localMcpServer?.enabled && !localMcpServer.isRunning()) {
      if (!s.localMcpServer.token?.trim()) {
        console.warn('[settings] MCP Server 启动被拒:token 为空');
      } else {
        localMcpServer.setTools(allTools());
        localMcpServer.setToken(s.localMcpServer.token);
        localMcpServer.start(s.localMcpServer.port, s.localMcpServer.token).catch((e) => {
          console.warn('[settings] MCP Server 启动失败:', (e as Error).message);
        });
      }
    } else if (!s.localMcpServer?.enabled && localMcpServer.isRunning()) {
      void localMcpServer.stop();
    }
    // 企信机器人:配置变化 → 重连/断开。
    const oldWecom = old.wecomBot;
    const newWecom = s.wecomBot;
    if (newWecom?.enabled && (!oldWecom?.enabled
        || oldWecom.botId !== newWecom.botId
        || oldWecom.secret !== newWecom.secret)) {
      getWeComBridge().start().catch((e) => console.warn('[wecom] 重连失败:', e.message));
    } else if (!newWecom?.enabled && oldWecom?.enabled) {
      getWeComBridge().stop();
    }
    // 飞书机器人:配置变化 → 重连/断开。
    const oldFeishu = old.feishuBot;
    const newFeishu = s.feishuBot;
    if (newFeishu?.enabled && (!oldFeishu?.enabled
        || oldFeishu.appId !== newFeishu.appId
        || oldFeishu.appSecret !== newFeishu.appSecret)) {
      getFeishuBridge().start().catch((e) => console.warn('[feishu] 重连失败:', e.message));
    } else if (!newFeishu?.enabled && oldFeishu?.enabled) {
      getFeishuBridge().stop();
    }
    return true;
  });
  // 热切换应用图标:清除缓存 → 重新加载 → 更新所有窗口 + macOS Dock
  ipcMain.handle('set-app-icon', (_e, iconKey: string) => {
    const s = getSettings();
    _appIcon = undefined;          // 清缓存,让 appIcon() 重新加载
    _appIconKey = null;
    saveSettings({ ...s, appIcon: iconKey });
    const img = appIcon();
    console.log(`[set-app-icon] key=${iconKey} img=${img ? img.getSize().width + 'x' + img.getSize().height : 'null'} isEmpty=${img ? img.isEmpty() : 'N/A'}`);
    if (img) {
      for (const win of BrowserWindow.getAllWindows()) {
        try { win.setIcon(img); } catch (e) { console.log('[set-app-icon] setIcon error:', e); }
      }
      if (process.platform === 'darwin') {
        try { app.dock?.setIcon(img); } catch { /* 非 mac */ }
      }
    }
    // Windows: 更新托盘图标(tray icon 可以在运行时改变)
    if (tray && !tray.isDestroyed()) {
      try {
        const ti = makeTrayIcon();
        tray.setImage(ti);
        console.log(`[set-app-icon] tray icon updated`);
      } catch (e) { console.log('[set-app-icon] tray setImage error:', e); }
    }
    return true;
  });
  // renderer 请求 icon 文件的 file:// URL(兼容打包后 resources/build/ 和开发模式 build/)
  ipcMain.handle('resolve-icon-url', (_e, file: string) => {
    const resBase = process.resourcesPath ? path.join(process.resourcesPath, 'build') : '';
    for (const candidate of [
      resBase ? path.join(resBase, file) : '',
      path.join(__dirname, '..', '..', 'build', file),
    ].filter(Boolean)) {
      try {
        if (fs.existsSync(candidate)) return 'file://' + candidate.replace(/\\/g, '/');
      } catch { /* try next */ }
    }
    return '';
  });
  ipcMain.handle('list-mcp', () => mcp.snapshot());
  // skill 列表(~/.kinetaios + ~/.claude + ~/.codex + plugins)。曾丢失导致
  // renderer invoke reject → slash 菜单/skill 按钮无响应。
  // / Skill listing — losing this handler broke the slash menu & skill button.
  ipcMain.handle('list-skills', () => listSkills());
  ipcMain.handle('get-brand', () => getBrand());

  // ── 多机协作:远程节点信息 + 远程任务调用 ──
  ipcMain.handle('list-remote-nodes', async () => mcp.remoteSnapshot());
  ipcMain.handle('call-remote-agent', async (_e, serverName: string, prompt: string) => {
    try {
      return await mcp.callRemote(serverName, 'run_agent', { prompt });
    } catch (err) {
      throw new Error((err as Error).message);
    }
  });

  // ── 多机协作:本机 MCP Server 启停 + 状态 ──
  // 远程 Agent 事件 → 转发到 dashboard,让用户看到"远程正在调我的 Agent 干活"。
  localMcpServer.setRemoteEventHandler((ev) => {
    safeSend(dashboardWin, 'remote-agent-event', ev);
  });

  ipcMain.handle('start-mcp-server', async (_e, port: number, token: string) => {
    try {
      // 安全:空 token 拒绝启动 —— mcp-server.ts 的 start() 也会拦,这里提前给 UI 友好提示。
      if (!token || !token.trim()) {
        return { ok: false, error: '安全限制:必须设置访问令牌(token),否则局域网内任何机器都能调用本机工具。' };
      }
      // 把当前所有内置工具 + 自定义工具暴露给远程调用者。
      localMcpServer.setTools(allTools());
      localMcpServer.setToken(token);
      await localMcpServer.start(port, token);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('stop-mcp-server', async () => {
    await localMcpServer.stop();
    return { ok: true };
  });
  ipcMain.handle('mcp-server-status', () => {
    const s = getSettings();
    return {
      running: localMcpServer.isRunning(),
      port: s.localMcpServer.port,
      url: `http://${os.hostname()}:${s.localMcpServer.port}/mcp`,
    };
  });

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
      const buf = fs.readFileSync(full);
      // 二进制检测:前 8KB 有 null byte → 拒绝
      const checkLen = Math.min(buf.length, 8192);
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0) return { ok: false, error: t(getSettings().lang, 'common.binary') };
      }
      const body = buf.toString('utf8');
      return { ok: true, name: rel, content: body.length > 20000 ? body.slice(0, 20000) + '\n…[截断]' : body };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // Files 窗口编辑器:绝对路径读全文(无 20KB 截断、无 cwd 越界检查 —— 用户主动挑的文件)。
  ipcMain.handle('file-read', (_e, abs: string) => {
    try {
      // 安全:阻止读取系统敏感目录。
      if (isBlockedSystemPath(abs)) return { ok: false, error: '安全限制:不允许读取系统目录' };
      // 先读 Buffer 检测二进制:前 8KB 内有 null byte → 二进制文件,拒绝打开。
      // 否则 toString('utf8') 返回文本(避免直接 utf8 读二进制导致乱码/崩溃)。
      const buf = fs.readFileSync(abs);
      const checkLen = Math.min(buf.length, 8192);
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0) return { ok: false, error: t(getSettings().lang, 'common.binary') };
      }
      const content = buf.toString('utf8');
      // 超大文件截断(避免渲染器卡死/OOM)—— 1MB 上限。
      const MAX = 1_000_000;
      const truncated = content.length > MAX ? content.slice(0, MAX) + '\n\n… [truncated]' : content;
      return { ok: true, content: truncated };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  // Files 窗口编辑器:绝对路径写全文。
  ipcMain.handle('file-write', (_e, abs: string, content: string) => {
    try {
      // 安全:阻止写入系统敏感目录。
      if (isBlockedSystemPath(abs)) return { ok: false, error: '安全限制:不允许写入系统目录' };
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
      return {
        ok: false,
        message: (e as Error)?.message ?? String(e),
      };
    }
  });

  // 列出本地 Ollama 已安装的模型(GET {baseURL}/api/tags)
  ipcMain.handle('list-local-models', async (_e, baseURL?: string) => {
    const base = (baseURL || '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
    if (!base) return { ok: false, models: [], message: 'Base URL 为空' };
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return { ok: false, models: [], message: `HTTP ${res.status}` };
      const data = await res.json() as any;
      const models: string[] = (data.models || []).map((m: any) => m.name || m.model).filter(Boolean);
      return { ok: true, models, message: '' };
    } catch (e) {
      return { ok: false, models: [], message: (e as Error)?.message ?? String(e) };
    }
  });

  // 查询智谱 API 账户状态 — Coding Plan 用量 + 钱包余额
  // 参考 CC Switch (github.com/farion1231/cc-switch) coding_plan.rs:
  //   1. Coding Plan 用量: GET {host}/api/monitor/usage/quota/limit
  //      - Auth 头直接放 key,不加 Bearer 前缀
  //      - 返回 data.limits[],每个条目含 type=TOKENS_LIMIT, unit(3=5h,6=weekly), percentage, nextResetTime
  //   2. 钱包余额: GET {baseURL}/balance (标准 OpenAI 兼容端点)
  //      - Auth 头加 Bearer 前缀
  //      - 返回 data.totalBalance / balance / giftBalance
  // 配置路由:profile.balanceUrl 显式配 > baseURL 关键字自动推断(MiniMax / CodingPlan / 智谱)。
  // 详见 settings.balanceSnapshot。
  ipcMain.handle('get-balance', async (_e, profileId?: string | null) => {
    // profileId: 会话级配置档 id(null/undefined = 全局 activeProfile)。与 TaskManager 的 snapshot 语义一致。
    const bal = balanceSnapshot(profileId ?? null);
    console.log('[get-balance] provider:', bal.provider, 'url:', bal.url, 'scheme:', bal.authScheme, 'keySet:', !!bal.apiKey);
    if (!bal.apiKey) return { ok: false, message: '未设置 API Key' };
    if (!bal.url) return { ok: false, message: '当前端点不支持余额查询' };

    // 根据 authScheme 构造 Authorization / 自定义 header
    const buildAuth = (key: string): Record<string, string> => {
      if (bal.authScheme === 'raw') return { Authorization: key }; // 智谱 quota:裸 token
      if (bal.authScheme === 'x-api-key') return { 'x-api-key': key }; // MiniMax / 部分 Anthropic 兼容
      return { Authorization: `Bearer ${key}` }; // OpenAI 兼容标准
    };

    const doFetch = async (): Promise<Response> => fetch(bal.url, {
      method: 'GET',
      headers: {
        ...buildAuth(bal.apiKey),
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
      },
      signal: AbortSignal.timeout(15_000),
    });

    try {
      const resp = await doFetch();

      // ── 错误统一处理 ──
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        if (resp.status === 401) {
          return { ok: false, message: 'API Key 无效或已过期' };
        }
        if (resp.status === 403) {
          // MiniMax 区分 admin key / 普通 key:普通 key(包括 sk-cp- coding plan 系列)无法查余额。
          if (/token_type_mismatch|admin key/i.test(detail)) {
            // 平台拒绝普通 API key 查余额(MiniMax 故意不开放),UI 给出网页入口。
            const webUrl = bal.provider === 'minimax'
              ? 'https://platform.minimaxi.com/console/usage'
              : undefined;
            return {
              ok: false,
              provider: bal.provider,
              webUrl,
              message: webUrl
                ? '该 Key 类型不支持 API 余额查询,请到网页控制台查看用量'
                : '该 Key 类型不支持查询余额(需 admin key)',
            };
          }
          return { ok: false, message: 'API Key 无权访问余额接口' };
        }
        if (resp.status === 404) {
          return { ok: false, message: '当前 API 端点不支持余额查询' };
        }
        return { ok: false, message: `查询失败 (HTTP ${resp.status}): ${detail.slice(0, 200)}` };
      }

      const j = await resp.json() as Record<string, any>;
      // 业务级错误:{ success: false, msg: "..." }
      if (j?.success === false) {
        return { ok: false, message: j?.msg || 'API 返回错误' };
      }

      // ── Coding Plan:解析 limits[] → tiers ──
      if (bal.provider === 'zhipu-coding-plan') {
        const data = j?.data ?? {};
        const level = data?.level ? String(data.level) : undefined; // 套餐等级 Lite/Pro/Max
        const tiers: Array<{ window: string; pct: number; reset?: string }> = [];
        const limits = data?.limits;
        if (Array.isArray(limits)) {
          for (const item of limits) {
            if (!String(item?.type || '').toUpperCase().includes('TOKENS_LIMIT')) continue;
            const unit = item?.unit;
            const pct = Number(item?.percentage ?? 0);
            const resetMs = item?.nextResetTime;
            let window = '';
            if (unit === 3) window = '5h';
            else if (unit === 6) window = 'weekly';
            else continue;
            tiers.push({ window, pct, reset: resetMs ? String(resetMs) : undefined });
          }
        }
        return { ok: true, codingPlan: true, level, tiers };
      }

      // ── 标准余额接口(MiniMax / 智谱开放 / 自定义):data?.{balance,left,gift} 双兜底 ──
      const data = (j as any)?.data ?? j ?? {};
      return {
        ok: true,
        codingPlan: false,
        provider: bal.provider,
        balance: String(data?.totalBalance ?? data?.balance ?? data?.total ?? '?'),
        left: String(data?.left ?? data?.available ?? data?.balance ?? '?'),
        gift: String(data?.gift ?? data?.giftBalance ?? '0'),
      };
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
  // 在用户默认程序里打开 URL(file:// → 系统默认程序 / http(s) → 默认浏览器)。
  // 文件树右键「在浏览器中打开」用 file:// 协议;浏览器/外链用 http(s)。
  // 只允许 file/http/https,防止 smb://、恶意协议打开本地程序。
  ipcMain.handle('shell-open', (_e, url: string) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return shell.openExternal(u.href);
      }
      if (u.protocol === 'file:') {
        // file:/// → 本地路径,用 openPath 走系统默认程序(浏览器/图片查看器等)
        // openPath 期望普通路径(URL decode + 去掉 file:// 前缀)
        const fp = decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1');
        return shell.openPath(fp);
      }
      return { ok: false, error: `不允许的协议: ${u.protocol}` };
    } catch {
      return { ok: false, error: '非法 URL' };
    }
  });
  ipcMain.handle('git-snapshot', (_e, cwd: string) => gitSnapshotAsync(cwd));
  ipcMain.handle('git-diff', (_e, cwd: string, opts: { file?: string; hash?: string; staged?: boolean }) =>
    gitDiffAsync(cwd, opts),
  );
  ipcMain.handle('git-action', (_e, cwd: string, action: GitActionKind, opts?: { message?: string; file?: string; branch?: string }) =>
    gitActionAsync(cwd, action, opts),
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
  ipcMain.handle('memory-update', async (_e, id: string, content: string) => {
    try {
      updateMemory(id, content);
      // content 变了 → 同步重建 embedding(失败不阻塞,recall 回退 FTS5)
      try {
        const { embed } = await import('./glm');
        const { snapshot, embedSnapshot } = await import('./settings');
        const snap = snapshot();
        const esnap = embedSnapshot();
        const vecs = await embed([content], snap);
        if (vecs[0]?.length) setMemoryEmbedding(id, vecs[0], esnap.model);
      } catch { /* embedding 失败 = recall 回退 FTS5,可接受 */ }
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
  // P0-2:会话级 KV 锚点(remember_fact / recall_fact 走 IPC 暴露给 renderer debug 面板)。
  // 工具自身通过 tools.ts 直接调 store(),不经 IPC(降低延迟)。
  ipcMain.handle('fact-list', (_e, convId: string) => {
    try {
      return { ok: true, items: listFacts(convId) };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('fact-delete', (_e, convId: string, key: string) => {
    try {
      return { ok: deleteFact(convId, key) };
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
      taskManager.rebuildEngines(); // v3: 插件引擎表可能变化 — rebuild engine registry.
      return { ok: true, count: items.length };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  // v2: 安装(复制目录) + 卸载(删除目录)。
  ipcMain.handle('plugin-install', (_e, sourcePath: string) => {
    try {
      const r = installPlugin(sourcePath);
      taskManager.rebuildEngines(); // v3: 新插件可能贡献引擎 — rebuild engine registry.
      return r;
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('plugin-uninstall', (_e, name: string) => {
    try {
      const r = uninstallPlugin(name);
      taskManager.rebuildEngines(); // v3: 卸载的插件引擎立即失效 — rebuild engine registry.
      return r;
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  // v2: 启用/禁用插件(不删除,只是从工具/prompt/命令注入中排除)。
  ipcMain.handle('plugin-toggle', (_e, name: string, enabled: boolean) => {
    try {
      const r = togglePlugin(name, enabled);
      taskManager.rebuildEngines(); // v3: 禁/启可能增删插件引擎 — rebuild engine registry.
      return r;
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  // v3.1: 保存插件引擎设置(占位符值) — 保存后热重建引擎(bin/args 插值立即生效)。
  ipcMain.handle('plugin-engine-settings-save', (_e, name: string, values: Record<string, string>) => {
    try {
      const r = savePluginEngineSettings(name, values ?? {});
      if (r.ok) taskManager.rebuildEngines();
      return r;
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  // Plugin SDK v2.1: 渲染层扩展 —— 返回已启用插件的 panel HTML, renderer 注入为独立视图。
  ipcMain.handle('plugin-panels', () => {
    try {
      return { ok: true, items: pluginPanelsSnap() };
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

  // ── Pipeline 跨引擎编排 ──
  ipcMain.handle('pipeline-run', async (_e, p: { name: string; stages: Array<{ engine: EngineKind; prompt: string; label?: string }>; cwd: string }) => {
    try {
      const id = await taskManager.runPipeline(p.stages, p.cwd, p.name);
      return { ok: true, convId: id };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('pipeline-templates', () => {
    const { loadPipelines } = require('./store');
    return loadPipelines().map((r: { id: string; name: string; data: string; cwd: string; createdAt: number }) => ({ id: r.id, name: r.name, stages: JSON.parse(r.data), cwd: r.cwd, createdAt: r.createdAt }));
  });
  ipcMain.handle('pipeline-save', (_e, p: Pipeline) => {
    const { savePipeline } = require('./store');
    savePipeline({ id: p.id, name: p.name, data: JSON.stringify(p.stages), cwd: p.cwd });
    return { ok: true };
  });
  ipcMain.handle('pipeline-delete', (_e, id: string) => {
    const { deletePipeline } = require('./store');
    deletePipeline(id);
    return { ok: true };
  });

  // ── 会话分支 ──
  ipcMain.handle('branch-from-turn', (_e, convId: string, turnIdx: number) => {
    const conv = taskManager.branchFrom(convId, turnIdx);
    return conv ? { ok: true, convId: conv.id } : { ok: false, error: '无法分支' };
  });

  // ── 成本预算 ──
  ipcMain.handle('get-budget', () => getSettings().budget);
  ipcMain.handle('save-budget', (_e, b: BudgetAlert) => {
    const s = getSettings();
    saveSettings({ ...s, budget: b });
    return { ok: true };
  });
  ipcMain.handle('cost-stats', () => {
    const { costStats } = require('./store');
    return costStats();
  });

  // ── Prompt 模板 ──
  ipcMain.handle('template-list', () => {
    const { loadTemplates } = require('./store');
    const builtin = builtinTemplates();
    const custom = loadTemplates().map((r: { id: string; name: string; data: string }) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
    return [...builtin, ...custom];
  });
  ipcMain.handle('template-save', (_e, t: PromptTemplate) => {
    const { saveTemplate } = require('./store');
    saveTemplate({ id: t.id, name: t.name, data: JSON.stringify(t) });
    return { ok: true };
  });
  ipcMain.handle('template-delete', (_e, id: string) => {
    const { deleteTemplate } = require('./store');
    deleteTemplate(id);
    return { ok: true };
  });

  // ── 可视化规则生成 ──
  ipcMain.handle('rules-generate', (_e, cfg: RuleConfig) => {
    return { ok: true, content: generateRules(cfg) };
  });

  // ── 自定义工具 ──
  ipcMain.handle('custom-tool-list', () => {
    try {
      const items = loadCustomTools();
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('custom-tool-save', (_e, t: CustomTool) => {
    try {
      saveCustomTool({
        id: t.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)),
        name: t.name,
        description: t.description || '',
        parameters: typeof t.parameters === 'string' ? t.parameters : JSON.stringify(t.parameters || {}),
        commandTpl: t.commandTpl || '',
        timeoutMs: t.timeoutMs || 120,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('custom-tool-delete', (_e, id: string) => {
    try {
      deleteCustomTool(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── 记忆时间线 ──
  ipcMain.handle('memory-timeline', () => {
    try {
      const items = loadMemoryTimeline();
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('memory-decay', () => {
    try {
      const pruned = decayMemories();
      return { ok: true, pruned };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('memory-dedup', async () => {
    try {
      const pruned = await dedupMemories(0.65);
      return { ok: true, pruned };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── P0: Memory Blocks ──
  ipcMain.handle('memory-blocks-list', () => {
    try {
      const blocks = loadMemoryBlocks();
      return { ok: true, blocks };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('memory-block-update', (_e, label: string, value: string) => {
    try {
      const ok = updateMemoryBlock(label, value);
      return { ok };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── P2: Episodic Memories ──
  ipcMain.handle('episodic-memories', (_e, limit?: number) => {
    try {
      const items = loadEpisodicMemories(limit ?? 20);
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── P3: Idle Reflection(记忆 GC)──
  ipcMain.handle('memory-reflection', async () => {
    try {
      const result = await taskManager.runIdleReflection();
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── 会话导出 ──
  ipcMain.handle('export-conversation', async (_e, convId: string, format: string) => {
    try {
      const conv = taskManager.hydrate(convId); // 导出需要全部 turns,懒加载
      if (!conv) return { ok: false, error: t(getSettings().lang, 'common.convNotFound') };
      const brand = getBrand();
      let content = '';
      let ext = '';
      if (format === 'json') {
        content = JSON.stringify(conv, null, 2);
        ext = 'json';
      } else if (format === 'html') {
        content = exportHTML(conv, brand.productName);
        ext = 'html';
      } else {
        content = exportMarkdown(conv);
        ext = 'md';
      }
      const win = dashboardWin && !dashboardWin.isDestroyed() ? dashboardWin : undefined;
      const r = win
        ? await dialog.showSaveDialog(win, { defaultPath: `${conv.customTitle || conv.turns[0]?.prompt.slice(0, 30) || 'session'}.${ext}`, filters: [{ name: format.toUpperCase(), extensions: [ext] }] })
        : await dialog.showSaveDialog({ defaultPath: `session.${ext}`, filters: [{ name: format.toUpperCase(), extensions: [ext] }] });
      if (r.canceled || !r.filePath) return { ok: false, error: t(getSettings().lang, 'common.cancelled') };
      fs.writeFileSync(r.filePath, content, 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── Arena Diff ──
  ipcMain.handle('arena-diff', (_e, leftConvId: string, rightConvId: string) => {
    try {
      const left = taskManager.hydrate(leftConvId); // diff 读 lastTurn.answer,懒加载
      const right = taskManager.hydrate(rightConvId);
      if (!left || !right) return { ok: false, error: t(getSettings().lang, 'common.convNotFound') };
      const leftText = left.turns[left.turns.length - 1]?.answer ?? '';
      const rightText = right.turns[right.turns.length - 1]?.answer ?? '';
      const diff = computeLineDiff(leftText, rightText);
      return { ok: true, diff, leftEngine: left.engine, rightEngine: right.engine };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── 上下文压缩可视化:估算会话 token 使用量 ──
  ipcMain.handle('est-context-tokens', (_e, convId: string) => {
    return taskManager.estContextTokens(convId);
  });

  // ── Pin/Unpin Turn:锁定的 turn 不被 compact 压缩 ──
  ipcMain.handle('pin-turn', (_e, convId: string, turnId: string, pinned: boolean) => {
    return { ok: taskManager.pinTurn(convId, turnId, pinned) };
  });

  // ── 上下文检查器:查看 / 编辑 Direct 引擎的 directHistory ──
  ipcMain.handle('get-direct-history', (_e, convId: string) => {
    return taskManager.getDirectHistory(convId);
  });
  ipcMain.handle('save-direct-history', (_e, convId: string, history: ChatMsg[]) => {
    return taskManager.saveDirectHistory(convId, history);
  });

  // ── 替身画像(Persona)──
  ipcMain.handle('generate-persona', async () => {
    return taskManager.generatePersona();
  });
  ipcMain.handle('get-persona', () => {
    return { ok: true, persona: getSettings().persona ?? '' };
  });
  ipcMain.handle('save-persona', (_e, persona: string) => {
    try {
      const s = getSettings();
      s.persona = persona;
      saveSettings(s);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── 跨会话引用 + Agent 任务图 ──
  ipcMain.handle('task-graph', () => {
    return loadTaskGraph();
  });

  ipcMain.handle('search-conversations', (_e, query: string) => {
    const q = (query ?? '').toLowerCase().trim();
    const all = taskManager.list();
    if (!q) return all.slice(0, 20).map((c) => ({ id: c.id, title: c.customTitle || c.firstPrompt?.slice(0, 40) || c.id.slice(0, 8), engine: c.engine, turns: c.turnCount ?? c.turns.length, lastActive: c.createdAt }));
    return all
      .filter((c) => {
        const title = (c.customTitle || '').toLowerCase();
        const firstPrompt = (c.firstPrompt || '').toLowerCase();
        return title.includes(q) || firstPrompt.includes(q) || c.id.toLowerCase().includes(q);
      })
      .slice(0, 20)
      .map((c) => ({ id: c.id, title: c.customTitle || c.firstPrompt?.slice(0, 40) || c.id.slice(0, 8), engine: c.engine, turns: c.turnCount ?? c.turns.length, lastActive: c.createdAt }));
  });

  // ── 全局对话搜索:FTS5 全文搜索 + 关联会话标题 ──
  ipcMain.handle('search-history', (_e, query: string) => {
    const results = searchEnriched(query, 50);
    return results;
  });

  // ── 上下文考古:读取会话的事件流(conv_events,append-only 事实源)──
  ipcMain.handle('conv-events', (_e, convId: string, afterSeq = 0) => {
    return loadEvents(convId, afterSeq);
  });

  // ── 记忆图谱数据:返回三元组 + 节点列表(给 renderer 力导向图用) + 溯源 + 冲突 ──
  ipcMain.handle('memory-graph-data', () => {    const triples = loadMemoryTriples();
    // 提取唯一节点(subject + object 去重)
    const nodeSet = new Set<string>();
    for (const t of triples) {
      nodeSet.add(t.subject);
      nodeSet.add(t.object);
    }
    const nodes = [...nodeSet].map((label, i) => ({ id: label, label, idx: i }));
    const edges = triples.map((t) => ({
      source: t.subject,
      target: t.object,
      predicate: t.predicate,
      tripleId: t.id,
      convId: t.conversation_id,
      createdAt: t.created_at,
    }));

    // ── 记忆溯源:为每个三元组预查来源会话的 prompt / Provenance pre-lookup ──
    // 按 conversation_id 批量查询(避免 N 次 DB call)
    const provenanceMap = new Map<string, { engine: string | null; prompt: string | null }>();
    const convIds = [...new Set(triples.map((t) => t.conversation_id).filter(Boolean))] as string[];
    for (const cid of convIds) {
      if (!provenanceMap.has(cid)) {
        const p = tripleProvenance(cid);
        provenanceMap.set(cid, { engine: p.engine, prompt: p.prompt });
      }
    }
    const triplesWithSource = triples.map((t) => ({
      id: t.id,
      subject: t.subject,
      predicate: t.predicate,
      object: t.object,
      convId: t.conversation_id,
      createdAt: t.created_at,
      sourceEngine: t.conversation_id ? provenanceMap.get(t.conversation_id)?.engine ?? null : null,
      sourcePrompt: t.conversation_id ? provenanceMap.get(t.conversation_id)?.prompt ?? null : null,
    }));

    // ── 记忆冲突检测:同 subject + 同 predicate,不同 object / Conflict detection ──
    // 例:(用户,使用系统,macOS) vs (用户,使用系统,Windows) → 冲突
    const conflictMap = new Map<string, Array<{ tripleId: string; subject: string; predicate: string; object: string; convId: string | null; createdAt: number }>>();
    const spKey = (s: string, p: string) => `${s}|${p}`.toLowerCase();
    for (const t of triples) {
      const key = spKey(t.subject, t.predicate);
      if (!conflictMap.has(key)) conflictMap.set(key, []);
      conflictMap.get(key)!.push({
        tripleId: t.id,
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
        convId: t.conversation_id,
        createdAt: t.created_at,
      });
    }
    // 只保留有 >1 个不同 object 的组
    const conflicts: Array<{
      subject: string;
      predicate: string;
      entries: Array<{ tripleId: string; object: string; convId: string | null; createdAt: number }>;
    }> = [];
    for (const [, entries] of conflictMap) {
      const uniqueObjects = new Set(entries.map((e) => e.object.toLowerCase()));
      if (uniqueObjects.size > 1) {
        conflicts.push({
          subject: entries[0].subject,
          predicate: entries[0].predicate,
          entries: entries.map((e) => ({ tripleId: e.tripleId, object: e.object, convId: e.convId, createdAt: e.createdAt })),
        });
      }
    }

    return { nodes, edges, triples: triplesWithSource, conflicts };
  });

  // ── Arena 深度统计:按引擎聚合 token/成本/耗时/工具调用数 ──
  ipcMain.handle('arena-stats', () => {
    return arenaAggregate();
  });

  // ── 删除记忆三元组 ──
  ipcMain.handle('delete-memory-triple', (_e, tripleId: string) => {
    deleteMemoryTriple(tripleId);
    return { ok: true };
  });

  // ── 记忆图谱独立窗口 ──
  ipcMain.handle('open-memory-graph', () => {
    showMemoryGraph();
    return true;
  });

  // ── 实时协作直播:获取当前远程 Agent 事件流(前端轮询或 SSE 获取)──
  // 返回最近 N 条远程事件 + 当前活跃远程任务状态。
  ipcMain.handle('remote-agent-status', () => {
    return localMcpServer.getLiveStatus();
  });

  // ── 会话交接:导出会话状态 ──
  ipcMain.handle('export-session-state', (_e, convId: string) => {
    try {
      const conv = taskManager.hydrate(convId); // 交接导出含全部 turns,懒加载
      if (!conv) return { ok: false, error: '会话不存在' };
      const state = {
        version: 1,
        conv: {
          engine: conv.engine,
          model: conv.model,
          cwd: conv.cwd,
          customTitle: conv.customTitle,
          turns: conv.turns,
          directHistory: conv.directHistory,
          engineSessionId: conv.engineSessionId,
          cost: conv.cost,
          tokens: conv.tokens,
        },
        exportedAt: Date.now(),
      };
      return { ok: true, json: JSON.stringify(state) };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── 会话交接:导入会话状态 ──
  ipcMain.handle('import-session-state', (_e, sessionJson: string) => {
    try {
      const state = JSON.parse(sessionJson) as { conv: { engine: EngineKind; model: string; cwd: string; customTitle: string | null; turns: Turn[]; directHistory: ChatMsg[]; engineSessionId: string | null; cost: number; tokens: number } };
      if (!state.conv) return { ok: false, error: '无效的会话 JSON' };
      const c = state.conv;
      const conv = taskManager.newConversation(c.cwd || os.homedir(), c.engine || 'direct');
      conv.customTitle = `[交接] ${c.customTitle || c.turns[0]?.prompt.slice(0, 20) || 'Session'}`;
      conv.turns = c.turns ?? [];
      conv.directHistory = c.directHistory ?? [];
      conv.engineSessionId = c.engineSessionId ?? null;
      conv.cost = c.cost ?? 0;
      conv.tokens = c.tokens ?? 0;
      saveConversation(conv);
      for (const t of conv.turns) saveTurn(conv.id, t);
      return { ok: true, convId: conv.id };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── 记忆同步:与远程节点双向合并记忆库 ──
  ipcMain.handle('sync-memories-remote', async (_e, serverName: string) => {
    try {
      // 先把本机记忆推给远程,远程返回合并后的全量
      const localMems = allMemoryContents();
      const result = await mcp.callRemote(serverName, 'sync_memories', { memories: localMems });
      const parsed = JSON.parse(result) as { addedCount?: number; totalLocal?: number; memories?: string[] };
      // 再把远程返回的全量合并到本机(可能有远程有但本机没有的)
      const localSet = new Set(localMems);
      let added = 0;
      for (const m of parsed.memories ?? []) {
        if (m && !localSet.has(m)) {
          addMemory(m);
          localSet.add(m);
          added++;
        }
      }
      return { ok: true, added, total: localSet.size };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── 系统级截图 ──
  // desktopCapturer 在 main 进程可用,但 macOS 需要屏幕录制权限。
  // 如果 main 进程拿不到(权限/版本差异),回退到 renderer 的 getUserMedia。
  // hideSelf=true: 截图前最小化本 app 窗口,截完还原(按钮"隐藏截图"路径)。
  ipcMain.handle('capture-screen', async (_e, hideSelf?: boolean) => {
    try {
      return await withSelfHidden(Boolean(hideSelf), async () => {
        console.log('[main] capture-screen: requesting desktopCapturer...');
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
        console.log('[main] capture-screen: got', sources.length, 'sources');
        if (!sources.length) return { ok: false, error: t(getSettings().lang, 'common.noScreen') };
        // 取整个虚拟桌面(包含多显示器)或第一个源
        const source = sources.find((s) => s.display_id === '') || sources[0];
        const thumb = source.thumbnail;
        // macOS 无屏幕录制权限时 thumbnail 为空 nativeImage → isEmpty() = true
        if (thumb.isEmpty()) {
          console.log('[main] capture-screen: thumbnail is EMPTY (screen permission not granted?)');
          return { ok: false, error: t(getSettings().lang, 'common.emptyCapture') };
        }
        const dataUrl = thumb.toDataURL();
        console.log('[main] capture-screen: dataUrl length =', dataUrl?.length);
        // 空图也会产生 ~100 字节的 PNG,真正截图至少几万字节
        if (!dataUrl || dataUrl.length < 1000) return { ok: false, error: t(getSettings().lang, 'common.emptyCapture') };
        return { ok: true, dataUrl };
      });
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── 语音转写 ──
  // renderer 录音(WebM/Opus)→ base64 发来 → 调 OpenAI-compatible /audio/transcriptions
  ipcMain.handle('transcribe-audio', async (_e, base64: string, mime: string) => {
    try {
      const s = getSettings();
      if (!s.apiKey) return { ok: false, error: 'API key not set' };
      // base64 → Buffer
      const buf = Buffer.from(base64, 'base64');
      const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : 'm4a';
      const filename = `audio.${ext}`;
      // multipart/form-data — 手拼 boundary(零依赖,不引 form-data)
      const boundary = '----KinetAios' + Math.random().toString(36).slice(2);
      const parts: Buffer[] = [];
      // file 字段
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`));
      parts.push(buf);
      parts.push(Buffer.from('\r\n'));
      // model 字段
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`));
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const body = Buffer.concat(parts);

      const url = s.baseURL.replace(/\/$/, '') + '/audio/transcriptions';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${s.apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      if (!res.ok) {
        const txt = await res.text();
        return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
      }
      const data = await res.json() as { text?: string };
      return { ok: true, text: data.text ?? '' };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // 剪贴板写入 — 走主进程 clipboard 模块,绕过 renderer contextIsolation 下 navigator.clipboard 失效问题
  ipcMain.handle('clipboard-write-text', (_e, text: string) => {
    try {
      clipboard.writeText(text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── Visual Inspector:向 <webview> 的 guest contents 注入采集脚本 ──
  // 安全:不再接受任意 script 字符串(防 XSS → IPC → 任意 JS 执行)。
  // 改为白名单 action,主进程内部硬编码脚本,renderer 只传坐标参数。
  // renderer 传 guestInstanceId(由 <webview>.getGuestInstanceId() 获得)+ action + params。
  // 返回 { ok, result?, error? }。
  ipcMain.handle('webview-inspect', async (_e, guestInstanceId: number, action: string, params?: Record<string, unknown>) => {
    try {
      const wc = webContents.fromId(guestInstanceId);
      if (!wc) {
        return { ok: false, error: 'webview not found (guestInstanceId=' + guestInstanceId + ')' };
      }
      // 白名单 action:只允许 collectElements 这一种操作 / Whitelist: only collectElements allowed
      if (action !== 'collectElements') {
        return { ok: false, error: `Unknown action: ${action}` };
      }
      const x1 = Number(params?.x1 ?? 0), y1 = Number(params?.y1 ?? 0);
      const x2 = Number(params?.x2 ?? 0), y2 = Number(params?.y2 ?? 0);
      // 数值校验:防 NaN / 负数 / 超大值注入 / Validate numbers
      if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
        return { ok: false, error: 'Invalid coordinates' };
      }
      // 硬编码采集脚本 —— 坐标为纯数字,不存在注入面 / Hardcoded script — numbers only, no injection surface
      const script = buildCollectScript(x1, y1, x2, y2);
      const result = await wc.executeJavaScript(script);
      return { ok: true, result };
    } catch (e) {
      console.error('[webview-inspect] ERROR:', (e as Error)?.message ?? e);
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── 实时语音助手(豆包实时语音大模型)──
  // VoiceChat 管理器:WebSocket 双向音频流, renderer 通过 IPC 发送麦克风音频、接收 AI 音频。
  const voiceChat = new VoiceChat();
  // 暴露到模块级,供 before-quit 清理 / Expose to module scope for before-quit cleanup.
  voiceChatRef = voiceChat;
  // VoiceChat 事件 → 转发到 renderer
  voiceChat.onEvent((ev) => {
    // Buffer → base64(IPC 不能直接传 Buffer)
    const payload: VoiceChatEventPayload = ev.type === 'aiAudio'
      ? { type: 'aiAudio', data: (ev as any).data.toString('base64') }
      : ev as any;
    // 防御:renderer 已销毁时不发送(app 退出 / 窗口关闭后的在途回调)
    if (dashboardWin && !dashboardWin.isDestroyed() && !dashboardWin.webContents.isDestroyed()) {
      dashboardWin.webContents.send('voice-chat-event', payload);
    }
  });

  // 用户语音 → 转发给当前活跃频道的 Agent 执行
  // 注意:实际的 onUserMessage 注册在 voice-chat-start handler 中,因为需要注入项目上下文。
  // 此处不再重复注册(旧版本会被 handler 内的新版本覆盖,但留着是 dead code + 混淆)。

  ipcMain.handle('voice-chat-start', async (_e, convId: string) => {
    const s = getSettings();
    if (!s.voiceChat?.appId || !s.voiceChat?.accessToken) {
      return { ok: false, error: '缺少 App ID 或 Access Token,请在设置中配置' };
    }
    try {
      // 从语音发起的频道提取项目上下文,注入语音对话的 system_role
      // Extract project context from the conversation where voice was triggered
      const activeConv = taskManager.hydrate(convId) || null; // 语音上下文读最近 3 轮,懒加载
      let contextHint: string | undefined;
      if (activeConv?.cwd) {
        const projName = activeConv.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || activeConv.cwd;
        // 取最近 3 轮对话摘要作为上下文(避免太长)
        const recentTurns = activeConv.turns.slice(-3);
        const recentText = recentTurns
          .filter(t => t.prompt || t.answer)
          .map(t => {
            const u = (t.prompt || '').slice(0, 100);
            const a = (t.answer || '').slice(0, 200);
            return u ? `用户:${u} → 回答:${a}` : '';
          })
          .filter(Boolean)
          .join('\n');
        contextHint = `你是一个友好的AI助手。用户当前正在「${projName}」项目中工作(路径:${activeConv.cwd})。${
          recentText ? `以下是最近的对话记录,供你参考:\n${recentText}\n` : ''
        }请用简洁易懂的中文回答。如果用户问到当前项目相关信息,基于以上上下文回答。`;
      }
      console.log('[VoiceChat] 📎 项目上下文注入:', activeConv?.cwd ? `项目=${activeConv.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}, 轮次=${activeConv.turns.length}` : '无活跃会话或无 cwd');

      // 设置 Agent 桥接:用户说完话 → ASR 文本转给 Agent → Agent 结果回传语音
      // Agent bridge: user speech → ASR text to Agent → Agent result spoken back
      voiceChat.onUserMessage(async (text: string) => {
        // 使用语音发起时的频道,而非列表第一个
        // Use the conversation that was active when voice chat was started
        const conv = taskManager.get(convId);
        if (!conv) {
          voiceChat.agentResult('频道不存在,请重新打开语音对话。');
          return;
        }
        // P0: double-check conv.status — agentBusy 在 VoiceChat case 459 中已设,
        // 但两个 ASR 事件可能近乎同时到达,这里做第二道防线
        if (conv.status === 'running') {
          voiceChat.agentResult('上一个任务还在执行中,请稍等。');
          return;
        }
        // send 是阻塞调用 — 返回时引擎已完成。直接读 turn 结果,无需 poll。
        // send blocks until engine completes — read turn result directly, no polling.
        console.log('[VoiceChat] 🔄 转发给 Agent:', text, 'convId:', conv.id);
        try {
          await taskManager.send(conv.id, text);
          // send 是阻塞调用 — 返回时引擎已完成(或出错)。直接读最终 turn 状态。
          // send blocks until engine completes — read final turn state directly, no polling needed.
          const c = taskManager.get(conv.id);
          const lastTurn = c?.turns[c.turns.length - 1];
          if (!lastTurn?.done) {
            // 理论上不会走到这里(send 一定 await 到 done),但防御性处理
            voiceChat.agentResult('发送失败,频道可能正忙,请稍后重试。');
          } else if (lastTurn.error) {
            console.log('[VoiceChat] ❌ Agent 出错:', lastTurn.error.slice(0, 200));
            voiceChat.agentResult(`执行失败: ${lastTurn.error}`);
          } else {
            const result = (lastTurn.answer || '').slice(0, 2000);
            console.log('[VoiceChat] ✅ Agent 完成,回传:', result.slice(0, 100));
            voiceChat.agentResult(result || '执行完成,但没有返回文本。');
          }
        } catch (e) {
          voiceChat.agentResult(`Agent 执行失败: ${(e as Error)?.message ?? String(e)}`);
        }
      });

      await voiceChat.start({ ...s.voiceChat, contextHint });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('voice-chat-stop', async () => {
    voiceChat.close();
    return { ok: true };
  });
  ipcMain.handle('voice-chat-send-audio', async (_e, pcmBase64: string) => {
    try {
      const buf = Buffer.from(pcmBase64, 'base64');
      voiceChat.sendAudio(buf);
      return { ok: true };
    } catch (e) {
      return { ok: false };
    }
  });
  ipcMain.handle('voice-chat-state', async () => {
    return { state: voiceChat.getState() };
  });

  // ── AgentTeams IPC handlers ──
  ipcMain.handle('team-list', (_e, convId: string) => {
    const teams = listTeamsForConv(convId);
    return teams.map(t => ({ team_id: t.team_id, conv_id: convId, member_count: t.member_count, updated_at: t.updated_at }));
  });

  ipcMain.handle('team-create', (_e, convId: string, members: Array<{ name: string; role: string }>) => {
    if (!members || members.length === 0) return { ok: false, error: '缺少 members' };
    if (members.length > 8) return { ok: false, error: '成员过多(上限 8)' };
    const teamId = `conv:${convId}:team:${Date.now().toString(36)}`;
    const now = Date.now() / 1000;
    const seen = new Set<string>();
    for (const m of members) {
      const name = String(m.name ?? '').trim();
      const role = String(m.role ?? '').trim();
      if (!name || !role) return { ok: false, error: '每个 member 必须有 name 和 role' };
      if (seen.has(name)) return { ok: false, error: `成员名重复: ${name}` };
      seen.add(name);
      upsertTeamMember({
        team_id: teamId, member_id: name, name, role,
        history: '[]', last_message: null, last_result: null,
        status: 'idle', created_at: now, updated_at: now,
      });
    }
    return { ok: true, team_id: teamId };
  });

  ipcMain.handle('team-delete', (_e, teamId: string) => {
    deleteTeam(teamId);
    return true;
  });

  ipcMain.handle('team-list-members', (_e, teamId: string) => {
    return listTeamMembers(teamId).map(m => ({
      team_id: m.team_id, member_id: m.member_id, name: m.name, role: m.role,
      status: m.status, last_message: m.last_message, last_result: m.last_result,
      created_at: m.created_at, updated_at: m.updated_at,
    }));
  });

  ipcMain.handle('team-send-member', async (_e, teamId: string, memberName: string, message: string) => {
    const convId = convIdFromTeamId(teamId);
    if (!convId) return { ok: false, error: '无法解析 convId' };
    const conv = taskManager.get(convId);
    if (!conv) return { ok: false, error: '会话不存在' };
    const member = loadTeamMember(teamId, memberName);
    if (!member) return { ok: false, error: `member 不存在: ${memberName}` };

    try {
      const { runMember } = await import('./teams');
      const { snapshot } = await import('./settings');
      const { currentProvider } = await import('./glm');
      const snap = snapshot(conv.profileId);
      const provider = currentProvider(snap);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3 * 60 * 1000);
      emitTeamEvent(teamId, { type: 'memberStatus', memberName, status: 'running' });
      const r = await runMember({
        member,
        userMessage: message,
        runOpts: {
          provider, snap, signal: ac.signal,
          cwd: conv.cwd,
          confirm,
          convId: conv.id,
          onTeamEvent: (mn, ev) => emitTeamEvent(teamId, ev),
        },
      });
      clearTimeout(timer);
      upsertTeamMember({
        ...member,
        history: JSON.stringify(r.newHistory),
        last_message: message, last_result: r.answer,
        status: 'done', updated_at: Date.now() / 1000,
      });
      emitTeamEvent(teamId, { type: 'memberDone', memberName, answer: r.answer });
      emitTeamEvent(teamId, { type: 'memberStatus', memberName, status: 'done' });
      return { ok: true, answer: r.answer };
    } catch (e) {
      emitTeamEvent(teamId, { type: 'memberStatus', memberName, status: 'failed' });
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  ipcMain.handle('team-broadcast', async (_e, teamId: string, message: string) => {
    const convId = convIdFromTeamId(teamId);
    if (!convId) return { ok: false, error: '无法解析 convId' };
    const conv = taskManager.get(convId);
    if (!conv) return { ok: false, error: '会话不存在' };
    const members = listTeamMembers(teamId);
    if (members.length === 0) return { ok: false, error: 'team 为空' };

    try {
      const { runMembersParallel } = await import('./teams');
      const { snapshot } = await import('./settings');
      const { currentProvider } = await import('./glm');
      const snap = snapshot(conv.profileId);
      const provider = currentProvider(snap);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3 * 60 * 1000);
      const results = await runMembersParallel({
        members, message,
        runOpts: {
          provider, snap, signal: ac.signal,
          cwd: conv.cwd,
          confirm,
          convId: conv.id,
          onTeamEvent: (mn, ev) => emitTeamEvent(teamId, ev),
        },
      });
      clearTimeout(timer);
      // 持久化
      const answers: Record<string, string> = {};
      for (const m of members) {
        const r = results.get(m.name);
        if (!r) continue;
        upsertTeamMember({
          ...m,
          history: JSON.stringify(r.newHistory),
          last_message: message, last_result: r.answer,
          status: r.error ? 'failed' : 'done', updated_at: Date.now() / 1000,
        });
        answers[m.name] = r.answer;
      }
      return { ok: true, results: answers };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── 企业微信机器人 IPC ──
  ipcMain.handle('wecom-bot-status', () => {
    const b = getWeComBridge();
    return { connected: b.connected, pendingCount: b.pendingCount };
  });
  ipcMain.handle('wecom-bot-connect', async () => {
    return getWeComBridge().start();
  });
  ipcMain.handle('wecom-bot-disconnect', () => {
    return getWeComBridge().stop();
  });

  // ── 飞书机器人 IPC ──
  ipcMain.handle('feishu-bot-status', () => {
    const b = getFeishuBridge();
    return { connected: b.connected, pendingCount: b.pendingCount };
  });
  ipcMain.handle('feishu-bot-connect', async () => {
    return getFeishuBridge().start();
  });
  ipcMain.handle('feishu-bot-disconnect', () => {
    return getFeishuBridge().stop();
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

  // ponytail: 追加前查大小,超 cap 轮转留一代 .old(wecom.log 同款)—— freeze-sample.txt
  // 曾无声涨到 17MB。不引日志库,两处调用够本。
  function appendCapped(file: string, data: string, cap = 5 * 1024 * 1024): void {
    try {
      const fs = require('fs') as typeof import('fs');
      if (fs.existsSync(file) && fs.statSync(file).size > cap) fs.renameSync(file, `${file}.old`);
      fs.appendFileSync(file, data);
    } catch { /* ignore */ }
  }

  app.whenReady().then(() => {
    // ── 内存哨兵:周期采样所有进程内存,增量写 userData/mem-watch.log ──
    // v2: 改用 app.getAppMetrics() 拿全部子进程(GPU/Utility/renderer)真实 RSS,每分钟无条件写。
    // v1 的"行长度变化检测"吞掉了 main 行(数值变但长度几乎不变);且 renderer jsHeap 平稳
    // 不代表没泄漏 —— 原生内存(DOM/纹理/blob)泄漏在 jsHeap 之外,必须看进程级 RSS。
    // v2: use getAppMetrics for real per-process RSS; write unconditionally every tick.
    setInterval(() => {
      try {
        const mu = process.memoryUsage();
        const parts = [`main rss=${(mu.rss / 1048576).toFixed(0)}M jsHeap=${(mu.heapUsed / 1048576).toFixed(0)}M`];
        for (const m of app.getAppMetrics()) {
          if (m.type === 'Browser' || m.memory.workingSetSize === 0) continue;
          const role = m.type === 'Tab' ? 'renderer' : m.type.toLowerCase();
          parts.push(`${role}(${m.pid}) rss=${(m.memory.workingSetSize / 1024).toFixed(0)}M`);
        }
        // ponytail: 60s 采样,足够捕捉渐进泄漏;精确归因再用 DevTools heap snapshot
        appendCapped(require('path').join(app.getPath('userData'), 'mem-watch.log'),
          `${new Date().toISOString()} ${parts.join(' ')}\n`);
      } catch { /* 窗口销毁竞态,忽略 */ }
    }, 60_000);
    // ── 卡死自动取证:renderer 每秒心跳,main 侧监测 ──
    // 「UI 卡死但进程没崩」(pid 不变、crash.log 无记录)时,唯一可靠的诊断是卡死瞬间的
    // renderer 调用栈。事后(重启后)再查什么都晚了。方案:preload 暴露的窗口每秒向 main
    // 发心跳;main 发现停摆超 5s 即用 macOS `sample` 抓 3s 调用栈写入 userData/freeze-sample.txt
    // (Windows 上退化为仅记录事件)。恢复后再卡死可多次取证,每次追加。
    // Freeze watchdog: renderer heartbeats every second; main samples the hung
    // renderer process to capture the exact call stack for post-mortem analysis.
    let lastBeat = Date.now();
    let sampling = false;
    let freezeReported = false;
    // 心跳恢复即复位标记:每次卡死episode都有自己的标题行(旧版只写第一次,后续卡死无标题难定位)。
    ipcMain.on('renderer-heartbeat', () => { lastBeat = Date.now(); freezeReported = false; });
    setInterval(() => {
      const silent = Date.now() - lastBeat;
      if (silent < 5000 || sampling) return;
      if (!freezeReported) {
        freezeReported = true;
        try {
          appendCapped(require('path').join(app.getPath('userData'), 'freeze-sample.txt'),
            `\n===== ${new Date().toISOString()} heartbeat silent ${silent}ms (main pid=${process.pid}) =====\n`, 10 * 1024 * 1024);
        } catch { /* ignore */ }
      }
      if (process.platform !== 'darwin') return;
      sampling = true;
      const { execFile } = require('child_process') as typeof import('child_process');
      const ud = app.getPath('userData');
      const grab = (pid: number, tag: string): void => {
        execFile('/usr/bin/sample', [String(pid), '3', '-file', require('path').join(ud, `${tag}.sample`)], { timeout: 15000 }, (err) => {
          if (!err) {
            try {
              const fs = require('fs');
              const p = require('path').join(ud, `${tag}.sample`);
              const head = fs.readFileSync(p, 'utf8').split('\n').slice(0, 120).join('\n');
              appendCapped(require('path').join(ud, 'freeze-sample.txt'), `--- ${tag} ---\n${head}\n`, 10 * 1024 * 1024);
            } catch { /* ignore */ }
          }
        });
      };
      // 教训(2026-08 卡死排查):心跳停摆的主因是 main 自己忙转(dedupMemories O(n²) 卡 4 分钟),
      // renderer 只是陪绑 —— 所以 main 和 renderer 都采样,main 是重点。
      // / Sample BOTH: past freezes were main-process stalls; the renderer was always idle.
      grab(process.pid, 'main');
      const tab = app.getAppMetrics().find((m) => m.type === 'Tab');
      if (tab) {
        execFile('/usr/bin/sample', [String(tab.pid), '3', '-file', require('path').join(ud, 'renderer.sample')], { timeout: 15000 }, () => {
          sampling = false;
          try {
            const fs = require('fs');
            const p = require('path').join(ud, 'renderer.sample');
            const head = fs.readFileSync(p, 'utf8').split('\n').slice(0, 120).join('\n');
            appendCapped(require('path').join(ud, 'freeze-sample.txt'), `--- renderer ---\n${head}\n`, 10 * 1024 * 1024);
          } catch { /* ignore */ }
        });
      } else {
        setTimeout(() => { sampling = false; }, 4000); // 无窗口时等采样结束再放开
      }
    }, 1000);
    // Windows 默认菜单条(File/Edit/View/Help)丑且无功能 → 全局清空,所有窗口都不显示。
    // devtools 仍可右键 Inspect 打开;reload/fullscreen 在生产 app 里也不需要快捷键。
    // 但清空菜单后 Cmd/Ctrl+Shift+I 快捷键失效 → 手动注册。
    Menu.setApplicationMenu(null);
    // 注册 DevTools 切换快捷键(macOS: Cmd+Option+I, Windows: Ctrl+Shift+I)
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      const win = BrowserWindow.getFocusedWindow();
      if (win) {
        if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
        else win.webContents.openDevTools({ mode: 'detach' });
      }
    });
    // macOS Dock 图标:BrowserWindow({icon}) 在 mac 上对 Dock 无效,需显式设 dock icon。
    // Windows/Linux 上 BrowserWindow icon 已生效,dock 仅 mac 有。
    const dockIcon = appIcon();
    if (dockIcon && process.platform === 'darwin') {
      try { app.dock?.setIcon(dockIcon); } catch { /* 非 mac 或 dock 不可用 */ }
    }
    // mic 权限放行 —— MediaRecorder 需要 media。
    // 信任模型:本应用本地,用户自己点按钮才触发,放行即可。
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => {
      cb(perm === 'media');
    });
    session.defaultSession.setPermissionCheckHandler((_wc, perm) => {
      return perm === 'media';
    });
    // getDisplayMedia(截图)的权限处理器 —— 提供 desktopCapturer 源给 renderer。
    // renderer 调 navigator.mediaDevices.getDisplayMedia 时触发,
    // main 进程弹屏幕选择器(macOS 原生)或直接给第一个屏幕源。
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (!sources.length) { cb({}); return; }
        // 直接给主屏幕(不弹选择器,简单粗暴)
        cb({ video: sources[0] });
      } catch {
        cb({});
      }
    });
    initStore();
    taskManager = new TaskManager(emitter);
    taskManager.load();
    // 把 taskManager 暴露给延迟加载模块(mcp-server 的 export/import session 等)。
    setTaskManager(taskManager);
    // Watch 模式:把 taskManager 注入 watcher(触发时起会话)+ 给所有现存会话的 cwd 起 watcher(若 .kinet-watch.json 存在)。
    setTaskManagerForWatchers(taskManager);
    // 企信机器人:注入 taskManager,settings 里 enabled 则自动连接。
    setTaskManagerForWeCom(taskManager);
    getWeComBridge().onEvent = (ev) => {
      safeSend(dashboardWin, 'wecom-event', ev);
    };
    if (getSettings().wecomBot?.enabled) {
      getWeComBridge().start().catch((e) => console.warn('[wecom] 自启动失败:', e.message));
    }
    // 飞书机器人:注入 taskManager,settings 里 enabled 则自动连接。
    setTaskManagerForFeishu(taskManager);
    getFeishuBridge().onEvent = (ev) => {
      safeSend(dashboardWin, 'feishu-event', ev);
    };
    if (getSettings().feishuBot?.enabled) {
      getFeishuBridge().start().catch((e) => console.warn('[feishu] 自启动失败:', e.message));
    }
    for (const c of taskManager.list()) if (c.cwd) ensureWatcher(c.cwd);
    // 定时任务:从 store 装载 → 启动每分钟 tick 的调度器。dispatcher 起新会话并发 prompt。
    setCronTasks(listCronTasks().map((r) => ({
      id: r.id, cron: r.cron, prompt: r.prompt, cwd: r.cwd ?? undefined, enabled: r.enabled,
      lastRun: r.lastRun ?? undefined, createdAt: r.createdAt,
    })));
    // cron 任务 → 最近一次派发的会话 id(重入门闩用)
    const cronConvByTask = new Map<string, string>();
    setDispatcher((task) => {
      try {
        // 重入门闩:同任务上一轮会话还在跑就跳过本次触发 —— 跑 10 分钟的
        // * * * * * 任务之前每分钟再起一个,滚雪球出 N 个并发实例。
        const prevId = cronConvByTask.get(task.id);
        if (prevId) {
          const prev = taskManager.get(prevId);
          if (prev && prev.status === 'running') {
            console.log(`[cron] 任务 ${task.id} 上一轮仍在运行,跳过本次触发`);
            return;
          }
        }
        const conv = taskManager.newConversation(task.cwd || os.homedir());
        cronConvByTask.set(task.id, conv.id); // 每任务只留最新 conv id,有界
        taskManager.send(conv.id, task.prompt);
        touchCronLastRun(task.id, Date.now());
      } catch (e) {
        console.warn('cron dispatch failed', e);
      }
    });
    startCronScheduler();
    registerIpc();
    // 从 settings 加载远程 MCP server 配置(多机协作),再连所有 server(stdio + remote SSE)。
    mcp.setRemoteServers(getSettings().remoteMcpServers ?? []);
    mcp.connectAll(); // 后台连 MCP server(不阻塞首屏;Direct 引擎首轮会等 ≤2s)
    // 如果 settings 里开启了本机 MCP Server,自动启动。
    {
      const s = getSettings();
      if (s.localMcpServer?.enabled) {
        localMcpServer.setTools(allTools());
        localMcpServer.setToken(s.localMcpServer.token || '');
        localMcpServer.start(s.localMcpServer.port, s.localMcpServer.token || '').catch((e) => {
          console.warn('[mcp-server] 自启动失败:', e.message);
        });
      }
    }
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
    // P1: 先 cancel 所有运行中会话 —— abort 信号触发各引擎的 taskkill/kill,
    // 防 CLI 子进程孤儿化(退出后继续跑、继续计费、继续写文件)。
    try { taskManager.cancelAll(); } catch { /* ignore */ }
    globalShortcut.unregisterAll();
    try { voiceChatRef?.close(); } catch { /* ignore */ } // P0: 关闭 VoiceChat WebSocket,防止连接/定时器残留
    try { getFeishuBridge().stop(); } catch { /* ignore */ } // 断开飞书 WS 长连接
    try { getWeComBridge().stop(); } catch { /* ignore */ } // 断开企信 WS 长连接
    mcp.dispose(); // 关掉所有 MCP 子进程
    void localMcpServer.stop(); // 关掉本机 MCP HTTP server(多机协作)
    stopCronScheduler(); // 停掉 cron 定时器,否则进程延迟退出
    for (const cwd of listWatchers()) stopWatcher(cwd); // 关闭所有文件监听器
    checkpointWal(); // 截断 WAL(cancelAll 已把收尾写入冲刷完)
    tray?.destroy(); // 销毁托盘,否则 macOS 上进程残留、退不干净
  });
}

// MARK: 内置 Prompt 模板
// ponytail: 硬编码 10 个高频场景模板,覆盖代码审查/Bug 修复/文档/测试/重构等。
function builtinTemplates(): PromptTemplate[] {
  return [
    { id: 'tpl-review', name: '代码审查', description: '审查当前文件的代码质量、安全性和最佳实践', engine: 'direct', prompt: '请审查以下代码,关注:\n1. 代码质量与可读性\n2. 潜在 Bug\n3. 安全漏洞\n4. 性能问题\n5. 最佳实践建议\n\n请用中文给出具体、可操作的反馈。', category: '代码质量', icon: '🔍', builtin: true },
    { id: 'tpl-bugfix', name: 'Bug 修复', description: '分析并修复 Bug', engine: 'direct', prompt: '请分析以下 Bug 描述,找到根因并给出修复方案:\n\nBug 描述:\n\n复现步骤:\n\n预期行为:\n\n实际行为:', category: '开发', icon: '🐛', builtin: true },
    { id: 'tpl-doc', name: '文档生成', description: '为代码生成中文文档注释', engine: 'direct', prompt: '请为以下代码生成完整的中英双语文档注释:\n1. 函数/类的功能说明\n2. 参数说明\n3. 返回值说明\n4. 使用示例\n5. 注意事项', category: '文档', icon: '📝', builtin: true },
    { id: 'tpl-test', name: '测试编写', description: '为代码生成单元测试', engine: 'direct', prompt: '请为以下代码编写单元测试:\n1. 覆盖正常路径\n2. 覆盖边界条件\n3. 覆盖异常情况\n4. 每个测试用例都有清晰的名称和断言', category: '测试', icon: '🧪', builtin: true },
    { id: 'tpl-refactor', name: '重构', description: '改善代码结构而不改变行为', engine: 'claudeCode', prompt: '请重构这段代码,目标:\n1. 提高可读性和可维护性\n2. 消除重复\n3. 改善命名\n4. 简化复杂逻辑\n\n约束:不改变外部行为,保持所有测试通过。', category: '代码质量', icon: '🔨', builtin: true },
    { id: 'tpl-explain', name: '代码解释', description: '用中文逐行解释代码', engine: 'direct', prompt: '请逐段解释以下代码的工作原理,用通俗易懂的中文:\n1. 整体功能是什么\n2. 关键逻辑的执行流程\n3. 重要设计决策的原因', category: '学习', icon: '📖', builtin: true },
    { id: 'tpl-optimize', name: '性能优化', description: '分析性能瓶颈并优化', engine: 'direct', prompt: '请分析以下代码的性能瓶颈:\n1. 时间复杂度分析\n2. 空间复杂度分析\n3. 具体优化建议(附改写后的代码)\n4. 预估提升幅度', category: '性能', icon: '⚡', builtin: true },
    { id: 'tpl-security', name: '安全审计', description: '检查代码安全问题', engine: 'direct', prompt: '请对以下代码进行安全审计:\n1. 注入漏洞(SQL/命令/XSS)\n2. 认证与授权问题\n3. 敏感信息泄露\n4. 不安全的依赖\n5. 修复建议', category: '安全', icon: '🛡️', builtin: true },
    { id: 'tpl-migrate', name: '类型迁移', description: 'JavaScript → TypeScript 迁移', engine: 'codex', prompt: '请将以下 JavaScript 代码迁移到 TypeScript:\n1. 添加完整的类型标注\n2. 定义必要的 interface/type\n3. 修复类型错误\n4. 保持运行时行为不变', category: '迁移', icon: '🔄', builtin: true },
    { id: 'tpl-arch', name: '架构分析', description: '分析项目架构并给出改进建议', engine: 'claudeCode', prompt: '请分析当前项目的架构:\n1. 当前架构模式(单体/微服务/分层/...)\n2. 模块依赖关系\n3. 架构优缺点\n4. 可扩展性评估\n5. 改进建议', category: '架构', icon: '🏗️', builtin: true },
  ];
}

// MARK: 可视化规则生成器 — 根据 UI 配置生成 KINET.md 内容
function generateRules(cfg: RuleConfig): string {
  const lines: string[] = [];
  lines.push('# 项目规则 (KINET.md)');
  lines.push('');
  lines.push('## 代码风格');
  if (cfg.codeStyle) lines.push(`- 语言: ${cfg.codeStyle}`);
  if (cfg.namingConvention) lines.push(`- 命名规范: ${cfg.namingConvention}`);
  if (cfg.indent) {
    const indentDesc = cfg.indent === 'tabs' ? 'Tab 缩进' : cfg.indent === '2spaces' ? '2 空格缩进' : '4 空格缩进';
    lines.push(`- ${indentDesc}`);
  }
  if (cfg.commentStyle) {
    const commentDesc = { bilingual: '中英双语注释', chinese: '中文注释', english: '英文注释', none: '尽量少加注释' }[cfg.commentStyle as string] || cfg.commentStyle;
    lines.push(`- 注释风格: ${commentDesc}`);
  }
  lines.push('');
  if (cfg.bannedApis) {
    lines.push('## 禁止使用');
    for (const api of String(cfg.bannedApis).split(',').map((s) => s.trim()).filter(Boolean)) {
      lines.push(`- 禁止使用 \`${api}\``);
    }
    lines.push('');
  }
  lines.push('## 通用规则');
  lines.push('- 改完代码必须自查(typecheck / build)');
  lines.push('- 每次修改完提交 git');
  lines.push('- 不破坏已有测试');
  if (cfg.extraRules) {
    lines.push('');
    lines.push('## 额外规则');
    for (const rule of String(cfg.extraRules).split('\n').filter(Boolean)) {
      lines.push(`- ${rule}`);
    }
  }
  return lines.join('\n') + '\n';
}

// MARK: 会话导出 — Markdown
function exportMarkdown(conv: Conversation): string {
  const lines: string[] = [];
  lines.push(`# ${conv.customTitle || conv.turns[0]?.prompt?.slice(0, 50) || 'Session'}`);
  lines.push('');
  lines.push(`> Engine: ${conv.engine} | Model: ${conv.model} | Created: ${new Date(conv.createdAt).toLocaleString()}`);
  lines.push(`> Cost: $${conv.cost.toFixed(4)} | Tokens: ${conv.tokens}`);
  if (conv.branchInfo) lines.push(`> Branched from: ${conv.branchInfo.sourceConvId} (turn ${conv.branchInfo.sourceTurnIdx})`);
  lines.push('');
  for (const t of conv.turns) {
    lines.push('---');
    lines.push('');
    lines.push(`## 🧑 ${t.prompt}`);
    lines.push('');
    if (t.steps.length) {
      for (const s of t.steps) {
        lines.push(`<details><summary>🔧 ${s.name}</summary>`);
        lines.push('');
        lines.push('```');
        lines.push(`args: ${s.args}`);
        lines.push(`result: ${s.result}`);
        lines.push('```');
        lines.push('</details>');
        lines.push('');
      }
    }
    lines.push(`### 🤖 ${t.error ? '❌ ' + t.error : ''}`);
    lines.push('');
    lines.push(t.answer || '_(empty)_');
    lines.push('');
    if (t.costUSD > 0) lines.push(`<sub>💰 $${t.costUSD.toFixed(4)} · 📊 ${t.tokensIn + t.tokensOut} tokens</sub>`);
    lines.push('');
  }
  return lines.join('\n');
}

// MARK: 会话导出 — 自包含 HTML(可离线打开)
function exportHTML(conv: Conversation, productName: string): string {
  const title = conv.customTitle || conv.turns[0]?.prompt?.slice(0, 50) || 'Session';
  const turnsHtml = conv.turns.map((t) => {
    const steps = t.steps.map((s) =>
      `<details><summary>🔧 ${esc4(s.name)}</summary><pre><code>args: ${esc4(s.args)}\n\nresult: ${esc4(s.result)}</code></pre></details>`
    ).join('');
    return `<div class="turn">
      <div class="user">🧑 ${esc4(t.prompt)}</div>
      ${steps}
      <div class="assistant">${esc4(t.answer || (t.error ? '❌ ' + t.error : ''))}</div>
      ${t.costUSD > 0 ? `<sub>💰 $${t.costUSD.toFixed(4)} · 📊 ${t.tokensIn + t.tokensOut} tokens</sub>` : ''}
    </div>`;
  }).join('');
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc4(title)} — ${esc4(productName)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:820px;margin:0 auto;padding:20px;background:#1a1a2e;color:#e0e0e0}
  .header{border-bottom:1px solid #333;padding-bottom:12px;margin-bottom:20px}
  .header h1{margin:0 0 4px;font-size:1.4em;color:#e8b339}
  .meta{color:#888;font-size:.85em}
  .turn{margin:16px 0;padding:14px;border:1px solid #333;border-radius:8px}
  .user{color:#e8b339;font-weight:600;margin-bottom:8px}
  .assistant{white-space:pre-wrap;margin-top:8px;line-height:1.6}
  details{margin:4px 0;color:#aaa}
  pre{background:#111;padding:8px;border-radius:4px;overflow-x:auto;font-size:.85em}
  sub{color:#666}
</style>
</head>
<body>
<div class="header">
  <h1>${esc4(title)}</h1>
  <div class="meta">Engine: ${conv.engine} | Model: ${conv.model} | ${new Date(conv.createdAt).toLocaleString()} | Cost: $${conv.cost.toFixed(4)}</div>
</div>
${turnsHtml}
</body>
</html>`;
}

function esc4(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// MARK: Arena Diff — 逐行 diff(Myers 简化版:LCS DP)
function computeLineDiff(leftText: string, rightText: string): string {
  const a = leftText.split('\n');
  const b = rightText.split('\n');
  const n = a.length;
  const m = b.length;
  // DP 表求 LCS
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // 回溯生成 unified diff
  const lines: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) { lines.push(`- ${a[i++]}`); }
  while (j < m) { lines.push(`+ ${b[j++]}`); }
  return lines.join('\n');
}
