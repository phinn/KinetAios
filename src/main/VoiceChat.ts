// VoiceChat.ts — 豆包实时语音大模型 WebSocket 管理器
// Realtime voice chat manager: connects to Volcengine (Doubao) realtime voice API via WebSocket,
// manages bidirectional audio streaming, sends user mic audio → receives AI audio response.
//
// 协议概述 / Protocol overview:
// 1. Renderer 采集麦克风 PCM (16kHz, 16-bit, mono) → IPC 传给 main → main 通过 WebSocket 发给服务端
// 2. 服务端返回 AI 语音音频 + 转写文本 → main 通过 IPC 推给 renderer
// 3. 用户可随时打断(说话时 AI 停止播放)
// 4. 支持"指令模式":用户语音 → ASR 转文字 → 填入 composer 或直接发给 Agent → 结果 TTS 回播
//
// 使用 ws 模块(Node WebSocket,支持自定义 headers)。
// ponytail: 当前实现走火山引擎实时语音对话 API (v3)。
// 二进制协议: 4-byte header + payload. 文档: https://www.volcengine.com/docs/6561
// 后续可扩展为 OpenAI Realtime API 或本地 whisper.cpp + TTS pipeline.

import WebSocket from 'ws';
import type { VoiceChatConfig } from '../shared/types.js';

// ── 事件类型(推给 renderer)──
export type VoiceChatEvent =
  | { type: 'state'; state: VoiceChatState }
  | { type: 'userText'; text: string }          // ASR 转写的用户语音文本(增量)
  | { type: 'aiText'; text: string }            // AI 回复文本(增量)
  | { type: 'aiAudio'; data: Buffer }           // AI 回复音频(PCM 16kHz 16-bit mono)
  | { type: 'aiAudioEnd' }                      // AI 一段音频播完
  | { type: 'error'; message: string }
  | { type: 'ready' };                          // WebSocket 连接成功,可以开始说话

export type VoiceChatState = 'idle' | 'connecting' | 'connected' | 'speaking' | 'listening' | 'error';

// ── 火山引擎实时语音 v3 协议常量 ──
// Binary framing: https://www.volcengine.com/docs/6561/1354557
const MSG_FULL_CLIENT = 0x01;       // 客户端→服务端:完整音频
const MSG_AUDIO_ONLY_CLIENT = 0x02;  // 客户端→服务端:仅音频(无 control)
const MSG_FULL_SERVER = 0x09;        // 服务端→客户端:完整响应
const MSG_AUDIO_SERVER = 0x0B;       // 服务端→客户端:仅音频
const MSG_ERROR = 0x0F;             // 服务端→客户端:错误

// 序列化 JSON header (0x10 = JSON header serialization)
const SERIAL_JSON = 0x10;
// GZIP compression (0x00 = no compression for simplicity, audio is raw PCM)
const COMPRESSION_NONE = 0x00;

type EventCb = (ev: VoiceChatEvent) => void;

export class VoiceChat {
  private ws: WebSocket | null = null;
  private cfg: VoiceChatConfig | null = null;
  private state: VoiceChatState = 'idle';
  private cb: EventCb | null = null;
  private sessionId = '';
  private sequenceNumber = 0;

  /** 设置事件回调 / Set event callback */
  onEvent(cb: EventCb): void {
    this.cb = cb;
  }

  /** 当前状态 / Current state */
  getState(): VoiceChatState {
    return this.state;
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
    this.sequenceNumber = 0;

    if (!cfg.appId || !cfg.accessToken) {
      this.emit({ type: 'error', message: '缺少 App ID 或 Access Token,请在设置 → 实时语音助手中填写' });
      this.setState('error');
      return;
    }

    const url = cfg.wsUrl || 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';

    try {
      this.ws = new WebSocket(url, {
        headers: this.buildHeaders(cfg),
      });
      this.ws.binaryType = 'arraybuffer';
      this.ws.on('open', () => this.onOpen());
      this.ws.on('message', (data: Buffer, isBinary: boolean) => this.onMessage(data, isBinary));
      this.ws.on('error', (err: Error) => this.onError(err));
      this.ws.on('close', (code: number, reason: Buffer) => this.onClose(code, reason));
    } catch (e) {
      this.emit({ type: 'error', message: `连接失败: ${(e as Error).message}` });
      this.setState('error');
    }
  }

  /** 停止并断开 / Stop & disconnect */
  close(): void {
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          // 发送 finish session 消息
          this.sendFinish();
        }
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }
    this.setState('idle');
  }

  /**
   * 发送麦克风音频(PCM 16kHz 16-bit mono)
   * Send microphone audio chunk (PCM 16kHz 16-bit mono)
   */
  sendAudio(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.sequenceNumber++;
    const frame = this.buildAudioFrame(pcm, this.sequenceNumber, false);
    this.ws.send(frame);
  }

  /**
   * 通知服务端用户开始说话(用于打断检测)
   * Notify server that user started speaking (for interruption detection)
   */
  sendUserStartTalking(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // 火山引擎协议中:客户端可发送 start-talking 信号
    // 这里用 control message 通知
  }

  // ── 内部方法 / Internal methods ──

  private setState(s: VoiceChatState): void {
    this.state = s;
    this.emit({ type: 'state', state: s });
  }

  private emit(ev: VoiceChatEvent): void {
    this.cb?.(ev);
  }

  /** 构建 WebSocket 握手 headers */
  private buildHeaders(cfg: VoiceChatConfig): Record<string, string> {
    return {
      'X-Api-App-Key': cfg.appId,
      'X-Api-Access-Key': cfg.accessToken,
      'X-Api-Resource-Id': 'volc.bigasr.sauc.duration',
      'X-Api-Connect-Id': this.genConnectId(),
    };
  }

  private genConnectId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /** WebSocket 连接成功 → 发送 StartSession */
  private onOpen(): void {
    this.sessionId = this.genConnectId();
    const startPayload = this.buildStartSession(this.cfg!);
    this.ws!.send(JSON.stringify(startPayload));
    this.setState('connected');
  }

  /** 构建 StartSession payload */
  private buildStartSession(cfg: VoiceChatConfig): object {
    return {
      event: 'StartSession',
      session_id: this.sessionId,
      // 音频配置:16kHz 16-bit mono PCM
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      channels: 1,
      // AI 音色
      voice_type: cfg.voiceType || 'zh_female_wanwanxiaohe_moon_bigtts',
      // 热词、场景等可选参数
      enable_punc: true,
      // 实时交互模式
      mode: 'dialogue',
    };
  }

  /** 发送 FinishSession */
  private sendFinish(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = {
      event: 'FinishSession',
      session_id: this.sessionId,
    };
    try {
      this.ws.send(JSON.stringify(payload));
    } catch { /* ignore */ }
  }

  /** 处理服务端消息 */
  private onMessage(data: Buffer, _isBinary: boolean): void {
    if (!data || data.length < 4) return;

    // 尝试解析二进制帧
    const msgType = data[0];
    const msgSpec = data[1];
    // const reserved = data.readUInt16BE(2);
    const payload = data.subarray(4);

    switch (msgType) {
      case MSG_FULL_SERVER:
      case MSG_AUDIO_SERVER:
        this.handleServerMessage(msgType, msgSpec, payload);
        break;
      case MSG_ERROR:
        this.handleServerError(payload);
        break;
      default:
        // 尝试 JSON 解析(有些版本用纯 JSON 协议)
        this.tryJsonMessage(data);
        break;
    }
  }

  /** 处理服务端音频/文本消息 */
  private handleServerMessage(msgType: number, msgSpec: number, payload: Buffer): void {
    // 检查是否包含 JSON header
    if (msgSpec & SERIAL_JSON || payload.length === 0) {
      // 尝试解析 JSON 部分(控制信息)和二进制部分(音频)
      const jsonEnd = payload.indexOf(0x7d); // '}' 的位置 — 粗略定位
      if (jsonEnd > 0) {
        const jsonStr = payload.subarray(0, jsonEnd + 1).toString('utf-8');
        const audioData = payload.subarray(jsonEnd + 1);
        try {
          const info = JSON.parse(jsonStr);
          this.processServerInfo(info, audioData);
        } catch {
          // JSON 解析失败,尝试当作纯音频
          if (audioData.length > 0) {
            this.emit({ type: 'aiAudio', data: audioData });
          }
        }
      } else if (payload.length > 0) {
        // 纯音频帧
        this.setState('speaking');
        this.emit({ type: 'aiAudio', data: payload });
      }
    } else {
      // 纯音频帧
      if (payload.length > 0) {
        this.setState('speaking');
        this.emit({ type: 'aiAudio', data: payload });
      }
    }
  }

  /** 处理服务端 JSON 信息 */
  private processServerInfo(info: any, audioData: Buffer): void {
    // ASR 转写结果(用户说的)
    if (info.result?.text || info.text) {
      const text = info.result?.text || info.text;
      const isFinal = info.is_final || info.isFull || false;
      if (info.from === 'user' || info.role === 'user' || !info.from) {
        // 默认当作用户输入文本(除非标记为 AI)
        if (info.from !== 'ai' && info.role !== 'assistant') {
          this.emit({ type: 'userText', text });
          this.setState('listening');
          return;
        }
      }
    }
    // AI 回复文本
    if (info.result?.text || info.text) {
      const text = info.result?.text || info.text;
      if (info.from === 'ai' || info.role === 'assistant') {
        this.emit({ type: 'aiText', text });
      }
    }
    // AI 音频
    if (audioData.length > 0) {
      this.setState('speaking');
      this.emit({ type: 'aiAudio', data: audioData });
    }
    // 音频结束标记
    if (info.is_last || info.end || info.event === 'AudioEnd') {
      this.emit({ type: 'aiAudioEnd' });
      this.setState('connected');
    }
  }

  /** 尝试纯 JSON 解析(兼容 JSON 协议版本) */
  private tryJsonMessage(data: Buffer): void {
    try {
      const text = data.toString('utf-8');
      const msg = JSON.parse(text);
      // 统一处理
      if (msg.event === 'Ready' || msg.event === 'SessionStarted') {
        this.setState('connected');
        this.emit({ type: 'ready' });
      } else if (msg.event === 'Error' || msg.error) {
        this.emit({ type: 'error', message: msg.error?.message || msg.message || '服务端错误' });
        this.setState('error');
      } else if (msg.event === 'ASRResult' || msg.event === 'Transcription') {
        const asrText = msg.result?.text || msg.text || '';
        if (asrText) this.emit({ type: 'userText', text: asrText });
        this.setState('listening');
      } else if (msg.event === 'LLMResult' || msg.event === 'Response') {
        const aiText = msg.result?.text || msg.text || '';
        if (aiText) this.emit({ type: 'aiText', text: aiText });
      } else if (msg.event === 'TTSResult' || msg.event === 'Audio') {
        const audioB64 = msg.data || msg.audio || '';
        if (audioB64) {
          const audioBuf = Buffer.from(audioB64, 'base64');
          this.setState('speaking');
          this.emit({ type: 'aiAudio', data: audioBuf });
        }
      } else if (msg.event === 'TTSEnd' || msg.event === 'AudioEnd') {
        this.emit({ type: 'aiAudioEnd' });
        this.setState('connected');
      }
    } catch {
      // 不是 JSON 也不是已知二进制帧,忽略
    }
  }

  /** 处理服务端错误帧 */
  private handleServerError(payload: Buffer): void {
    const msg = payload.toString('utf-8');
    let errMsg = msg;
    try {
      const j = JSON.parse(msg);
      errMsg = j.error?.message || j.message || msg;
    } catch { /* use raw */ }
    this.emit({ type: 'error', message: `服务端错误: ${errMsg}` });
    this.setState('error');
  }

  private onError(err: Error): void {
    this.emit({ type: 'error', message: `WebSocket 错误: ${err.message}` });
    this.setState('error');
  }

  private onClose(code: number, _reason: Buffer): void {
    if (this.state !== 'error') {
      this.setState('idle');
    }
    // 非正常关闭 → 提示
    if (code !== 1000 && code !== 1005) {
      this.emit({ type: 'error', message: `连接已断开 (code: ${code})` });
    }
  }

  /** 构建客户端音频帧(火山引擎二进制协议) */
  private buildAudioFrame(pcm: Buffer, sequence: number, isLast: boolean): Buffer {
    // Header: 1 byte msg_type | 1 byte msg_spec | 2 byte sequence_high | payload
    // 简化版:4-byte header + raw PCM
    const header = Buffer.alloc(4);
    header[0] = MSG_AUDIO_ONLY_CLIENT;
    header[1] = isLast ? 0x02 : 0x00;  // negative_sequence = is_last marker
    header.writeUInt16BE(Math.min(sequence, 0xFFFF), 2);
    return Buffer.concat([header, pcm]);
  }
}
