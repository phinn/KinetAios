> 🌐 Language: **English** | [中文](Settings.zh-CN.md)

# Settings

Top-right **⚙** in the main window. Five sections.

## API

| Field | Description |
|---|---|
| Provider protocol | `OpenAI-compatible` / `Anthropic`. Determines whether requests go to `/chat/completions` or `/v1/messages` |
| Base URL | Endpoint root. Preset buttons: GLM Zhipu / DeepSeek / OpenAI / Anthropic |
| Model | Default model. e.g. `glm-4.6` / `claude-sonnet-4-6` / `gpt-4o`. Can be overridden per session |
| API Key | Encrypted via safeStorage (macOS Keychain / Windows DPAPI). Plaintext never goes into settings.json |
| **Test connection** | Sends a minimal request to verify. **Always test before saving** |

`AppSettings.apiKey` is encrypted via `safeStorage.encryptString`, stored as `apiKeyEnc` in `userData/settings.json`.

## Behavior

| Field | Description |
|---|---|
| Shell approval | `always` (default, modal every time) / `never` (auto-allow, use with caution) |
| Sandbox (Claude Code / Codex) | `readOnly` / `workspaceWrite` / `fullAccess`. Maps to `--permission-mode` (CC) / `-s` (Codex) |
| Plan mode | On → engine is read-only (CC goes `plan` mode, Codex goes `read-only`) |
| Enable CLI engines | Off by default. When on, scans PATH for `claude` / `codex` and adds them to the engine dropdown |

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
