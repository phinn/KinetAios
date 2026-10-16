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
      const script = deps.buildCollectScript(x1, y1, x2, y2);
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
  deps.setVoiceChatRef(voiceChat);
  // VoiceChat 事件 → 转发到 renderer
  voiceChat.onEvent((ev) => {
    // Buffer → base64(IPC 不能直接传 Buffer)
    const payload: VoiceChatEventPayload = ev.type === 'aiAudio'
      ? { type: 'aiAudio', data: (ev as any).data.toString('base64') }
      : ev as any;
    // 防御:renderer 已销毁时不发送(app 退出 / 窗口关闭后的在途回调)
    if ((__dw => __dw && !__dw.isDestroyed() && !__dw.webContents.isDestroyed())(deps.dashboardWin())) {
      (deps.dashboardWin() as BrowserWindow).webContents.send('voice-chat-event', payload);
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
      const activeConv = deps.taskManager().hydrate(convId) || null; // 语音上下文读最近 3 轮,懒加载
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
        const conv = deps.taskManager().get(convId);
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
          await deps.taskManager().send(conv.id, text);
          // send 是阻塞调用 — 返回时引擎已完成(或出错)。直接读最终 turn 状态。
          // send blocks until engine completes — read final turn state directly, no polling needed.
          const c = deps.taskManager().get(conv.id);
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

}
