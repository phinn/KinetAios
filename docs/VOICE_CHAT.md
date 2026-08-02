# 实时语音对话功能文档

> KinetAiosWin 基于豆包（火山引擎）实时语音大模型的双向音频流对话功能。

## 功能概述

用户在聊天界面点击「对话」按钮，即可进入实时语音对话模式：

- **实时说话** → ASR 自动识别为文本
- **豆包大模型** → 实时生成回复文本 + TTS 语音
- **双向音频流** → WebSocket 全双工通信，边说边听
- **项目上下文注入** → 自动把当前工作目录、项目名、最近对话摘要注入 system\_role
- **Agent 桥接** → ASR 判定说完一句话后，转发给当前频道的 Agent 执行

---

## 架构总览

```
┌──────────────────────────────────────────────────────┐
│                   Renderer 进程                       │
│                                                      │
│  getUserMedia(16kHz) → AudioWorklet → Float32→Int16  │
│       → base64 → IPC(voice-chat-send-audio)          │
│                                                      │
│  IPC(voice-chat-event) ← 音频/文本/状态               │
│       → playAiAudio(24kHz PCM → 扬声器)               │
│       → 实时显示用户文本 + AI 文本                     │
└──────────────┬───────────────────────────────────────┘
               │ IPC (contextBridge)
┌──────────────┴───────────────────────────────────────┐
│                    Main 进程                          │
│                                                      │
│  VoiceChat.ts                                        │
│    ├─ WebSocket → wss://openspeech.bytedance.com     │
│    ├─ 二进制帧协议 (4B header + event + payload)     │
│    ├─ 发送: StartConnection → StartSession → 音频    │
│    ├─ 接收: ASR 文本 / AI 文本 / TTS 音频 / 错误     │
│    └─ ASREnded(459) → onUserMessage → Agent          │
│                                                      │
│  main.ts                                             │
│    ├─ voice-chat-start: 注入项目上下文,启动连接       │
│    └─ onUserMessage: 转发给 TaskManager → Agent      │
└──────────────┬───────────────────────────────────────┘
               │ WebSocket (二进制帧)
┌──────────────┴───────────────────────────────────────┐
│            火山引擎 实时语音大模型                     │
│                                                      │
│  ASR (语音识别) → Dialog (豆包大模型) → TTS (语音合成) │
└──────────────────────────────────────────────────────┘
```

### 文件清单

| 文件 | 职责 |
|---|---|
| `src/main/VoiceChat.ts` | WebSocket 管理器：连接、二进制帧编解码、音频收发、事件分发 |
| `src/main/main.ts` | IPC handlers：`voice-chat-start/stop/send-audio/state/event`，Agent 桥接 |
| `src/main/settings.ts` | 凭据管理：App ID / Access Token（accessToken 加密存储） |
| `src/preload/preload.ts` | IPC 桥接：`voiceChatStart/Stop/SendAudio/State` + `onVoiceChatEvent` |
| `src/shared/types.ts` | 类型定义：`VoiceChatConfig`、`VoiceChatState` |
| `src/shared/i18n.ts` | 4 语言翻译：中文 / English / 繁體中文 / 日本語 |
| `src/renderer/app.ts` | UI 逻辑：音频采集、播放、状态显示、浮层交互 |
| `src/renderer/index.html` | 语音对话浮层 DOM 结构 |
| `src/renderer/styles.css` | 浮层样式（动画 orb、状态指示器等） |

---

## 二进制帧协议

### 帧结构

火山引擎实时语音 API 使用自定义二进制帧，非标准 WebSocket 文本协议。

```
┌─────────────────────────────────────────────────────────┐
│ Header (4 bytes)                                        │
│   byte 0:  0x11   (protocol version = 1)                │
│   byte 1:  0x14   (header size = 1, msg type = full)    │
│   byte 2:  0x10   (flags = has_event, serial = JSON)    │
│   byte 3:  0x00                                         │
├─────────────────────────────────────────────────────────┤
│ Event ID (4 bytes, big-endian)                          │
│   例如: 0x00 0x00 0x00 0x64 = 100 (StartSession)        │
├─────────────────────────────────────────────────────────┤
│ Session/Connect ID Length (4 bytes, big-endian)         │
│   * 仅 session/connect 类事件包含此字段                  │
│   纯音频帧(200)和大部分服务端事件不含                    │
├─────────────────────────────────────────────────────────┤
│ Session/Connect ID (UTF-8 字符串)                       │
├─────────────────────────────────────────────────────────┤
│ Payload Length (4 bytes, big-endian)                    │
├─────────────────────────────────────────────────────────┤
│ Payload (JSON 字符串或二进制音频)                        │
└─────────────────────────────────────────────────────────┘
```

### 消息类型（Header byte 1 低 4 位）

| 类型值 | 方向 | 说明 |
|---|---|---|
| `0x01` | Client → Server | Full client message（含 event + payload） |
| `0x02` | Client → Server | Audio-only client message（纯音频帧，无 event header） |
| `0x09` | Server → Client | Full server message |
| `0x0B` | Server → Client | Audio server message（TTS 音频） |
| `0x0F` | Server → Client | Error message |

### 序列化方式

`0x00` = Raw / `0x10` = JSON。当前实现统一使用 JSON 序列化。

---

## 事件序列

### 客户端事件

```
客户端                           服务端
  │                                │
  │── StartConnection (event=1) ──→│  无 connect_id
  │                                │
  │←── ConnectionStarted (50) ────│  返回 connect_id
  │                                │
  │── StartSession (event=100) ──→│  含 session_id + ASR/Dialog/TTS 配置
  │                                │
  │←── SessionStarted (150) ──────│  会话建立
  │                                │
  │══ 音频流 (event=200) ════════→│  持续发送麦克风 PCM
  │                                │
  │←══ ASR 增量文本 (451) ════════│  用户正在说话
  │←══ ASR 结束 (459) ════════════│  一句话说完了
  │←══ AI 回复文本 (550) ═════════│  豆包流式回复
  │←══ TTS Start (350) ═══════════│  语音合成开始
  │←══ TTS 音频 (352) ════════════│  PCM 音频数据
  │←══ TTS End (359) ═════════════│  语音合成结束
  │                                │
  │── StopConnection (event=2) ──→│  断开连接
  │                                │
```

### 关键事件号一览

| Event ID | 方向 | 名称 | 说明 |
|---|---|---|---|
| **1** | C→S | StartConnection | 初始化连接，payload=`{}` |
| **2** | C→S | StopConnection | 关闭连接 |
| **50** | S→C | ConnectionStarted | 返回 `connect_id` |
| **100** | C→S | StartSession | ASR/Dialog/TTS 完整配置 |
| **150** | S→C | SessionStarted | 返回 `dialog_id`，可以开始发音频 |
| **200** | C→S | AudioData | 麦克风 PCM 音频（二进制） |
| **350** | S→C | TTSStart | AI 语音合成开始 |
| **352** | S→C | TTSAudio | TTS PCM 音频数据 |
| **359** | S→C | TTSEnd | AI 一段语音结束 |
| **450** | S→C | ASRInfo | 用户开始说话（VAD 触发） |
| **451** | S→C | ASRResponse | ASR 识别结果（增量，可能多次） |
| **459** | S→C | ASREnded | 一句话说完，触发 Agent 查询 |
| **453** | S→C | AIResponseText | AI 回复文本（旧事件号，兼容） |
| **550** | S→C | ChatResponse | 豆包流式回复文本 |
| **559** | S→C | ChatEnded | 模型回复结束 |
| **599** | S→C | DialogCommonError | 对话错误 |

---

## StartSession 配置（event=100）

```typescript
{
  asr: {
    audio_info: {
      format: 'pcm',          // PCM 原始格式
      sample_rate: 16000,     // 16kHz 采样率
      channel: 1,             // 单声道
    },
  },
  dialog: {
    bot_name: 'AI助手',
    system_role: '...',       // 人设 + 项目上下文（见下文）
    bot_personality: '...',   // 与 system_role 一致（部分版本用此字段）
    extra: {
      input_mod: 'keep_alive',// 保持连接活跃
      model: '1.2.1.1',       // 豆包实时语音大模型版本
    },
  },
  tts: {
    speaker: 'zh_female_vv_jupiter_bigtts',  // 音色 ID
    audio_config: {
      format: 'pcm_s16le',    // 16-bit 有符号 PCM
      sample_rate: 24000,     // 24kHz 采样率
      channel: 1,             // 单声道
    },
  },
}
```

### 音色选项

| Voice Type | 说明 |
|---|---|
| `zh_female_vv_jupiter_bigtts` | 默认音色（女声） |
| `zh_female_wanwanxiaohe_moon_bigtts` | 豌豆小嘴（女声） |

> 可在设置 → 高级 → 音色下拉菜单中切换。

---

## 项目上下文注入

启动语音对话时，自动从当前活跃聊天频道提取上下文，注入到 `system_role`：

**数据来源：**
- `taskManager.list()[0].cwd` — 当前项目路径
- `taskManager.list()[0].turns.slice(-3)` — 最近 3 轮对话

**注入后的 system\_role 示例：**

```
你是一个友好的AI助手。用户当前正在「KinetAiosWin」项目中工作
(路径: /Users/phinn/Documents/kinet/KinetAiosWin)。
以下是最近的对话记录,供你参考:
用户:帮我看看main.ts → 回答:已查看main.ts文件...
用户:修复bug → 回答:已修复...

请用简洁易懂的中文回答。如果用户问到当前项目相关信息,
基于以上上下文回答。
```

**代码位置：** `src/main/main.ts` → `voice-chat-start` IPC handler

---

## 认证 Headers

WebSocket 握手时需携带 5 个自定义 Headers：

| Header | 值 |
|---|---|
| `X-Api-App-ID` | 火山引擎控制台的 App ID |
| `X-Api-Access-Key` | 实时语音服务的 Access Token |
| `X-Api-Resource-Id` | `volc.speech.dialog`（固定值） |
| `X-Api-App-Key` | `PlgvMymc7f3tQnJ6`（应用标识） |
| `X-Api-Connect-Id` | UUID（每次连接随机生成） |

> Access Token 通过 Electron `safeStorage` API 加密存储在 `settings.json` 中。

---

## IPC 通道

### Renderer → Main

| 频道 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `voice-chat-start` | 无 | `{ ok: boolean, error?: string }` | 启动语音对话（含上下文注入） |
| `voice-chat-stop` | 无 | `{ ok: true }` | 停止并断开 |
| `voice-chat-send-audio` | `base64 PCM string` | `{ ok: boolean }` | 发送麦克风音频帧 |
| `voice-chat-state` | 无 | `{ state: VoiceChatState }` | 查询当前状态 |

### Main → Renderer

| 频道 | Payload | 说明 |
|---|---|---|
| `voice-chat-event` | `VoiceChatEvent` | 推送所有语音事件（状态/文本/音频/错误） |

### VoiceChatEvent 类型

```typescript
type VoiceChatEvent =
  | { type: 'state'; state: VoiceChatState }
  | { type: 'userText'; text: string }       // ASR 用户文本（增量）
  | { type: 'aiText'; text: string }         // AI 回复文本（增量）
  | { type: 'aiAudio'; data: string }        // AI 音频（base64 PCM）
  | { type: 'aiAudioEnd' }                   // 一段音频结束
  | { type: 'agentReply'; text: string }     // Agent 执行结果
  | { type: 'error'; message: string }
  | { type: 'ready' };                       // 会话已就绪
```

---

## 音频格式

### 录音链路（Renderer → Server）

```
麦克风 → getUserMedia({ sampleRate: 16000 })
       → AudioWorkletNode (或 ScriptProcessor 回退)
       → Float32Array → Int16Array (PCM s16le)
       → base64 编码
       → IPC → main → WebSocket event=200
```

| 参数 | 值 |
|---|---|
| 采样率 | 16 kHz |
| 格式 | PCM signed 16-bit little-endian |
| 声道 | 单声道 |
| 帧大小 | 2048 samples（约 128ms） |

### 播放链路（Server → Renderer）

```
WebSocket event=352 → main → base64 PCM
    → IPC → renderer playAiAudio()
    → Int16Array → Float32Array
    → AudioContext(24000) → AudioBufferSourceNode → 扬声器
```

| 参数 | 值 |
|---|---|
| 采样率 | 24 kHz |
| 格式 | PCM signed 16-bit little-endian |
| 声道 | 单声道 |
| 播放方式 | 串行队列（`vcPlayQueue`），逐块播放 |

---

## 状态机

```
idle ──start()──→ connecting ──SessionStarted(150)──→ connected
                                                          │
                                                    ┌─────┴─────┐
                                                    │           │
                                              ASRInfo(450)  TTSStart(350)
                                                    │           │
                                                listening    speaking
                                                    │           │
                                              ASREnded(459)  TTSEnd(359)
                                                    │           │
                                                    └─────┬─────┘
                                                          │
                                                     connected
                                                          │
                                                   close()/error
                                                          │
                                                        idle
                                                         or
                                                        error
```

**状态枚举：** `idle | connecting | connected | speaking | listening | error`

---

## Agent 桥接机制

除了豆包自己回答外，语音对话还支持把 ASR 结果转发给 KinetAios 的 Agent 引擎：

1. 服务端发送 **ASREnded (event=459)** — 表示用户说完了一句话
2. `VoiceChat` 触发 `userMsgCb(lastUserText)`
3. `main.ts` 收到回调：
   - 找到当前活跃频道 `convs[0]`
   - 如果频道空闲 → `taskManager.send(conv.id, text)` 发给 Agent
   - 如果频道忙碌 → 返回"频道正在执行任务中"
4. 轮询 turn 完成（500ms 间隔，60s 超时）
5. Agent 结果通过 `voiceChat.agentResult(answer)` 推回 renderer

> **注意：** 豆包会同时自己生成回复（event 550），两条路径并行。豆包端到端回复更快（实时流式），Agent 桥接用于需要工具调用的复杂查询。

---

## 设置配置

路径：设置 → 高级 → 🎙️ 实时语音助手

```json
{
  "voiceChat": {
    "appId": "your-app-id",
    "accessToken": "your-access-token",
    "wsUrl": "wss://openspeech.bytedance.com/api/v3/realtime/dialogue",
    "voiceType": "zh_female_vv_jupiter_bigtts",
    "enable": true
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `appId` | ✅ | 火山引擎控制台 → 语音技术 → 应用管理 |
| `accessToken` | ✅ | 火山引擎控制台 → 实时语音 → Access Key |
| `wsUrl` | 可选 | WebSocket 地址（有默认值） |
| `voiceType` | 可选 | 音色 ID（有默认值） |
| `enable` | 可选 | 是否在聊天界面显示语音按钮 |
| `contextHint` | 自动 | 运行时自动生成，无需手动配置 |

---

## i18n 翻译 Key

| Key | 中文 | English |
|---|---|---|
| `voice.chatTitle` | 实时语音对话(双向音频流) | Realtime voice chat (bidirectional audio) |
| `voice.chatConnecting` | 正在连接… | Connecting… |
| `voice.chatConnected` | 已连接 | Connected |
| `voice.chatListening` | 正在聆听… | Listening… |
| `voice.chatSpeaking` | AI 正在回复… | AI is responding… |
| `voice.chatError` | 连接错误 | Connection error |
| `voice.chatHintSpeak` | 开始说话,AI 会自动回复 | Start speaking, AI will respond automatically |
| `voice.chatHintMute` | 点击麦克风可静音 | Click mic to mute |
| `voice.chatNeedConfig` | 请在设置 → 高级中配置… | Please configure… |
| `voice.chatEnd` | 结束 | End |

> 完整支持 4 语言：中文 / English / 繁體中文 / 日本語

---

## 调试

### 日志标签

所有 VoiceChat 日志统一以 `[VoiceChat]` 前缀输出到 main 进程 stdout：

```
[VoiceChat] 🔌 WebSocket 连接中: wss://openspeech.bytedance.com/...
[VoiceChat] ✅ WebSocket 已连接
[VoiceChat] 📤 发送 StartConnection (event=1)
[VoiceChat] 📥 ConnectionStarted (event=50), connectId=xxx
[VoiceChat] 📤 发送 StartSession (event=100), sessionId: xxx
[VoiceChat] 📝 system_role: 你是一个友好的AI助手...
[VoiceChat] 📎 项目上下文注入: 项目=KinetAiosWin, 轮次=5
[VoiceChat] ✅ SessionStarted (event=150)
[VoiceChat] 🎤 开始发送音频...
[VoiceChat] 📋 用户完整发言,转发给 Agent: 当前项目是什么
[VoiceChat] 🔌 WebSocket 关闭: code=1000
```

### 常见问题

| 现象 | 原因 | 解决方案 |
|---|---|---|
| WebSocket code=1006 | 认证失败 / 未开通服务 | 检查 App ID 和 Access Token；确认火山引擎控制台已开通实时语音对话服务 |
| 无声音播放 | 浏览器音频策略阻止 | 确保用户已与页面交互（点击操作） |
| 麦克风无输入 | 权限被拒 | 系统设置 → 隐私 → 麦克风 → 允许 KinetAios |
| AI 抢答 | 豆包端到端回复先于 Agent | 属正常行为；Agent 桥接用于复杂工具查询 |
| 上下文未注入 | 当前会话无 cwd | 确保聊天频道有活跃的工作目录 |

---

## 参考资源

- **火山引擎实时语音文档：** https://www.volcengine.com/docs/6561
- **参考实现：** studyapp 项目 (`/Users/phinn/Documents/austin/studyapp/StudyApp/AIAssistant/VoiceChatManager.swift`)
- **WebSocket 库：** `ws` (npm)
- **协议版本：** v3 (`/api/v3/realtime/dialogue`)
