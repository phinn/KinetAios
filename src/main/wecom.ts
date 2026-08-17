// 企业微信智能机器人 WebSocket 长连接桥接模块 / WeCom AI Bot WebSocket bridge.
//
// 接收企业微信消息 → 路由到 TaskManager(Direct 引擎)处理 → 回复到企信。
// Uses @wecom/aibot-node-sdk WSClient for the long-connection protocol.
import { WSClient, WSAuthFailureError, WSReconnectExhaustedError } from '@wecom/aibot-node-sdk';
import type { WsFrame, TextMessage, VoiceMessage, WsFrameHeaders } from '@wecom/aibot-node-sdk';
import os from 'node:os';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import type { TaskManager } from './TaskManager';
import type { Conversation } from '../shared/types';
import { getSettings } from './settings';
import * as store from './store';
import { loadSkillBody, listSkills } from './skills';

type WeComStatusEv = { type: string; data?: unknown };

class WeComBridge {
  private ws: WSClient | null = null;
  private taskManager: TaskManager | null = null;
  private _connected = false;
  /** wecomKey → convId 映射(内存缓存,启动时从 SQLite 重建)。 */
  // / wecomKey → convId mapping (in-memory cache, rebuilt from SQLite on start).
  private wecomSessions = new Map<string, string>();
  /** wecomKey → 最近一条可回复 frame(被动回复通道有时效,仅工具回发文件用)。 */
  // / wecomKey → latest replyable frame (passive reply channel; used by file send).
  private lastFrames = new Map<string, WsFrameHeaders>();
  /** 最近活跃会话的 wecomKey(最后收到消息的那个),工具回发文件用。 */
  // / wecomKey of the most recent chat (last message received); used by file send.
  private activeWecomKey: string | null = null;
  /** per-userKey 串行队列,保证同一用户的消息按顺序处理。 */
  // / Per-userKey serial queue: messages from the same user are processed in order.
  private userQueues = new Map<string, Promise<void>>();
  private static readonly MAX_SESSIONS_PER_USER = 5;

  setTaskManager(tm: TaskManager): void {
    this.taskManager = tm;
    // 启动时从 SQLite 恢复 wecomSessions 映射 / Rebuild wecomSessions from SQLite.
    this.rebuildSessionIndex();
  }

  /** 从 TaskManager 的所有会话中,重建 wecomKey → convId 映射。 */
  // / Rebuild wecomKey → convId map from all conversations in TaskManager.
  private rebuildSessionIndex(): void {
    if (!this.taskManager) return;
    const convs = this.taskManager.list();
    for (let i = convs.length - 1; i >= 0; i--) {
      const c = convs[i];
      if (c.wecomKey && !this.wecomSessions.has(c.wecomKey)) {
        this.wecomSessions.set(c.wecomKey, c.id);
      }
    }
    console.log(`[wecom] 会话索引已恢复: ${this.wecomSessions.size} 条映射`);
  }

  /** 查找 wecomKey 对应的会话:先查内存 Map,miss 时查 SQLite fallback。 */
  // / Find conv by wecomKey: memory Map first, SQLite fallback on miss.
  private findConvByWecomKey(key: string): Conversation | undefined {
    const cachedId = this.wecomSessions.get(key);
    if (cachedId) {
      const conv = this.taskManager?.get(cachedId);
      if (conv) return conv;
    }
    if (!this.taskManager) return undefined;
    const convs = this.taskManager.list();
    for (let i = convs.length - 1; i >= 0; i--) {
      if (convs[i].wecomKey === key) {
        this.wecomSessions.set(key, convs[i].id);
        return convs[i];
      }
    }
    return undefined;
  }

  /** 列出指定 wecomKey 的所有历史会话(按最近活动排序)。 */
  // / List all conversations for a wecomKey, sorted by recent activity.
  private listUserConversations(key: string): Conversation[] {
    if (!this.taskManager) return [];
    return this.taskManager.list()
      .filter(c => c.wecomKey === key)
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }

  /** 获取或创建会话(含淘汰逻辑)。 */
  // / Get-or-create conversation (with eviction).
  private getOrCreateConv(key: string, cwd: string, engine?: string): Conversation {
    let conv = this.findConvByWecomKey(key);
    if (conv) return conv;

    const userConvs = this.listUserConversations(key);
    while (userConvs.length >= WeComBridge.MAX_SESSIONS_PER_USER) {
      const oldest = userConvs.pop()!;
      try {
        this.taskManager?.deleteConversation(oldest.id);
        console.log(`[wecom] 淘汰旧会话: ${oldest.id} (${key})`);
      } catch { /* ignore */ }
    }

    conv = this.taskManager!.newConversation(cwd, engine as any);
    conv.wecomKey = key;
    // 频道级模型覆盖 / Channel-level model overrides.
    const cfg = getSettings().wecomBot;
    if (cfg.model) conv.model = cfg.model;
    conv.subAgentModel = cfg.subAgentModel || null;
    store.saveConversation(conv); // 持久化 wecomKey,重启后可恢复 / Persist wecomKey for restart recovery
    this.wecomSessions.set(key, conv.id);
    return conv;
  }

  /** per-userKey 串行队列:保证同一用户的消息按顺序处理。 */
  // / Per-userKey serial queue: ensures ordered message processing.
  private enqueue(userKey: string, task: () => Promise<void>): void {
    const prev = this.userQueues.get(userKey) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.userQueues.set(userKey, next);
    next.finally(() => {
      if (this.userQueues.get(userKey) === next) {
        this.userQueues.delete(userKey);
      }
    });
  }

  /** 淘汰超额会话(仅保留最近 MAX_SESSIONS_PER_USER 条)。 */
  // / Evict excess conversations.
  private evictIfNeeded(wecomKey: string): void {
    const convs = this.listUserConversations(wecomKey);
    if (convs.length <= WeComBridge.MAX_SESSIONS_PER_USER) return;
    for (let i = WeComBridge.MAX_SESSIONS_PER_USER; i < convs.length; i++) {
      try {
        this.taskManager?.deleteConversation(convs[i].id);
        console.log(`[wecom] 淘汰旧会话: ${convs[i].id} (${wecomKey})`);
      } catch { /* ignore */ }
    }
  }

  get connected(): boolean { return this._connected; }
  get pendingCount(): number { return 0; } // 当前无流式 pending 追踪(非流式 send 完即回复)

  // ── 启动连接 / Start connection ──
  async start(): Promise<{ ok: boolean; error?: string }> {
    const cfg = getSettings().wecomBot;
    if (!cfg.enabled) return { ok: false, error: 'wecomBot.enabled = false' };
    if (!cfg.botId || !cfg.secret) return { ok: false, error: 'botId 或 secret 为空' };
    if (!this.taskManager) return { ok: false, error: 'TaskManager 未初始化' };

    // 已连接 → 先断开 / Already connected → disconnect first
    if (this.ws) this.stop();

    try {
      this.ws = new WSClient({
        botId: cfg.botId,
        secret: cfg.secret,
        maxReconnectAttempts: -1,    // 无限重连 / infinite reconnect
        maxAuthFailureAttempts: 5,
        heartbeatInterval: 30_000,
        reconnectInterval: 2_000,
      });
      this.setupHandlers();
      this.ws.connect();
      return { ok: true };
    } catch (e: any) {
      this.broadcast({ type: 'error', data: { message: e.message } });
      return { ok: false, error: e.message };
    }
  }

  // ── 断开 / Disconnect ──
  stop(): { ok: boolean } {
    if (this.ws) {
      try { this.ws.disconnect(); } catch { /* ignore */ }
      this.ws = null;
    }
    this._connected = false;
    this.broadcast({ type: 'disconnected' });
    return { ok: true };
  }

  // ── 事件绑定 / Wire WSClient events ──
  private setupHandlers(): void {
    if (!this.ws) return;
    const ws = this.ws;

    // 文本消息 / Text message
    ws.on('message.text', (data: WsFrame<TextMessage>) => {
      this.handleIncoming(data).catch((e) => console.error('[wecom] handleIncoming:', e));
    });

    // 语音消息(SDK 已转文本)/ Voice message (SDK provides transcribed text)
    ws.on('message.voice', (data: WsFrame<VoiceMessage>) => {
      const voiceBody = data.body;
      if (voiceBody?.voice?.content) {
        // 语音转文本 → 当文本消息处理
        const asText: WsFrame<TextMessage> = {
          ...data,
          body: {
            ...voiceBody,
            msgtype: 'text' as any,
            text: { content: voiceBody.voice.content },
          } as any,
        };
        this.handleIncoming(asText).catch((e) => console.error('[wecom] voice:', e));
      }
    });

    // 连接建立(认证前)/ Connected (pre-auth)
    ws.on('connected', () => {
      this.broadcast({ type: 'connecting' });
    });

    // 认证成功 / Authenticated
    ws.on('authenticated', () => {
      this._connected = true;
      this.broadcast({ type: 'connected' });
      console.log('[wecom] WebSocket 已连接并认证');
    });

    // 断开 / Disconnected
    ws.on('disconnected', (reason: string) => {
      this._connected = false;
      this.broadcast({ type: 'disconnected', data: { reason } });
    });

    // 重连中 / Reconnecting
    ws.on('reconnecting', (attempt: number) => {
      this._connected = false;
      this.broadcast({ type: 'reconnecting', data: { attempt } });
    });

    // 错误 / Error
    ws.on('error', (err: Error) => {
      if (err instanceof WSAuthFailureError) {
        this.broadcast({ type: 'error', data: { message: '认证失败:botId/secret 可能错误' } });
      } else if (err instanceof WSReconnectExhaustedError) {
        this.broadcast({ type: 'error', data: { message: '重连次数用尽' } });
      } else {
        this.broadcast({ type: 'error', data: { message: err.message } });
      }
      console.error('[wecom] error:', err.message);
    });
  }

  // ── 斜杠指令处理 / Slash command handling ──
  // / Users send /new, /reset, /list, /switch, /context, /skills in WeCom to manage sessions.
  // / Returns true if handled (reply sent); false if the message should flow to the agent (skill invocation).
  private async handleSlashCommand(
    text: string, wecomKey: string, frame: WsFrameHeaders, streamId: string,
  ): Promise<boolean> {
    const parts = text.toLowerCase().trim().split(/\s+/);
    const command = parts[0];

    switch (command) {
      case '/new': {
        const cfg = getSettings().wecomBot;
        const cwd = cfg.defaultCwd || os.homedir();
        const conv = this.taskManager!.newConversation(cwd, cfg.engine);
        conv.wecomKey = wecomKey;
        if (cfg.model) conv.model = cfg.model;
        conv.subAgentModel = cfg.subAgentModel || null;
        store.saveConversation(conv); // 持久化 wecomKey / Persist wecomKey
        this.wecomSessions.set(wecomKey, conv.id);
        this.evictIfNeeded(wecomKey);
        await this.replyFinal(frame, streamId, '✅ 已开启新对话');
        return true;
      }
      case '/reset': {
        const conv = this.findConvByWecomKey(wecomKey);
        if (conv) {
          this.taskManager!.clearConversation(conv.id);
          await this.replyFinal(frame, streamId, '✅ 已清空当前对话上下文');
        } else {
          await this.replyFinal(frame, streamId, '当前没有活跃会话');
        }
        return true;
      }
      case '/list': {
        const convs = this.listUserConversations(wecomKey).slice(0, 5);
        if (convs.length === 0) {
          await this.replyFinal(frame, streamId, '暂无历史会话');
          return true;
        }
        const lines = convs.map((c, i) => {
          const time = new Date(c.updatedAt || c.createdAt).toLocaleString('zh-CN');
          const title = c.customTitle || c.turns[0]?.prompt?.slice(0, 30) || '新对话';
          const active = this.wecomSessions.get(wecomKey) === c.id ? ' ← 当前' : '';
          return `${i + 1}. ${title}\n   ${time} · ${c.turns.length} 轮${active}`;
        });
        await this.replyFinal(frame, streamId, `📋 会话列表:\n\n${lines.join('\n\n')}\n\n输入 /switch <编号> 切换`);
        return true;
      }
      case '/switch': {
        const idx = parseInt(parts[1], 10) - 1;
        const convs = this.listUserConversations(wecomKey);
        if (isNaN(idx) || idx < 0 || idx >= convs.length) {
          await this.replyFinal(frame, streamId, '❌ 无效编号,输入 /list 查看可用会话');
          return true;
        }
        const target = convs[idx];
        this.wecomSessions.set(wecomKey, target.id);
        const title = target.customTitle || target.turns[0]?.prompt?.slice(0, 30) || '新对话';
        await this.replyFinal(frame, streamId, `✅ 已切换到: ${title}`);
        return true;
      }
      case '/context': {
        const conv = this.findConvByWecomKey(wecomKey);
        if (!conv) {
          await this.replyFinal(frame, streamId, '当前没有活跃会话');
          return true;
        }
        const time = new Date(conv.createdAt).toLocaleString('zh-CN');
        await this.replyFinal(frame, streamId,
          `📊 当前会话信息:\n\n` +
          `创建时间: ${time}\n` +
          `对话轮次: ${conv.turns.length}\n` +
          `Token 用量: ${conv.tokens}\n` +
          `累计费用: $${conv.cost.toFixed(4)}\n` +
          `工作目录: ${conv.cwd}`
        );
        return true;
      }
      case '/skills': {
        const skills = listSkills();
        if (skills.length === 0) {
          await this.replyFinal(frame, streamId, '暂无可用 Skill\n\nSkill 目录:\n~/.claude/commands/\n~/.codex/skills/\n<plugin>/commands/');
          return true;
        }
        const lines = skills.slice(0, 20).map((s, i) => {
          const desc = s.description ? ` — ${s.description.slice(0, 40)}` : '';
          return `${i + 1}. \`/${s.name}\`${desc}`;
        });
        const hint = skills.length > 20 ? `\n\n(仅显示前 20 个,共 ${skills.length} 个)` : '';
        await this.replyFinal(frame, streamId, `📋 可用 Skill:\n\n${lines.join('\n')}${hint}\n\n发送 /<skill名> 来调用`);
        return true;
      }
      default: {
        // 检查是否是 skill 调用(如 /review, /deploy 等)。
        // / Check if this is a skill invocation (e.g. /review, /deploy).
        const skillMatch = command.match(/^\/([\w-]+)/);
        if (skillMatch) {
          const body = loadSkillBody(skillMatch[1]);
          if (body != null) {
            // 是 skill → 提示用户已加载,然后让消息走 agent。
            // / Is a skill → notify user, then let the message flow to agent.
            const cfg = getSettings().wecomBot;
            if (cfg.streamReply && this.ws) {
              try {
                await this.ws!.replyStreamNonBlocking(frame, streamId, `📦 已加载技能: ${skillMatch[1]}\n⏳ 正在执行…`, false);
              } catch { /* ignore */ }
            }
            return false;
          }
        }
        await this.replyFinal(frame, streamId,
          '可用指令:\n' +
          '/new — 开启新对话\n' +
          '/reset — 清空当前对话上下文\n' +
          '/list — 查看历史会话\n' +
          '/switch <编号> — 切换到指定会话\n' +
          '/context — 查看当前会话信息\n' +
          '/skills — 查看可用 Skill\n' +
          '/<skill名> — 调用指定 Skill'
        );
        return true;
      }
    }
  }

  // ── 处理收到的企信消息 → 路由到 TaskManager ──
  private async handleIncoming(frame: WsFrame<TextMessage>): Promise<void> {
    if (!this.ws || !this.taskManager) return;
    const body = frame.body;
    if (!body) return;

    const reqId = frame.headers.req_id;
    const text = body.text?.content?.trim();
    if (!text) return;

    const cfg = getSettings().wecomBot;
    const userid = body.from?.userid || 'unknown';
    const chatid = body.chatid || userid;
    // 群聊按 chatid 共享会话,单聊按 userid 隔离。
    // / Group chats share a conv per chatid; DMs per userid.
    const isGroup = body.chattype === 'group';
    const wecomKey = isGroup ? `wecom:group:${chatid}` : `wecom:${userid}`;

    const streamId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const replyFrame: WsFrameHeaders = { headers: frame.headers };
    // 存最近 frame 供工具被动回复(wecom_send_file 用,被动通道有时效限制)
    // / Keep latest frame for passive replies from tools (has expiry window).
    this.lastFrames.set(wecomKey, replyFrame);
    this.activeWecomKey = wecomKey;

    // ── 斜杠指令(同步快速回复,不走 Agent)或 Skill 调用 ──
    // / Slash commands (fast reply) or skill invocations (flow to agent).
    if (text.startsWith('/')) {
      const handled = await this.handleSlashCommand(text, wecomKey, replyFrame, streamId);
      if (handled) return; // 命令已处理(已回复)
      // handled === false → 是 skill 调用,继续走 agent
    }

    // ── 入 per-user 串行队列:同一用户的消息按顺序处理 ──
    // / Enqueue to per-user serial queue for ordered processing.
    this.enqueue(wecomKey, () =>
      this.processMessage(frame, text, wecomKey, userid, chatid, replyFrame, streamId)
    );
  }

  // ── 后台处理:实际执行 Agent 调用和企信回复 ──
  // / Background processing: actual agent invocation and WeCom reply.
  private async processMessage(
    frame: WsFrame<TextMessage>,
    text: string,
    wecomKey: string,
    userid: string,
    chatid: string,
    replyFrame: WsFrameHeaders,
    streamId: string,
  ): Promise<void> {
    if (!this.ws || !this.taskManager) return;
    const cfg = getSettings().wecomBot;

    // ── 获取或创建会话(含 fallback + 淘汰) ──
    // / Get-or-create conversation.
    const cwd = cfg.defaultCwd || os.homedir();
    const conv = this.getOrCreateConv(wecomKey, cwd, cfg.engine);
    const convId = conv.id;

    this.broadcast({
      type: 'message_received',
      data: { userid, chatid, text: text.slice(0, 100), chattype: frame.body?.chattype },
    });

    // 流式模式:先发"思考中"首帧(skill 调用已在 handleSlashCommand 发过提示,跳过)。
    // / Stream mode: send "thinking" first frame (skill invocations already showed a hint).
    const isSkillInvocation = text.startsWith('/') && loadSkillBody(text.match(/^\/([\w-]+)/)?.[1] ?? '') != null;
    if (cfg.streamReply && this.ws && !isSkillInvocation) {
      try {
        await this.ws.replyStreamNonBlocking(replyFrame, streamId, '⏳ 正在思考…', false);
      } catch (e) {
        console.warn('[wecom] stream first frame failed:', e);
      }
    }

    // send() 内部 await engine.run(),返回时引擎处理完毕
    // / send() awaits engine.run(); when it resolves the answer is ready
    try {
      await this.taskManager.send(convId, text);
    } catch (e: any) {
      console.error('[wecom] Agent error:', e);
      await this.replyFinal(replyFrame, streamId, `❌ 内部错误: ${e.message}`);
      return;
    }

    const updated = this.taskManager.get(convId);
    if (!updated) return;
    const lastTurn = updated.turns[updated.turns.length - 1];
    if (!lastTurn) return;

    if (lastTurn.error) {
      await this.replyFinal(replyFrame, streamId, `❌ ${lastTurn.error}`);
    } else if (lastTurn.answer) {
      await this.replyFinal(replyFrame, streamId, lastTurn.answer);
    }

    this.broadcast({ type: 'message_replied', data: { userid, chatid } });
  }

  /** 将磁盘文件发送到最近活跃的企业微信会话(上传临时素材 + 被动回复媒体)。 */
  // / Send a file to the most recent WeCom chat (uploadMedia + replyMedia).
  async sendFileToActiveChat(filePath: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.activeWecomKey) return { ok: false, error: '没有活跃的企业微信会话' };
    return this.sendFileToChat(this.activeWecomKey, filePath);
  }

  /** 将磁盘文件发送到指定 wecomKey 的最近会话(上传临时素材 + 被动回复媒体)。 */
  // / Send a file to the latest chat of a wecomKey (uploadMedia + replyMedia).
  async sendFileToChat(wecomKey: string, filePath: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.ws || !this._connected) return { ok: false, error: '企业微信未连接' };
    const frame = this.lastFrames.get(wecomKey);
    if (!frame) return { ok: false, error: '该会话暂无可回复的消息通道(用户需先发一条消息)' };
    try {
      const buf = await fsp.readFile(filePath);
      const up = await this.ws.uploadMedia(buf, { type: 'file', filename: nodePath.basename(filePath) });
      await this.ws.replyMedia(frame, 'file', up.media_id);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  // ── 最终回复 / Final reply ──
  private async replyFinal(frame: WsFrameHeaders, streamId: string, content: string): Promise<void> {    if (!this.ws) return;
    const cfg = getSettings().wecomBot;

    // 截断超长消息(企信 markdown 限制 20480 字节 ≈ ~6000 汉字)
    // / Truncate (WeCom markdown limit: 20480 bytes)
    const clipped = content.length > 4000
      ? content.slice(0, 4000) + '\n\n…(内容过长已截断)'
      : content;

    try {
      if (cfg.streamReply) {
        // 流式模式:最终帧 finish=true 刷新完整内容
        // / Stream mode: final frame with finish=true
        await this.ws.replyStreamNonBlocking(frame, streamId, clipped, true);
      } else {
        // 非流式:通用 reply 发 markdown 消息体
        // / Non-stream: markdown reply via generic reply()
        await this.ws.reply(frame, {
          msgtype: 'markdown',
          markdown: { content: clipped },
        });
      }
    } catch (e: any) {
      console.error('[wecom] reply failed:', e.message);
      // 回退:纯文本 / Fallback: plain text
      try {
        await this.ws.reply(frame, {
          msgtype: 'text',
          text: { content: clipped.slice(0, 2048) },
        });
      } catch (e2: any) {
        console.error('[wecom] text fallback failed:', e2.message);
      }
    }
  }

  // ── 广播事件到 renderer(由 main.ts 桥接) ──
  private broadcast(ev: WeComStatusEv): void {
    if (this.onEvent) this.onEvent(ev);
  }

  /** 外部注册的事件回调(main.ts 设置以桥接到 renderer) */
  onEvent: ((ev: WeComStatusEv) => void) | null = null;
}

// ── 单例 / Singleton ──
let bridge: WeComBridge | null = null;

export function getWeComBridge(): WeComBridge {
  if (!bridge) bridge = new WeComBridge();
  return bridge;
}

export function setTaskManagerForWeCom(tm: TaskManager): void {
  getWeComBridge().setTaskManager(tm);
}
