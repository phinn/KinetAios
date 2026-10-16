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
    deps.safeSend(deps.dashboardWin(), 'remote-agent-event', ev);
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
    const win = (__dw => __dw && !__dw.isDestroyed() ? __dw : undefined)(deps.dashboardWin());
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
      if (deps.isBlockedSystemPath(abs)) return { ok: false, error: '安全限制:不允许读取系统目录' };
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
      if (deps.isBlockedSystemPath(abs)) return { ok: false, error: '安全限制:不允许写入系统目录' };
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
    const resolve = deps.pendingConfirms.get(id);
    if (resolve) {
      resolve(approved);
      deps.pendingConfirms.delete(id);
    }
  });

  // P2: 撤销 Computer Use 会话级授权(设置页/状态条入口;传 convId 撤单会话,不传撤全部)。
  ipcMain.handle('revoke-cu-approval', (_e, convId?: string) => {
    const { revokeComputerUseApproval } = require('../tools') as typeof import('../tools');
    return revokeComputerUseApproval(convId);
  });

  // ── 隐私闸独立确认桥(不复用 shell confirm 通道)──
  // 独立事件名(pgp-request/privacy-confirm-response)+ 独立 pending 表:
  // 不受「本会话不再询问」和 approval=never/fullAccess 短路影响 —— 用户显式开闸,
  // 每次外发命中都必须人点头。5 分钟无响应 auto-deny(goal 无人值守不挂死)。
  ipcMain.on('privacy-confirm-response', (_e, { id, approved }: { id: string; approved: boolean }) => {
    const resolve = deps.pendingPrivacyConfirms.get(id);
    if (resolve) {
      clearTimeout(resolve.timer);
      resolve.fn(approved);
      deps.pendingPrivacyConfirms.delete(id);
    }
  });

  ipcMain.handle('quick-submit', async (_e, text: string) => {
    const conv = deps.taskManager().newConversation(os.homedir());
    try {
      await deps.taskManager().send(conv.id, text);
    } catch (e) {
      console.error('[quick-submit] send failed:', e);
    }
    return conv.id;
  });
  ipcMain.handle('open-dashboard', () => {
    deps.toggleMetricsWindow();
    return true;
  });
  ipcMain.handle('open-files', (_e, cwd?: string) => {
    deps.toggleFilesWindow(cwd && cwd.trim() ? cwd.trim() : undefined);
    return true;
  });
  ipcMain.handle('open-arena', (_e, cwd?: string) => {
    deps.toggleArenaWindow(cwd && cwd.trim() ? cwd.trim() : undefined);
    return true;
  });
  ipcMain.handle('list-dir', (_e, absPath: string) => deps.listDirAbs(absPath));
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
  ipcMain.handle('git-snapshot', (_e, cwd: string) => deps.gitSnapshotAsync(cwd));
  ipcMain.handle('git-diff', (_e, cwd: string, opts: { file?: string; hash?: string; staged?: boolean }) =>
    deps.gitDiffAsync(cwd, opts),
  );
  ipcMain.handle('git-action', (_e, cwd: string, action: GitActionKind, opts?: { message?: string; file?: string; branch?: string }) =>
    deps.gitActionAsync(cwd, action, opts),
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
        const { embed } = await import('../glm');
        const { snapshot, embedSnapshot } = await import('../settings');
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
      deps.taskManager().rebuildEngines(); // v3: 插件引擎表可能变化 — rebuild engine registry.
      return { ok: true, count: items.length };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  // v2: 安装(复制目录) + 卸载(删除目录)。
  ipcMain.handle('plugin-install', (_e, sourcePath: string) => {
    try {
      const r = installPlugin(sourcePath);
      deps.taskManager().rebuildEngines(); // v3: 新插件可能贡献引擎 — rebuild engine registry.
      return r;
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  ipcMain.handle('plugin-uninstall', (_e, name: string) => {
    try {
      const r = uninstallPlugin(name);
      deps.taskManager().rebuildEngines(); // v3: 卸载的插件引擎立即失效 — rebuild engine registry.
      return r;
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  // v2: 启用/禁用插件(不删除,只是从工具/prompt/命令注入中排除)。
  ipcMain.handle('plugin-toggle', (_e, name: string, enabled: boolean) => {
    try {
      const r = togglePlugin(name, enabled);
      deps.taskManager().rebuildEngines(); // v3: 禁/启可能增删插件引擎 — rebuild engine registry.
      return r;
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });
  // v3.1: 保存插件引擎设置(占位符值) — 保存后热重建引擎(bin/args 插值立即生效)。
  ipcMain.handle('plugin-engine-settings-save', (_e, name: string, values: Record<string, string>) => {
    try {
      const r = savePluginEngineSettings(name, values ?? {});
      if (r.ok) deps.taskManager().rebuildEngines();
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
    try {
      deleteTeam(teamId);
      return true;
    } catch (e) {
      console.error('[team-delete] failed:', e);
      return false;
    }
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
    const conv = deps.taskManager().get(convId);
    if (!conv) return { ok: false, error: '会话不存在' };
    const member = loadTeamMember(teamId, memberName);
    if (!member) return { ok: false, error: `member 不存在: ${memberName}` };

    try {
      const { runMember } = await import('../teams');
      const { snapshot } = await import('../settings');
      const { currentProvider } = await import('../glm');
      const snap = snapshot(conv.profileId);
      const provider = currentProvider(snap);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3 * 60 * 1000);
      emitTeamEvent(teamId, { type: 'memberStatus', memberName, status: 'running' });
      try {
        const r = await runMember({
          member,
          userMessage: message,
          runOpts: {
            provider, snap, signal: ac.signal,
            cwd: conv.cwd,
            confirm: deps.confirm,
            convId: conv.id,
            onTeamEvent: (mn, ev) => emitTeamEvent(teamId, ev),
          },
        });
        upsertTeamMember({
          ...member,
          history: JSON.stringify(r.newHistory),
          last_message: message, last_result: r.answer,
          status: 'done', updated_at: Date.now() / 1000,
        });
        emitTeamEvent(teamId, { type: 'memberDone', memberName, answer: r.answer });
        emitTeamEvent(teamId, { type: 'memberStatus', memberName, status: 'done' });
        return { ok: true, answer: r.answer };
      } finally {
        // finally 清 timer:失败路径此前不清理,timer 句柄多驻留 3 分钟。
        clearTimeout(timer);
      }
    } catch (e) {
      emitTeamEvent(teamId, { type: 'memberStatus', memberName, status: 'failed' });
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  });

  ipcMain.handle('team-broadcast', async (_e, teamId: string, message: string) => {
    const convId = convIdFromTeamId(teamId);
    if (!convId) return { ok: false, error: '无法解析 convId' };
    const conv = deps.taskManager().get(convId);
    if (!conv) return { ok: false, error: '会话不存在' };
    const members = listTeamMembers(teamId);
    if (members.length === 0) return { ok: false, error: 'team 为空' };

    try {
      const { runMembersParallel } = await import('../teams');
      const { snapshot } = await import('../settings');
      const { currentProvider } = await import('../glm');
      const snap = snapshot(conv.profileId);
      const provider = currentProvider(snap);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3 * 60 * 1000);
      try {
        const results = await runMembersParallel({
          members, message,
          runOpts: {
            provider, snap, signal: ac.signal,
            cwd: conv.cwd,
            confirm: deps.confirm,
            convId: conv.id,
            onTeamEvent: (mn, ev) => emitTeamEvent(teamId, ev),
          },
        });
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
      } finally {
        clearTimeout(timer); // 失败路径同样清理(同 team-send-member)
      }
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
