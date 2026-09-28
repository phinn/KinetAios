> 🌐 Language: **English** | [中文](Settings.zh-CN.md)

# Settings

Top-right **⚙** in the main window. Two-column layout: vertical tab nav on the left (Model / Appearance / Engine / Advanced / Security / Messaging / Plugins / Skills / Goal Supervisor / Mesh), independently scrolling content on the right; narrow windows fall back to horizontal tabs. A search box filters across all panels. **Save / Test buttons are pinned to the bottom** of the content pane — visible from any tab; the save button lights a dot when there are unsaved changes.

## Model

| Field | Description |
|---|---|
| Provider protocol | `OpenAI-compatible` / `Anthropic`. Determines whether requests go to `/chat/completions` or `/v1/messages` |
| Base URL | Endpoint root. Preset buttons: GLM Zhipu / DeepSeek / OrcaRouter / OpenAI / Anthropic |
| Model | Default model. e.g. `glm-4.6` / `claude-sonnet-4-6` / `gpt-4o`. Can be overridden per session |
| API Key | Encrypted via safeStorage (macOS Keychain / Windows DPAPI). Plaintext never goes into settings.json |
| **Test connection** | Sends a minimal request to verify. **Always test before saving** |
| **Add model (v3.7.3+)** | Model profile editing moved into a centered modal: profile name / key / URL / models / protocol / reasoning / pricing / balance check, with built-in test connection. Saved profiles appear in the list immediately |
| Zhipu balance | One-click query of the remaining balance for GLM keys |

`AppSettings.apiKey` is encrypted via `safeStorage.encryptString`, stored as `apiKeyEnc` in `userData/settings.json`.

## Engine / Behavior (Advanced)

| Field | Description |
|---|---|
| Shell approval | `always` (default, modal every time) / `never` (auto-allow, use with caution) |
| Sandbox (Claude Code / Codex) | `readOnly` / `workspaceWrite` / `fullAccess`. Maps to `--permission-mode` (CC) / `-s` (Codex) |
| Plan mode | On → engine is read-only (CC goes `plan` mode, Codex goes `read-only`) |
| CLI engine plugins | Claude Code / Codex are **plugin-gated** — enable them in ⚙ → Plugins to add them to the engine dropdown |
| **Run complex tasks in background (V3)** (v3.8.0+) | On (default) → tasks V3 grades as `deep` submit to the JobManager; the session unlocks immediately and the result backfills when done. Off → synchronous wait |
| Computer Use background mode | Mouse/keyboard events are delivered to the target window in the background — your real cursor and focus never move (full support on Windows) |
| Window close behavior | Quit / minimize / tray |

## Pricing

| Field | Description |
|---|---|
| Input price (per 1M tokens) | USD. Overrides the default (GLM `0.07`, others `3`) |
| Output price (per 1M tokens) | Same |

`priceUSD(model, tokensIn, tokensOut)` (`glm.ts:96`) prefers your settings; falls back to built-in defaults when 0.

## Interface

| Field | Description |
|---|---|
| Language | English / 简体中文 / 繁體中文 / 日本語. **Live switch** (no restart) |
| Theme | dark (default) / light. **Live preview** (no flicker when toggling back and forth) |

i18n internals: [[i18n]].

## Long-term memory

| Button | Description |
|---|---|
| Export JSON | Writes to a user-chosen path. `{ version: 1, exportedAt: number, memories: Memory[] }` |
| Import JSON | Accepts the above structure **or** a plain `string[]`. Dedupes by content. Returns `{ imported: N, skipped: N }` |

Good for machine migration, backup, sharing across providers. See [[Long-Term-Memory]].

## Skills (v3.7.2+)

The Skills tab aggregates every skill / command / agent from all sources — Claude Code, Codex, plugin-contributed, and the app's own **built-in skills** (read-only, shipped with the app; the first one, `data-analysis`, ports the V3 analysis discipline). Search, view, and edit user-level source files directly; plugin/built-in skills are read-only. Changes take effect immediately. See [[Skills]].

## Goal Supervisor

Long-running `/goal` sessions: a persona-driven supervisor reviews each Worker turn against your taste, accepts output or raises new requirements — built for overnight runs.

| Field | Description |
|---|---|
| Supervisor | Enable the acceptance loop (requires a non-empty persona) |
| Supervisor model | Which model plays the supervisor (e.g. a cheap fast one); empty = follow the session model |
| Model failover chain | Ordered profile list. When the current model hits quota/auth errors, the Worker rotates to the next profile and keeps running |
| 5h-window failover | Coding-plan 5h quota nearly used up → switch to the next profile proactively, before the error; threshold defaults to 100% (switch when full) |
| Fuse: max iterations / hours / cost | Hard caps for overnight runs. 0 = unlimited. Exceeding any stops the run |

**Failover chain gotcha (fixed in v3.9.3):** the chain is cached renderer-side and seeded when the settings panel opens. Previously the seed ran *after* `markClean()` — which snapshots the form (including the not-yet-seeded empty cache) as the dirty-check baseline — so the first open after a cold start showed an empty chain, and one save wiped it. Also note add/remove on the chain is button-driven (no `input`/`change` bubbling): the dirty dot lights up via an explicit `updateSaveDot()` call.

The chain is read live by the runtime (`getFailoverChain()` re-reads settings each time), so editing the chain mid-overnight-run takes effect on the next failover without restart.

## Messaging

Configure Feishu and WeCom bot integrations. See [[Messaging-Bots]] for full details.

| Field | Description |
|---|---|
| Feishu — Enabled | Toggle Feishu bot connection |
| Feishu — App ID / Secret | Credentials from Feishu Developer Console |
| WeCom — Enabled | Toggle WeCom bot connection |
| WeCom — Bot ID / Secret | Credentials from WeCom developer portal |
| Engine | Which agent engine handles IM messages |
| Stream reply | Send "thinking" placeholder first, then replace with answer |
| Default cwd | Working directory for agent tools |

## Per-session vs global

| Global (setting) | Per-session (conv) |
|---|---|
| Provider protocol | Engine (Direct/CC/Codex) |
| Base URL | Model |
| API Key | cwd |
| Pricing | |
| Approval / sandbox | |
| Language / theme | |

The per-session model is an editable dropdown in the chat header's second row; supports both OpenAI-compatible and Anthropic protocols.

## Encrypted storage tradeoff

`CLAUDE.md` notes:

> API key is stored **plaintext** in `userData/settings.json` (known MVP constraint — swap for Windows Credential Manager before real distribution).

Actually, as of v1.0 it's already encrypted via safeStorage. The CLAUDE.md note is stale. Actual security: protected by macOS Keychain / Windows DPAPI; reading `settings.json` directly only gives you the encrypted blob.

## Key source files

- `src/main/settings.ts` — `getSettings` / `saveSettings` / `snapshot` / encrypted read-write
- `src/shared/types.ts:30` — `AppSettings` type
- `src/renderer/settings.ts` (embedded in app.ts) — settings view rendering
