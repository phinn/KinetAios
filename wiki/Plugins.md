> 🌐 Language: **English** | [中文](Plugins.zh-CN.md)

# Plugin Engines (SDK v3)

Since SDK v3, **any external CLI agent can be registered as a KinetAios engine** — zero JS code, one declarative `engine` field in `plugin.json`. The plugin's CLI gets its own entry in the engine dropdown as `plugin:<name>`, streaming tokens, tool events, session resume and cost tracking — everything the built-in CLI engines (Claude Code / Codex) get.

This page is for **users** of plugin engines. For writing plugins in general (tools / slash commands / panels), see the dev SOP at [`KinetAiosPlugin.md`](../KinetAiosPlugin.md) in the repo root.

## Quick start

1. Drop a plugin folder into `<userData>/plugins/<name>/` (Settings → Plugins shows the exact path).
2. The plugin's `plugin.json` declares an `engine` block (see below).
3. Enable "CLI engines" in Settings → Behavior (plugin engines share the same toggle).
4. Pick the engine from the session header dropdown — it appears as `plugin:<name>` with its label.

The engine list **hot-rebuilds** after install / uninstall / enable / disable — no app restart. Conversations already running on an engine keep their old reference until they finish.

## The `engine` spec

```jsonc
{
  "name": "my-agent",
  "version": "1.0.0",
  "engine": {
    "bin": "my-agent",                    // CLI name, resolved from PATH + common install dirs
    "protocol": "plain",                  // ndjson | jsonl-claude | jsonl-codex | jsonl-gemini | plain (default)
    "args": ["--no-color"],               // argv prefix, before the prompt
    "cwdFlags": ["-C", "{cwd}"],          // {cwd} placeholder = session working dir
    "inject": "prompt",                   // prompt (default) | system
    "resume": { "idField": "session_id", "resumeFlag": "--resume", "mode": "flag" },
    "label": "My Agent"                   // display name in dropdown / NEXUS
  }
}
```

### Protocol presets

| protocol | wire format | for |
|---|---|---|
| `ndjson` | one JSON object per line: `{"type":"token","text":..}`, `{"type":"tool",...}`, `{"type":"cost",...}`, `{"type":"done"}`, `{"type":"error","message":..}` | CLIs you write yourself |
| `jsonl-claude` | `claude -p --output-format stream-json` compatible | claude-protocol agents |
| `jsonl-codex` | `codex exec --json` compatible | codex-protocol agents |
| `jsonl-gemini` | `gemini --output-format json` compatible | gemini-protocol agents |
| `plain` | entire stdout is the answer text | ordinary CLIs (git, ripgrep wrappers, …) |

### Session resume

- `resume.idField` names the event field carrying the session id (`sessionStarted` events). When the engine emits it, KinetAios stores the id in `conv.engineSessionId` and appends the resume args on the next turn.
- `mode: "flag"` (default) → `--resume <id>`; `mode: "subcommand"` → `resumeFlag` is split on spaces and prepended, e.g. `"session resume"` → `my-agent session resume <id> <prompt>` (codex-style).

### Context injection

- `inject: "prompt"` (default, codex-style): persona + project rules + memory are joined with `---` separators and prepended to the prompt.
- `inject: "system"`: the block goes through `systemFlag` (default `--append-system-prompt`) as a separate argv pair — claude-style.

## Behavior notes

- **Windows `.cmd` shims** are routed through `shell: true` (same as claude/codex); real `.exe`/unix bins spawn directly. Abort kills the whole process tree (`taskkill /T /F`).
- **plain protocol**: stderr is **split off** the answer stream; if the CLI exits non-zero, the last 8 stderr lines are appended to the error message. Exit code 0 with no terminal event = done.
- **Invalid specs** (bad `protocol` value, missing `bin`, broken `resume`) — the engine is not registered; the plugin card in Settings shows a red badge with the exact reason (hover for details).
- **Name collisions**: two plugins contributing the same engine name — the later one wins (same semantics as tool flattening).
- A plugin that contributes an engine ignores the manifest `engines` field (the engine *is* the entry point).

## Bundled plugin engines

Two plugin engines ship with the app. Both are **manifest-only** — the entire engine spec lives in `plugin.json`, there is no JS to maintain.

### `plugin:claude-code-router` — Claude Code Router (ccr)

Routes Claude Code sessions through [claude-code-router](https://github.com/musistudio/claude-code-router) to a cheaper backend (DeepSeek / Kimi / Qwen / GLM) while keeping KinetAios's multi-channel workspace, long-term memory and tool ecosystem.

- `bin`: `ccr`, `protocol`: `jsonl-claude`, args `code -p --output-format stream-json --verbose`
- `resume`: `--resume <session_id>`
- Requires `ccr` on PATH (`npm i -g @musistudio/claude-code-router`) and a configured `~/.claude-code-router/config.json`.

### `plugin:gemini-cli` — Gemini CLI

Runs [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) as a managed engine: live token / tool-call / stats streaming, session resume, and the shared end-side long-term memory.

- `bin`: `gemini`, `protocol`: `jsonl-gemini`, args `--output-format stream-json --approval-mode <mode>`
- `resume`: `-r <session_id>`
- The approval mode is a **plugin setting** (`default` / `auto_edit` / `yolo` / `plan`), editable in the plugin card.
- Requires `gemini` on PATH (`npm i -g @google/gemini-cli`) and a completed auth.

### `jsonl-gemini` protocol

`gemini --output-format stream-json` emits one JSON object per line. The preset maps them onto KinetAios's unified event model:

| gemini event | KinetAios event |
|---|---|
| `init` (`session_id`) | `sessionStarted` |
| `message` (role=assistant, `delta=true` for incremental chunks) | `token` |
| `tool_use` (`tool_id`, `tool_name`, `parameters`) | pending — paired with the matching `tool_result` |
| `tool_result` (`tool_id`, `status`, `output`) | `tool` (name + args + result) |
| `error` (`severity=error`) | `error` (`severity=warning` is non-fatal and ignored) |
| `result` (`status`, `stats`) | terminal `done` + cost |

Pending `tool_use` calls are buffered **per conversation**, so parallel conversations don't cross-pair their tool ids.

## Built-in example

`plugins/examples/git-agent/` in the repo wraps plain `git` as an engine (`plain` protocol, `-C {cwd}` working dir). It's the reference for the whole chain: manifest → engine registry → dropdown → plain-protocol token stream.

## Related

- [[Engines]] — the built-in engines and the shared CliEngineAdapter skeleton
- [`KinetAiosPlugin.md`](../KinetAiosPlugin.md) — full plugin dev SOP (categories, tools, slash commands, panels)
