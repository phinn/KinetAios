> 🌐 Language: **English** | [中文](MCP-Server.zh-CN.md)

# MCP Server

KinetAios includes a **built-in MCP (Model Context Protocol) Server** — an HTTP+SSE endpoint that exposes your local agent to remote machines. Other KinetAios instances (or any MCP-compatible client) can invoke `run_agent` to run tasks on your machine with full tool access.

This is the foundation of the [[Town]] remote collaboration feature.

## How it works

```
Remote machine                          Your machine (MCP Server)
     │                                            │
     │  POST /mcp  (JSON-RPC over HTTP)           │
     │  Authorization: Bearer <token>             │
     │ ─────────────────────────────────────────> │
     │                                            │  → run_agent(prompt, cwd, engine)
     │                                            │  → TaskManager dispatches to engine
     │                                            │  → streams AgentEvents
     │  <── SSE: data: {type:"token",...} ──────  │
     │  <── SSE: data: {type:"tool",...}  ──────  │
     │  <── SSE: data: {type:"done"}     ──────  │
     │                                            │
```

## Configuration

In **⚙ Settings → Behavior**:

| Setting | Effect |
|---|---|
| MCP Server enabled | Toggles the HTTP listener |
| Port | Default `0` (random) → displayed in status bar after start |
| Token | Auto-generated; required for all requests |

The server binds `0.0.0.0` (accessible from LAN). The token is shown in the status bar when the server is running.

## Authentication

- **Bearer token** in `Authorization` header (timing-safe comparison via HMAC-SHA256 normalization — no length-based timing leak).
- SSE endpoints **reject tokens passed as URL query parameters** (prevent logging in proxy/CDN logs).
- 5-minute idle timeout per connection.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/mcp` | JSON-RPC: `tools/list`, `tools/call` (returns SSE stream for `run_agent`) |
| `GET` | `/mcp` | SSE event stream (live agent events, read-only) |
| `GET` | `/` | Health check: `{ ok: true, server, mcp: true }` |

## `run_agent` tool

The primary remote tool. Accepts:

```json
{
  "prompt": "Fix the failing tests in src/utils.test.ts",
  "cwd": "/home/user/project",
  "engine": "direct",
  "model": "glm-4.6"
}
```

Returns an SSE stream of `AgentEvent`s (`token`, `tool`, `cost`, `status`, `done`, `error`) — same unified event union used internally.

### cwd grant boundary

`cwd` is optional and **must** fall inside the operator-granted roots. Grant roots with the
`KINET_MCP_CWD` environment variable (path-separator delimited, e.g. `KINET_MCP_CWD=/home/user/project:/home/user/work`):

- The containment check runs **before** the agent is dispatched — a `cwd` outside the granted roots is refused and **nothing executes** (no prompt, no tool calls).
- With no roots declared, the boundary defaults to the user's home directory.
- The generic tool fallback rejects a `cwd` argument by the same gate.

## Other exposed tools

- `list_conversations` — list local sessions
- `export_session` — serialize a session for handoff (auto-redacts API keys/secrets)
- `import_session` — deserialize a session (validates message structure, role whitelist, length limits)
- `sync_memories` — push/pull long-term memories between machines (deduplicates by content)
- `search_history` — FTS5 full-text search across all conversations

## Security

- **Export redaction**: `exportSession` strips API keys, secrets, and tokens matching common patterns (`sk-...`, `api_key=...`, etc.) before serialization.
- **Import validation**: `importSession` validates message roles (whitelist: system/user/assistant/tool), content types, and enforces length limits (500 messages, 50K chars/message).
- **Zombie connection cleanup**: SSE connections track backpressure; 3 consecutive write failures → destroy + remove from active list.

## Key source files

- `src/main/mcp-server.ts` — HTTP server, SSE streaming, tool dispatch, auth
- `src/main/TaskManager.ts` — `runAgent`, `exportSession`, `importSession`, `syncMemories`
- `src/shared/types.ts` — `AgentEvent` union, `McpTool` type
