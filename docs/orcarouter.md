# KinetAios × OrcaRouter

KinetAios ships a **built-in OrcaRouter provider preset** — one API key for 200+ models with adaptive routing, no markup.

## Provider configuration

| Field | Value |
|---|---|
| Provider | `orcarouter` (built-in preset, Settings → 预设/Provider → OrcaRouter) |
| Protocol | OpenAI-compatible (`/v1` chat completions) |
| Base URL | `https://api.orcarouter.ai/v1` |
| API key | `sk-orca-...` (create in the OrcaRouter console) |
| Model | `orcarouter/auto` (adaptive routing), or any `vendor/model` e.g. `anthropic/claude-opus-4.8` |

```yaml
provider: orcarouter
protocol: openai
base_url: https://api.orcarouter.ai/v1
api_key: sk-orca-...
model: orcarouter/auto
```

Equivalent JSON (as stored in KinetAios settings):

```json
{
  "presetId": "orcarouter",
  "apiProtocol": "openai",
  "baseURL": "https://api.orcarouter.ai/v1",
  "apiKey": "sk-orca-...",
  "model": "orcarouter/auto"
}
```

## How to connect

1. Launch KinetAios → ⚙ Settings → **Model** tab.
2. **Preset** → select **OrcaRouter (multi-model routing)** — Base URL / model auto-fill.
3. Paste your `sk-orca-...` key → **Test connection** → done.

All engines (Direct V1/V2/V3, Claude Code, Codex, DeepSeek Harness) can point at the OrcaRouter endpoint; per-conversation engine switching keeps its own model/baseURL.

## Install

Download from [releases](https://github.com/phinn/KinetAios/releases/latest), or build from source (`npm install && npm run build && npm start`).

**New to OrcaRouter?** Sign up via [this referral link](https://www.orcarouter.ai/ref/ref_1ed8570b7192ed54082b) — supports this project with 5% referral credit, at no extra cost to you.

## Verification

```sh
curl https://api.orcarouter.ai/v1/chat/completions \
  -H "Authorization: Bearer sk-orca-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"orcarouter/auto","messages":[{"role":"user","content":"Reply with exactly: OK"}]}'
```

Predefined in source: `src/renderer/app.ts` → `PRESETS` → `{ id: 'orcarouter', baseURL: 'https://api.orcarouter.ai/v1', model: 'orcarouter/auto', proto: 'openai' }`.
