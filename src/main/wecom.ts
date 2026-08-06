// 企业微信智能机器人 WebSocket 长连接桥接模块 / WeCom AI Bot WebSocket bridge.
//
// 接收企业微信消息 → 路由到 TaskManager(Direct 引擎)处理 → 回复到企信。
// Uses @wecom/aibot-node-sdk WSClient for the long-connection protocol.
import { WSClient, WSAuthFailureError, WSReconnectExhaustedError } from '@wecom/aibot-node-sdk';
import type { WsFrame, TextMessage, VoiceMessage, WsFrameHeaders } from '@wecom/aibot-node-sdk';
import os from 'node:os';
import type { TaskManager } from './TaskManager';
import { getSettings } from './settings';

type WeComStatusEv = { type: string; data?: unknown };

class WeComBridge {
  private ws: WSClient | null = null;
  private taskManager: TaskManager | null = null;
  private _connected = false;
  /** userid → convId 映射,用于按用户复用会话(而非每条消息新建)。 */
  private wecomSessions = new Map<string, string>();

  setTaskManager(tm: TaskManager): void {
    this.taskManager = tm;
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
    const wecomKey = `wecom:${userid}`;

    // 按用户复用会话:同一 userid 的后续消息进入同一会话,保持多轮上下文。
    // / Reuse conversation per user: subsequent messages from the same userid go into the same conv.
    const cwd = cfg.defaultCwd || os.homedir();
    let convId = this.wecomSessions.get(wecomKey);
    let conv = convId ? this.taskManager.get(convId) : undefined;

    // 会话不存在或已被删除 → 新建并登记
    // / Conv not found or deleted → create and register
    if (!conv) {
      conv = this.taskManager.newConversation(cwd, cfg.engine);
      conv.wecomKey = wecomKey;
      this.wecomSessions.set(wecomKey, conv.id);
    }
    convId = conv.id;
    const streamId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const replyFrame: WsFrameHeaders = { headers: frame.headers };

    this.broadcast({
      type: 'message_received',
      data: { userid, chatid, text: text.slice(0, 100), chattype: body.chattype },
    });

    // 上一轮还在处理 → 排队等待(轮询 conv.status 变为 ready)
    // / Previous turn still running → wait in queue (poll until conv.status becomes ready)
    if (conv.status === 'running') {
      try {
        await this.ws.reply(frame, {
          msgtype: 'text',
          text: { content: '⏳ 上一条消息还在处理中,请稍候…' },
        });
      } catch { /* ignore */ }
      // 最多等待 120 秒
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const c = this.taskManager.get(convId);
        if (c && c.status !== 'running') break;
      }
      // 超时仍 running → 放弃这条消息
      const stillRunning = this.taskManager.get(convId);
      if (stillRunning?.status === 'running') {
        await this.replyFinal(replyFrame, streamId, '❌ 等待超时,上一条消息仍在处理。请稍后重试。');
        return;
      }
    }

    // 流式模式:先发"思考中"首帧 / Stream mode: send "thinking" first frame
    if (cfg.streamReply && this.ws) {
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

  // ── 最终回复 / Final reply ──
  private async replyFinal(frame: WsFrameHeaders, streamId: string, content: string): Promise<void> {
    if (!this.ws) return;
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
