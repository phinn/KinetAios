import { app as __app } from 'electron';
import __path from 'node:path';
import { getBrand } from '../brand'; // ⚠️ 必须在这组 import 里:编译成 CJS 后 require 按声明顺序排放,
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, session, shell, Tray, webContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { initStore, loadMemories, allMemoryContents, addMemory, updateMemory, deleteMemory, loadMemoryTriples, tripleProvenance, addMemoryTriple, deleteMemoryTriple, loadTaskGraph, saveConversation, saveTurn, searchEnriched, arenaAggregate, usageAggregate, setMemoryEmbedding, loadEvents, rulesMatching } from '../store';
import { saveCustomTool, loadCustomTools, deleteCustomTool, loadMemoryTimeline, decayMemories, dedupMemories, loadMemoryBlocks, updateMemoryBlock, loadEpisodicMemories, checkpointWal } from '../store';
import { saveFact, loadFact, listFacts, deleteFact, factsAsBlock } from '../store';
import { listTeamsForConv, convIdFromTeamId, listTeamMembers, loadTeamMember, upsertTeamMember, deleteTeam } from '../store';
import { listSnapshots, restoreSnapshot } from '../snapshots';
import { registerUpdateIpc } from '../updater';
import { pluginListSnap, invalidatePluginCache, installPlugin, uninstallPlugin, togglePlugin, pluginPanelsSnap, savePluginEngineSettings } from '../plugins';
import { setCronTasks, setDispatcher, startCronScheduler, stopCronScheduler, validateCron } from '../cron';
import { listCronTasks, addCronTask, updateCronTask, deleteCronTask, touchCronLastRun } from '../store';
import { setTaskManagerForWatchers, ensureWatcher, listWatchers, startWatcher, stopWatcher } from '../watcher';
import { setTaskManager } from '../main-instance';
import { initJobManager, jobManager } from '../JobManager';
import { setTeamEventEmitter } from '../team-events';
import { getSettings, saveSettings, snapshot, balanceSnapshot } from '../settings';
import { setPrivacyConfirm } from '../privacy-gate';
import { t, type Lang } from '../../shared/i18n';
import { currentProvider } from '../glm';
import { listSkills, readSkillSource, saveSkillSource } from '../skills';
import { mcp } from '../mcp';
import { localMcpServer } from '../mcp-server';
import { allTools } from '../tools';
import { killAgentChrome } from '../cdp';
import { binEnv } from '../engines';
import { TaskManager, type TaskManagerEmitter } from '../TaskManager';
import { withSelfHidden } from '../computer-use';
import { VoiceChat } from '../VoiceChat';
import { getWeComBridge, setTaskManagerForWeCom } from '../wecom';
import { getFeishuBridge, setTaskManagerForFeishu } from '../feishu';
import type { AgentEvent, AppSettings, BudgetAlert, ConfigSnapshot, Conversation, ContextMode, CustomTool, EngineKind, GitActionKind, GitActionResult, GitChange, GitCommit, GitDiffResult, GitSnapshot, Pipeline, PromptTemplate, RuleConfig, Turn, ChatMsg, VoiceChatEventPayload } from '../../shared/types';
import { emitTeamEvent } from '../team-events';
import { deps } from './ctx';

export function register(): void {
  // ── 后台 Job IPC ──
  ipcMain.handle('job-list', (_e, convId?: string) => jobManager().list(convId));
  ipcMain.handle('job-get', (_e, id: string) => jobManager().get(String(id)));
  ipcMain.handle('job-kill', (_e, id: string, reason?: string) => {
    jobManager().kill(String(id), reason ? String(reason) : undefined);
    return true;
  });
  ipcMain.handle('job-resume', (_e, id: string) => jobManager().resume(String(id)));
  ipcMain.handle('job-dispatch', (_e, opts: { convId: string; engine: 'claudeCode' | 'codex'; prompt: string; cwd: string; timeoutMs?: number }) =>
    jobManager().submitDispatch(opts));
  ipcMain.handle('clear-conversation', (_e, id: string) => deps.taskManager().clearConversation(id));
  ipcMain.handle('rename', (_e, id: string, title: string) => deps.taskManager().rename(id, title));
  ipcMain.handle('set-pinned', (_e, id: string, pinned: boolean) => deps.taskManager().setPinned(id, !!pinned));
  ipcMain.handle('set-cwd', (_e, id: string, cwd: string) => deps.taskManager().setCwd(id, cwd));
  ipcMain.handle('set-engine', (_e, id: string, engine: EngineKind) => {
    deps.taskManager().setEngine(id, engine);
    return true;
  });
  ipcMain.handle('set-model', (_e, id: string, model: string) => {
    deps.taskManager().setModel(id, model);
    return true;
  });
  ipcMain.handle('set-sub-model', (_e, id: string, model: string) => {
    deps.taskManager().setSubModel(id, model);
    return true;
  });
  // 切换会话的模型配置档 —— 写入 conv.profileId,DirectEngine 运行时读取。
  ipcMain.handle('set-conv-profile', (_e, id: string, profileId: string | null) => {
    deps.taskManager().setConvProfile(id, profileId);
    return true;
  });
  // 上下文模式切换 —— standard / hifi,以后可扩展更多模式。
  ipcMain.handle('set-context-mode', (_e, id: string, mode: string) => {
    deps.taskManager().setContextMode(id, mode as ContextMode);
    return true;
  });
  // 会话级替身画像开关。
  ipcMain.handle('set-persona-enabled', (_e, id: string, enabled: boolean) => {
    deps.taskManager().setPersonaEnabled(id, enabled);
    return true;
  });
  // 会话级 Ralph 自迭代开关(true = DirectV5 走 Ralph 循环拓扑)。
  ipcMain.handle('set-loop-ralph', (_e, id: string, enabled: boolean) => {
    deps.taskManager().setLoopRalph(id, enabled);
    return true;
  });
  // 会话级跨项目记忆开关(false = recall/注入只看本会话)。
  ipcMain.handle('set-cross-project-memory', (_e, id: string, enabled: boolean) => {
    deps.taskManager().setCrossProjectMemory(id, enabled);
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
    s.goalFailover5hEnabled = Boolean(s.goalFailover5hEnabled);
    s.goalFailover5hPct = Math.min(100, Math.max(50, Math.floor(norm(s.goalFailover5hPct, 100))));
    saveSettings(s);
    deps.rebuildTrayMenu(); // 语言切换后托盘菜单跟随
    // 记忆同步:配置变更 → 重置自动同步节流(新周期立即生效)
    void import('../memory-sync').then((m) => m.restartMemorySyncAuto());
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
    deps.set_appIcon(undefined);          // 清缓存,让 appIcon() 重新加载
    deps.set_appIconKey(null);
    saveSettings({ ...s, appIcon: iconKey });
    const img = deps.appIcon();
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
    if ((__tr => __tr && !__tr.isDestroyed())(deps.tray())) {
      try {
        const ti = deps.makeTrayIcon();
        (deps.tray() as Tray).setImage(ti);
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
  // 技能面板:读全文/保存。save 走 writeFileSync(技能文件小,无需 tmp+rename;
  // 保存后 cache=null 强制重扫,slash 菜单与注入内容立即生效)。
  ipcMain.handle('read-skill-source', (_e, name: string) => readSkillSource(String(name ?? '')));
  ipcMain.handle('save-skill-source', (_e, name: string, content: string) => saveSkillSource(String(name ?? ''), String(content ?? '')));
  ipcMain.handle('get-brand', () => getBrand());

  // ── 会话分支 ──
  ipcMain.handle('branch-from-turn', (_e, convId: string, turnIdx: number) => {
    const conv = deps.taskManager().branchFrom(convId, turnIdx);
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
    try {
      const { costStats } = require('../store');
      return costStats();
    } catch (e) {
      console.error('[cost-stats] failed:', e);
      return { total: 0, rows: [], error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── 会话导出 ──
  ipcMain.handle('export-conversation', async (_e, convId: string, format: string) => {
    try {
      const conv = deps.taskManager().hydrate(convId); // 导出需要全部 turns,懒加载
      if (!conv) return { ok: false, error: t(getSettings().lang, 'common.convNotFound') };
      const brand = getBrand();
      let content = '';
      let ext = '';
      if (format === 'json') {
        content = JSON.stringify(conv, null, 2);
        ext = 'json';
      } else if (format === 'html') {
        content = deps.exportHTML(conv, brand.productName);
        ext = 'html';
      } else {
        content = deps.exportMarkdown(conv);
        ext = 'md';
      }
      const win = (__dw => __dw && !__dw.isDestroyed() ? __dw : undefined)(deps.dashboardWin());
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
      const left = deps.taskManager().hydrate(leftConvId); // diff 读 lastTurn.answer,懒加载
      const right = deps.taskManager().hydrate(rightConvId);
      if (!left || !right) return { ok: false, error: t(getSettings().lang, 'common.convNotFound') };
      const leftText = left.turns[left.turns.length - 1]?.answer ?? '';
      const rightText = right.turns[right.turns.length - 1]?.answer ?? '';
      const diff = deps.computeLineDiff(leftText, rightText);
      return { ok: true, diff, leftEngine: left.engine, rightEngine: right.engine };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── 上下文压缩可视化:估算会话 token 使用量 ──
  ipcMain.handle('est-context-tokens', (_e, convId: string) => {
    return deps.taskManager().estContextTokens(convId);
  });

  // ── Arena 深度统计:按引擎聚合 token/成本/耗时/工具调用数 ──
  ipcMain.handle('arena-stats', () => {
    return arenaAggregate();
  });

  // ── 用量看板:KPI/环比/热力图/模型/引擎/会话 聚合(对齐 Juejin Usage)──
  ipcMain.handle('usage-stats', (_e, rangeDays: number) => {
    return usageAggregate(Number(rangeDays) || 7);
  });

  // ── 会话交接:导出会话状态 ──
  ipcMain.handle('export-session-state', (_e, convId: string) => {
    try {
      const conv = deps.taskManager().hydrate(convId); // 交接导出含全部 turns,懒加载
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
      const conv = deps.taskManager().newConversation(c.cwd || os.homedir(), c.engine || 'direct');
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

}
