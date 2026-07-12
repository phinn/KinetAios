> 🌐 Language: **English** | [中文](Home.zh-CN.md)

# KinetAios Wiki

Welcome to the KinetAios wiki. This is the **feature manual** — for users who already installed the app and want to dig into how each feature works.

> For project intro (first-time visitors), see the [README](https://github.com/phinn/KinetAios) in the main repo. The wiki doesn't repeat the README — it expands each feature area: **how to use + how it works + common questions**.

## What this is

KinetAios is a local-first AI agent dashboard, cross-platform (Windows 11 + macOS). Run multiple sessions concurrently, stream answers, use shell/file/search/MCP tools, SQLite history + long-term memory, global hotkey, per-session model.

Stack: **Electron + TypeScript**, **better-sqlite3 + FTS5**, **no frontend framework** (vanilla TS + HTML/CSS, bundled with esbuild).

## 30-second quickstart

```sh
cd KinetAiosWin
npm install      # postinstall rebuilds better-sqlite3 for Electron
npm run build
npm start
```

First launch → top-right **⚙** → fill in the **API Key** (+ Base URL / model; default GLM Zhipu) → once "Test connection" passes → send a task.

See [[Getting-Started]] for details.

## Feature matrix

| Feature | Entry | Wiki page |
|---|---|---|
| Three switchable engines (Direct / Claude Code / Codex) | Session header engine selector | [[Engines]] |
| Direct engine internals | — | [[Direct-Engine]] |
| 10 built-in tools + MCP | Auto-injected | [[Tools-and-MCP]] |
| Long-term memory extraction & injection | 🧠 button | [[Long-Term-Memory]] |
| Skills / Commands / Agents | `/` or ⚡ | [[Skills]] |
| File browser + built-in browser + editor | 🌐 button / "Files" tab | [[Files-and-Preview]] |
| Git status / history / file diff / commit show | "Git" tab | [[Git-Integration]] |
| Project rules + project context | "Rules" tab / Workbench "Context" | [[Rules-and-Context]] |
| Workbench (project card overview) | 📂 button | [[Workbench]] |
| Settings (API / Behavior / Pricing / Interface / Memory) | ⚙ button | [[Settings]] |
| Global hotkey quick panel | `Ctrl/Cmd+Alt+Space` | [[Global-Hotkey]] |
| Four-language switch | ⚙ → Interface → Language | [[i18n]] |
| Architecture overview (main / preload / renderer) | — | [[Architecture]] |
| Dev & packaging (typecheck / build / dist / CI) | — | [[Development]] |

## Conventions

- English is the primary language; Chinese (`.zh-CN.md`) is a switchable mirror.
- Code identifiers, CLI flags, file names stay in English in both versions.
- Cross-page links use `[[Page-Name]]` (GitHub wiki auto-renders; file name maps to `Page-Name.md`).
- Code references use `src/path/file.ts:line` — clickable in your local repo.
- `ponytail:` markers in code are deliberate MVP simplifications.

## Syncing this wiki to GitHub

The markdown sources live in the main repo's `wiki/` directory. To push them to GitHub wiki, see [[Wiki-Sync]].
