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
      const r = updateMemoryBlock(label, value);
      // r.droppedTail > 0 时 UI 可提示截断(当前 renderer 只消费 ok)。
      return { ok: r.ok, droppedTail: r.droppedTail, stored: r.stored };
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
      const result = await deps.taskManager().runIdleReflection();
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  // ── 跨会话引用 + Agent 任务图 ──
  ipcMain.handle('task-graph', () => {
    try {
      return loadTaskGraph();
    } catch (e) {
      console.error('[task-graph] failed:', e);
      return { nodes: [], edges: [], error: (e as Error)?.message ?? String(e) };
    }
  });

  ipcMain.handle('search-conversations', (_e, query: string) => {
    const q = (query ?? '').toLowerCase().trim();
    const all = deps.taskManager().list();
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
    try {
      return searchEnriched(query, 50);
    } catch (e) {
      console.error('[search-history] failed:', e);
      return [];
    }
  });

  // ── 上下文考古:读取会话的事件流(conv_events,append-only 事实源)──
  ipcMain.handle('conv-events', (_e, convId: string, afterSeq = 0) => {
    try {
      return loadEvents(convId, afterSeq);
    } catch (e) {
      console.error('[conv-events] failed:', e);
      return [];
    }
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

  // ── 删除记忆三元组 ──
  ipcMain.handle('delete-memory-triple', (_e, tripleId: string) => {
    deleteMemoryTriple(tripleId);
    return { ok: true };
  });

  // ── 记忆图谱独立窗口 ──
  ipcMain.handle('open-memory-graph', () => {
    deps.showMemoryGraph();
    return true;
  });

  // ── 实时协作直播:获取当前远程 Agent 事件流(前端轮询或 SSE 获取)──
  // 返回最近 N 条远程事件 + 当前活跃远程任务状态。
  ipcMain.handle('remote-agent-status', () => {
    return localMcpServer.getLiveStatus();
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

  // ── memory-sync Git 仓库同步(2026-10-22)──
  const { memorySyncRun, memorySyncTest } = require('../memory-sync') as typeof import('../memory-sync');
  ipcMain.handle('memory-sync-run', async (_e, cfg?: import('../../shared/types').MemorySyncSettings) => {
    try {
      // 兜底:调用方没传(旧 renderer / 自动 tick 之外的路径)→ 回落读已保存设置,
      // 防「设置了仓库地址仍报未配置」(2026-10-23 报障根因之一)。
      let c = cfg;
      if (!c?.remote?.trim()) {
        const saved = getSettings().memorySync;
        if (saved?.remote?.trim()) c = { ...saved, ...c, remote: saved.remote };
      }
      if (!c?.remote?.trim()) return { ok: false, error: '未配置仓库地址', exported: 0, imported: 0, commits: 0, pushed: false, steps: [] };
      return await memorySyncRun(c);
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e), exported: 0, imported: 0, commits: 0, pushed: false, steps: [] };
    }
  });
  ipcMain.handle('memory-sync-test', async (_e, cfg?: import('../../shared/types').MemorySyncSettings) => {
    try {
      if (!cfg?.remote?.trim()) return { ok: false, error: '未配置仓库地址' };
      return await memorySyncTest(cfg);
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
}
