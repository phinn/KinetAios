> 🌐 Language: **English** | [中文](Architecture.zh-CN.md)

# Architecture

KinetAios is an Electron + TypeScript app with the standard three-process model.

## Three layers

```
┌────────────────────────────────────────────────────────┐
│  Main process (src/main/*)                             │
│  - app lifecycle, windows, global hotkey, IPC handlers │
│  - agent runtime (3 engines), SQLite, settings, spawn  │
│  - full Node access                                    │
└────────────────────────────────────────────────────────┘
              ▲
              │ contextBridge (typed KinetAPI)
              ▲
┌────────────────────────────────────────────────────────┐
│  Preload (src/preload/preload.ts)                      │
│  - the sole bridge: binds KinetAPI onto window.kinet   │
│  - ipcRenderer.invoke / on → ipcMain.handle / on       │
└────────────────────────────────────────────────────────┘
              ▲
              │ window.kinet.*
              ▲
┌────────────────────────────────────────────────────────┐
│  Renderer (src/renderer/*)                             │
│  - vanilla TS + HTML/CSS, bundled by esbuild           │
│  - no Node access (contextIsolation: true)             │
│  - dashboard / quick panel / files window              │
└────────────────────────────────────────────────────────┘
```

## Single source of truth: `shared/types.ts`

`src/shared/types.ts` is imported by **both** main and renderer. Pure types + pure functions (no Node/DOM APIs).

Key things inside:

- All shared types (`Conversation`, `Turn`, `ChatMsg`, `AgentEvent`, `AppSettings`, …)
- **`applyEvent(conv, ev)`** — folds one streaming event into the current turn's state. **Main calls it once before persisting; renderer calls the same `applyEvent` to update the view.** Changing how an event updates state = one place (mirrors the Swift original's `apply()`).
- `KinetAPI` interface — the **contract** the preload exposes to the renderer.

## `KinetAPI`: the three-layer contract

Adding a main↔renderer capability = sync three places:

1. Add method signature to `KinetAPI` (`src/shared/types.ts`)
2. Add `ipcRenderer.invoke` / `on` in preload (`src/preload/preload.ts`)
3. Add matching `ipcMain.handle` / `on` in main (`src/main/main.ts`)

Missing any one → renderer calls fail. All three must align before shipping.

Current `KinetAPI` methods: see `src/shared/types.ts:133`. Rough breakdown:
- Sessions: `newConversation` / `send` / `cancel` / `deleteConversation` / `clearConversation` / `rename` / `setCwd` / `setEngine` / `setModel`
- Settings: `getSettings` / `saveSettings` / `testConnection`
- Files: `pickDirectory` / `readFile` / `fileRead` / `fileWrite` / `listDir` / `shellOpen`
- Git: `gitSnapshot` / `gitDiff`
- Rules: `readRules` / `writeRules` / `readContext` / `writeContext`
- Memory: `memoryList` / `memoryUpdate` / `memoryDelete` / `memoryExport` / `memoryImport`
- Skills / MCP: `listSkills` / `listMcp`
- Events: `onAgentEvent` / `onFilesCwd` / `onConversation` / `onConversationRemoved` / `onConfirmRequest` + `confirmResponse`
- Windows: `openDashboard` / `openFiles` / `quickSubmit`

## Unified event model

Every engine (Direct / Claude Code / Codex) normalizes its streaming format into the same `AgentEvent` union:

```ts
type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; args: string; result: string }
  | { type: 'cost'; usd: number; tokens: number; tokensIn?: number; tokensOut?: number }
  | { type: 'status'; text: string }
  | { type: 'sessionStarted'; id: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

Engines only emit events; `TaskManager` receives → `applyEvent` updates `Conversation` → persists → pushes to renderer → renderer also calls `applyEvent` to update the view. **Defined once, used by both sides.**

## Main process key modules

| Module | Responsibility |
|---|---|
| `main.ts` | Windows, tray, hotkey, IPC, shell-confirm bridge |
| `TaskManager.ts` | Session lifecycle + engine dispatch + background memory extraction |
| `engines.ts` | `Engine` interface + three implementations + cross-platform CLI spawn |
| `AgentLoop.ts` | Direct's ReAct loop + history compaction + reactive trim |
| `glm.ts` | Provider + OpenAI/Anthropic dual-protocol SSE streaming + retry |
| `tools.ts` | 10 built-in tools + cross-platform shell + dispatch_agent |
| `mcp.ts` | MCP client (scan + stdio + reconnect) |
| `skills.ts` | skills / commands / agents / plugin scan |
| `store.ts` | better-sqlite3 + FTS5 schema |
| `settings.ts` | Config (encrypted API key persistence, language) |

## Renderer key modules

| Module | Responsibility |
|---|---|
| `app.ts` | Main window logic (chat / files / git / rules tabs) |
| `quick.ts` | Global hotkey quick panel |
| `dashboard.ts` | Standalone metrics window |
| `files-pane.ts` | File tree + webview + editor (shared by standalone window & inline tab) |
| `markdown.ts` | Minimal markdown renderer |
| `i18n.ts` (shared) | Four-language string table + `t(lang, key, params)` |

## SQLite schema

See `src/main/store.ts`. Three main tables:

- **`conversations`** + **`turns`** — sessions and turns (turn body stored as JSON)
- **`history`** — FTS5 virtual table, powers `recall_memory` full-text search
- **`memories`** — extracted long-term facts (cross-session, cross-engine)

Schema is migrated idempotently on init (`hasColumn` prevents ALTER errors). See [[Long-Term-Memory]].

## Shell-confirm bridge

`shell` (Direct) and sandboxed CLI engines may need pre-approval. Main can't show UI, so `main.ts`'s `confirm()` sends a `confirm-request` to the dashboard window and parks a resolver in a `pendingConfirms` map; the renderer's modal replies via `confirm-response`; main looks up the resolver and resolves.

`approval: 'never'` short-circuits this (no modal).

## Three-engine abstraction

```ts
interface Engine {
  readonly name: EngineKind;
  run(opts: EngineRunOpts): Promise<void>;
}
```

Three implementations: `DirectEngine` (built-in ReAct), `ClaudeCodeEngine` (spawns `claude -p`), `CodexEngine` (spawns `codex exec`). `TaskManager` owns all sessions and dispatches by `conv.engine`. See [[Engines]].
