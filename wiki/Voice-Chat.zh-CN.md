> 🌐 Language: [English](Voice-Chat.md) | **中文**

# 实时语音对话

基于火山引擎(豆包)实时语音大模型的双向语音对话。自然说话——AI 听、转写、用自然 TTS 回复,同时可触发 Agent 工具执行。

## 快速开始

1. **⚙ 设置 → 语音对话** — 填入火山引擎 App ID + Access Token。
2. 点击输入栏的 **🎤** 打开语音浮层。
3. 说话——实时显示转写文本。
4. AI 用自然语音回复(豆包 TTS)。
5. 再点 **🎤**(或关闭按钮)结束会话。

## 工作原理

```
用户说话 → 麦克风(AudioWorklet 16kHz PCM)
        → WebSocket 二进制帧(event 200)
        → 火山 ASR(event 451: 增量转写)
        → ASR 结束(event 459: 完整发言)
                      ↓
                ┌─────┴─────┐
                ↓           ↓
          豆包 LLM       本地 Agent
          (event 453/550)  (taskManager.send)
                ↓           ↓
          豆包 TTS       Agent 结果
          (event 352)      → WS 502 注入
                ↓              → 豆包 TTS
          AI 音频          Agent 音频
```

会话运行在**全链路对话模式**:豆包负责完整的 ASR → LLM → TTS 管道。同时,识别到的文本被转发给本地 Agent 引擎执行工具(shell、文件操作等)。Agent 结果通过 WS 通道(event 502)注入,由豆包 TTS 朗读。

## 关键特性

### 频道绑定
语音对话绑定到按下 🎤 时的**当前活跃频道**。所有 Agent 结果发送到该频道的主聊天窗口——会话中途切换频道不会重定向消息。

### 项目上下文注入
语音启动时读取当前项目的 `cwd` 和最近 3 轮对话,注入为 `system_role`。问"这个项目用了什么框架"——AI 知道。

### 并发保护
- **`agentBusy` 锁** — Agent 任务执行期间,新的 ASR 发言会被丢弃(防止交错回复)。
- **双重检查** — VoiceChat 在 event 459 加锁,TaskManager 再检查 `conv.status === 'running'` 作为第二道防线。
- **TTS 串行化** — Agent TTS 等豆包 TTS 播完再注入(最长等 15 秒)。

### Agent 结果显示
Agent 结果出现在**主聊天窗口**(通过 `agent-event` 流式推送),不在语音浮层中独立显示。语音浮层只管实时转写和豆包对话——保持聊天记录干净,与文字输入行为一致。

## 配置

### 火山引擎凭据

| 字段 | 说明 |
|---|---|
| App ID | 火山引擎语音应用标识 |
| Access Token | WS 端点认证密钥 |
| Voice Type | TTS 说话人音色(默认:`zh_female_vv_jupiter_bigtts`) |

WS 端点为 `wss://openspeech.bytedance.com/api/v3/realtime/dialog`,资源 ID 为 `volc.speech.dialog`。

### 二进制协议

WS 连接使用自定义二进制帧协议(不是 JSON-over-text):

- **4 字节 header**:`0x11 0x14 0x10 0x00`(协议版本、header 大小、消息类型、flags)
- **4 字节 event ID**(大端)
- **Session/Connection ID**(长度前缀)
- **Payload**(长度前缀的 JSON 或原始音频)

关键事件:

| Event | 方向 | 说明 |
|---|---|---|
| 1 | C→S | StartConnection |
| 50 | S→C | ConnectionStarted |
| 100 | C→S | StartSession(ASR + Dialog + TTS 配置) |
| 150 | S→C | SessionStarted — 可以说话 |
| 200 | C→S | 音频数据(16kHz PCM) |
| 451 | S→C | ASR 增量结果 |
| 459 | S→C | ASR 结束 — 触发 Agent |
| 453/550 | S→C | AI 对话文本 |
| 352 | S→C | TTS 音频回复 |
| 359 | S→C | TTS 结束 |
| 502 | C→S | ChatRequest — 注入文本供 TTS 朗读 |
| 102 | C→S | FinishSession |

## 音频管道

- **采集**:AudioWorklet 16kHz 单声道 PCM → base64 → WS event 200
- **播放**:event 352 音频块排队 → 串行播放(drainPlayQueue)24kHz
- **打断**:speaking → listening 状态切换由 event 359(TTSEnded)触发

## 常见问题

| 症状 | 可能原因 |
|---|---|
| WS 立即关闭(code 1006) | App ID / Access Token 不对,或服务未开通 |
| 没有 ASR 转写(451/459 不来) | StartSession 配置为全链路模式 — 豆包内部处理一切 |
| Agent 结果没有语音播放 | WS 可能已断开;查看 `agentResult` 日志 |
| 音频重叠 | 不应发生 — `agentBusy` + TTS 串行化防止 |

## 关键源文件

- `src/main/VoiceChat.ts` — WS 管理器、二进制协议、会话生命周期、Agent 桥接
- `src/main/main.ts:~1948` — `voice-chat-start` IPC handler、上下文注入、`onUserMessage` 回调
- `src/renderer/app.ts:~4189` — `onVoiceChatEvent` 监听、浮层 UI、音频采集/播放
- `src/preload/preload.ts` — `voiceChatStart(convId)` / `voiceChatStop` IPC 桥接
