// VoiceChat.ts — 豆包实时语音大模型 WebSocket 管理器
// Realtime voice chat manager: connects to Volcengine (Doubao) realtime voice API via WebSocket,
// manages bidirectional audio streaming, sends user mic audio → receives AI audio response.
//
// 协议概述 / Protocol overview (参照 studyapp 已验证实现):
// 1. WebSocket 握手需 5 个认证 headers: X-Api-App-ID / X-Api-Access-Key / X-Api-Resource-Id / X-Api-App-Key / X-Api-Connect-Id
// 2. 握手成功后发送 StartConnection (event=1, 二进制帧)
// 3. 收到 ConnectionStarted (event=50) → 发送 StartSession (event=100, 含 ASR/Dialog/TTS 配置)
// 4. 收到 SessionStarted (event=150) → 开始发送音频 (event=200, 二进制帧)
// 5. 服务端返回: ASR 文本 (event=451) / AI 文本 (event=453) / TTS 音频 (event=352) / TTS 结束 (event=359)
//
// 二进制帧格式:
//   Header (4 bytes): 0x11 0x14 0x10 0x00 (protocol=1, header_size=1, msg_type=full_client, flags=has_event, serial=JSON)
//   Event ID (4 bytes big-endian)
//   Session/Connect ID size (4 bytes) + ID bytes (仅 session/connect 类事件)
//   Payload size (4 bytes) + payload bytes

import WebSocket from 'ws';
import crypto from 'crypto';
import type { VoiceChatConfig } from '../shared/types.js';

// ── 事件类型(推给 renderer)──
export type VoiceChatEvent =
  | { type: 'state'; state: VoiceChatState }
  | { type: 'userText'; text: string }          // ASR 转写的用户语音文本(增量)
  | { type: 'aiText'; text: string }            // AI 回复文本(增量)
  | { type: 'aiAudio'; data: Buffer }           // AI 回复音频(PCM s16le 24kHz mono)
  | { type: 'aiAudioEnd' }                      // AI 一段音频播完
  | { type: 'error'; message: string }
  | { type: 'ready' };                          // 会话已建立,可以开始说话

export type VoiceChatState = 'idle' | 'connecting' | 'connected' | 'speaking' | 'listening' | 'error';

// ── 火山引擎常量 ──
const WS_URL = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';
const RESOURCE_ID = 'volc.speech.dialog';
const APP_KEY = 'PlgvMymc7f3tQnJ6';   // 应用标识,与 studyapp 一致

type EventCb = (ev: VoiceChatEvent) => void;

export class VoiceChat {
  private ws: WebSocket | null = null;
  private cfg: VoiceChatConfig | null = null;
  private state: VoiceChatState = 'idle';
  private cb: EventCb | null = null;
  private connectId = '';
  private sessionId = '';
  private lastUserText = '';                    // 最近一句 ASR 识别文本(增量累积)
  private userMsgCb: ((text: string) => void) | null = null;
  private agentBusy = false;                    // P0: Agent 执行并发保护

  /** 设置事件回调 / Set event callback */
  onEvent(cb: EventCb): void {
    this.cb = cb;
  }

  /** 设置"用户完整发言"回调 — ASR 判定一句话结束时触发,main 可据此调用 Agent */
  onUserMessage(cb: (text: string) => void): void {
    this.userMsgCb = cb;
  }

  /** 当前状态 / Current state */
  getState(): VoiceChatState {
    return this.state;
  }

  /** Agent 执行完毕,把结果文本通过豆包 WS TTS 朗读。显示由主聊天窗口的 agent-event 自然处理。 */
  // Agent result → speak via Doubao WS TTS. Display is handled by the main chat window's agent-event listener.
  async agentResult(text: string): Promise<void> {
    if (!text) return;

    // P1 #3: 等待豆包 WS TTS 播完再合成 Agent TTS,避免双路音频叠加
    // Wait for Doubao WS TTS to finish before synthesizing Agent TTS to prevent audio overlap
    if (this.state === 'speaking') {
      console.log('[VoiceChat] ⏳ 豆包 TTS 正在播放,等待结束后再合成 Agent TTS');
      const waitStart = Date.now();
      while (this.state === 'speaking' && Date.now() - waitStart < 15000) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // 用豆包实时语音 WS 管道直接注入文本,让豆包端到端 TTS 朗读 Agent 回复。
    // Inject Agent reply text into the Doubao WS dialogue channel for TTS.
    // 这复用已认证的 WS 连接,不需要额外的 TTS HTTP 权限。
    // Reuses the authenticated WS connection — no separate TTS HTTP permission needed.
    try {
      const clean = text
        .replace(/```[\s\S]*?```/g, '代码块')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[#*_>]/g, '')
        .trim()
        .slice(0, 500);
      if (clean && this.ws && this.ws.readyState === WebSocket.OPEN) {
        // event=502 ChatRequest: 让豆包 TTS 朗读指定文本
        // 这会触发 event 352(TTSResponse)+ 359(TTSEnded),复用现有播放管道
        console.log('[VoiceChat] 📤 通过 WS 注入 Agent 回复文本供豆包 TTS:', clean.slice(0, 80));
        this.sendSessionEvent(502, JSON.stringify({ text: clean }));
      }
    } catch (e) {
      console.error('[VoiceChat] WS 文本注入失败:', (e as Error)?.message);
    } finally {
      // P0: 无论成功失败,都释放并发锁
      this.agentBusy = false;
    }
  }

  /** 是否活跃 / Is active */
  isActive(): boolean {
    return this.state !== 'idle' && this.state !== 'error';
  }

  /** 开始连接 / Connect & start session */
  async start(cfg: VoiceChatConfig): Promise<void> {
    if (this.ws) {
      this.close();
    }
    this.cfg = cfg;
    this.setState('connecting');

    if (!cfg.appId || !cfg.accessToken) {
      this.emit({ type: 'error', message: '缺少 App ID 或 Access Key,请在设置 → 高级中配置' });
      this.setState('error');
      return;
    }

    const url = cfg.wsUrl || WS_URL;
    this.connectId = crypto.randomUUID();

    // 调试: 打印实际使用的认证参数(脱敏)
    // Debug: print actual auth params (masked)
    console.log('[VoiceChat] 正在连接火山引擎实时语音...');
    console.log('[VoiceChat]   URL:', url);
    console.log('[VoiceChat]   appId:', cfg.appId);
    console.log('[VoiceChat]   accessKey:', cfg.accessToken.slice(0, 6) + '...' + cfg.accessToken.slice(-4));
    console.log('[VoiceChat]   resourceID:', RESOURCE_ID);
    console.log('[VoiceChat]   appKey:', APP_KEY);
    console.log('[VoiceChat]   connectId:', this.connectId);

    try {
      // 5 个认证 headers — 与 studyapp (Swift) 已验证的实现完全一致
      // 5 auth headers — matching studyapp's verified Swift implementation
      this.ws = new WebSocket(url, {
        headers: {
          'X-Api-App-ID': cfg.appId,
          'X-Api-Access-Key': cfg.accessToken,
          'X-Api-Resource-Id': RESOURCE_ID,
          'X-Api-App-Key': APP_KEY,
          'X-Api-Connect-Id': this.connectId,
        },
      });
      // 不设 binaryType — ws 模块在 Node.js 默认传 Buffer,适合我们的 readUInt32BE 操作
      this.ws.on('open', () => this.onOpen());
      this.ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => this.onMessage(data, isBinary));
      this.ws.on('error', (err: Error) => this.onError(err));
      this.ws.on('close', (code: number, reason: Buffer) => this.onClose(code, reason));
    } catch (e) {
      this.emit({ type: 'error', message: `连接失败: ${(e as Error).message}` });
      this.setState('error');
    }
  }

  /** 停止并断开 / Stop & disconnect */
  close(): void {
    // P0 #6: 清空回调,防止 close 后仍有在途的 async 回调将结果打到新 session
    this.userMsgCb = null;
    this.agentBusy = false;
    this.lastUserText = '';
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          // 发送 FinishSession (event=102)
          this.sendSessionEvent(102, '{}');
          // 发送 FinishConnection (event=2)
          this.sendConnectEvent(2, '{}');
        }
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }
    this.setState('idle');
  }

  /** 发送音频数据(由 renderer IPC 调用) / Send audio chunk (called from renderer via IPC) */
  sendAudio(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.state === 'idle' || this.state === 'error') return;
    // event=200 TaskRequest, message_type=0b0010 (audio-only)
    this.sendAudioFrame(pcm);
  }

  // ── 内部方法 / Internal methods ──

  private emit(ev: VoiceChatEvent): void {
    this.cb?.(ev);
  }

  private setState(s: VoiceChatState): void {
    this.state = s;
    this.emit({ type: 'state', state: s });
  }

  /** WebSocket 连接成功 → 发送 StartConnection (event=1) */
  private onOpen(): void {
    console.log('[VoiceChat] ✅ WebSocket 握手成功! 发送 StartConnection (event=1)');
    // StartConnection: event=1, payload="{}" (connect_id 已通过 HTTP header 传递)
    this.sendConnectEvent(1, '{}');
  }

  /** 构建并发送 StartSession (event=100) */
  private startSession(): void {
    this.sessionId = crypto.randomUUID();
    const cfg = this.cfg!;

    // 基础人设 + 当前项目上下文(如果有)
    // Base persona + current project context (if any)
    let systemRole = '你是一个友好的AI助手,请用简洁易懂的中文回答。';
    if (cfg.contextHint) {
      systemRole = cfg.contextHint;
    }

    const payload = {
      asr: {
        audio_info: {
          format: 'pcm',
          sample_rate: 16000,
          channel: 1,
        },
      },
      dialog: {
        bot_name: 'AI助手',
        system_role: systemRole,
        bot_personality: systemRole,  // 与 studyapp 一致,部分版本用此字段
        extra: {
          input_mod: 'keep_alive',
          model: '1.2.1.1',    // 豆包实时语音大模型版本
        },
      },
      tts: {
        speaker: cfg.voiceType || 'zh_female_vv_jupiter_bigtts',
        audio_config: {
          format: 'pcm_s16le',
          sample_rate: 24000,
          channel: 1,
        },
      },
    };

    console.log('[VoiceChat] 📤 发送 StartSession (event=100), sessionId:', this.sessionId);
    console.log('[VoiceChat] 📝 system_role:', systemRole.slice(0, 200));
    this.sendSessionEvent(100, JSON.stringify(payload));
  }

  // ── 二进制帧编码 ──

  /** 发送 Connect 类事件(不含 connect_id 字段,已在 HTTP header 中传递) */
  private sendConnectEvent(eventId: number, payload: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const header = Buffer.from([0x11, 0x14, 0x10, 0x00]);  // protocol=1, header_size=1, msg_type=full_client, flags=has_event, serial=JSON
    const eventBuf = Buffer.alloc(4);
    eventBuf.writeUInt32BE(eventId, 0);
    const payloadBytes = Buffer.from(payload, 'utf-8');
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32BE(payloadBytes.length, 0);

    this.ws.send(Buffer.concat([header, eventBuf, sizeBuf, payloadBytes]));
  }

  /** 发送 Session 类事件(含 session_id 字段) */
  private sendSessionEvent(eventId: number, payload: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const header = Buffer.from([0x11, 0x14, 0x10, 0x00]);
    const eventBuf = Buffer.alloc(4);
    eventBuf.writeUInt32BE(eventId, 0);
    const sidBytes = Buffer.from(this.sessionId, 'utf-8');
    const sidLenBuf = Buffer.alloc(4);
    sidLenBuf.writeUInt32BE(sidBytes.length, 0);
    const payloadBytes = Buffer.from(payload, 'utf-8');
    const payloadSizeBuf = Buffer.alloc(4);
    payloadSizeBuf.writeUInt32BE(payloadBytes.length, 0);

    this.ws.send(Buffer.concat([header, eventBuf, sidLenBuf, sidBytes, payloadSizeBuf, payloadBytes]));
  }

  /** 发送音频帧(event=200, message_type=audio-only) */
  private sendAudioFrame(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // message_type=0b0010 (audio-only), flags=0b0100 (has_event)
    const header = Buffer.from([0x11, 0x24, 0x00, 0x00]);  // serial=raw, compression=none
    const eventBuf = Buffer.alloc(4);
    eventBuf.writeUInt32BE(200, 0);   // event=200 TaskRequest
    const sidBytes = Buffer.from(this.sessionId, 'utf-8');
    const sidLenBuf = Buffer.alloc(4);
    sidLenBuf.writeUInt32BE(sidBytes.length, 0);
    const payloadSizeBuf = Buffer.alloc(4);
    payloadSizeBuf.writeUInt32BE(pcm.length, 0);

    this.ws.send(Buffer.concat([header, eventBuf, sidLenBuf, sidBytes, payloadSizeBuf, pcm]));
  }

  // ── 二进制帧解析 ──

  /** 处理服务端消息 */
  private onMessage(raw: WebSocket.RawData, isBinary: boolean): void {
    // ws 模块可能传 ArrayBuffer / ArrayBuffer[] / Buffer，统一转 Buffer
    const data: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (data.length < 4) {
      console.log(`[VoiceChat] ⚠️ 消息过短: ${data.length}B`);
      return;
    }

    // 调试: 打印前几个字节,便于排查协议问题
    if (data.length <= 512) {
      const preview = data.toString('utf-8').slice(0, 200);
      console.log(`[VoiceChat] 📥 收到消息 ${data.length}B: ${preview}`);
    } else {
      console.log(`[VoiceChat] 📥 收到消息 ${data.length}B (audio/binary)`);
    }

    // 解析 header
    const byte1 = data[1];
    const messageType = (byte1 >> 4) & 0x0F;
    const messageFlags = byte1 & 0x0F;

    let offset = 4;  // 跳过 4-byte header

    // 1) code (flags bit3, 仅 error 包)
    let errorCode = 0;
    if (messageFlags & 0b1000) {
      if (offset + 4 <= data.length) {
        errorCode = data.readUInt32BE(offset);
        offset += 4;
      }
    }

    // 2) event (flags bit2)
    let eventId = 0;
    if (messageFlags & 0b0100) {
      if (offset + 4 <= data.length) {
        eventId = data.readUInt32BE(offset);
        offset += 4;
      }
    }

    // 3) sequence (flags bit1)
    if (messageFlags & 0b0010) {
      if (offset + 4 <= data.length) {
        offset += 4;  // 跳过 sequence
      }
    }

    // 4) connect_id 或 session_id (根据事件类型)
    //    Connect 类事件 (eventId <= 99) → connect_id
    //    Session 类事件 (eventId >= 100) → session_id
    if (eventId > 0) {
      const isConnectEvent = eventId <= 99;
      if (offset + 4 <= data.length) {
        const idLen = data.readUInt32BE(offset);
        offset += 4;
        if (idLen > 0 && offset + idLen <= data.length) {
          offset += idLen;  // 跳过 ID 字段
        }
      }
    }

    // 5) payload
    let payload: Buffer | null = null;
    if (offset + 4 <= data.length) {
      const payloadSize = data.readUInt32BE(offset);
      offset += 4;
      if (payloadSize > 0 && offset + payloadSize <= data.length) {
        payload = data.subarray(offset, offset + payloadSize);
      }
    }

    // 处理 error 包
    if (messageType === 0x0F || errorCode > 0) {
      const errMsg = payload ? this.extractErrorMessage(payload) : `错误码: ${errorCode}`;
      this.emit({ type: 'error', message: `服务端错误: ${errMsg}` });
      this.setState('error');
      return;
    }

    // 按 eventId 处理
    switch (eventId) {
      case 50:  // ConnectionStarted → 发送 StartSession
        this.startSession();
        break;

      case 51:  // ConnectionFailed
        this.emit({ type: 'error', message: `连接被拒绝: ${payload ? payload.toString('utf-8') : '未知原因'}` });
        this.setState('error');
        break;

      case 52:  // ConnectionFinished
        break;

      case 150:  // SessionStarted → 可以开始说话
        this.setState('listening');
        this.emit({ type: 'ready' });
        break;

      case 152:  // SessionFinished
        break;

      case 153:  // SessionFailed
        this.emit({ type: 'error', message: `会话失败: ${payload ? payload.toString('utf-8') : '未知'}` });
        this.setState('error');
        break;

      case 350:  // TTSSentenceStart → AI 开始说话
        this.setState('speaking');
        break;

      case 352:  // TTSResponse — 音频数据(message_type=0b1011 audio-only server)
        if (payload && payload.length > 0) {
          this.emit({ type: 'aiAudio', data: payload });
        }
        break;

      case 359:  // TTSEnded → AI 说完
        this.emit({ type: 'aiAudioEnd' });
        this.setState('listening');
        break;

      case 450:  // ASRInfo — 用户开始说话
        this.setState('listening');
        break;

      case 451: { // ASRResponse — 识别结果(增量)
        if (payload) {
          const json = this.safeJson(payload);
          if (json) {
            const results = json.results as Array<{ text?: string; is_interim?: boolean }> | undefined;
            if (results && results.length > 0) {
              const text = results.map((r) => r.text || '').join('');
              const isInterim = results[0]?.is_interim;  // 诊断:读取是否中间结果
              console.log('[VoiceChat] 📝 ASR 451:', JSON.stringify(text).slice(0, 80), 'is_interim=', isInterim);
              if (text) {
                this.lastUserText = text;  // 累积最新文本
                this.emit({ type: 'userText', text });
              }
            }
          }
        }
        break;
      }

      case 453: { // AI 回复文本(旧事件号,兼容)
        // 豆包全链路对话自回复,正常显示在语音面板
        if (payload) {
          const json = this.safeJson(payload);
          if (json) {
            const text = json.text || json.content || '';
            if (text) this.emit({ type: 'aiText', text: String(text) });
          }
        }
        break;
      }

      case 550: { // ChatResponse — 模型回复文本(流式增量)
        if (payload) {
          const json = this.safeJson(payload);
          if (json) {
            const content = json.content || '';
            if (content) this.emit({ type: 'aiText', text: String(content) });
          }
        }
        break;
      }

      case 559:  // ChatEnded — 模型回复结束
        break;

      case 459: // ASREnded — 用户说话结束,触发 Agent 查询
        console.log('[VoiceChat] 🔔 ASREnded 到达, lastUserText:', JSON.stringify(this.lastUserText), 'hasCb:', !!this.userMsgCb, 'agentBusy:', this.agentBusy);
        if (this.lastUserText && this.userMsgCb) {
          if (this.agentBusy) {
            // P0: 上一个 Agent 任务还在执行,丢弃本次 — 避免并发 send 导致消息乱序
            console.log('[VoiceChat] ⚠️ Agent 正忙,丢弃本次 ASR:', this.lastUserText.slice(0, 60));
            this.lastUserText = '';
            break;
          }
          const msg = this.lastUserText;
          this.lastUserText = '';
          this.agentBusy = true;  // P0: 加锁,在 agentResult finally 中释放
          console.log('[VoiceChat] 📋 用户完整发言,转发给 Agent:', msg);
          // 回调是 async, 但不 await — 不阻塞 WS 消息处理循环
          // 加 .catch() 防止 unhandled rejection (agentResult 内部异常等)
          Promise.resolve(this.userMsgCb(msg)).catch(e => {
            console.error('[VoiceChat] ❌ onUserMessage 回调异常:', (e as Error)?.message);
            this.agentBusy = false;  // 确保异常时释放锁
          });
        }
        break;

      case 599: { // DialogCommonError
        if (payload) {
          const json = this.safeJson(payload);
          const msg = json?.message || json?.error || '对话错误';
          this.emit({ type: 'error', message: `对话错误: ${msg}` });
        }
        break;
      }

      default:
        // 未知事件号 — 打印诊断(仅 ≤512B 的消息,避免音频刷屏)
        if (payload && payload.length <= 512) {
          console.log(`[VoiceChat] ❓ 未知事件 eventId=${eventId}, payload=${payload.toString('utf-8').slice(0, 150)}`);
        } else {
          console.log(`[VoiceChat] ❓ 未知事件 eventId=${eventId}, payload=${payload?.length || 0}B`);
        }
        break;
    }
  }

  /** 从 payload 提取错误消息 */
  private extractErrorMessage(payload: Buffer): string {
    const json = this.safeJson(payload);
    if (json) return json.error || json.message || payload.toString('utf-8');
    return payload.toString('utf-8').slice(0, 200);
  }

  /** 安全 JSON 解析 */
  private safeJson(buf: Buffer): Record<string, any> | null {
    try {
      return JSON.parse(buf.toString('utf-8'));
    } catch {
      return null;
    }
  }

  private onError(err: Error): void {
    console.error('[VoiceChat] ❌ WebSocket error:', err.message);
    this.emit({ type: 'error', message: `WebSocket 错误: ${err.message}` });
    this.setState('error');
  }

  private onClose(code: number, reason: Buffer): void {
    const reasonStr = reason.toString('utf-8');
    console.log(`[VoiceChat] 🔌 WebSocket 关闭: code=${code}, reason=${reasonStr}`);
    if (this.state !== 'error') {
      this.setState('idle');
    }
    // 1006 = 异常关闭(通常是认证失败或 TLS 问题)
    if (code !== 1000 && code !== 1005) {
      let hint = '';
      if (code === 1006) {
        hint = '(可能是 App ID / Access Key 不正确,或未开通实时语音服务)';
      }
      this.emit({ type: 'error', message: `连接已断开 (code: ${code}) ${hint}` });
    }
  }
}
