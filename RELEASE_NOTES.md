# Release Notes

## v1.1.0 — Town, Multi-Machine Collaboration & UX Overhaul

**Release Date:** 2026-07-14

69 commits since v1.0.0. Three major themes: **Town View** (game-style agent visualization), **MCP Bridge** (multi-machine agent collaboration), and **11 differentiating features** (Arena, Snapshots, Memory Graph, Voice, Ollama, and more). Plus a full UI/UX overhaul — four themes, SVG icons, custom code editor, and a reworked Git Diff.

---

### 🏘️ Town View — Your Projects as a Living Village (New)

A brand-new way to visualize and interact with your AI agents. Each project is a **house**; each conversation is a **villager** living in that house.

- **Isometric Game-Style Map** — Projects rendered as little houses on a grid. Villagers appear as animated sprites inside their house.
- **Real-Time Agent States** — Each villager shows a live status badge: Idle / Working / Done / Error. Spot what your agents are doing at a glance.
- **Inline Chat on the Map** — Click any villager to open a mini chat panel right on the map. Send a new task, stop a running agent, or jump to the full conversation — without leaving Town.
- **New Project / New Task** — "New Project" picks a working directory and builds a new house. "New Task" spawns a new villager (conversation) inside an existing house.
- **Cross-Engine** — Villagers can use any engine (Kaios / Claude Code / Codex). An engine badge identifies which one each villager runs.
- **Step Inspector** — Expand any villager to see their reasoning steps — tool calls and outputs — in real time or after completion.
- **Workbench Integration** — One-click switch between Workbench (list view) and Town (visual view) for the same projects.
- **Four-Language i18n** — Town UI fully localized: English / 简体中文 / 繁體中文 / 日本語.

---

### 🌐 Multi-Machine Collaboration — MCP Bridge (New)

Connect multiple machines running KinetAios via MCP protocol (SSE/HTTP + JSON-RPC 2.0). Machine A's Agent can dispatch full computing tasks to Machine B.

- **Local MCP Server** — Default port 18109, Bearer token auth, 30s ping keep-alive.
- **Remote SSE Client** — Auto-discover and connect to remote nodes. Remote tools appear as `[MCP:remote/node-name]` in the Direct engine.
- **`run_agent` Remote Dispatch** — Remote nodes expose only `run_agent` (not fine-grained tools), launching a complete ReAct loop on the callee side. Sandbox follows local settings, 5-minute timeout.
- **Auto-Reconnect** — SSE connections recover automatically after network drops — no more permanent failure from a single jitter.
- **Remote Agent Status Bar** — When this machine is called remotely, a gold pulsing status bar appears in the bottom-right corner, showing "Agent started / calling tool / completed" in real time.
- **Settings Page** — iOS-style toggles, one-click MCP token generation, visual remote node management. Tabs: Model / Behavior / Advanced / Collaboration.

---

### 🚀 11 Differentiating Features (Phase 1–11)

| Feature | Description |
|---|---|
| **Arena (Multi-Engine Parallel)** | Send the same prompt to multiple engines simultaneously, compare output quality side by side. |
| **File Snapshots & Rollback** | Auto-snapshot files before an Agent modifies them. Roll back to any version with one click. |
| **Cross-Engine Sub-Task Orchestration** | `dispatch_agent` spawns independent sub-agents (isolated context) for parallel exploration. |
| **Memory Graph** | Long-term memory stored as triples (subject–relation–object), visualized as a force-directed graph on Canvas. |
| **Plugin SDK v1** | Third-party plugin interface for custom tool extensions. |
| **Voice Input / Output** | 🎤 Record voice → API transcription → send. AI replies can be read aloud. |
| **Cron Scheduled Tasks** | Trigger Agents on a schedule for recurring tasks. |
| **Watch Mode** | Monitor file changes and auto-trigger an Agent. |
| **Ollama Local Models** | Connect to a local Ollama instance — fully offline capable. |
| **Semantic Recall (Embeddings)** | Independent embedding endpoint (default: GLM embedding-3). Semantic similarity search complements FTS5 keyword search. |
| **Knowledge Graph Visualization** | Canvas-based force-directed graph replaces plain text lists. Drag nodes, zoom the canvas. |

---

### 🎨 UI / UX Overhaul

- **Four Themes** — Dark / Light / **Serene** (warm grey + rose gold, new) / Gold.
- **All-SVG Icons** — Every emoji replaced with inline SVG for visual consistency.
- **Custom Code Editor** — Lightweight in-house CodeEditor replaces all `<textarea>` elements. Syntax highlighting, auto-indent, multi-language support. Zero external dependencies — no Monaco.
- **Git Diff Redesign** — Word-level diff, per-file sections, staged/unstaged grouping, clickable file rows.
- **Sidebar Cleanup** — Header buttons tucked into a ⋯ dropdown menu for a cleaner layout.
- **Message Copy Button** — One-click copy on every AI reply.
- **Redesigned App Icon** — Dark squircle + gold "K" + spark element. macOS Dock icon now displays correctly.
- **Landing Page Overhaul** — Major visual upgrade to index/landing pages with animated mockups, comparison tables, and SVG diagrams.

---

### ⚙️ Engine & Core Improvements

- **Engine Rename** — "GLM Direct" unified to **"Kaios"** across the entire app and landing page (4 languages).
- **maxTurns Configurable** — Settings control for maximum ReAct loop iterations. Default 50, 0 = unlimited.
- **Token Estimation** — Now includes `tool_calls` in the count. Sliding-average self-calibration (initial coefficient 0.6).
- **Prompt Cache** — Direct engine supports Anthropic prompt caching to reduce cost.
- **Three-Level Context Compression** — trim → LLM summary → hard truncation fallback.
- **File Encoding Auto-Detection** — `read_file` / `edit_file` / `grep` auto-detect UTF-8 / GBK / GB18030 and more.
- **Memory Injection Refactor** — Moved from systemPrompt to `history[0]`, reducing repeated injection overhead.

---

### 🐛 Notable Bug Fixes

- Binary file read crash → detection + skip
- Screenshot blank image → switched to `getDisplayMedia`
- Context break after interrupting a response then continuing the conversation
- Duplicate cost records / memory 1970 timestamps / orphan data
- Command injection hardening (`execFile` replacing `exec`)
- Webview HTML preview showing source code → CSP `frame-src` fix
- Light theme not applying in standalone windows (Dashboard / Quick / Files)
- Packaging: `asar: true` + native module unpack — fixes "damaged app" on other Windows machines
- Microphone permission not acquired — voice button fixed
- Memory timeline display + custom tool UI corrections

---

### 📦 Packaging, CI & Docs

- **GitHub Actions** — Auto-build Windows + macOS dual-platform releases.
- **Cross-Platform Branding** — All marketing copy updated from "macOS only" to "Windows & macOS". Download buttons now point to [GitHub Releases](https://github.com/phinn/KinetAios/releases/tag/v1.1.0).
- **README** — English first-screen overhaul: badges, comparison tables, download links, hero screenshot.
- **GitHub Wiki** — Full 17-page wiki (English primary + Chinese mirror).
- **Promotion Plan** — Comprehensive Chinese promotion action plan and marketing guidelines.

---

### Download

| Platform | Link |
|---|---|
| Windows (NSIS Installer) | [KinetAios-Setup-1.1.0.exe](https://github.com/phinn/KinetAios/releases/tag/v1.1.0) |
| macOS (Apple Silicon) | [KinetAios-1.1.0-arm64.dmg](https://github.com/phinn/KinetAios/releases/tag/v1.1.0) |

**Full changelog:** https://github.com/phinn/KinetAios/commits/main

---

## v1.0.0 — 首个正式发布

**发布日期：** 2026-07-12

KinetAios 首个正式版本——Windows 11 平台的三引擎 AI Agent 面板。

### 核心特性

- **三引擎架构** — Kaios（内置 ReAct）/ Claude Code / Codex，每会话可切换
- **9 个内置工具** — shell / read_file / write_file / edit_file / grep / glob / web_fetch / recall_memory / git_diff
- **SQLite + FTS5** — 对话历史全文检索 + 长期记忆抽取
- **全局热键** — 快速呼出 Quick Panel
- **MCP 协议** — stdio transport 接入外部 MCP Server
- **成本追踪** — 实时 token 消耗 + 费用统计
- **Files / Git / Rules 内联 Tab** — 不离主窗口管理项目文件
- **Workbench 项目视图** — 按 cwd 分组管理多项目
- **Dashboard 窗口** — Token 消耗 + Agent 实时状态监控
- **长期记忆面板** — 按频道查看 / 行内编辑 / 删除
- **暗 / 淡色主题**
- **四语言 i18n** — en / zh-CN / zh-TW / ja
- **@文件引用** — 拖入文件自动拼进 prompt
- **Plugin + Agent 扫描** — 自动发现 Claude / Codex 插件和 agent 配置
