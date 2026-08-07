> 🌐 Language: **English** | [中文](Messaging-Bots.zh-CN.md)

# Messaging Bots

KinetAios can receive messages from **Feishu (Lark)** and **WeCom (Enterprise WeChat)** via WebSocket long connections, route them to any agent engine, and reply with the agent's answer — plus auto-send any files/images the agent produces.

This turns your IM app into a remote agent terminal: send a text message, get an AI-powered response with file attachments.

## Supported platforms

| Platform | SDK | Connection mode |
|---|---|---|
| Feishu / Lark | `@larksuiteoapi/node-sdk` | WebSocket long connection |
| WeCom | `@wecom/aibot-node-sdk` | WebSocket long connection |

Both use official SDKs with built-in heartbeat, exponential-backoff reconnection, and message deduplication.

## Setup

### Feishu

1. Go to [Feishu Developer Console](https://open.feishu.cn/app) → create an app
2. Enable **Bot** capability
3. Under **Event Subscriptions**, switch to **Long Connection mode** (not HTTP callback)
4. Subscribe to `im.message.receive_v1`
5. Copy **App ID** and **App Secret** → paste into Settings → **Messaging** tab

### WeCom

1. Go to [WeCom Developer Portal](https://developer.work.weixin.qq.com/) → create a smart bot
2. Copy **Bot ID** and **Secret** from the bot management page
3. Paste into Settings → **Messaging** tab

### Settings fields

| Field | Description |
|---|---|
| Enabled | Toggle the bot on/off. Changing this auto-reconnects |
| App ID / Bot ID | Feishu App ID or WeCom Bot ID |
| App Secret / Secret | Corresponding secret |
| Engine | Which agent engine handles messages: `direct` / `directV2` / `claudeCode` / `codex` |
| Stream reply | On → send a "⏳ thinking…" placeholder first, then replace with the answer |
| Default cwd | Working directory for agent tool calls (shell, file ops) |

## How messages are routed

```
IM user sends message
    ↓
SDK WebSocket receives
    ↓
Bridge (feishu.ts / wecom.ts) normalizes to text
    ↓
Slash command? ── yes → handle immediately, reply
    ↓ no
Enqueue to per-user serial queue
    ↓
TaskManager.send(convId, text)
    ↓
Engine processes (ReAct loop / CLI spawn)
    ↓
Extract answer from last turn
    ↓
Extract artifacts (files/images from tool output)
    ↓
Reply text + upload & send attachments
```

## Slash commands

Users can manage their own sessions directly in the IM chat — no need to open the desktop app.

| Command | Action |
|---|---|
| `/new` | Start a new conversation (clears current context) |
| `/reset` | Clear current conversation's turns (keep the session, wipe history) |
| `/list` | Show up to 5 recent conversations with timestamps and turn counts |
| `/switch N` | Switch to the Nth conversation from `/list` |
| `/context` | Show current session info (turns, tokens, cost, cwd) |

Any unrecognized `/...` shows the help text.

## Session management

### Per-user conversation reuse

Messages from the same user are automatically routed to the same conversation, maintaining multi-turn context. The mapping key depends on chat type:

| Chat type | Key format | Behavior |
|---|---|---|
| Feishu DM | `feishu:${open_id}` | One conversation per user |
| Feishu group | `feishu:group:${chat_id}` | Shared conversation for the whole group |
| WeCom DM | `wecom:${userid}` | One conversation per user |
| WeCom group | `wecom:group:${chatid}` | Shared conversation for the whole group |

### Persistence

The `feishuKey` / `wecomKey` is stored on the `Conversation` record in SQLite. On app restart, the bridge scans all conversations and rebuilds the in-memory `Map<key, convId>`. If a Map lookup misses, it falls back to a SQLite scan.

### Eviction

Each user (or group) can have at most **5 conversations**. When creating a new one would exceed this limit, the oldest conversation is automatically deleted.

### Concurrent message handling

Messages from the same user are processed **serially** via a per-user promise chain (`enqueue()`). If user A sends 3 messages quickly, they queue up and execute one-by-one. Messages from different users run in parallel.

This replaces the old polling-based approach (`while + setTimeout(2000)` with 120s timeout).

## File & image auto-send (Feishu only)

When the agent produces files or images during tool execution, the bridge automatically:

1. **Extracts** file paths from tool outputs (`write_file`, `shell`, `read_file`, `feishu_send_file`)
2. **Uploads** each file to Feishu via `im.image.create` / `im.file.create`
3. **Replies** with the file/image message type

Supported file types: PNG, JPG, GIF, WebP (images); PDF, DOC, XLS, PPT, MP4, MP3 (files).

The agent can also proactively send files using the `feishu_send_file` tool.

## Source hints

When a conversation originates from Feishu or WeCom, a source hint is injected into the system prompt so the agent knows it's talking through an IM channel:

- **Feishu**: "You are responding in a Feishu conversation. Keep replies concise. Use `feishu_send_file` to send files."
- **WeCom**: "You are responding in a WeCom conversation. Keep replies concise (markdown supported, max ~4000 chars)."

## Key source files

| File | Role |
|---|---|
| `src/main/feishu.ts` | FeishuBridge: WS connection, message handling, file upload |
| `src/main/wecom.ts` | WeComBridge: WS connection, message handling |
| `src/main/engines.ts` | `sourceHintSection()` — injects IM context into system prompt |
| `src/main/tools.ts` | `feishuSendFile` tool registration |
| `src/shared/types.ts` | `FeishuBotConfig`, `WeComBotConfig`, `feishuKey`, `wecomKey` fields |
| `src/main/settings.ts` | Default bot configs |
| `src/main/main.ts` | IPC handlers, auto-start on launch, settings-change reconnect |
