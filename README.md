# KinetAios

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/phinn/KinetAios?style=social)](https://github.com/phinn/KinetAios)
[![Release](https://img.shields.io/github/v/release/phinn/KinetAios)](https://github.com/phinn/KinetAios/releases/latest)
[![Platforms](https://img.shields.io/badge/platform-Windows%2011%20%7C%20macOS-black)](https://github.com/phinn/KinetAios/releases/latest)

> 🌐 **[Website → https://phinn.github.io/KinetAios/](https://phinn.github.io/KinetAios/)**

![KinetAios hero screenshot](documents/hero.png)

![Four engines running side-by-side](documents/demo-arena.gif)

A **local-first AI agent dashboard** for **Windows 11 and macOS — both first-class platforms** (the "Win" folder name is historical; the repo is phinn/KinetAios). Platform differences (cmd.exe vs /bin/sh, hotkey, tray) are routed at runtime; features are aligned on both sides. Run multiple agent sessions concurrently with streaming answers, shell/file/search/MCP tools, SQLite history with long-term memory, a global hotkey, and a per-session model. **No account, no relay server — your own LLM API key is the only credential.**

**The 30-second version:**

- 🔀 **Four engines, one window** — Direct (in-house ReAct) + Claude Code + Codex + DeepSeek Harness; switch per session, hand off context via Pipeline
- 🧠 **Long-term memory on local SQLite** — auto-extracted facts shared across all engines, survives restarts
- 🔒 **Local-first, no account** — your API key is the only credential; nothing goes through a relay
- 🛠 **30+ built-in tools + MCP client/server + plugins** — shell, files, web, screenshots, computer use out of the box
- ⌨️ **Global-hotkey quick panel** — Spotlight for AI agents, summon from anywhere
- 📊 **Benchmarked on a real 400k-row business task** — in-house engine **9.2** vs Claude Code **7.0** ([full report](documents/excel-cross-analysis-engines.html))
- 🖥 **Windows 11 & macOS — both first-class**

> ⭐ If KinetAios saves you time, **a Star is the loudest thank-you** for a solo open-source project.

---

## Why KinetAios?

Most AI clients lock you into one provider, drop context when you switch engines, and route your conversations through a relay. KinetAios runs **four engines in one window**, keeps long-term memory across all of them, and **never asks for an account**.

| | KinetAios | Claude Desktop | Cherry Studio | Cursor | Codex Desktop |
|---|---|---|---|---|---|
| Four engines (Direct V1/V2/V3 + Claude Code + Codex + DeepSeek Harness) | ✅ | — | — | — | — |
| Local SQLite + automatic long-term memory | ✅ | — | — | — | — |
| Cross-engine memory (one user profile shared by all engines) | ✅ | — | — | — | — |
| Multiple parallel sessions | ✅ | — | ✅ | — | ✅ |
| Global hotkey + quick panel | ✅ | — | — | — | — |
| Auto-scan MCP / Skills / Agents | ✅ | ✅ | — | — | — |
| Project rules (AGENTS / CLAUDE / KINET) | ✅ | — | — | ✅ | ✅ |
| Built-in MCP Server (remote agent control) | ✅ | — | — | — | — |
| Plugin system (tools / panels / slash commands) | ✅ | — | — | — | — |
| Multimodal (image input + voice + screenshots) | ✅ | ✅ | — | — | — |
| Session branching + cross-engine Pipeline orchestration | ✅ | — | — | — | — |
| Local-first, no account | ✅ | ✅ | ✅ | — | — |

## Install

Grab the latest release:

- **Windows** — [`KinetAios-Setup-<version>.exe`](https://github.com/phinn/KinetAios/releases/latest) (NSIS installer)
- **macOS** — see [releases](https://github.com/phinn/KinetAios/releases/latest)

> Unsigned builds → Windows SmartScreen / macOS Gatekeeper will warn; allow it manually.

**First launch**: click the ⚙ in the top right → paste your **API Key** (+ base URL / model, defaults to GLM/Zhipu) → hit **Test Connection**, then send your first task.

> 🐋 **One key for every model?** Pick the **OrcaRouter** preset — an OpenAI-compatible gateway with 200+ models, adaptive routing, zero markup. [Sign up with this link](https://www.orcarouter.ai/ref/ref_1ed8570b7192ed54082b) to support the project (5% referral credit).

Built-in OrcaRouter preset:

```yaml
provider: orcarouter          # Settings → Presets → OrcaRouter (multi-model routing)
protocol: openai              # OpenAI-compatible
base_url: https://api.orcarouter.ai/v1
api_key: sk-orca-...          # create in the OrcaRouter console
model: orcarouter/auto        # adaptive routing, or pin a vendor/model e.g. anthropic/claude-opus-4.8
```

### From source

Requires **Node.js 18+** and a network connection (the `better-sqlite3` native module needs compiling).

```sh
git clone https://github.com/phinn/KinetAios.git
cd KinetAios
npm install      # includes postinstall: rebuild better-sqlite3 for Electron
npm run build
npm start
```

---

## Highlights

### Four engines, switchable per session
- **Direct V1 (Kaios)** — built-in ReAct loop with a dual-protocol provider (OpenAI-compatible & Anthropic, both directions of SSE streaming), tool-level concurrency, sub-agents, context compaction and retries.
- **Direct V2** — next-gen ReAct on a Plan-Execute-Verify-Judge architecture, streaming tool calls, step-by-step task lists rendered live in the chat as checklist cards.
- **Direct V3** — latest: an **intent router** picks `fast` / `standard` / `deep` per query; the `deep` path builds tool calls into a **dependency DAG and executes it in parallel** — real speedups on multi-step tasks.
- **Claude Code** — spawns `claude -p --output-format stream-json`, parses NDJSON, resumes with `--resume`.
- **Codex** — spawns `codex exec --json`, parses JSONL, resumes.
- **DeepSeek Harness** *(3.0+)* — spawns the `dsh` CLI over OpenAI-compatible SSE with built-in OpenAI / Pi-AI providers, retries and token billing. Switchable per session like every other engine.

### 30+ built-in tools
`shell` (confirm before running; **focus guard** — if a command steals the foreground it's handed back automatically), `read_file`, `write_file`, `edit_file` (exact replace), `grep`, `glob`, `web_fetch` (SSRF guard + Jina Reader fallback), `web_search` (Bing → DuckDuckGo fallback), `recall_memory`, `git_diff` (read-only, no confirm), `remember_fact` / `recall_fact` (session anchors), `memory_replace` / `memory_append` (core memory blocks), `dispatch_agent` (read-only sub-agent with its own context), `spawn_team` / `team_broadcast` / `team_send` / `team_close` (multi-agent teams), `video_gen` (MiniMax H3 text-to-video), `todo_write` (shared task list, rendered live as checklist cards), and more.

### Computer Use (native, zero external dependencies)
- `screenshot` (with `hide_self` — the agent's own window turns transparent during the shot, zero focus stealing), `screenshot_window` (capture any window by title — even occluded/background ones, no desktop switching).
- `mouse_click` / `mouse_scroll` / `mouse_drag`, `keyboard_type` / `keyboard_key` — coordinates are converted from the last screenshot's pixel space to the platform's action space (DPI / window-origin aware, with staleness expiry).
- Backed by Electron desktopCapturer + PowerShell (Windows) / cliclick (macOS) / xdotool (Linux). On macOS, bare `open` is mechanically rewritten to `open -gj` — the agent never steals your foreground.

### MCP integration (client + server)
- **Client**: the Direct engine auto-connects to MCP servers configured on your system (scans `~/.claude.json`, `~/.codex/config.toml`, Claude Desktop). stdio transport, auto-reconnect after unexpected drops. The 🔌 button shows connected servers/tools.
- **Server**: a built-in MCP Server (HTTP+SSE) exposes a `run_agent` tool — remote machines can invoke your local full agent. Token auth (constant-time compare), 5-minute timeout, zombie-connection detection.

### Long-term memory + memory graph
- Each turn, durable "facts about the user" are extracted in the background → SQLite → injected into the next turn. Shared **across engines and sessions**.
- **Memory graph** visualization: force-directed graph of memory provenance, conflict detection, timeline. Standalone fullscreen window.
- Import/export memories as JSON (backup or migration).

### Skills / Commands / Agents / Plugins
- Scans Claude Code's skills + commands + agents and Codex's skills. Invoke via the `/` menu or the ⚡ button.
- **Skills panel** (Settings → Skills): aggregates skills from all third-party sources plus plugin contributions, with search, viewing, and direct source editing (plugin skills read-only). Edits take effect immediately.
- **Plugin SDK v3**: plugins contribute tools, slash commands, hooks, and fullscreen panels. Injected on demand (keyword matching saves ~60% tokens). **20 built-in plugins**: office-suite, brainstorm (Excalidraw), math-practice, cpp-learning, low-altitude (drones), an embedded & IoT suite (arduino-dev / platformio-dev / serial-comm / modbus-dev / mqtt-dev / ble-dev / ota-dev / sensor-lookup / logic-analyzer / hw-diag), nestjs-dev, deepseek-harness, claude-code, codex, and more.

### Sidebar (left to right)
- **＋** new session.
- **📂 Workbench** — project cards grouped by cwd, each showing recent activity + cost. A "Context" button edits `KINET-CONTEXT.md`.
- **📊 Dashboard** — standalone window with live token usage, cost stats, engine distribution.
- **🌐 Files** — file browsing + `<webview>` preview (HTML/SVG/PNG/JPG/PDF) + editor. Multi-tab. The address bar accepts `file://` / `http(s)://` / `localhost:<port>`.
- **🏘️ Town** — game-style isometric visualization of remote nodes (other KinetAios instances) on your network.
- **🧠 Memory** — memory panel: current channel / all, inline edit/delete, provenance.
- **🔌 Plugins** — plugin management: enable/disable, search & filter, category cards.
- **⚙️ Settings** — see below.

### Main-window tabs (Chat / Files / Git / Rules)
- **Chat** — streaming output, collapsible tool steps, live token counts, context inspector, screenshots, voice input.
- **Files** — same as 🌐, following the current session's cwd.
- **Git** — `git status` (left) + `git log` (right). Click a changed file → side-by-side diff; click a commit → unified `git show`.
- **Rules** — edit `KinetAios.md` in the cwd (project-level rules, injected into the system prompt).

### Pipeline (cross-engine orchestration)
Chain multiple stages, each with its own engine + prompt. The previous stage's output is prepended to the next stage's prompt. 2-minute per-stage timeout polling, abort on failure.

### Session branching & handoff
- **Branch** from any turn — deep-copies turns/steps into a new session.
- **Export/import sessions** — serializes full session state (turns + history + engine + model + cwd) for cross-machine handoff. Export auto-redacts secrets (API keys, passwords → `[REDACTED]`).
- **Cross-session references** — link related sessions, visualized as a DAG.

### Context management (Direct engine)
- **Context inspector** — view/edit each session's `directHistory` array (JSON editor).
- **Auto-compaction** — when history exceeds the token budget, early turns are summarized by the LLM. Compaction events are visualized (tokens before vs after).
- **Per-protocol calibration** — token/char ratios are tracked separately per API protocol (OpenAI vs Anthropic) so concurrent sessions don't interfere.

### Multimodal (Direct engine)
- **Image input**: 📎 pick/paste images → vision content parts → OpenAI `image_url` or Anthropic base64 format.
- **Voice transcription**: 🎤 record → Whisper → fills the input box.
- **Realtime voice chat**: 🎤 → Volcengine Doubao WebSocket two-way voice — natural TTS, live transcription, parallel agent tool execution. See the [voice chat wiki](https://github.com/phinn/KinetAios/wiki/Voice-Chat).
- **Screenshots**: 📸 overlay → drag a region → cropped image injected into the prompt.

### Global search
`Ctrl/Cmd+K` overlays a search across all sessions — matching prompt text, answer text, and tool output.

### Settings (⚙️)
- **Two-column layout**: vertical tab nav on the left (Models / Appearance / Engines / Advanced / Security / Messages / Plugins / Skills / Goal / Multi-machine), independent scrolling on the right; narrow windows fall back to horizontal tabs; a search box filters across all panels.
- **Providers**: OpenAI / Anthropic protocols, base URL, model, key. GLM / DeepSeek / OrcaRouter / OpenAI / Anthropic presets. Zhipu balance check button. Encrypted storage via safeStorage.
- **Security**: privacy gate (detects sensitive data leaving the machine).
- **Behavior**: shell approval mode, sandbox level, plan mode, CLI engine toggles, window-close behavior (quit / minimize / tray).
- **Pricing**: per-model input/output prices for cost calculation.
- **Interface**: language (English / 简体中文 / 繁體中文 / 日本語), theme (dark / light, live preview).
- **Long-term memory**: export/import JSON.

### Misc
- **Per-session model** (editable dropdown, OpenAI-compatible + Anthropic dual protocol).
- **File attachments**: 📎 pick/drop multiple text files (large files read header-only), `@path` references to cwd files.
- **`KinetAios.md` / `AGENTS.md` / `CLAUDE.md`** — rule files in the cwd are auto-injected into the system prompt.
- **Tray + global hotkey** `Ctrl/Cmd+Alt+Space` → quick panel.
- **Update check** against GitHub Releases, shown on the About page.
- **Configurable branding** (`brand.json`), **encrypted API key storage** (safeStorage: macOS Keychain / Windows DPAPI).

---

## Benchmarks: four engines, one real business task

The same **400k-row medical-device CRM cross-analysis** (multi-sheet × hospital tier × time window, producing an interactive ECharts report) — four engines, identical prompt, zero human intervention:

| Engine | Score /10 | Tokens | Key difference |
|---|---|---|---|
| **Direct (in-house)** | **9.2** | **1.31M** | Native SAX-streaming xlsx — the file never enters the context |
| Claude Code | 7.0 | ~2M | Great context management, but no plugin tools — every step detours through Bash+python |
| Codex | 5.5 | ~2.4M | Sandbox-first design, wrong fit for interactive data tasks |
| PEVJ V2 (in-house) | 3.5 | 3.8M+ | Four-layer architecture with no guardrails on verify = token amplifier |

> **The most valuable finding: 7.5% of API calls burned 63% of the budget.** The root cause wasn't the model — it was tool design. The agent read the same large file 16 times sequentially, resending full history each pass. Switching to a streaming reader zeroed that cost.

> [Full report: methodology + per-dimension scores + step-by-step traces](https://github.com/phinn/KinetAios/blob/main/documents/excel-cross-analysis-engines.html) — includes all the gory details of our own engine's 3.5.

---

## Tech stack

- **Electron + TypeScript** — the main process runs the agent runtime; the renderer is a native web UI.
- **better-sqlite3** — SQLite + FTS5 (history / `recall_memory` full-text search + embedding semantic recall).
- **No frontend framework** — the renderer is vanilla TS + HTML/CSS, bundled with esbuild.

## Project layout

```
KinetAios/               # repo root (the "Win" dir name is historical — it's the cross-platform repo now)
  brand.json               # branding config (product name etc., read at startup)
  package.json
  src/
    shared/types.ts         # types + applyEvent (shared by main/renderer, single source of truth)
    shared/i18n.ts          # four-language string table + t()
    main/
      main.ts               # windows / tray / hotkey / IPC / shell-confirm bridge
      TaskManager.ts        # session management + engine dispatch + memory extraction
      engines.ts            # Engine interface + Direct/ClaudeCode/Codex + cross-platform CLI spawn
      AgentLoop.ts          # ReAct loop (Direct) + history compaction + auto-shrink
      V3/                   # Direct V3: intent router + fast/deep paths (deep = DAG parallel)
      glm.ts                # providers + OpenAI/Anthropic SSE streaming + retries
      updater.ts            # GitHub Releases update check
      tools.ts              # 30+ built-in tools + computer-use glue + focus guard
      computer-use.ts       # screenshot / mouse / keyboard (native APIs)
      mcp.ts                # MCP client (scan + stdio + reconnect)
      mcp-server.ts         # MCP server (HTTP+SSE, run_agent, token auth)
      skills.ts             # skills/commands/agents/plugin scanning
      plugins.ts            # plugin loader (SDK v3: tools/slash commands/hooks/panels)
      store.ts              # better-sqlite3 + FTS5
      settings.ts           # config (encrypted API key, lang, embedding)
    preload/preload.ts      # narrow contextBridge API
    renderer/
      index.html quick.html styles.css
      app.ts                # dashboard logic (chat, sidebar, tabs, context inspector)
      quick.ts              # quick panel logic
      dashboard.ts          # cost/token dashboard window
      arena.ts              # deep-analysis dashboard
      memory-graph.ts       # memory graph SVG visualization
      town.ts               # Town view (remote-node visualization)
      files-pane.ts         # file browsing + webview preview + editor
      code-editor.ts        # code editor (syntax highlighting)
      file-drawer.ts        # file drawer UI
      nexus.ts              # Nexus view
      focus-manager.ts      # focus / focus-trap management
      highlight.ts          # chat code-block syntax highlighting
      markdown.ts           # mini markdown renderer
  plugins/                  # 20 built-in plugins (SDK v3)
```

## Build / develop

```sh
npm run build       # tsc (main/preload/shared) + esbuild (renderer) + copy brand.json
npm run typecheck   # typecheck both halves, no emit
npm start           # launch (requires a prior build)
npm run dev         # build + start
```

## Packaging

```sh
npm run dist         # default target for the current platform
```

- **Windows**: `release\KinetAios Setup <ver>.exe` (NSIS). **Must be built on Windows** (cross-building Windows + native modules from macOS is unreliable).
- **macOS**: build a dmg with `npx electron-builder --mac` (requires a Mac toolchain).
- electron-builder rebuilds `better-sqlite3` against Electron's ABI automatically; `asar: false` avoids native-module-in-asar loading errors.
- **Unsigned builds** → Windows SmartScreen / macOS Gatekeeper will warn; allow manually. Removing the warning needs a signing cert (+ Apple notarization).
- The icon defaults to Electron's; replace with your own: `build/icon.ico` (256×256) on Windows, `build/icon.icns` on macOS.

## Known constraints

- **Window-close behavior is configurable** (quit / minimize / tray), default minimize. The global hotkey only works while the app is running.
- **No cross-building** — build Windows installers on a Windows machine or a GitHub Actions `windows-latest` runner, and dmgs on a Mac (native-module rebuild needs the target toolchain).
- Platform-specific code paths (shell / PATH / hotkey / tray) should be verified on their target OS.

---

## The Kinet family

KinetAios is part of the [Kinet family](https://phinn.github.io/kinetapp/index.html):

- **KinetFit** — smart health companion
- **KinetAgent** — AI automation assistant
- **KinetBrief** — AI briefing / notes app

## License

[GPL-3.0](LICENSE)
