// 飞书机器人 WebSocket 长连接桥接模块 / Feishu Bot WebSocket bridge.
//
// 接收飞书消息 → 路由到 TaskManager(Direct 引擎)处理 → 回复到飞书。
// Uses @larksuiteoapi/node-sdk WSClient for the long-connection protocol.
// KinetAios 主动连飞书服务器,不需要公网回调 URL。
import * as lark from '@larksuiteoapi/node-sdk';
import os from 'node:os';
import type { TaskManager } from './TaskManager';
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
  /** open_id → convId 映射,用于按用户复用会话(而非每条消息新建)。 */
  private feishuSessions = new Map<string, string>();

  setTaskManager(tm: TaskManager): void {
    this.taskManager = tm;
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
        'im.message.receive_v1': async (raw: unknown) => {
          try {
            await this.handleIncoming(raw as FeishuMessageEvent);
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
  private async handleIncoming(event: FeishuMessageEvent): Promise<void> {
    if (!this.apiClient || !this.taskManager) return;

    const msg = event.message;
    if (!msg) return;

    // 只处理文本消息 / Only handle text messages
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

    const cfg = getSettings().feishuBot;
    const senderId = event.sender?.sender_id?.open_id || 'unknown';
    const messageId = msg.message_id;
    const chatId = msg.chat_id;
    const chatType = msg.chat_type;
    const feishuKey = `feishu:${senderId}`;

    // 按用户复用会话:同一 open_id 的后续消息进入同一会话,保持多轮上下文。
    // / Reuse conversation per user: subsequent messages from the same open_id go into the same conv.
    const cwd = cfg.defaultCwd || os.homedir();
    let convId = this.feishuSessions.get(feishuKey);
    let conv = convId ? this.taskManager.get(convId) : undefined;

    if (!conv) {
      conv = this.taskManager.newConversation(cwd, cfg.engine);
      conv.feishuKey = feishuKey;
      this.feishuSessions.set(feishuKey, conv.id);
    }
    convId = conv.id;

    this.broadcast({
      type: 'message_received',
      data: { senderId, chatId, text: text.slice(0, 100), chatType },
    });

    // 上一轮还在处理 → 排队等待
    // / Previous turn still running → wait in queue
    if (conv.status === 'running') {
      try {
        await this.sendText(messageId, '⏳ 上一条消息还在处理中,请稍候…');
      } catch { /* ignore */ }
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const c = this.taskManager.get(convId);
        if (c && c.status !== 'running') break;
      }
      const stillRunning = this.taskManager.get(convId);
      if (stillRunning?.status === 'running') {
        await this.replyFinal(messageId, '❌ 等待超时,上一条消息仍在处理。请稍后重试。');
        return;
      }
    }

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

  // ── 广播事件到 renderer(由 main.ts 桥接) ──
  private broadcast(ev: FeishuStatusEv): void {
    if (this.onEvent) this.onEvent(ev);
  }

  /** 外部注册的事件回调(main.ts 设置以桥接到 renderer) */
  onEvent: ((ev: FeishuStatusEv) => void) | null = null;
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
