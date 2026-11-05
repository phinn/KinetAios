> 🌐 Language: **English** | [中文](Engines.zh-CN.md)

# Engines

KinetAios ships **five generations of the built-in Direct engine** (V1–V5) plus CLI engines wired through the plugin system. Each session picks one independently. **Switching engines clears cross-engine context** (the engines don't share history formats — Direct stores `directHistory: ChatMsg[]`, Claude/Codex use session ids via `--resume`). On top of these, **plugin engines** (SDK v3) can register any external CLI agent as `plugin:<name>` — see [[Plugins]].

## One-liner

| Engine | Implementation | Tool system | Use when |
|---|---|---|---|
| **Direct V1 (Kaios)** | Built-in ReAct loop, talks directly to LLM provider | `tools.ts` built-ins + MCP | Q&A, small edits, tight cost/step control |
| **Direct V2** | Plan-Execute-Verify-Judge on top of V1's tools | Same + task-list cards | Multi-file changes with verification |
| **Direct V3** | Intent router → fast/std/deep paths; deep = DAG | Same + analysis mode | Data analysis, cross-file refactors, "not sure" |
| **Direct V4 (Legis)** | V3 router; deep path runs the Legis pipeline: compile → runtime → execute | Same as V3 + assertion gate | Long-horizon deep tasks needing plan-level rigor |
| **Direct V5 (Phylum)** | Population evolution: prompt → gene template → living expression executes → death settlement → scar inheritance | Same as V3 + affinity pruning | Repeatable task families that benefit from evolved templates |
| **Claude Code** *(plugin toggle)* | Spawns `claude -p --output-format stream-json` | Claude Code's own (Read/Write/Edit/Bash/Glob/Grep) | You're a Claude Code CLI user |
| **Codex** *(plugin toggle)* | Spawns `codex exec --json` | Codex's own | You're a Codex CLI user |
| **DeepSeek Harness** *(plugin engine)* | Spawns the `dsh` CLI headless profile | The CLI's own | One-shot DeepSeek runs |
| **plugin:<name>** | Spawns whatever CLI the plugin declares | The CLI's own | Wire up another CLI agent (zero code, manifest-only) |

CLI engines need their CLIs installed locally. They're **plugin-gated**: enable the `claude-code` / `codex` plugin in ⚙ → Plugins to add them to the engine dropdown. A guide for choosing between V1–V5 lives at [[Choose-Engine]].

## Direct V1 (Kaios)

The built-in ReAct engine. See [[Direct-Engine]].

- **Protocol**: `OpenAI-compatible` or `Anthropic` (your choice). Provider in `src/main/glm.ts`.
- **Streaming**: SSE, bidirectional OpenAI ↔ Anthropic conversion.
- **Tools**: Consecutive read-only tools (`read_file` / `grep` / `glob` / `web_fetch` / `recall_memory` / `git_diff`) run in parallel; write tools (`shell` / `write_file` / `edit_file` / `dispatch_agent`) run serially. Results backfill by `tool_call_id`.
- **History**: `conv.directHistory: ChatMsg[]`, persistent across turns, mirrored into the `history` table for `recall_memory` FTS5.
- **Context-too-long fallback**: reactive trim — on context-too-long API error, halve the budget and retry the turn once (`AgentLoop.ts:44`).
- **Compaction**: when over 30K, the head is summarized by an LLM into a single message, keeping the tail's recent turns intact (`compactHistory`).

See [[Direct-Engine]], [[Tools-and-MCP]].

## Direct V2 — Plan-Execute-Verify-Judge

`src/main/DirectV2Engine.ts`. Complex tasks enter a **planning phase** first (read-only exploration producing a step plan), then execute step by step; each step can carry a verification command (typecheck / tests) with automatic retry (≤3 per step, ≤2 replans). Task lists stream into the chat as live checklist cards (`todo_write`). Trivial tasks auto-degrade to plain mode.

## Direct V3 — intent router (default)

`src/main/V3/`. A zero-cost rules-based router picks one of three paths per query:

| Path | Trigger | Behavior |
|---|---|---|
| `fast` | lookups, docs, simple Q&A | single-round direct answer, zero overhead |
| `std` | bugfix, feature, data analysis | multi-round tool execution |
| `deep` | cross-file refactors, architecture changes | planned as a **DAG**; independent nodes run in parallel |

Deep path extras (v3.8.0):

- **Background execution** — deep tasks submit to `JobManager` (`src/main/JobManager.ts`); the session unlocks immediately and can keep chatting. Live running-node count + cost while it works; the result backfills when done. Toggle: ⚙ → "Run complex tasks in background (V3)" (default on).
- **Node-level checkpoints** — each completed DAG node persists a checkpoint; killed/failed/restarted jobs resume from the last checkpoint instead of restarting the whole graph. Jobs with checkpoints come back as `paused` — one click to resume.
- **Bounded same-layer parallelism** — read-only nodes in the same DAG layer run in batches of `dagConcurrency` (default 3); write nodes stay serial to prevent races.
- **Analysis mode** — when data files (csv/xlsx/db) appear in the task, V3 loads the `data-analysis` discipline: schema before conclusions, compute via tools (python/sqlite) not mental math, intermediate results on disk, sourced numbers, cross-checked key figures. Shows as 「📊 分析模式」 in the status bar.

See [[Choose-Engine]] for a task-by-task comparison.

## Direct V4 — Legis pipeline

`src/main/V4/`. Same router as V3 (fast/std reuse V3 paths); the deep path runs the **Legis pipeline** instead of free-form DAG execution:

1. **Compile** (LLM call #1) — `legis-compiler.ts`: the model submits a structured plan via forced `submit_legis_plan` tool-use. Nodes are typed `replay` (pure tool chains) or `agent` (sub-ReAct); the plan carries deterministic acceptance assertions. Compile-time validation: script tool whitelist, write ops forced to agent nodes, DAG acyclicity, unique node ids.
2. **Runtime** — `legis-executor.ts`: topological layering (same layer: read-only parallel, writes serial — V3 semantics). `replay` nodes run with **zero LLM calls**; `agent` nodes run sub-agent loops. 429 → park with backoff, not fail.
3. **Assert & recall** — assertion failure → minimal failure context recalled to the LLM (call #2..n) → patch → node resumes. Plan acceptance all-green → GOAL_COMPLETE.

The essential difference from V3: **LLM appearances drop from "once per step" to "once per program"**. Router, JobManager background execution and checkpoint resume are all inherited from V3.

## Direct V5 — population evolution (Phylum)

`src/main/V5/`. paradigm: agents don't learn, they breed. The prompt is normalized into a task-template id (signature v1); a living expression is claimed from the gene pool and executed (hard constraints: affinity-pruned tools, maxSteps budget, assertion gate). Execution ends in death settlement; scars from failures are inherited by the next generation.

- **Gene pool**: task templates with accumulated execution records (store tables, see `V5/`)
- **Constraints**: affinity tool pruning + maxSteps + assertion gate (`V5/bodyplan.ts`, assertions shared with V4)
- **When it wins**: repeatable task families where past failures should shape future attempts

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

## Plugin engines (SDK v3)

Any external CLI agent can be registered as an engine with a manifest-only plugin — no JS. The engine shows up as `plugin:<name>` in the dropdown and runs on the **same `CliEngineAdapter` skeleton** as Claude Code / Codex (spawn → line parsing → resume → exit fallback), configured by a declarative spec in `plugin.json`:

- `bin` — CLI to spawn (resolved like claude/codex)
- `protocol` — one of `ndjson` / `jsonl-claude` / `jsonl-codex` / `plain` (line→event presets)
- `resume` — which event field carries the session id + how to resume (`--resume <id>` flag or codex-style subcommand)
- `inject` — persona/rules/memory via `--append-system-prompt`-style flag or prepended to prompt

Details and a runnable example (`git` wrapped as an engine): [[Plugins]].

## Cross-platform CLI spawn (important)

npm-global CLIs ship as `.cmd` shims on Windows. Node refuses to spawn `.cmd`/`.bat` directly (CVE-2024-27980), so `engines.ts:resolveBin` routes `.cmd`/`.bat` through `shell: true` and spawns real `.exe`/unix bins directly (clean argv, smaller prompt-injection surface).

`binEnv()` augments `PATH` with common install dirs (`%APPDATA%\npm` / `~/.npm-global` / `/opt/homebrew/bin`, etc.) because a GUI-launched Electron app inherits a sparse PATH and would not find `claude`/`codex` otherwise.

On abort: on Windows the `.cmd` shim spawns cmd.exe as the direct child, so `child.kill()` only kills cmd.exe — the real claude/codex keeps running (still billable!). So we `taskkill /PID <pid> /T /F` to kill the whole tree. Unix just calls `child.kill()`.

## What switching loses

When you change `conv.engine`:
- `directHistory` is preserved (so you can switch back to Direct and continue)
- `engineSessionId` is cleared (the other engine's CLI session id is invalidated)
- Cross-engine conversation context doesn't transfer (each engine stores its own)

This is **intentional**: the engines have different world models, tool sets, and state machines — forcing them to share would confuse users.

## Shared injections

Regardless of engine, these three blocks are injected **every turn** (assembled in `TaskManager.runTurn`):
- **memoryBlock** — long-term memory (user facts from `extractMemories`). Direct: history[0] user message; Claude: `--append-system-prompt`; Codex: prepended to prompt. See [[Long-Term-Memory]].
- **rulesBlock** — `KINET.md` (app-maintained project rules)
- **contextBlock** — `KINET-CONTEXT.md` (project-level background knowledge)

Direct additionally auto-reads `AGENTS.md`/`CLAUDE.md` (convention over config). See [[Rules-and-Context]].

## How to pick

- **Want GLM / DeepSeek / OpenAI / Anthropic direct + custom tools** → Direct (V1 for quick tasks, V3 for anything multi-step)
- **Already paying for Claude / OpenAI subscriptions, want the local CLI experience** → Claude Code / Codex
- **Not sure** → V3 default; it routes fast/std/deep by itself. Full comparison: [[Choose-Engine]]
