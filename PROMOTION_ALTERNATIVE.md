# AlternativeTo 推广材料

> 用于 alternativeto.net 提交，以及各类"找替代品"平台的项目展示。
> 核心策略：不碰 ChatGPT（流量黑洞），专打 Claude Code / Cursor / Cline / Cherry Studio 的"多引擎短板"。

---

## 一、项目一句话（Tagline）

**Run Claude Code, Codex, and a built-in agent engine side-by-side from one desktop app.**

---

## 二、短描述（AlternativeTo "Description" 字段，≤ 260 字符）

```
KinetAios is a local-first desktop app that runs multiple AI agent engines — Claude Code, Codex, and a built-in Plan-Execute-Verify-Judge ReAct engine — in concurrent sessions from a single window. Local SQLite history, cross-engine long-term memory, 27 plugins, MCP integration, voice, and Computer Use.
```

---

## 三、替代谁 + 差异化（AlternativeTo Categories）

### 作为以下产品的替代品提交

| 替代目标 | 切入角度 |
|---|---|
| **Claude Code (CLI)** | "你已经在用 Claude Code？KinetAios 给它加了一个桌面 GUI：并发多会话、跨引擎切换、全局仪表盘、成本追踪。同时跑 Codex 和内置引擎做对比。" |
| **Cursor** | "Cursor 是单引擎编辑器。KinetAios 不做编辑器，做编排层——三个引擎同屏并行，工具调用全程可观测，数据 100% 本地。" |
| **Cline (VS Code 插件)** | "Cline 绑死 VS Code + 单引擎。KinetAios 是独立桌面端，三引擎并发，跨引擎长期记忆，不依赖任何 IDE。" |
| **Cherry Studio** | "Cherry Studio 是多模型聊天客户端。KinetAios 是多引擎 Agent 运行时——不只是聊天，是能跑 shell、读写文件、操控屏幕、跨引擎编排任务的 AI 工作台。" |
| **Open WebUI** | "Open WebUI 需要自建服务器跑 Ollama。KinetAios 是零部署桌面端，开箱即用，同时调度 Claude Code / Codex / 内置引擎。" |

---

## 四、核心功能列表（AlternativeTo "Features" / "Pros" 标签）

### 标签式卖点（每条 1-2 句）

1. **🔄 Multi-Engine Concurrent** — Three engines in one window. Each session runs independently with its own loop, status, and output. No blocking.

2. **🧠 Cross-Engine Long-Term Memory** — Facts extracted every turn persist across engine switches. FTS5 full-text + semantic vector dual recall. Your Claude Code session remembers what your Direct session learned.

3. **🖥️ Computer Use** — Agent can screenshot your screen, click, type, and drag. Full desktop automation via ReAct loop: see → think → act → verify.

4. **🌌 NEXUS Spatial Dashboard** — Visualize all sessions as orbiting nodes on a spatial canvas. Click any node for real-time agent status, token cost, and model info. Not decoration — a real control center.

5. **🔌 27 Plugins + MCP** — Arduino, ESP32, BLE, MQTT, Modbus, NestJS, Excel, PDF, Sigrok logic analyzer, Drone flight planning, Sensors, OTA firmware... Domain-specific tools no other AI agent has.

6. **🎙️ Real-time Voice** — Doubao (ByteDance) real-time voice model integration. Speak → ASR → LLM → natural TTS, with parallel agent tool execution.

7. **💰 Cost Tracking** — Per-session, per-turn token and USD cost. Dashboard aggregates across all sessions. Know exactly what each engine costs you.

8. **🔐 100% Local-First** — SQLite storage, no account, no cloud upload. API keys in OS Keychain (DPAPI / Keychain). Your engines, your keys, your data.

9. **🌐 4 Languages** — English, Simplified Chinese, Traditional Chinese, Japanese. Full i18n including plugin interfaces.

10. **📦 GPL-3.0 Open Source** — Full transparency. No telemetry. No hidden data collection.

---

## 五、版本演进时间线（证明活跃度）

> AlternativeTo 用户最怕"废弃项目"。用 18 个版本的迭代节奏说话。

```
v1.0.0  (Jul 12) — 首发三引擎 + 9 工具 + SQLite + FTS5 + MCP + 4语言i18n
v1.1.0  (Jul 14) — Ollama 本地模型 + Embedding 语义召回 + 编码自动检测 + 应用图标
v1.2.0  (Jul 15) — 11 大差异化功能：多引擎 Arena 对比 + 文件快照回滚 + 跨引擎子任务 + 知识图谱
v1.3.0  (Jul 15) — Plugin SDK v1 + 定时任务 + Watch 模式 + 语音进出 + 记忆图谱三元组
v1.4.0  (Jul 17) — 轻量代码编辑器 + 知识图谱力导向可视化 + macOS Dock 图标
v1.5.0  (Jul 28) — Markdown 编辑器 + RAG 管线 + 独立嵌入模型配置
v1.6.0  (Aug 01) — Dot/Slash 双命令菜单 + i18n 解耦重构
v1.7.0  (Aug 02) — Agent Memory System：Memory Blocks + Importance Scoring + Episodic Memory + Idle Reflection
v1.8.0  (Aug 03) — 流式渲染大修 + Git 同步状态 + V2 引擎上下文修复
v1.9.0  (Aug 04) — V2 引擎 Plan-Execute-Verify-Judge 四层架构上线
v2.0.0  (Aug 05) — V2 引擎稳定 + GFM 表格 + 四引擎对比报告 + 流式抖动根因修复
v2.1.0  (Aug 06) — 安全加固：webview 白名单化 + MCP CORS 收紧 + Anthropic vision
v2.2.0  (Aug 06) — 企业微信智能机器人 WebSocket 接入 + 记忆系统深度对比文档
v2.3.0  (Aug 06) — 飞书机器人 WebSocket + Agent 产出文件自动回传飞书
v2.4.0  (Aug 06) — 实时语音对话（豆包 WS）+ macOS DMG 双架构 + 用户操作手册
v2.5.0  (Aug 07) — 飞书/企微独立消息 Tab + macOS Intel/ARM CI 分离
v2.6.0  (Aug 10) — NEXUS 空间认知界面 Phase 1-5：轨道视图 + Mini-map + 节点拖拽
v2.7.0  (Aug 11) — Computer Use（截屏+鼠标+键盘）+ NEXUS Phase 6-9：等离子球体 → 实用管控中心
v2.8.0  (Aug 12) — UI/UX 全面改版：全局字号 + 工具步骤折叠 + Composer Craft 主题 + Sidebar 6 项修复
```

**641 commits in 31 days. Zero downtime.**

---

## 六、竞品对比表（直接放 AlternativeTo description 或 review 里）

| Feature | KinetAios | Claude Code | Cursor | Cline | Cherry Studio |
|---|:---:|:---:|:---:|:---:|:---:|
| Multi-engine concurrent | ✅ 3 engines | ❌ 1 | ❌ 1 | ❌ 1 | ◐ multi-model |
| Cross-engine memory | ✅ | ❌ | ❌ | ❌ | ❌ |
| Desktop GUI (not IDE plugin) | ✅ | ❌ CLI | ✅ | ❌ VS Code | ✅ |
| Computer Use (screen control) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Spatial agent dashboard (NEXUS) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Real-time voice | ✅ | ❌ | ❌ | ❌ | ❌ |
| Domain plugins (IoT/hardware) | ✅ 27 | ❌ | ❌ | ❌ | ❌ |
| MCP integration | ✅ client+server | ✅ | ❌ | ✅ | ❌ |
| Cost tracking per session | ✅ | ❌ | ❌ | ❌ | ❌ |
| Local-first (no account) | ✅ | ✅ | ❌ needs login | ✅ | ✅ |
| Open source | ✅ GPL-3.0 | ❌ closed | ❌ closed | ✅ Apache | ✅ MIT |

---

## 七、各平台投稿文案

### AlternativeTo（英文）

**Listing title:** KinetAios

**Tagline:** Local-first multi-engine AI agent dashboard

**Description:**
```
KinetAios is a cross-platform (Windows + macOS) desktop app that runs multiple AI agent engines side-by-side from a single window. No cloud, no account — everything stays on your machine.

THREE ENGINES, ONE PANEL
• Claude Code — spawns the CLI, parses NDJSON, resumes sessions
• Codex — spawns the CLI, parses JSONL, resume continuation
• Direct V2 — built-in ReAct with Plan-Execute-Verify-Judge architecture, 27 tools, sub-agent dispatch

WHAT MAKES IT DIFFERENT
• Cross-engine long-term memory — facts persist across engine switches
• Computer Use — agent screenshots your screen, clicks, types, drags
• NEXUS spatial dashboard — sessions as orbiting nodes, real-time status
• 27 domain plugins — Arduino, ESP32, BLE, MQTT, Modbus, NestJS, Excel, PDF, drone flight planning, OTA firmware, and more
• Real-time voice (Doubao/ByteDance WebSocket)
• Per-session cost tracking (token + USD)
• 100% local — SQLite + FTS5, API keys in OS Keychain
• GPL-3.0, zero telemetry
```

**Categories (alternatives to):** Claude Code, Cursor, Cline, Cherry Studio, Open WebUI

---

### Product Hunt（英文，280 字符 tagline + 正文）

**Tagline (260 char):**
```
Run Claude Code, Codex & a built-in agent engine in one desktop app. Multi-session concurrent, cross-engine memory, Computer Use (screen control), NEXUS spatial dashboard, 27 plugins (IoT/hardware/data), voice, cost tracking. 100% local-first. GPL-3.0.
```

**First comment (正文展开):**
```
🚀 KinetAios v2.8.0 is here — 641 commits, 18 releases in 31 days.

WHY I BUILT THIS:
I was running Claude Code, Codex, and GLM in separate terminal tabs, losing track of context. I wanted ONE window where I could see all agents working, switch engines mid-task, and have memory persist across them.

WHAT'S INSIDE:
→ Three engines, concurrent sessions, each with own loop + status
→ Cross-engine memory: your Direct session remembers what Claude learned
→ Computer Use: agent screenshots → analyzes → clicks/types → verifies
→ NEXUS: a spatial canvas showing all sessions as orbiting nodes
→ 27 plugins for hardware/IoT/data that no other AI agent has
→ Real-time voice via ByteDance Doubao
→ Everything local: SQLite, FTS5, no account, no cloud

USE CASES:
- Run the same task on 3 engines, compare outputs side-by-side
- Let Direct V2 plan, Claude Code execute, Codex review
- Automate desktop tasks (fill forms, scrape, test) via Computer Use
- Control Arduino/ESP32 via natural language
- Voice-driven coding without touching keyboard

Open source (GPL-3.0), zero telemetry.
Windows + macOS, download from GitHub Releases.

👉 https://github.com/phinn/KinetAios
```

---

### V2EX / 少数派（中文）

**标题：** KinetAios v2.8.0 — 把 Claude Code、Codex、自研引擎装进一个桌面端，31 天 18 个版本

**正文：**
```
## 这是什么

KinetAios 是一个本地优先的多引擎 AI Agent 桌面端。一个窗口同时跑 Claude Code、Codex、和自研的 Direct V2（Plan-Execute-Verify-Judge 四层架构），每个引擎独立循环、独立状态、独立输出。

## 为什么不直接用 Claude Code / Cursor

- **Claude Code 是 CLI**：开了 5 个终端 tab 就分不清谁是谁了。KinetAios 给每个会话一个可视化节点（NEXUS 空间界面），状态/Token/花费一目了然
- **Cursor 是单引擎**：不能同时跑三个引擎对比同一个问题。KinetAios 可以
- **Cline 绑死 VS Code**：KinetAios 是独立桌面端，不依赖任何 IDE

## 杀手级功能

1. **跨引擎长期记忆** — Direct 学到的用户习惯，切到 Claude Code 还记得。FTS5 + 语义向量双重召回
2. **Computer Use** — Agent 截屏 → 分析画面 → 鼠标点击 → 键盘输入 → 再截屏验证。全自动桌面操作
3. **NEXUS 空间仪表盘** — 会话按引擎分布在轨道上，点击核心球看全局统计
4. **27 个领域插件** — Arduino、ESP32、BLE、MQTT、Modbus、NestJS CRUD、Excel、PDF、逻辑分析仪、无人机航迹规划……这些别的 AI 工具一个都没有
5. **实时语音** — 豆包实时语音大模型，说话→ASR→LLM→TTS 全链路，Agent 工具结果语音播报

## 技术细节

- Electron + TypeScript，vanilla DOM（无前端框架）
- better-sqlite3 + FTS5 全文检索
- 三引擎统一 AgentEvent 事件流（token/tool/cost/done）
- contextBridge 隔离渲染进程，零 Node 泄露
- GPL-3.0，零遥测

## 下载

GitHub Releases：Windows NSIS + macOS DMG（Intel + ARM）
https://github.com/phinn/KinetAios

31 天，641 commits，18 个版本。一个人做的。
```

---

### HackerNews（英文）

**Title:** KinetAios: Local-first multi-engine AI agent dashboard (Electron + TypeScript)

**Text:**
```
I built a desktop app that runs Claude Code, Codex, and a custom ReAct engine (Plan-Execute-Verify-Judge) side-by-side from one window. Everything is local — SQLite, FTS5, API keys in OS Keychain, no account needed.

Key differentiators vs single-engine tools (Cursor, Cline, Claude Code CLI):
- Cross-engine long-term memory: facts extracted from one engine's session persist when you switch to another
- Computer Use: agent screenshots the screen, clicks, types, drags — full desktop automation loop
- NEXUS: a spatial canvas where sessions appear as orbiting nodes with real-time status/cost
- 27 domain plugins (Arduino, ESP32, BLE, MQTT, Modbus, drone flight planning) — hardware/IoT tools no other agent has
- Per-session cost tracking (token + USD)

Stack: Electron + TypeScript, no frontend framework (vanilla DOM), better-sqlite3, GPL-3.0.

641 commits in 31 days, 18 releases. Looking for feedback on the architecture and plugin system.

GitHub: https://github.com/phinn/KinetAios
```

---

## 八、Review 模板（自荐 + 鼓励用户写）

### AlternativeTo User Review 模板

```
★★★★★

Switched from running Claude Code in multiple terminal tabs. KinetAios gives me:
- A visual dashboard for all my agent sessions (NEXUS orbit view)
- Cost tracking so I know what each engine actually costs
- Cross-engine memory — my preferences persist when I switch from Claude to the built-in engine
- Computer Use for desktop automation tasks

The plugin system is wild — I can control Arduino boards and ESP32 from the same chat window where I'm writing code. Nothing else does that.

Cons: unsigned builds (SmartScreen warning on Windows), no code completion (it's not an editor), learning curve if you've never used agent tools before.
```

---

## 九、提交检查清单

- [ ] AlternativeTo 创建 listing（logo + 截图 + 描述）
- [ ] 标注 5 个替代目标（Claude Code / Cursor / Cline / Cherry Studio / Open WebUI）
- [ ] 填写 10 个 feature 标签
- [ ] Product Hunt 准备（maker comment + gallery 图片）
- [ ] V2EX 发帖（附 NEXUS 截图）
- [ ] HackerNews 选周二-周四 10am ET
- [ ] 少数派写长文版
- [ ] 所有帖子附 `github.com/phinn/KinetAios` 链接
