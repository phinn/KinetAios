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
  // ── Pin/Unpin Turn:锁定的 turn 不被 compact 压缩 ──
  ipcMain.handle('pin-turn', (_e, convId: string, turnId: string, pinned: boolean) => {
    return { ok: deps.taskManager().pinTurn(convId, turnId, pinned) };
  });

  // ── 上下文检查器:查看 / 编辑 Direct 引擎的 directHistory ──
  ipcMain.handle('get-direct-history', (_e, convId: string) => {
    return deps.taskManager().getDirectHistory(convId);
  });
  ipcMain.handle('save-direct-history', (_e, convId: string, history: ChatMsg[]) => {
    return deps.taskManager().saveDirectHistory(convId, history);
  });

  // ── 替身画像(Persona)──
  ipcMain.handle('generate-persona', async () => {
    return deps.taskManager().generatePersona();
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

}
