> 🌐 Language: **English** | [中文](Getting-Started.zh-CN.md)

# Getting Started

From zero to your first task running.

## Install dependencies

Requires **Node.js 18+** + internet (the `better-sqlite3` native module needs to compile).

```sh
cd KinetAiosWin
npm install      # postinstall rebuilds better-sqlite3 for Electron
npm run build
npm start
```

**CN network note**: `npm install` may time out fetching the Electron binary. `.npmrc` already configures npmmirror; if it still fails:

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

See [[Development]].

## Configure API

First launch → top-right **⚙** → **API** section:

| Field | Description |
|---|---|
| Provider | OpenAI-compatible / Anthropic (determines request protocol) |
| Base URL | Default GLM Zhipu; presets for GLM / DeepSeek / OpenAI / Anthropic |
| Model | e.g. `glm-4.6`, `claude-sonnet-4-6`, `gpt-4o` |
| API Key | Encrypted via safeStorage (macOS Keychain / Windows DPAPI), stored in `settings.json` |

Click **Test connection** after filling. Pass = good to go.

API key storage details: [[Settings]]. Protocol differences: [[Engines]].

## Send your first task

In the main window's bottom input:

```
Show me the directory structure of the current project, list all .md files,
and tell me the first sentence of each.
```

Enter = send; Shift+Enter = newline; drag files into the input to attach.

The model will:
1. Call `glob` to find `.md` files
2. Call `read_file` to read the headers
3. Stream the answer

Each tool call is shown as a collapsible step in the chat (`▸ shell`, `▸ read_file`…); click to see the full result. Live token counter at the bottom.

## Pick a working directory (cwd)

Session header's second row, **Working directory** input:
- Type a path + Enter, or
- Click 📁 to pick a directory

All of the agent's shell / read_file / write_file use this as root. Switching sessions follows cwd; each session has its own.

## Switch engine

Session header **Engine** dropdown:
- **Kaios (Direct)** — built-in ReAct loop, default.
- **Claude Code** — requires local `claude` CLI.
- **Codex** — requires local `codex` CLI.

Switching clears cross-engine context (the three engines don't share history formats). See [[Engines]].

## Try the global hotkey

From any app, press `Ctrl/Cmd+Alt+Space` → quick panel pops up:
- Type a task → Enter → temporary session runs in the background
- Notification + result shown when done

The quick panel does not work when the main window is closed (closing the window quits the app). See [[Global-Hotkey]].

## Next

- [[Direct-Engine]] — how the built-in engine thinks and calls tools
- [[Tools-and-MCP]] — the 10 built-in tools + MCP integration
- [[Long-Term-Memory]] — how cross-session memory auto-extracts
- [[Files-and-Preview]] — built-in browser for HTML / local dev servers
