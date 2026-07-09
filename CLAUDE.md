# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

KinetAios — Windows 11 port of a local AI-agent dashboard (the macOS original is the native-SwiftUI app in `../KinetAios`). **Behavior-aligned TypeScript rewrite, not shared code with the original** — the Swift sources were ported line-by-line into Electron + TypeScript. Run multiple sessions concurrently, stream answers, three switchable agent engines, shell/file/web/memory tools, SQLite history, global hotkey.

Stack: **Electron + TypeScript**, **better-sqlite3** (with FTS5), **no frontend framework** (vanilla TS + HTML/CSS, bundled with esbuild).

## Commands

```bash
npm install          # installs + builds better-sqlite3 native module (needs Node 18+ and a compiler toolchain)
npm run build        # tsc (main/preload/shared) + esbuild (renderer bundles) + copy renderer assets
npm run typecheck    # typecheck both halves without emitting — the primary verification step
npm start            # electron .  (requires a prior build)
npm run dev          # build + start
npm run pack         # build + electron-builder --win --dir  → release/win-unpacked/KinetAios.exe
npm run dist         # build + electron-builder --win        → release/KinetAios Setup <ver>.exe (NSIS)
```

**There is no test framework in this repo.** Verification = `npm run typecheck` plus launching the app (`npm start`) and driving the affected flow. Don't invent a test script.

### Platform caveat (important)

The real build target is **Windows 11** (cmd.exe shell, `.cmd` shims, Windows paths). On this mac you can `npm install`, `npm run typecheck`, and `npm start` (Electron is cross-platform; core logic smokes fine), but you **cannot build/verify a Windows binary or NSIS installer from macOS** — electron-builder + the native module rebuild need a Windows toolchain. Windows-only behavior (shell, PATH, hotkey) must be verified on Windows.

## Architecture

### Two processes, one narrow bridge

- **Main process** (`dist/main/main.js`, source `src/main/*`): app lifecycle, windows, global hotkey, IPC handlers, the agent runtime, SQLite, settings, CLI spawning. Has full Node access.
- **Renderer** (`src/renderer/*`): vanilla-TS dashboard + quick panel. **No Node access** — `contextIsolation: true`, `nodeIntegration: false`. It can only call what the preload exposes.

The **preload** (`src/preload/preload.ts`) is the entire surface between them: it binds a typed `KinetAPI` (`src/shared/types.ts`) onto `window.kinet` via `contextBridge`. Adding a new main↔renderer capability = add a method to `KinetAPI`, a `ipcRenderer.invoke`/`on` line in preload, and the matching `ipcMain.handle`/`on` in `main.ts`. All three must stay in sync; the `KinetAPI` interface is the contract.

### `shared/types.ts` is the single source of truth

This file is imported by **both** halves (main as CJS, renderer bundled) and is deliberately pure — no Node- or DOM-only APIs. It holds all shared types **and** `applyEvent(conv, ev)`, the pure function that folds one streaming event into a conversation's current turn.

The key pattern: every engine emits the same unified `AgentEvent` union (`token | tool | cost | status | sessionStarted | done | error`). **Main calls `applyEvent` then persists; the renderer calls the same `applyEvent` to update the view.** When you change how an event updates state, you change it in exactly one place. (This mirrors the Swift original's `apply()`.)

### Three engines, one `Engine` interface

`src/main/engines.ts` defines `Engine { name; run(opts) }` and three implementations, switchable per-conversation (switching clears cross-engine context):

- **Direct ("Kaios")** — the built-in ReAct loop (`AgentLoop.ts`) calling the provider in `glm.ts`. Only Direct uses the in-app tools (`tools.ts`: `shell`, `read_file`, `write_file`, `web_fetch`, `recall_memory`).
- **Claude Code** — spawns `claude -p --output-format stream-json`, parses NDJSON, resumes via `--resume` + persisted session id, injects memory via `--append-system-prompt`.
- **Codex** — spawns `codex exec --json`, parses JSONL, resumes, prepends memory into the prompt.

`TaskManager.ts` owns conversations, dispatches to the right engine, and runs background memory extraction (pulls durable "facts about the user" from each turn, injected into the next).

### Cross-platform CLI spawn — read this before touching spawn logic

npm-global CLIs ship as **`.cmd` shims on Windows**. Node refuses to spawn `.cmd`/`.bat` directly (CVE-2024-27980), so `engines.ts` routes `.cmd`/`.bat` through `shell: true` and spawns real `.exe`/unix bins directly (clean argv, smaller prompt-injection surface). There is also a `binEnv()` that **augments `PATH`** with common install dirs, because a GUI-launched Electron app inherits a sparse PATH and would otherwise not find `claude`/`codex`.

### SQLite schema (`src/main/store.ts`)

FTS5 virtual table `history` powers `recall_memory`; `conversations` + `turns` (turn bodies stored as JSON in `data`) hold session state; `memories` holds extracted long-term facts. Schema is migrated idempotently on init (FTS via `db.exec` because `.prepare` runs only the first statement).

### Shell-confirm bridge

`shell` (Direct) and the sandboxed CLIs may need pre-approval. Main can't show UI, so `main.ts`'s `confirm()` sends a `confirm-request` to the dashboard window and parks a resolver in a `pendingConfirms` map; the renderer's modal replies via `confirm-response`. `approval: 'never'` short-circuits this.

## Conventions

- Comments are **bilingual (Chinese + English)** throughout, matching the Swift original and the README. Match the surrounding style.
- Deliberate MVP simplifications are marked `// ponytail:` with the ceiling named and the upgrade path noted. Respect these — don't silently "complete" them unless the task asks.
- UI strings and the Direct system prompt are **Chinese**; engine error messages guide users in Chinese.
- `dist/`, `release/`, `node_modules/` are gitignored. `main` entry points at `dist/main/main.js` (set in `package.json`), so **`npm start` won't work without a build**.
- API key is stored **plaintext** in `userData/settings.json` (known MVP constraint — swap for Windows Credential Manager before real distribution).
