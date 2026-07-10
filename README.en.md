# KinetAios

English | [简体中文](README.md)

A local-first AI agent dashboard, **cross-platform (Windows 11 + macOS)**. Run multiple sessions concurrently, stream answers, use shell/file/search/MCP tools, keep SQLite history + memory, summon a global hotkey, and pick a model per session.

> The product name is configurable in `brand.json` (`productName`); all UI surfaces read it at startup.
> The macOS original (native SwiftUI) lives one level up at `../KinetAios`. The two projects **share no code** — this is a behavior-aligned TypeScript rewrite (Electron).

## Tech stack

- **Electron + TypeScript** — the main process runs the agent runtime; the renderer is a native web UI.
- **better-sqlite3** — SQLite + FTS5 (history / `recall_memory` full-text search).
- **No frontend framework** — the renderer is vanilla TS + HTML/CSS, bundled with esbuild.

## Features

### Three engines (switchable per session; switching clears cross-engine context)
- **Direct (Kaios)** — a built-in ReAct loop with a GLM/OpenAI-compatible & Anthropic **bidirectional SSE streaming** provider, tool-level concurrency, sub-agents, context compaction, and retry.
- **Claude Code** — spawns `claude -p --output-format stream-json`, parses NDJSON, resumes with `--resume`.
- **Codex** — spawns `codex exec --json`, parses JSONL, resumes past sessions.

### Direct tools (9)
`shell` (asks for confirmation before running), `read_file`, `write_file`, `edit_file` (precise replace), `grep` (recursive content search), `glob` (list files), `web_fetch`, `recall_memory`, and `dispatch_agent` (a read-only sub-agent — reuses the ReAct loop with its own context). Claude/Codex use their own CLI tool systems.

### MCP
The Direct engine auto-connects to MCP services configured on the system (scans `~/.claude.json` / `~/.codex/config.toml` / Claude Desktop) over a stdio client; tools are merged into the ReAct loop; dropped connections auto-reconnect. The 🔌 button lists connected services/tools.

### Skills / Commands / Agents
Scans Claude Code skills + commands + agents (including installed plugin content) and Codex skills; invoke via the `/` menu or the ⚡ button; the body is injected into Direct.

### Other
- **Four-language UI** — English / 简体中文 / 繁體中文 / 日本語, switchable in Settings (model-facing strings stay Chinese)
- **Per-session model** (editable dropdown; OpenAI-compatible + Anthropic dual protocol)
- **File attachments** — 📎 pick / drop multiple text files (large files read only the head); `@path` references files in cwd
- **AGENTS.md / CLAUDE.md** — rule files in cwd are auto-injected into the system prompt
- **Long-term memory** — each turn extracts durable facts about the user in the background and recalls them next turn
- **Tray + global hotkey** — `Ctrl/Cmd+Alt+Space` summons the quick panel (closing the window quits; the hotkey is active while the app runs)
- **Configurable brand** (`brand.json`), **encrypted API key storage** (safeStorage: macOS Keychain / Windows DPAPI)
- Chat with left/right bubbles + avatars, streaming + "thinking" feedback, cost/token stats

## Run it (Windows 11 / macOS)

Requires **Node.js 18+** and internet (the `better-sqlite3` native module needs to compile).

```sh
cd KinetAiosWin
npm install      # postinstall rebuilds better-sqlite3 for Electron
npm run build
npm start
```

> On a CN network `npm install` may time out fetching the Electron binary — `.npmrc` is already configured with the npmmirror mirror; on failure you can also run `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`.

First launch: click ⚙ top-right → fill in the **API Key** (+ Base URL / model; default GLM Zhipu) → once "Test connection" passes, send a task.

## Directory layout

```
KinetAiosWin/
  brand.json               # brand config (product name etc., read at startup)
  package.json
  src/
    shared/types.ts         # types + applyEvent (shared by main/renderer, single source of truth)
    shared/i18n.ts          # four-language string table + t()
    main/
      main.ts               # windows / tray / hotkey / IPC / shell-confirm bridge
      TaskManager.ts        # session management + engine dispatch + memory extraction
      engines.ts            # Engine interface + Direct/ClaudeCode/Codex + cross-platform CLI spawn
      AgentLoop.ts          # ReAct loop (Direct) + history compaction + reactive trim
      glm.ts                # Provider + OpenAI/Anthropic SSE streaming + retry
      tools.ts              # 9 tools + cross-platform shell (cmd.exe / sh) + dispatch_agent
      mcp.ts                # MCP client (scan + stdio + reconnect)
      skills.ts             # skills/commands/agents/plugin scan
      brand.ts              # brand config reader
      store.ts              # better-sqlite3 + FTS5
      settings.ts           # config (encrypted API key persistence, lang)
    preload/preload.ts      # the narrow API exposed via contextBridge
    renderer/
      index.html quick.html styles.css
      app.ts                # dashboard logic
      quick.ts              # quick panel logic
      markdown.ts           # mini markdown renderer
```

## Build / dev

```sh
npm run build       # tsc (main) + esbuild (renderer) + copy brand.json
npm run typecheck   # typecheck both halves (no output)
npm start           # launch (requires a prior build)
npm run dev         # build + start
```

## Package

```sh
npm run dist         # current platform's default target
```

- **Windows** — `release\KinetAios Setup <ver>.exe` (NSIS). **Must be built on Windows** (cross-building Windows + native modules from macOS is unreliable).
- **macOS** — build a dmg: `npx electron-builder --mac` (needs a mac toolchain).
- electron-builder rebuilds `better-sqlite3` against Electron's ABI; `asar: false` avoids native-module load errors from inside an asar.
- **Unsigned** → Windows SmartScreen / macOS Gatekeeper will warn; users allow manually. Removing the warning needs a signing cert + Apple notarization.
- The default icon is Electron's; to use your own: Windows `build/icon.ico` (256×256), mac `build/icon.icns`.

## Known constraints

- **Closing the window quits** (no background persistence); the global hotkey only works while the app runs. If you want "close-to-tray + always-on hotkey", switch back to hide-on-close.
- Codebase indexing / semantic retrieval, image multimodality, IDE plugins, etc. are on the `FEATURES.md` roadmap (not done).
