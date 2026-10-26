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
import { initStore, loadMemories, allMemoryContents, addMemory, updateMemory, deleteMemory, loadMemoryTriples, tripleProvenance, addMemoryTriple, deleteMemoryTriple, loadTaskGraph, saveConversation, saveTurn, searchEnriched, arenaAggregate, usageAggregate, setMemoryEmbedding, loadEvents, rulesMatching, memoryStoreApi } from './store';
import { startMemorySyncAuto } from './memory-sync';
import { saveCustomTool, loadCustomTools, deleteCustomTool, loadMemoryTimeline, decayMemories, dedupMemories, loadMemoryBlocks, updateMemoryBlock, loadEpisodicMemories, checkpointWal } from './store';
import { saveFact, loadFact, listFacts, deleteFact, factsAsBlock } from './store';
import { listTeamsForConv, convIdFromTeamId, listTeamMembers, loadTeamMember, upsertTeamMember, deleteTeam } from './store';
import { listSnapshots, restoreSnapshot } from './snapshots';
import { registerUpdateIpc } from './updater';
import { pluginListSnap, invalidatePluginCache, installPlugin, uninstallPlugin, togglePlugin, pluginPanelsSnap, savePluginEngineSettings } from './plugins';
import { setCronTasks, setDispatcher, startCronScheduler, stopCronScheduler, validateCron } from './cron';
import { listCronTasks, addCronTask, updateCronTask, deleteCronTask, touchCronLastRun, setCronConvId } from './store';
import { setTaskManagerForWatchers, ensureWatcher, listWatchers, startWatcher, stopWatcher } from './watcher';
import { setTaskManager } from './main-instance';
import { initJobManager, jobManager } from './JobManager';
import { setTeamEventEmitter } from './team-events';
import { getSettings, saveSettings, snapshot, balanceSnapshot } from './settings';
import { setPrivacyConfirm } from './privacy-gate';
import { t, type Lang } from '../shared/i18n';
import { currentProvider } from './glm';
import { listSkills, readSkillSource, saveSkillSource } from './skills';
import { mcp } from './mcp';
import { localMcpServer } from './mcp-server';
import { webCompanionServer } from './web-companion';
import { allTools } from './tools';
import { killAgentChrome } from './cdp';
import { binEnv } from './engines';
import { TaskManager, type TaskManagerEmitter } from './TaskManager';
import { withSelfHidden } from './computer-use';
import { VoiceChat } from './VoiceChat';
import { getWeComBridge, setTaskManagerForWeCom } from './wecom';
import { getFeishuBridge, setTaskManagerForFeishu } from './feishu';
import type { AgentEvent, AppSettings, BudgetAlert, ConfigSnapshot, Conversation, ContextMode, CustomTool, EngineKind, GitActionKind, GitActionResult, GitChange, GitCommit, GitDiffResult, GitSnapshot, Pipeline, PromptTemplate, RuleConfig, Turn, ChatMsg, VoiceChatEventPayload } from '../shared/types';

const execFileAsync = promisify(execFile);

// 兜底:未捕获异常/拒绝都记到 crash.log + stderr,避免 app 静默退出无从排查。
// ⚠️ EPIPE 风暴修复(2026-09-14,crash.log 曾涨到 24.8GB):
// stderr 管道破裂(从终端启动后终端关闭)时 console.error 同步抛 EPIPE → 触发
// uncaughtException → 又进 logFatal → 再 console.error → 无限递归,每秒数千次写盘。
// 防线:①EPIPE 直接吞掉不记(它本身就是 logFatal 造成的二次异常,记它无意义);
// ②限流:同类消息 60s 内只落盘一次;③console.error 包 try(stdin 坏了就别硬写)。
let lastFatalLog = { key: '', at: 0 };
function logFatal(kind: string, e: unknown): void {
  const msg = e instanceof Error && e.message === 'write EPIPE'
    ? '' // EPIPE = stderr 已断,再写必然再抛 → 静默,只落盘
    : `[${new Date().toISOString()}] ${kind}: ${(e as Error)?.stack ?? e}\n`;
  const now = Date.now();
  const key = kind + ':' + ((e as Error)?.message ?? String(e)).slice(0, 80);
  if (msg && !(key === lastFatalLog.key && now - lastFatalLog.at < 60_000)) {
    lastFatalLog = { key, at: now };
    try { console.error(msg); } catch { /* stderr 坏了,忽略 */ }
  }
  if (!msg) return; // EPIPE:连落盘都跳过 —— 否则风暴只是从 stderr 挪到文件
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
// 隐私闸独立 pending 表:值带 timer(超时 auto-deny 用)+ resolver。
const pendingPrivacyConfirms = new Map<string, { fn: (approved: boolean) => void; timer: NodeJS.Timeout }>();
let privacySeq = 0;
let confirmSeq = 0;

// confirm 超时(5 分钟):防止 dashboard 窗口关闭/刷新后 confirm Promise 永久挂起,
// 导致 Direct 引擎的 AgentLoop 卡在 await ctx.confirm() 上 —— 既泄漏 Promise 又锁住会话。
const CONFIRM_TIMEOUT_MS = 300_000;

// ── 只读命令白名单:整条命令全部命中只读前缀才自动放行 ──
// 分析/探索任务要跑大量只读命令(ls/grep/git status…),逐条弹窗会把人变成 agent
// 循环的瓶颈。白名单只认"确定无副作用"的命令;写操作、重定向、命令替换、任何
// 不在白名单的成员仍然照常弹窗 —— 不改变写安全边界。
const READONLY_CMD_RE =
  /^(ls|dir|type|more|cat|head|tail|wc|grep|rg|findstr|file|stat|du|df|which|where|echo|pwd|cd|jq|git (status|log|diff|show|branch|blame|shortlog|describe|ls-files)|pip (list|show)|node --version|python --version|python -V|--version)\b/i;

function isReadOnlyCommand(cmd: string): boolean {
  const s = cmd.trim();
  if (!s) return false;
  // 重定向(写文件)、命令替换(可藏任意命令)→ 一律不算只读
  if (/[<>`]|\$\(/.test(s)) return false;
  // 按 shell 逻辑分隔符拆开,要求每一段都命中白名单(防 "ls && del x" 绕过)
  const parts = s.split(/&&|\|\||&|\||;|\n/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => READONLY_CMD_RE.test(p));
}

// ── 隐私闸 confirm 实现(main.ts 注入 privacy-gate,避免循环 import)──
// 独立弹窗通道:privacy-request 事件 + privacy-confirm-response 回执,不走 shell confirm 的
// 「不再询问」/approval 短路。5 分钟无响应 auto-deny。窗不在 → 直接 deny(内容不出网,安全侧)。
function privacyConfirm(msg: string): Promise<boolean> {
  const win = dashboardWin;
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  const id = `pg${process.pid}_${privacySeq++}`;
  win.webContents.send('privacy-request', { id, msg });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingPrivacyConfirms.has(id)) {
        pendingPrivacyConfirms.delete(id);
        resolve(false);
      }
    }, CONFIRM_TIMEOUT_MS);
    pendingPrivacyConfirms.set(id, {
      fn: (approved) => resolve(approved),
      timer,
    });
  });
}

function confirm(cmd: string): Promise<boolean> {
  const s = getSettings();
  // 自动放行:approval=never 或 sandbox=fullAccess(完全访问 = 信任一切操作,与 CLI 引擎 bypassPermissions 对齐)。
  // / Auto-approve: approval=never OR sandbox=fullAccess (matches CLI engines' bypassPermissions).
  if (s.approval === 'never' || s.sandbox === 'fullAccess') return Promise.resolve(true);
  // 只读白名单:即使 approval=always 也放行(工具事件里仍会显示完整命令,只是不弹窗)。
  if (isReadOnlyCommand(cmd)) return Promise.resolve(true);
  const id = `c${process.pid}_${confirmSeq++}`;
  const win = dashboardWin;
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  // ── 动作时刻规则闸(2026-09 纠错闭环 ③)──
  // 命令文本匹配规则触发词 → 把铁律塞进弹窗正文。注入≠遵守的最后一道机械防线:
  // 模型在生成命令时可能没核对铁律,人肉确认时必须看到。
  const hitRules = rulesMatching(cmd);
  const rulesNote = hitRules.length
    ? hitRules.map((r) => `⚠️ 铁律: ${r.content}${r.strikes > 0 ? `(犯过 ${r.strikes} 次)` : ''}`).join('\n')
    : null;
  win.webContents.send('confirm-request', { id, cmd, rulesNote });
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
  // 隐私闸 pending 表同池 drain:dashboard 刷新/导航后 privacy-confirm-response 永远不会回来,
  // 只 drain confirm 链会让等隐私闸的 agent 挂满 5 分钟 auto-deny 才解脱。
  for (const resolve of pendingPrivacyConfirms.values()) {
    clearTimeout(resolve.timer);
    resolve.fn(false);
  }
  pendingPrivacyConfirms.clear();
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

// ── 运行态广播合并器的状态(见 emitConversation 注释)──
const convBroadcastPending = new Map<string, Conversation>();
let convBroadcastTimer: NodeJS.Timeout | null = null;

/** 原样发送一个 conversation 广播(瘦身逻辑不变),合并器与立即路径共用。 */
function sendConversationNow(conv: Conversation): void {
  // turnCount 归一化:turnCount 只在启动加载时由 SQL 聚合写入,运行期 push 新 turn
  // 从不更新 → 广播里 turnCount 恒为旧值,renderer 侧按 turnCount 判断"有新 turn"
  // 的合并逻辑永远不触发(用户消息不上屏)。turns 在内存时以真实长度为准,单一出口覆盖
  // send/goal/failTurn/delete 所有路径。
  if (conv.turnsLoaded !== false) conv.turnCount = conv.turns.length;
  // directHistory(Direct 会话完整 LLM 消息,MB 级)永不进广播 —— 2026-08 卡死事故的
  // 同族载荷,turns 修了它漏了。上下文检查器走 get-conversation-context 按需拉;
  // renderer 只在引擎切换确认处读 .length,[] 语义足够。
  let payload: Conversation = { ...conv, directHistory: [] };
  if (conv.turnsLoaded !== false) {
    // 估重不打日志、不 stringify —— 只遍历字符串 length,O(n) 且零拷贝。
    // traj 计入权重:快照分级配额后单 turn 可达 256K 字符,漏计会让 600K
    // 降级闸门失灵(2026-08 卡死事故同族载荷,直发 history 时已修过一次)。
    let weight = 0;
    for (const t of conv.turns) {
      weight += (t.prompt?.length ?? 0) + (t.answer?.length ?? 0);
      if (t.steps) for (const s of t.steps) {
        weight += (s.args?.length ?? 0) + (s.result?.length ?? 0) + 64;
      }
      if (t.traj) for (const r of t.traj) weight += r.text.length + 48;
    }
    if (weight > IPC_TURNS_CHAR_LIMIT) {
      const last = conv.turns[conv.turns.length - 1];
      payload = { ...payload, turns: last ? [last] : [], turnsLoaded: false };
    }
  }
  safeSend(dashboardWin, 'conversation', payload);
  safeSend(quickWin, 'conversation', payload);
  safeSend(arenaWin, 'conversation', payload);
}

const emitter: TaskManagerEmitter = {
  emitEvent(convId, ev: AgentEvent) {
    safeSend(dashboardWin, 'agent-event', { convId, ev });
    safeSend(quickWin, 'agent-event', { convId, ev });
    safeSend(arenaWin, 'agent-event', { convId, ev });
  },
  // Broadcast slimming: see IPC_TURNS_CHAR_LIMIT above.
  // ── 运行态广播合并(2026-10-21 界面卡死事故)──
  // goal 循环一轮内 statusNote/turn 变更连发多次 emitConversation,每次都是
  // MB 级 structured clone × 3 窗口;renderer 侧每个广播都触发 侧栏刷新 + rAF
  // 增量渲染。多循环并发时渲染层被重建任务塞满,点击/聚焦落在"按下与抬起之间
  // 节点被换掉"的目标上 → 界面卡死、输入框光标进不去(AX 树实测元素数在
  // 983↔255 间翻转)。节流阀:status==='running' 的广播按 conv 合并,200ms
  // 尾沿只发最新快照;终态/空闲(ready)立即发 —— 用户可见的状态切换不延迟,
  // 循环轮边界的 ready 也不受影响(轮频低,本就不是洪峰)。
  // / Coalesce running-state broadcasts per conv (200ms trailing edge).
  // Terminal/idle (ready) states flush immediately. The 2026-10-21 wedge was
  // caused by render-side churn at event frequency, not round frequency.
  emitConversation(conv: Conversation) {
    if (conv.status !== 'running') {
      // 终态立即发,并撤销该 conv 的待发合并快照(本条已是最新)。
      convBroadcastPending.delete(conv.id);
      sendConversationNow(conv);
      return;
    }
    // 存引用不拷贝:flush 时读到的就是最新字段(turns 数组是同一引用)。
    // 会话中途被删也无害:renderer 的 removedConvs 守卫会拒收迟到广播。
    convBroadcastPending.set(conv.id, conv);
    if (!convBroadcastTimer) {
      convBroadcastTimer = setTimeout(() => {
        convBroadcastTimer = null;
        const pending = [...convBroadcastPending.values()];
        convBroadcastPending.clear();
        for (const c of pending) sendConversationNow(c);
      }, 200);
    }
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
    // 容量治理:顺带清理过期项(>10 分钟未活动)防长期运行 Map 只增不减。
    // O(n) 但 n=活跃会话数,量级极小;只在写入路径触发,无额外 timer。
    if (notifyLastAt.size > 64) {
      for (const [k, v] of notifyLastAt) {
        if (now - v > 600_000) notifyLastAt.delete(k);
      }
    }
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
import { emitTeamEvent } from './team-events';
import { deps } from './ipc/ctx';
import { register as registerIpcModules } from './ipc/register';
export { emitTeamEvent };

// ── P1 加固: 窗口导航防护(window-open / 跳转拦截面)──
// 此前主窗口无 setWindowOpenHandler / will-navigate 防护:webview 内 target=_blank 或
// 页面自动跳转会开新 Electron 窗口 / 整窗导航到任意 URL(钓鱼面)。
// 策略:window.open 一律拦截,http(s) 转交系统默认浏览器,其余静默丢弃;
// will-navigate 只允许本应用 file:// 页面(自身 loadFile 的导航),http(s) 同样转交系统浏览器。
// P1 hardening: window.open is denied (http(s) handed to the OS browser), top-level
// navigation is restricted to the app's own file:// pages.
function hardenWindowNav(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        void shell.openExternal(u.href); // 外链走系统浏览器,不在应用内开 Electron 窗口
      }
    } catch { /* 非法 URL → 静默拒绝 */ }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'file:') return; // 本应用页面(index/quick/dashboard/memory-graph)放行
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        e.preventDefault();
        void shell.openExternal(u.href); // 整窗跳转外链 → 转系统浏览器
        return;
      }
      e.preventDefault();
    } catch {
      e.preventDefault();
    }
  });
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
  hardenWindowNav(win); // P1: window.open/导航拦截(外链转系统浏览器)
  // 关窗置空:closeBehavior=minimize/tray 时 dashboard 关了但 app 不退,
  // 悬挂的 destroyed 引用会被 second-instance 等路径直接调 isMinimized() 抛 "Object has been destroyed"。
  win.on('closed', () => { dashboardWin = null; });

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
  // renderer console 黑匣子(2026-10-21):init 阶段的 TypeError 在渲染进程里被吞,
  // 主进程侧只见"按钮无反应"零痕迹 —— console-message 落盘后,重启实例即可查
  // renderer 报错原文+行号,不用再盲猜。Renderer console persisted for post-mortem.
  win.webContents.on('console-message', (_e, _level, message, line, sourceId) => {
    if (!message.includes('Uncaught') && !message.includes('Error') && !message.includes('error')) return;
    try {
      const fs = require('fs') as typeof import('fs');
      const f = require('path').join(app.getPath('userData'), 'renderer-console.log');
      if (fs.existsSync(f) && fs.statSync(f).size > 5 * 1024 * 1024) fs.renameSync(f, `${f}.old`);
      fs.appendFileSync(f, `[${new Date().toISOString()}] ${message} @${sourceId}:${line}\n`);
    } catch { /* ignore */ }
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
        // 异步执行:此前 execFileSync 在主进程跑 15s,把 renderer 的卡死放大成 main 也冻住。
        const pid = win.webContents.getOSProcessId();
        if (pid) {
          execFile('/usr/bin/sample', [String(pid), '3', '-mayDie', '-file', outFile], { timeout: 15000 }, () => { /* best-effort */ });
        }
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
  hardenWindowNav(win); // P1: window.open/导航拦截(外链转系统浏览器)
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
  hardenWindowNav(win); // P1: window.open/导航拦截(外链转系统浏览器)
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
  hardenWindowNav(win); // P1: window.open/导航拦截(外链转系统浏览器)
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
  hardenWindowNav(win); // P1: window.open/导航拦截(外链转系统浏览器)
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
  hardenWindowNav(win); // P1: window.open/导航拦截(外链转系统浏览器)
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


// ── IPC 依赖注入(registerIpc 已拆分至 src/main/ipc/*;此处是唯一注入点)──
function createIpcDeps(): void {
  deps.isBlockedSystemPath = isBlockedSystemPath;
  deps.dashboardWin = () => dashboardWin;
  deps.taskManager = () => taskManager;
  deps.tray = () => tray;
  deps.voiceChatRef = () => voiceChatRef;
  deps.setVoiceChatRef = (v: VoiceChat | null) => { voiceChatRef = v; };
  deps.pendingConfirms = pendingConfirms;
  deps.pendingPrivacyConfirms = pendingPrivacyConfirms;
  deps.confirm = confirm;
  deps.drainConfirms = drainConfirms;
  deps.safeSend = safeSend;
  deps.IPC_TURNS_CHAR_LIMIT = IPC_TURNS_CHAR_LIMIT;
  deps._appIcon = () => _appIcon;
  deps.set_appIcon = (v: ReturnType<typeof nativeImage.createFromPath> | undefined) => { _appIcon = v; };
  deps._appIconKey = () => _appIconKey;
  deps.set_appIconKey = (v: string | null) => { _appIconKey = v; };
  deps.appIcon = appIcon;
  deps.toggleMetricsWindow = toggleMetricsWindow;
  deps.toggleFilesWindow = toggleFilesWindow;
  deps.toggleArenaWindow = toggleArenaWindow;
  deps.listDirAbs = listDirAbs;
  deps.gitSnapshotAsync = gitSnapshotAsync;
  deps.gitDiffAsync = gitDiffAsync;
  deps.gitActionAsync = gitActionAsync;
  deps.makeTrayIcon = makeTrayIcon;
  deps.showMemoryGraph = showMemoryGraph;
  deps.rebuildTrayMenu = rebuildTrayMenu;
  deps.buildCollectScript = buildCollectScript;
  deps.builtinTemplates = builtinTemplates;
  deps.generateRules = generateRules;
  deps.exportMarkdown = exportMarkdown;
  deps.exportHTML = exportHTML;
  deps.computeLineDiff = computeLineDiff;
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
    // ── 隐私闸 confirm 桥注入(dashboardWin 就绪后;函数内每请求重取窗,重建窗不失效)──
    setPrivacyConfirm(privacyConfirm);
    // ── 版本更新检查:IPC + 启动静默检查(发现新版本推 'update-available')──
    registerUpdateIpc(() => dashboardWin);
    // ── 内存哨兵:周期采样所有进程内存,增量写 userData/mem-watch.log ──
    // v2: 改用 app.getAppMetrics() 拿全部子进程(GPU/Utility/renderer)真实 RSS,每分钟无条件写。
    // v1 的"行长度变化检测"吞掉了 main 行(数值变但长度几乎不变);且 renderer jsHeap 平稳
    // 不代表没泄漏 —— 原生内存(DOM/纹理/blob)泄漏在 jsHeap 之外,必须看进程级 RSS。
    // v2: use getAppMetrics for real per-process RSS; write unconditionally every tick.
    // v3 内存熔断:renderer rss 连续两跳 > 1.5GB → 主动 reload,宁可白屏重启也别让
    // Blink cppgc 走 Fatal(2026-09-13 09:35 renderer 2.5GB → SIGTRAP 崩溃的教训)。
    // v3 Memory circuit breaker: same renderer pid above 1.5GB for two consecutive
    // ticks → proactive reload before Chromium's cppgc OOM abort kills the frame.
    let hotRendererPid = 0;
    let hotRendererStreak = 0;
    setInterval(() => {
      try {
        const mu = process.memoryUsage();
        const parts = [`main rss=${(mu.rss / 1048576).toFixed(0)}M jsHeap=${(mu.heapUsed / 1048576).toFixed(0)}M`];
        for (const m of app.getAppMetrics()) {
          if (m.type === 'Browser' || m.memory.workingSetSize === 0) continue;
          const role = m.type === 'Tab' ? 'renderer' : m.type.toLowerCase();
          parts.push(`${role}(${m.pid}) rss=${(m.memory.workingSetSize / 1024).toFixed(0)}M`);
          if (role === 'renderer') {
            const rssMB = m.memory.workingSetSize / 1024;
            if (rssMB > 1536) {
              if (m.pid === hotRendererPid) hotRendererStreak++;
              else { hotRendererPid = m.pid; hotRendererStreak = 1; }
              if (hotRendererStreak >= 2) {
                hotRendererStreak = 0;
                hotRendererPid = 0;
                logFatal('renderer-mem-guard', `pid=${m.pid} rss=${rssMB.toFixed(0)}M ≥2 ticks — proactive reload`);
                const w = dashboardWin;
                // 只熔断主窗口自己的 renderer;其他窗口(仪表盘等)不在守卫范围。
                if (w && !w.isDestroyed() && w.webContents.getOSProcessId() === m.pid) {
                  try { w.webContents.reload(); } catch { /* torn down mid-reload */ }
                }
              }
            } else if (m.pid === hotRendererPid) {
              hotRendererPid = 0;
              hotRendererStreak = 0;
            }
          }
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
      // 窗口隐藏/最小化/被完全遮挡时,Chromium 会节流 renderer 的定时器(1s 心跳
      // 退化成分钟级)——停摆是节流不是卡死,取证只会抓到空闲栈污染日志(2026-10-22
      // 深夜 23:08/23:24 两次"冻结"即此误报)。跳过检测并刷新 lastBeat,避免回
      // 前台瞬间用积压的静默误触发。
      // / Hidden/minimized/occluded windows get their timers throttled — silence
      // is throttling, not a freeze. Skip and reset so refocusing can't misfire.
      const w = dashboardWin;
      if (!w || w.isDestroyed() || !w.isVisible() || w.isMinimized()) {
        lastBeat = Date.now();
        return;
      }
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
    // 记忆 Git 同步:挂自动 tick(每分钟查,autoSyncMinutes>0 且配置了 remote 才跑)
    startMemorySyncAuto(
      () => getSettings().memorySync,
      app.getPath('userData'),
      memoryStoreApi(),
    );
    taskManager = new TaskManager(emitter);
    taskManager.load();
    // 后台 Job:hydrate 遗留 running/queued → failed(M3 断点续跑后改 paused)。
    // Job 事件桥接进会话事件流(agent-event 频道),renderer 无需新订阅路径。
    setTeamEventEmitter((teamId, ev) => {
      safeSend(dashboardWin, 'team-event', { teamId, ev });
    });
    initJobManager({
      emitJob: (info) => {
        safeSend(dashboardWin, 'job-update', info);
      },
      emitJobEvent: (convId, turnId, jobId, ev) => {
        // v4: job 事件双通道 — ①独立 job-event(Job 面板);②折叠进 agent-event,后台 Legis/V3-deep
        // 的 status/todo 在会话流里实时可见(修前渲染端 onJobEvent 空实现,job 运行但 UI 零状态)。
        // 注意:turn 状态机安全 — job 事件不碰 done/error 终态(执行器内部已用 terminalGate 拦内层 done),
        // applyEvent 对 status/todo 只写 statusNote/todos,不触发 sidebar 终态逻辑。
        safeSend(dashboardWin, 'job-event', { convId, jobId, ev });
        if (convId) {
          if (ev.type === 'status' || ev.type === 'todo' || ev.type === 'context') {
            // 与 260 行同款双窗口语义:dashboard 实时,quick/arena 不推(job 是 dashboard 概念)。
            safeSend(dashboardWin, 'agent-event', { convId, ev });
          }
          // 后台 token 不进主流(避免与回贴 turn 重复),Job 面板已有速率展示。
        }
      },
    });
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
    // 定时任务:从 store 装载 → 启动每分钟 tick 的调度器。
    setCronTasks(listCronTasks().map((r) => ({
      id: r.id, cron: r.cron, prompt: r.prompt, cwd: r.cwd ?? undefined, enabled: r.enabled,
      lastRun: r.lastRun ?? undefined, createdAt: r.createdAt,
    })));
    // dispatcher:同一定时任务固定复用一个频道(cron_tasks.conv_id 持久化),不再每次触发
    // 都 newConversation 把侧栏撑爆。会话被用户删了 → 自动重建并回写;cwd 改了 → 换新频道。
    // 重入门闩:绑定的会话还在 running 就跳过本次触发 —— 跑 10 分钟的 * * * * * 任务
    // 不会每分钟叠一个并发实例。
    // 每次触发前清空上下文(turns/directHistory/engineSessionId 落库重置):cron 轮次彼此
    // 独立,不复用上轮对话,避免 token 随触发次数滚雪球。turns 留在库里没必要 —— UI 侧
    // 该频道每次触发都是一轮干净的问答,历史意义有限;要留痕看 cron 日志即可。
    // Dispatcher: one cron task = one persistent channel (cron_tasks.conv_id). Recreate
    // only if the user deleted it; rebind if cwd changed; skip while still running.
    // Clear context before every fire (turns/directHistory/engineSessionId, persisted) —
    // cron runs are independent; never replay last run's tokens.
    setDispatcher((task) => {
      try {
        const row = listCronTasks().find((r) => r.id === task.id);
        const wantCwd = task.cwd || os.homedir();
        let convId = row?.convId ?? null;
        if (convId) {
          const prev = taskManager.get(convId);
          if (!prev) {
            convId = null; // 用户删了频道 → 下面的分支重建
            setCronConvId(task.id, null);
          } else if (prev.status === 'running') {
            console.log(`[cron] 任务 ${task.id} 上一轮仍在运行,跳过本次触发`);
            return;
          } else if (prev.cwd !== wantCwd) {
            convId = null; // cwd 变更 → 换新频道(旧频道保留,不删用户数据)
          } else {
            taskManager.clearConversation(convId); // 每轮独立上下文,不烧上轮 token
          }
        }
        if (!convId) {
          convId = taskManager.newConversation(wantCwd).id;
          setCronConvId(task.id, convId);
        }
        taskManager.send(convId, task.prompt);
        touchCronLastRun(task.id, Date.now());
      } catch (e) {
        console.warn('cron dispatch failed', e);
      }
    });
    startCronScheduler();
    createIpcDeps();
    registerIpcModules();
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
      // 手机伴侣:settings 开启 + token 非空才自启(token 空则跳过,等用户在设置里生成)。
      if (s.webRemote?.enabled && s.webRemote?.token) {
        webCompanionServer.start(s.webRemote.port, s.webRemote.token).catch((e) => {
          console.warn('[web-companion] 自启动失败:', e.message);
        });
      }
    }
    dashboardWin = createDashboard();
    tray = createTray();
    // KINET_METRICS=1 启动即开用量看板(e2e/截图验证用,平时无感)。
    if (process.env.KINET_METRICS === '1') toggleMetricsWindow();

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
    killAgentChrome(); // 关掉 agent 专属 Chrome(browser_* 工具的子进程,防孤儿 Chrome)
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
