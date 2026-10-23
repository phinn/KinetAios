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
  // directHistory MB 级,不随列表下发;上下文检查器按需走 get-conversation-context。
  ipcMain.handle('get-conversations', () => deps.taskManager().list().map((c) => {
    // 与 emitConversation 同族瘦身:hydrate 过的会话 turns 可达 MB 级,
    // 每次拉列表全量 structured clone 过 IPC 是 2026-08 卡死事故的漏网同类。
    if (c.turnsLoaded === false) return { ...c, directHistory: [] };
    // 与 emitConversation 同口径:traj 计入估重(快照配额放宽后单 turn 可达 256K)。
    let weight = 0;
    for (const t of c.turns) {
      weight += (t.prompt?.length ?? 0) + (t.answer?.length ?? 0);
      if (t.steps) for (const s of t.steps) {
        weight += (s.args?.length ?? 0) + (s.result?.length ?? 0) + 64;
      }
      if (t.traj) for (const r of t.traj) weight += r.text.length + 48;
    }
    if (weight > deps.IPC_TURNS_CHAR_LIMIT) {
      const last = c.turns[c.turns.length - 1];
      return { ...c, directHistory: [], turns: last ? [last] : [], turnsLoaded: false as const };
    }
    return { ...c, directHistory: [] };
  }));

  // 懒加载:renderer 切频道时按需拉 turns(head 模式启动不载全文)
  // Lazy: renderer fetches turns on conversation switch.
  ipcMain.handle('get-turns', (_e, convId: string) => {
    const conv = deps.taskManager().hydrate(convId);
    return conv ? conv.turns : [];
  });
  ipcMain.handle('new-conversation', (_e, cwd?: string, engine?: EngineKind) => {
    const conv = deps.taskManager().newConversation(cwd || os.homedir(), engine);
    // 新会话:自动检测该 cwd 的 .kinet-watch.json,有就起 watcher。
    if (conv.cwd) ensureWatcher(conv.cwd);
    return conv;
  });
  // 从某条 turn 处分叉出新会话(复制该 turn 及之前的历史)
  ipcMain.handle('fork-conversation', (_e, sourceId: string, uptoTurnId: string) => {    const conv = deps.taskManager().forkConversation(sourceId, uptoTurnId);
    if (conv?.cwd) ensureWatcher(conv.cwd);
    return conv;
  });
  // 清目标硬通道:绕过 sendCore(旧实现是发 '/goal' 聊天消息,loop 全速跑时 IPC 延迟数秒,
  // 用户观感=点了没反应 2026-10-21)。任何状态立即清 goal + cancel,零 turn 落库。
  ipcMain.handle('clear-goal', (_e, id: string) => { deps.taskManager().clearGoal(id); });
  ipcMain.handle('send', async (_e, id: string, text: string) => {
    // await + 异常包装:send 同步段(如 SQLite 写失败)抛出时 renderer 此前毫无感知,只进 unhandledRejection。
    // sendDetached:turn 入列即返回 —— 阻塞版要等 engine.run 整轮结束,renderer 的
    // composer 清空排在 await 之后,消息会一直挂在输入框里直到 AI 答完。
    // Fire-and-forget: the composer clear in the renderer sits behind this await;
    // blocking until the whole turn finishes would leave text stuck in the box.
    try {
      await deps.taskManager().sendDetached(id, text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('cancel', (_e, id: string) => {
    deps.drainConfirms();
    return deps.taskManager().cancel(id);
  });
  // 用户打断(Steer):不取消运行中的 turn,把文本注入引擎下一轮上下文。
  // 返回 false = 会话没在跑 / 非 Direct 系引擎(无注入通道)。
  ipcMain.handle('interrupt', (_e, id: string, text: string) => deps.taskManager().interrupt(id, String(text ?? '')));
  ipcMain.handle('delete-conversation', (_e, id: string) => {
    deps.drainConfirms();
    jobManager().purgeConv(id); // 级联:kill 未完成 job + 删 job 行
    return deps.taskManager().deleteConversation(id);
  });
  // ── Pipeline 跨引擎编排 ──
  ipcMain.handle('pipeline-run', async (_e, p: { name: string; stages: Array<{ engine: EngineKind; prompt: string; label?: string }>; cwd: string }) => {
    try {
      const id = await deps.taskManager().runPipeline(p.stages, p.cwd, p.name);
      return { ok: true, convId: id };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('pipeline-templates', () => {
    const { loadPipelines } = require('../store');
    return loadPipelines().map((r: { id: string; name: string; data: string; cwd: string; createdAt: number }) => ({ id: r.id, name: r.name, stages: JSON.parse(r.data), cwd: r.cwd, createdAt: r.createdAt }));
  });
  ipcMain.handle('pipeline-save', (_e, p: Pipeline) => {
    const { savePipeline } = require('../store');
    savePipeline({ id: p.id, name: p.name, data: JSON.stringify(p.stages), cwd: p.cwd });
    return { ok: true };
  });
  ipcMain.handle('pipeline-delete', (_e, id: string) => {
    const { deletePipeline } = require('../store');
    deletePipeline(id);
    return { ok: true };
  });

  // ── Prompt 模板 ──
  ipcMain.handle('template-list', () => {
    const { loadTemplates } = require('../store');
    const builtin = deps.builtinTemplates();
    const custom = loadTemplates().map((r: { id: string; name: string; data: string }) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
    return [...builtin, ...custom];
  });
  ipcMain.handle('template-save', (_e, t: PromptTemplate) => {
    const { saveTemplate } = require('../store');
    saveTemplate({ id: t.id, name: t.name, data: JSON.stringify(t) });
    return { ok: true };
  });
  ipcMain.handle('template-delete', (_e, id: string) => {
    const { deleteTemplate } = require('../store');
    deleteTemplate(id);
    return { ok: true };
  });

  // ── 可视化规则生成 ──
  ipcMain.handle('rules-generate', (_e, cfg: RuleConfig) => {
    return { ok: true, content: deps.generateRules(cfg) };
  });

}
