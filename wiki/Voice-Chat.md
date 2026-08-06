> 🌐 Language: **English** | [中文](Voice-Chat.zh-CN.md)

# Realtime Voice Chat

Realtime bidirectional voice conversation powered by the Volcengine (Doubao) realtime voice model. Speak naturally — the AI listens, transcribes, responds with natural TTS, and can trigger Agent tool execution in parallel.

## Quickstart

1. **⚙ Settings → Voice Chat** — fill in Volcengine App ID + Access Token.
2. Click **🎤** in the composer bar to open the voice overlay.
3. Speak — your words appear as live transcription.
4. The AI responds with natural voice (Doubao TTS).
5. Click **🎤** again (or the close button) to end the session.

## How it works

```
User speaks → Mic (AudioWorklet 16kHz PCM)
            → WebSocket binary frames (event 200)
            → Volcengine ASR (event 451: incremental transcription)
            → ASR complete (event 459: full utterance)
                          ↓
                    ┌─────┴─────┐
                    ↓           ↓
              Doubao LLM     Local Agent
              (event 453/550)  (taskManager.send)
                    ↓           ↓
              Doubao TTS     Agent result
              (event 352)      → WS 502 injection
                    ↓              → Doubao TTS
              AI audio          Agent audio
```

The session runs in **full-dialogue mode**: Doubao handles the complete ASR → LLM → TTS pipeline. Simultaneously, the recognized text is forwarded to the local Agent engine for tool execution (shell, file operations, etc.). The Agent's result is injected back into the WS channel (event 502) for TTS playback.

## Key features

### Channel binding
Voice chat binds to the **active conversation** at the moment you press 🎤. All Agent results are sent to that conversation's main chat window — switching channels mid-session won't redirect messages.

### Project context injection
When voice starts, it reads the current project's `cwd` and the last 3 conversation turns, injecting them as `system_role`. Ask "what framework is this project using?" — the AI knows.

### Concurrency protection
- **`agentBusy` lock** — while an Agent task is running, new ASR utterances are queued/discarded (prevents interleaved responses).
- **Double-check** — VoiceChat locks on event 459, TaskManager re-checks `conv.status === 'running'` as a second guard.
- **TTS serialization** — Agent TTS waits for Doubao TTS to finish before injecting (up to 15s timeout).

### Agent result display
Agent results appear in the **main chat window** (via `agent-event` streaming), not in the voice overlay. The voice overlay only shows live transcription and Doubao's own dialogue — keeping the chat history clean and consistent with text-based conversations.

## Configuration

### Volcengine credentials

| Field | Description |
|---|---|
| App ID | Volcengine speech app identifier |
| Access Token | Authentication key for the WS endpoint |
| Voice Type | TTS speaker voice (default: `zh_female_vv_jupiter_bigtts`) |

The WS endpoint is `wss://openspeech.bytedance.com/api/v3/realtime/dialog` with resource ID `volc.speech.dialog`.

### Binary protocol

The WS connection uses a custom binary frame protocol (not JSON-over-text):

- **4-byte header**: `0x11 0x14 0x10 0x00` (protocol version, header size, message type, flags)
- **4-byte event ID** (big-endian)
- **Session/Connection ID** (size-prefixed)
- **Payload** (size-prefixed JSON or raw audio)

Key events:

| Event | Direction | Description |
|---|---|---|
| 1 | C→S | StartConnection |
| 50 | S→C | ConnectionStarted |
| 100 | C→S | StartSession (ASR + Dialog + TTS config) |
| 150 | S→C | SessionStarted — ready to speak |
| 200 | C→S | Audio data (16kHz PCM) |
| 451 | S→C | ASR incremental result |
| 459 | S→C | ASR ended — triggers Agent |
| 453/550 | S→C | AI dialogue text |
| 352 | S→C | TTS audio response |
| 359 | S→C | TTS ended |
| 502 | C→S | ChatRequest — inject text for TTS |
| 102 | C→S | FinishSession |

## Audio pipeline

- **Capture**: AudioWorklet at 16kHz mono PCM → base64 → WS event 200
- **Playback**: event 352 audio chunks queued → serial playback (drainPlayQueue) at 24kHz
- **Interrupt**: speaking → listening state transition on event 359 (TTSEnded)

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| WS closes immediately (code 1006) | Wrong App ID / Access Token, or service not activated |
| No ASR transcription (events 451/459 never arrive) | StartSession configured in full-dialogue mode — Doubao handles everything internally |
| Agent result not spoken | WS connection may have closed; check `agentResult` logs |
| Audio overlap | Should not happen — `agentBusy` + TTS serialization prevents it |

## Key source files

- `src/main/VoiceChat.ts` — WS manager, binary protocol, session lifecycle, Agent bridge
- `src/main/main.ts:~1948` — `voice-chat-start` IPC handler, context injection, `onUserMessage` callback
- `src/renderer/app.ts:~4189` — `onVoiceChatEvent` listener, overlay UI, audio capture/playback
- `src/preload/preload.ts` — `voiceChatStart(convId)` / `voiceChatStop` IPC bridge
