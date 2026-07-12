> 🌐 Language: **English** | [中文](Engines.zh-CN.md)

# Three Engines

KinetAios supports three switchable agent engines, each session picks one independently. **Switching engines clears cross-engine context** (the three engines don't share history formats — Direct stores `directHistory: ChatMsg[]`, Claude/Codex use session ids via `--resume`).

## One-liner

| Engine | Implementation | Tool system | Use when |
|---|---|---|---|
| **Direct (Kaios)** | Built-in ReAct loop, talks directly to LLM provider | The 10 tools in `tools.ts` + MCP | You want tool/cost/step control |
| **Claude Code** | Spawns `claude -p --output-format stream-json` | Claude Code's own (Read/Write/Edit/Bash/Glob/Grep) | You're a Claude Code CLI user |
| **Codex** | Spawns `codex exec --json` | Codex's own | You're a Codex CLI user |

CLI engines need their CLIs installed locally; they're off by default. ⚙ → Behavior → "Enable CLI engines" turns on PATH scanning.

## Direct (Kaios)

The built-in engine. See [[Direct-Engine]].

- **Protocol**: `OpenAI-compatible` or `Anthropic` (your choice). Provider in `src/main/glm.ts`.
- **Streaming**: SSE, bidirectional OpenAI ↔ Anthropic conversion.
- **Tools**: Consecutive read-only tools (`read_file` / `grep` / `glob` / `web_fetch` / `recall_memory` / `git_diff`) run in parallel; write tools (`shell` / `write_file` / `edit_file` / `dispatch_agent`) run serially. Results backfill by `tool_call_id`.
- **History**: `conv.directHistory: ChatMsg[]`, persistent across turns, mirrored into the `history` table for `recall_memory` FTS5.
- **Context-too-long fallback**: reactive trim — on context-too-long API error, halve the budget and retry the turn once (`AgentLoop.ts:44`).
- **Compaction**: when over 30K, the head is summarized by an LLM into a single message, keeping the tail's recent turns intact (`compactHistory`).

See [[Direct-Engine]], [[Tools-and-MCP]].

## Claude Code

Spawns `claude -p --output-format stream-json --verbose --include-partial-messages`. Parses NDJSON line by line.

| Behavior | Implementation |
|---|---|
| Tool whitelist | `--allowedTools Read,Edit,Write,Bash,Glob,Grep` |
| Sandbox | `--permission-mode plan/acceptEdits/bypassPermissions` (from `sandbox` setting) |
| Working dir | `--add-dir <cwd>` |
| Resume | `--resume <session_id>` (stored in `conv.engineSessionId`, updated after each turn) |
| Inject memory/rules | `--append-system-prompt <rules+context+memory>` |

Event model: see `ClaudeCodeEngine` around `engines.ts:264`. `init` grabs session id, `assistant` extracts tool_use, `user` extracts tool_result, `result` carries cost + done/error.

## Codex

Spawns `codex exec --json --skip-git-repo-check -C <cwd> --add-dir <cwd> -s <sandbox>`. Parses JSONL line by line.

| Behavior | Implementation |
|---|---|
| Sandbox | `-s read-only/workspace-write/danger-full-access` (from `sandbox` setting) |
| Resume | `resume <session_id>` |
| Inject memory/rules | codex has no `--append-system-prompt` flag → rules + context + memory prepended to prompt |

Event model: see `CodexEngine` around `engines.ts:349`.

## Cross-platform CLI spawn (important)

npm-global CLIs ship as `.cmd` shims on Windows. Node refuses to spawn `.cmd`/`.bat` directly (CVE-2024-27980), so `engines.ts:resolveBin` routes `.cmd`/`.bat` through `shell: true` and spawns real `.exe`/unix bins directly (clean argv, smaller prompt-injection surface).

`binEnv()` augments `PATH` with common install dirs (`%APPDATA%\npm` / `~/.npm-global` / `/opt/homebrew/bin`, etc.) because a GUI-launched Electron app inherits a sparse PATH and would not find `claude`/`codex` otherwise.

On abort: on Windows the `.cmd` shim spawns cmd.exe as the direct child, so `child.kill()` only kills cmd.exe — the real claude/codex keeps running (still billable!). So we `taskkill /PID <pid> /T /F` to kill the whole tree. Unix just calls `child.kill()`.

## What switching loses

When you change `conv.engine`:
- `directHistory` is preserved (so you can switch back to Direct and continue)
- `engineSessionId` is cleared (the other engine's CLI session id is invalidated)
- Cross-engine conversation context doesn't transfer (each engine stores its own)

This is **intentional**: the three engines have different world models, tool sets, and state machines — forcing them to share would confuse users.

## Shared injections

Regardless of engine, these three blocks are injected **every turn** (assembled in `TaskManager.runTurn`):
- **memoryBlock** — long-term memory (user facts from `extractMemories`). Direct: history[0] user message; Claude: `--append-system-prompt`; Codex: prepended to prompt. See [[Long-Term-Memory]].
- **rulesBlock** — `KINET.md` (app-maintained project rules)
- **contextBlock** — `KINET-CONTEXT.md` (project-level background knowledge)

Direct additionally auto-reads `AGENTS.md`/`CLAUDE.md` (convention over config). See [[Rules-and-Context]].

## How to pick

- **Want to use GLM / DeepSeek / OpenAI / Anthropic directly + custom tools** → Direct
- **Already paying for Claude / OpenAI subscriptions, want the local CLI experience** → Claude Code / Codex
- **Not sure** → default to Direct, try it for a while, then decide
