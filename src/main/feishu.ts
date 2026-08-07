// 飞书机器人 WebSocket 长连接桥接模块 / Feishu Bot WebSocket bridge.
//
// 接收飞书消息 → 路由到 TaskManager(Direct 引擎)处理 → 回复到飞书。
// Uses @larksuiteoapi/node-sdk WSClient for the long-connection protocol.
// KinetAios 主动连飞书服务器,不需要公网回调 URL。
import * as lark from '@larksuiteoapi/node-sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';
import type { TaskManager } from './TaskManager';
import type { TaskStep, Conversation } from '../shared/types';
import { getSettings } from './settings';

type FeishuStatusEv = { type: string; data?: unknown };

// 飞书消息事件的数据结构(从 im.message.receive_v1 事件中提取)。
// / Feishu message event payload (extracted from im.message.receive_v1).
type FeishuMessageEvent = {
  message: {
    message_id: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;       // JSON 字符串,如 {"text":"hello"}
    create_time?: string;
    mentions?: Record<string, { key: string; id: { open_id: string }; name: string }>;
  };
  sender: {
    sender_id: {
      open_id: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
  };
};

class FeishuBridge {
  private wsClient: lark.WSClient | null = null;
  private apiClient: lark.Client | null = null;
  private taskManager: TaskManager | null = null;
  private _connected = false;
  /** feishuKey → convId 映射(内存缓存,启动时从 SQLite 重建)。 */
  // / feishuKey → convId mapping (in-memory cache, rebuilt from SQLite on start).
  private feishuSessions = new Map<string, string>();
  /** per-userKey 串行队列,保证同一用户的消息按顺序处理。 */
  // / Per-userKey serial queue: messages from the same user are processed in order.
  private userQueues = new Map<string, Promise<void>>();
  /** 当前活跃消息 ID(用于 feishu_send_file 工具回传文件) */
  // / Active message ID (used by feishu_send_file tool to send files back)
  private activeMessageId: string | null = null;
  /** 已处理的 message_id 集合,用于幂等去重(飞书 WS 会在超时后重投递同一条消息) */
  // / Processed message_id set for idempotency (Feishu WS redelivers on timeout)
  private processedMsgIds = new Set<string>();
  private static readonly MAX_PROCESSED = 500;
  /** 每个用户最多保留的会话数(超出时关闭最旧的)。 */
  // / Max conversations per user key (oldest gets closed when exceeded).
  private static readonly MAX_SESSIONS_PER_USER = 5;

  setTaskManager(tm: TaskManager): void {
    this.taskManager = tm;
    // 启动时从 SQLite 恢复 feishuSessions 映射 / Rebuild feishuSessions from SQLite.
    this.rebuildSessionIndex();
  }

  /** 从 TaskManager 的所有会话中,重建 feishuKey → convId 映射。 */
  // / Rebuild feishuKey → convId map from all conversations in TaskManager.
  private rebuildSessionIndex(): void {
    if (!this.taskManager) return;
    // 倒序遍历(最近创建的优先),每个 feishuKey 只保留最新的 convId。
    const convs = this.taskManager.list();
    for (let i = convs.length - 1; i >= 0; i--) {
      const c = convs[i];
      if (c.feishuKey && !this.feishuSessions.has(c.feishuKey)) {
        this.feishuSessions.set(c.feishuKey, c.id);
      }
    }
    console.log(`[feishu] 会话索引已恢复: ${this.feishuSessions.size} 条映射`);
  }

  /** 查找 feishuKey 对应的会话:先查内存 Map,miss 时查 SQLite fallback。 */
  // / Find conv by feishuKey: memory Map first, SQLite fallback on miss.
  private findConvByFeishuKey(key: string): Conversation | undefined {
    const cachedId = this.feishuSessions.get(key);
    if (cachedId) {
      const conv = this.taskManager?.get(cachedId);
      if (conv) return conv;
    }
    // Map miss → 查 SQLite (app 重启后 Map 可能不全) / Fallback: scan conversations.
    if (!this.taskManager) return undefined;
    const convs = this.taskManager.list();
    for (let i = convs.length - 1; i >= 0; i--) {
      if (convs[i].feishuKey === key) {
        this.feishuSessions.set(key, convs[i].id);
        return convs[i];
      }
    }
    return undefined;
  }

  /** 列出指定 feishuKey 的所有历史会话(按最近活动排序)。 */
  // / List all conversations for a feishuKey, sorted by recent activity.
  private listUserConversations(key: string): Conversation[] {
    if (!this.taskManager) return [];
    return this.taskManager.list()
      .filter(c => c.feishuKey === key)
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }

  /** 获取或创建会话(含淘汰逻辑)。 */
  // / Get-or-create conversation (with eviction).
  private getOrCreateConv(key: string, cwd: string, engine?: string): Conversation {
    let conv = this.findConvByFeishuKey(key);
    if (conv) return conv;

    // 新建前检查会话数上限 / Check session limit before creating.
    const userConvs = this.listUserConversations(key);
    while (userConvs.length >= FeishuBridge.MAX_SESSIONS_PER_USER) {
      const oldest = userConvs.pop()!;
      try {
        this.taskManager?.deleteConversation(oldest.id);
        console.log(`[feishu] 淘汰旧会话: ${oldest.id} (${key})`);
      } catch { /* ignore */ }
    }

    conv = this.taskManager!.newConversation(cwd, engine as any);
    conv.feishuKey = key;
    this.feishuSessions.set(key, conv.id);
    return conv;
  }

  /** per-userKey 串行队列:保证同一用户的消息按顺序处理。 */
  // / Per-userKey serial queue: ensures ordered message processing.
  private enqueue(userKey: string, task: () => Promise<void>): void {
    const prev = this.userQueues.get(userKey) ?? Promise.resolve();
    const next = prev.then(task, task); // 前一个失败不影响后一个 / prev failure doesn't block next
    this.userQueues.set(userKey, next);
    next.finally(() => {
      if (this.userQueues.get(userKey) === next) {
        this.userQueues.delete(userKey);
      }
    });
  }

  get connected(): boolean { return this._connected; }
  get pendingCount(): number { return 0; }

  // ── 启动连接 / Start connection ──
  async start(): Promise<{ ok: boolean; error?: string }> {
    const cfg = getSettings().feishuBot;
    if (!cfg.enabled) return { ok: false, error: 'feishuBot.enabled = false' };
    if (!cfg.appId || !cfg.appSecret) return { ok: false, error: 'appId 或 appSecret 为空' };
    if (!this.taskManager) return { ok: false, error: 'TaskManager 未初始化' };

    // 已连接 → 先断开 / Already connected → disconnect first
    if (this.wsClient) this.stop();

    try {
      // 1. 创建 API Client(用于发消息/回复)
      // / Create API Client (for sending/replying messages)
      this.apiClient = new lark.Client({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        appType: lark.AppType.SelfBuild,
        domain: lark.Domain.Feishu,
      });

      // 2. 创建事件分发器 + 注册消息处理
      // / Create event dispatcher + register message handler
      const eventDispatcher = new lark.EventDispatcher({});

      eventDispatcher.register({
        'im.message.receive_v1': (raw: unknown) => {
          try {
            this.handleIncoming(raw as FeishuMessageEvent);
          } catch (e: any) {
            console.error('[feishu] handleIncoming:', e.message);
          }
        },
      });

      // 3. 创建 WSClient 长连接客户端(主动连飞书服务器)
      // / Create WSClient (proactively connects to Feishu servers)
      this.wsClient = new lark.WSClient({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        domain: lark.Domain.Feishu,
        autoReconnect: true,
        onReady: () => {
          this._connected = true;
          this.broadcast({ type: 'connected' });
          console.log('[feishu] WebSocket 长连接已建立');
        },
        onError: (err: Error) => {
          this._connected = false;
          this.broadcast({ type: 'error', data: { message: err.message } });
          console.error('[feishu] error:', err.message);
        },
        onReconnecting: () => {
          this._connected = false;
          this.broadcast({ type: 'reconnecting' });
          console.log('[feishu] 重连中…');
        },
        onReconnected: () => {
          this._connected = true;
          this.broadcast({ type: 'connected' });
          console.log('[feishu] 重连成功');
        },
      });

      // 4. 启动长连接(传入 eventDispatcher)
      // / Start long connection (passing eventDispatcher)
      this.wsClient.start({ eventDispatcher });

      this.broadcast({ type: 'connecting' });
      return { ok: true };
    } catch (e: any) {
      this.broadcast({ type: 'error', data: { message: e.message } });
      return { ok: false, error: e.message };
    }
  }

  // ── 断开 / Disconnect ──
  stop(): { ok: boolean } {
    if (this.wsClient) {
      try { this.wsClient.close(); } catch { /* ignore */ }
      this.wsClient = null;
    }
    this.apiClient = null;
    this._connected = false;
    this.broadcast({ type: 'disconnected' });
    return { ok: true };
  }

  // ── 处理收到的飞书消息 → 路由到 TaskManager ──
  // ⚠️ 核心原则:此函数必须尽快返回(fire-and-forget)。
  // 飞书 SDK 在 handleEventData 中 await invoke() 等此函数返回后才发 ack。
  // 如果 await send() 阻塞几十秒,飞书服务器等不到 ack 会断连重连并重新推送事件。
  // 因此:同步完成去重 + 解析 → 立即返回 → Agent 处理放到后台 Promise。
  // / Must return ASAP — SDK awaits this to send ack. Agent runs in background.
  private handleIncoming(event: FeishuMessageEvent): void {
    if (!this.apiClient || !this.taskManager) return;

    const msg = event.message;
    if (!msg) return;

    if (msg.message_type !== 'text') return;

    // 解析消息内容(JSON: {"text":"实际内容"})
    // / Parse message content (JSON: {"text":"actual content"})
    let text: string;
    try {
      const parsed = JSON.parse(msg.content);
      text = (parsed.text || '').trim();
    } catch {
      return;
    }
    if (!text) return;

    // 去掉 @机器人 的 mention key(如 @_user_1)
    // / Strip bot mention key (e.g. @_user_1)
    text = text.replace(/@_user_\d+\s*/g, '').trim();
    if (!text) return;

    const messageId = msg.message_id;

    // ── 幂等去重(同步,在任何 async 操作之前)
    // 飞书 WS 长连接在 ack 超时后会重新投递同一条消息,用 message_id 去重。
    // / Idempotency: dedup by message_id BEFORE any async work (sync check).
    if (this.processedMsgIds.has(messageId)) {
      console.log(`[feishu] 跳过重复消息: ${messageId}`);
      return;
    }
    this.processedMsgIds.add(messageId);
    if (this.processedMsgIds.size > FeishuBridge.MAX_PROCESSED) {
      const first = this.processedMsgIds.values().next().value;
      if (first) this.processedMsgIds.delete(first);
    }

    // ── 计算 feishuKey:群聊按 chat_id 共享会话,单聊按用户隔离 ──
    // / Compute feishuKey: group chats share a conv per chat_id, DMs per open_id.
    const senderId = event.sender?.sender_id?.open_id || 'unknown';
    const chatId = msg.chat_id;
    const isGroup = msg.chat_type === 'group';
    const feishuKey = isGroup ? `feishu:group:${chatId}` : `feishu:${senderId}`;

    // ── 斜杠指令处理(同步快速回复,不走 Agent) ──
    // / Slash command handling (sync fast reply, no Agent invocation).
    if (text.startsWith('/')) {
      this.handleSlashCommand(text, feishuKey, messageId).catch((e) => {
        console.error('[feishu] slash command error:', e);
      });
      return;
    }

    // ── fire-and-forget:Agent 处理放后台,函数立即返回让 SDK 发 ack ──
    // 入 per-user 串行队列:同一用户的消息按顺序处理,不同用户并行。
    // / Fire-and-forget: enqueue to per-user serial queue.
    this.enqueue(feishuKey, () => this.processMessage(event, text, messageId, feishuKey));
  }

  // ── 斜杠指令处理 / Slash command handling ──
  // 用户在飞书中发送 /new, /reset, /list, /context 来管理会话。
  // / Users send /new, /reset, /list, /context in Feishu to manage sessions.
  private async handleSlashCommand(text: string, feishuKey: string, messageId: string): Promise<void> {
    const cmd = text.toLowerCase().trim();
    const parts = cmd.split(/\s+/);
    const command = parts[0];

    switch (command) {
      case '/new': {
        // 新建会话,旧会话保留 / Create new conv, old one preserved.
        const cfg = getSettings().feishuBot;
        const cwd = cfg.defaultCwd || os.homedir();
        const conv = this.taskManager!.newConversation(cwd, cfg.engine);
        conv.feishuKey = feishuKey;
        this.feishuSessions.set(feishuKey, conv.id);
        // 淘汰超额会话 / Evict excess conversations.
        this.evictIfNeeded(feishuKey);
        await this.sendText(messageId, '✅ 已开启新对话');
        return;
      }
      case '/reset': {
        // 清空当前会话的上下文 / Clear current conv context.
        const conv = this.findConvByFeishuKey(feishuKey);
        if (conv) {
          this.taskManager!.clearConversation(conv.id);
          await this.sendText(messageId, '✅ 已清空当前对话上下文');
        } else {
          await this.sendText(messageId, '当前没有活跃会话');
        }
        return;
      }
      case '/list': {
        // 列出该用户的最近会话 / List recent conversations.
        const convs = this.listUserConversations(feishuKey).slice(0, 5);
        if (convs.length === 0) {
          await this.sendText(messageId, '暂无历史会话');
          return;
        }
        const lines = convs.map((c, i) => {
          const time = new Date(c.updatedAt || c.createdAt).toLocaleString('zh-CN');
          const title = c.customTitle || c.turns[0]?.prompt?.slice(0, 30) || '新对话';
          const active = this.feishuSessions.get(feishuKey) === c.id ? ' ← 当前' : '';
          return `${i + 1}. ${title}\n   ${time} · ${c.turns.length} 轮${active}`;
        });
        await this.sendText(messageId, `📋 会话列表:\n\n${lines.join('\n\n')}\n\n输入 /switch <编号> 切换`);
        return;
      }
      case '/switch': {
        // 切换到历史会话 / Switch to a historical conversation.
        const idx = parseInt(parts[1], 10) - 1;
        const convs = this.listUserConversations(feishuKey);
        if (isNaN(idx) || idx < 0 || idx >= convs.length) {
          await this.sendText(messageId, '❌ 无效编号,输入 /list 查看可用会话');
          return;
        }
        const target = convs[idx];
        this.feishuSessions.set(feishuKey, target.id);
        const title = target.customTitle || target.turns[0]?.prompt?.slice(0, 30) || '新对话';
        await this.sendText(messageId, `✅ 已切换到: ${title}`);
        return;
      }
      case '/context': {
        // 显示当前会话信息 / Show current conv info.
        const conv = this.findConvByFeishuKey(feishuKey);
        if (!conv) {
          await this.sendText(messageId, '当前没有活跃会话');
          return;
        }
        const time = new Date(conv.createdAt).toLocaleString('zh-CN');
        await this.sendText(messageId,
          `📊 当前会话信息:\n\n` +
          `创建时间: ${time}\n` +
          `对话轮次: ${conv.turns.length}\n` +
          `Token 用量: ${conv.tokens}\n` +
          `累计费用: $${conv.cost.toFixed(4)}\n` +
          `工作目录: ${conv.cwd}`
        );
        return;
      }
      default:
        // 未知指令 → 提示 / Unknown command → help.
        await this.sendText(messageId,
          '可用指令:\n' +
          '/new — 开启新对话\n' +
          '/reset — 清空当前对话上下文\n' +
          '/list — 查看历史会话\n' +
          '/switch <编号> — 切换到指定会话\n' +
          '/context — 查看当前会话信息'
        );
        return;
    }
  }

  /** 淘汰超额会话(仅保留最近 MAX_SESSIONS_PER_USER 条)。 */
  // / Evict excess conversations (keep only MAX_SESSIONS_PER_USER most recent).
  private evictIfNeeded(feishuKey: string): void {
    const convs = this.listUserConversations(feishuKey);
    if (convs.length <= FeishuBridge.MAX_SESSIONS_PER_USER) return;
    // 删除最旧的 / Remove oldest.
    for (let i = FeishuBridge.MAX_SESSIONS_PER_USER; i < convs.length; i++) {
      try {
        this.taskManager?.deleteConversation(convs[i].id);
        console.log(`[feishu] 淘汰旧会话: ${convs[i].id} (${feishuKey})`);
      } catch { /* ignore */ }
    }
  }

  // ── 后台处理:实际执行 Agent 调用和飞书回复 ──
  // / Background processing: actual agent invocation and Feishu reply.
  private async processMessage(
    event: FeishuMessageEvent,
    text: string,
    messageId: string,
    feishuKey: string,
  ): Promise<void> {
    if (!this.apiClient || !this.taskManager) return;

    const cfg = getSettings().feishuBot;
    const senderId = event.sender?.sender_id?.open_id || 'unknown';
    const chatId = event.message.chat_id;
    const chatType = event.message.chat_type;

    this.activeMessageId = messageId;

    // 按用户/群聊复用会话(含 Map miss fallback + 淘汰)。
    // / Reuse conversation per user/group (with Map miss fallback + eviction).
    const cwd = cfg.defaultCwd || os.homedir();
    const conv = this.getOrCreateConv(feishuKey, cwd, cfg.engine);
    const convId = conv.id;

    this.broadcast({
      type: 'message_received',
      data: { senderId, chatId, text: text.slice(0, 100), chatType },
    });

    // 流式模式:先发"思考中"
    // / Stream mode: send "thinking" placeholder
    if (cfg.streamReply) {
      try {
        await this.sendText(messageId, '⏳ 正在思考…');
      } catch (e) {
        console.warn('[feishu] thinking placeholder failed:', e);
      }
    }

    // send() 内部 await engine.run(),返回时引擎处理完毕
    // / send() awaits engine.run(); when it resolves the answer is ready
    try {
      await this.taskManager.send(convId, text);
    } catch (e: any) {
      console.error('[feishu] Agent error:', e);
      await this.replyFinal(messageId, `❌ 内部错误: ${e.message}`);
      return;
    }

    const updated = this.taskManager.get(convId);
    if (!updated) return;
    const lastTurn = updated.turns[updated.turns.length - 1];
    if (!lastTurn) return;

    if (lastTurn.error) {
      await this.replyFinal(messageId, `❌ ${lastTurn.error}`);
    } else if (lastTurn.answer) {
      await this.replyFinal(messageId, lastTurn.answer);
    }

    // 提取并发送 Agent 产出的文件/图片到飞书
    // / Extract and send files/images produced by the agent to Feishu
    const files = this.extractArtifacts(lastTurn.steps, cwd, text);
    if (files.length > 0) {
      await this.uploadAndSendFiles(messageId, files);
    }

    this.broadcast({ type: 'message_replied', data: { senderId, chatId } });
  }

  // ── 发送文本消息(回复某条消息) / Send text (reply to a message) ──
  private async sendText(messageId: string, content: string): Promise<void> {
    if (!this.apiClient) return;
    await this.apiClient.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text: content }),
        msg_type: 'text',
      },
    });
  }

  // ── 最终回复 / Final reply ──
  private async replyFinal(messageId: string, content: string): Promise<void> {
    if (!this.apiClient) return;

    // 截断超长消息 / Truncate long messages
    const clipped = content.length > 4000
      ? content.slice(0, 4000) + '\n\n…(内容过长已截断)'
      : content;

    try {
      // 飞书支持 markdown 富文本(post 类型)
      // / Feishu supports rich text (post type)
      await this.apiClient.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: clipped }),
        },
      });
    } catch (e: any) {
      console.error('[feishu] reply failed:', e.message);
    }
  }

  // ── 从 Turn 提取要发送的文件 ──
  // / Extract files to send from the turn.
  // 三条提取路径(按优先级):
  // 1. write_file 的 args.path — Agent 本轮产出的新文件
  // 2. read_file 的 args.path — Agent 读取过的文件(用户说"发图片"时 Agent 会先读取)
  // 3. shell args 里的文件路径 — Agent 用 shell 操作过的文件
  // 不从 shell result 正文提取(ls/grep 输出会污染)。
  // / Three extraction paths by priority:
  // 1. write_file args.path — newly produced files
  // 2. read_file args.path — files the agent read (user says "send photo" → agent reads it)
  // 3. shell args containing file paths — files operated on via shell
  // Never extract from shell result body (ls/grep output would pollute).
  private extractArtifacts(steps: TaskStep[], cwd: string, userPrompt?: string): string[] {
    const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    const FILE_EXTS = ['.pdf', '.xlsx', '.xls', '.docx', '.doc', '.csv', '.zip', '.mp4', '.mp3'];
    const ALL_EXTS = new Set([...IMAGE_EXTS, ...FILE_EXTS]);
    // 排除代码/配置/日志类文件(不是交付物,只是中间产物)
    // / Exclude code/config/log files (intermediate artifacts, not deliverables)
    const EXCLUDE_EXTS = new Set(['.json', '.txt', '.md', '.html', '.js', '.ts', '.css', '.xml', '.log', '.yaml', '.yml']);

    const found = new Set<string>();

    const tryAdd = (p: string) => {
      const ext = path.extname(p).toLowerCase();
      if (EXCLUDE_EXTS.has(ext)) return;
      if (!ALL_EXTS.has(ext)) return;
      found.add(path.resolve(cwd, p));
    };

    for (const step of steps) {
      try {
        const args = JSON.parse(step.args);

        // write_file: Agent 本轮产出的新文件
        if (step.name === 'write_file') {
          const p = args.path as string;
          if (p) tryAdd(p);
        }

        // read_file: Agent 读取过的文件(如用户说"发图片",Agent 可能先读取确认)
        // / read_file: files the agent read (e.g. user says "send photo", agent reads first)
        if (step.name === 'read_file') {
          const p = args.path as string;
          if (p) tryAdd(p);
        }

        // shell:从命令参数中提取文件路径(不从 result 正文提取,避免 ls 输出污染)
        // / shell: extract file paths from command args only (not from result body)
        if (step.name === 'shell') {
          const cmd = args.command as string;
          if (cmd) {
            // 提取命令中出现的文件路径(带扩展名的)
            // / Extract file paths (with extensions) from the command string
            const filePathRegex = /[\w\/\\.\-]+\.(?:png|jpe?g|gif|webp|bmp|pdf|xlsx?|docx?|csv|zip|mp[34])/gi;
            const matches = cmd.match(filePathRegex);
            if (matches) for (const m of matches) tryAdd(m);
          }
        }
      } catch { /* args 不是合法 JSON,跳过 */ }
    }

    // Fallback:如果 steps 没提取到任何文件,检查用户消息里是否提到了文件名
    // / Fallback: if no files found from steps, check user prompt for filenames
    if (found.size === 0 && userPrompt) {
      const nameRegex = /[\w.\-]+\.(?:png|jpe?g|gif|webp|bmp|pdf|xlsx?|docx?|csv|zip|mp[34])/gi;
      const matches = userPrompt.match(nameRegex);
      if (matches) for (const m of matches) tryAdd(m);
    }

    // 只返回实际存在的文件,最多 5 个(防止刷屏)
    // / Only return files that exist; cap at 5 to prevent flooding
    return [...found].filter(p => {
      try { return fs.existsSync(p) && fs.statSync(p).size > 0; } catch { return false; }
    }).slice(0, 5);
  }

  // ── 上传图片/文件到飞书并发送回复 ──
  // / Upload images/files to Feishu and send as replies.
  private async uploadAndSendFiles(messageId: string, files: string[]): Promise<void> {
    if (!this.apiClient) return;

    const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

    for (const filePath of files) {
      const ext = path.extname(filePath).toLowerCase();
      const fileName = path.basename(filePath);
      const isImage = IMAGE_EXTS.includes(ext);

      try {
        if (isImage) {
          // 图片:im.image.create → reply msg_type='image'
          // / Image: upload → get image_key → reply as image message
          const uploadRes = await this.apiClient.im.image.create({
            data: {
              image_type: 'message',
              image: fs.createReadStream(filePath),
            },
          });
          const imageKey = uploadRes?.image_key;
          if (!imageKey) {
            console.error('[feishu] image upload returned no key:', filePath);
            continue;
          }
          await this.apiClient.im.message.reply({
            path: { message_id: messageId },
            data: {
              msg_type: 'image',
              content: JSON.stringify({ image_key: imageKey }),
            },
          });
          console.log('[feishu] 已发送图片:', fileName);
        } else {
          // 文件:im.file.create → reply msg_type='file'
          // / File: upload → get file_key → reply as file message
          const fileType = this.mapFileType(ext);
          const uploadRes = await this.apiClient.im.file.create({
            data: {
              file_type: fileType,
              file_name: fileName,
              file: fs.createReadStream(filePath),
            },
          });
          const fileKey = uploadRes?.file_key;
          if (!fileKey) {
            console.error('[feishu] file upload returned no key:', filePath);
            continue;
          }
          await this.apiClient.im.message.reply({
            path: { message_id: messageId },
            data: {
              msg_type: 'file',
              content: JSON.stringify({ file_key: fileKey }),
            },
          });
          console.log('[feishu] 已发送文件:', fileName);
        }
      } catch (e: any) {
        console.error(`[feishu] 上传/发送失败 ${fileName}:`, e.message);
        // 失败不中断,继续处理下一个文件
        // / Don't abort on single file failure, continue with remaining
      }
    }
  }

  // 飞书文件 API 要求的 file_type 枚举映射
  // / Map file extension to Feishu file_type enum.
  private mapFileType(ext: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
    switch (ext) {
      case '.pdf': return 'pdf';
      case '.doc':
      case '.docx': return 'doc';
      case '.xls':
      case '.xlsx':
      case '.csv': return 'xls';
      case '.ppt':
      case '.pptx': return 'ppt';
      case '.mp4': return 'mp4';
      case '.mp3':
      case '.opus': return 'opus';
      default: return 'stream';
    }
  }

  // ── 广播事件到 renderer(由 main.ts 桥接) ──
  private broadcast(ev: FeishuStatusEv): void {
    if (this.onEvent) this.onEvent(ev);
  }

  /** 外部注册的事件回调(main.ts 设置以桥接到 renderer) */
  onEvent: ((ev: FeishuStatusEv) => void) | null = null;

  // ── 供 feishu_send_file 工具调用的公开接口 ──
  // / Public API for feishu_send_file tool to send files to the active chat.
  async sendFileToActiveChat(filePath: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.apiClient) return { ok: false, error: '飞书未连接' };
    if (!this.activeMessageId) return { ok: false, error: '没有活跃的飞书消息(非飞书频道会话)' };

    try {
      await this.uploadAndSendFiles(this.activeMessageId, [filePath]);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}

// ── 单例 / Singleton ──
let bridge: FeishuBridge | null = null;

export function getFeishuBridge(): FeishuBridge {
  if (!bridge) bridge = new FeishuBridge();
  return bridge;
}

export function setTaskManagerForFeishu(tm: TaskManager): void {
  getFeishuBridge().setTaskManager(tm);
}
