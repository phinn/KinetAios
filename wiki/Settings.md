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
