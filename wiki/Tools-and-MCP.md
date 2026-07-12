> 🌐 Language: **English** | [中文](Tools-and-MCP.zh-CN.md)

# Tools + MCP

The Direct engine has 10 built-in tools + auto-connects to MCP services configured on the system. Claude Code / Codex use their own CLI tooling, not this layer.

## 10 built-in tools

| Tool | Type | Purpose |
|---|---|---|
| `shell` | write | Run a shell command (cmd.exe on Windows, sh on Unix). **Asks for confirmation first** (unless setting `approval: 'never'`) |
| `read_file` | read-only | Read file contents. Returns UTF-8 text |
| `write_file` | write | Write a file (path + content direct, **the only correct way**; from a few KB to a few hundred KB in one shot) |
| `edit_file` | write | Precise replace (`old_string` → `new_string`, optional `replace_all`) |
| `grep` | read-only | Recursive content search. Returns matching lines + line numbers |
| `glob` | read-only | List files by pattern (`**/*.ts`) |
| `web_fetch` | read-only | Fetch a URL, return markdown-ized body |
| `recall_memory` | read-only | FTS5 full-text search of history (`history` table) |
| `git_diff` | read-only | Read git diff (args: `file`, `ref`, `cached`). **No confirmation** (read-only) |
| `dispatch_agent` | write | Dispatch a read-only sub-agent (own history, see [[Direct-Engine]]) |

## `shell` tool

```
shell({ cmd: string, cwd?: string }) → string
```

- Windows: `cmd.exe /c <cmd>`
- Unix: `sh -c <cmd>`
- Output merges stdout + stderr, plus exit code
- **Confirms by default**: renderer shows a modal with the command, only runs on user approval
- `approval: 'never'` short-circuits (no modal)

Confirm bridge details in [[Architecture]] under "Shell-confirm bridge".

## `write_file` tool (emphasis)

baseSystemPrompt repeats this:

> The only correct way to write a file is the write_file tool (path + content direct).
> write_file has no length limit — a few KB, tens of KB, hundreds of KB all write in one shot.
> Never switch to shell echo/cat/heredoc, powershell Set-Content, or base64 decode "because the content is too long".
> Those shell/powershell forms almost always break under JSON+shell double-escaping.

Models occasionally try to be clever with shell heredocs (looks shorter as a one-liner). The system prompt forbids it. Reason: JSON arg escaping + shell quote escaping compound, and almost always corrupt content.

## `edit_file` tool

```
edit_file({ path: string, old_string: string, new_string: string, replace_all?: boolean })
```

Precise string replacement. `old_string` must be unique (not unique + no `replace_all: true` → fails, tells the model to add more context).

Good for small edits; for large changes use `write_file` to rewrite wholesale.

## `git_diff` tool

```
git_diff({ file?: string, ref?: string, cached?: boolean })
```

Arg combinations:
- `{}` — whole working tree diff
- `{ file: "src/x.ts" }` — single-file diff
- `{ ref: "main" }` — diff against a branch
- `{ cached: true }` — staged diff (`--cached`)
- `{ file, ref }` — single file vs branch

**Read-only, no confirmation modal**. Added in v1.0.

## Tool definition + ToolCtx

Defined in `src/main/tools.ts`:

```ts
interface Tool {
  name: string;
  description: string;
  readOnly?: boolean;       // determines parallel eligibility
  parameters: JSONSchema;   // OpenAI/Anthropic tool schema
  run(args, ctx: ToolCtx): Promise<string>;
}
```

`ToolCtx` is the runtime context: `cwd`, `confirm`, `signal`, `spawn` (for dispatch_agent sub-agents).

## Tool execution: parallel vs serial

`runToolBatch` (`AgentLoop.ts:197`):

- Collect consecutive read-only segments (`readOnly: true`) → `Promise.all` parallel
- Hit a write tool → run serially, one at a time
- Backfill results in original `toolCalls` order (`tool_call_id` matching)

Why:
- Read-only has no side effects, parallel saves time (5 file reads = 5x speedup)
- Write tools have ordering dependencies (shell changes a file, then read_file should see it) → must serialize

## MCP (Model Context Protocol)

`src/main/mcp.ts`.

### Auto-discovery

On startup, scans:
- `~/.claude.json` (Claude Desktop config)
- `~/.codex/config.toml` (Codex config)
- Claude Code's plugin config

Extracts all stdio MCP service configs (`command` + `args` + `env`), spins up a client for each.

### Integration

- Each client uses stdio (spawns a subprocess, JSON-RPC over stdin/stdout)
- Calls `tools/list` on connect to discover tools
- The Direct engine waits up to 2s on each turn for connections to be ready, then merges all MCP tools into the `tools` array
- Tool names are prefixed with the service name (to avoid collisions): `mcp__<server>__<tool>`
- Calls go through `tools/call`, results normalized to strings

### Auto-reconnect

If a stdio subprocess dies → auto-restart + re-`tools/list`. Available again on the next turn.

### 🔌 button

Main window's **🔌 MCP** button: lists connected services + each one's exposed tools. **Read-only display** — you can't edit configs here (edit `~/.claude.json` / `~/.codex/config.toml`, restart the app).

## Tool result truncation

`truncateForModel` (`AgentLoop.ts:250`):

- Head + tail: 3000 chars each
- Middle: `…[omitted N chars]…`
- Threshold: 8192

**Only the model-facing version is truncated; the UI gets the full original** (clickable in step details). See [[Direct-Engine]].

## When to extend tools

Adding a new tool:

1. Implement the `Tool` interface in `src/main/tools.ts` (name / description / parameters / run)
2. Add to `allTools()` or `readOnlyTools()` (depending on read-only-ness)
3. typecheck → ship

No need to touch AgentLoop, glm, or IPC. The ReAct loop auto-discovers.

Adding MCP tools: **no code changes**. Locally-installed MCP services are auto-discovered.
