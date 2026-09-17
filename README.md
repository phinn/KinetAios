# KinetAios

[![macOS 14+](https://img.shields.io/badge/macOS-14%2B-black)](https://phinn.github.io/KinetAppPortal/mac.html?utm_source=github-readme&utm_medium=badge&utm_campaign=launch-m1)
[![Engines](https://img.shields.io/badge/engines-4-blue)](#四引擎真实业务跑分)
[![license](https://img.shields.io/badge/price-$39%20once-green)](https://phinn.github.io/KinetAppPortal/mac.html?utm_source=github-readme&utm_medium=pricing-cta&utm_campaign=launch-m1#buy)
[![Ollama](https://img.shields.io/badge/Ollama-free%20forever-8A2BE2)](https://phinn.github.io/KinetAppPortal/mac.html?utm_source=github-readme&utm_medium=badge&utm_campaign=launch-m1)

**macOS 上的多引擎 Agent 工作台**:Direct / Claude Code / Codex / PEVJ 四引擎并发跑同一任务,实时对比状态、步骤、token 消耗。BYO API Key,数据全落本地 SQLite,无中继服务器。

<img src="https://phinn.github.io/KinetAppPortal/assets/demo-arena.gif" alt="KinetAios demo: install → Ollama free tier → first answer → switch engine, all in 30 seconds" width="800">

## Features

**Multi-engine agent runtime** — run multiple AI agent sessions concurrently in one dashboard: built-in **Direct** (ReAct loop with native tools), **Claude Code** (`claude -p` stream-json), **Codex** (`codex exec`), and PEVJ (Plan-Execute-Verify-Judge). Switch engines per conversation; same SQLite history across all.

**MCP support** — connect MCP servers (stdio + remote SSE) and their tools are exposed to the agent automatically, alongside 30+ built-in tools: shell (with per-session approval), file read/write/edit, web search/fetch, long-term memory, git diff, computer use (screenshot / click / keyboard on macOS), and more.

**Skills auto-loading** — scans `~/.claude/skills`, `~/.codex/skills`, `~/.kinetaios/skills` and injects a lightweight catalog into the system prompt; the agent pulls full skill bodies on demand via `load_skill` when a task matches. Create a skill mid-session and it's visible immediately. A dedicated Settings → Skills panel aggregates every skill/command/agent from all sources with search, viewing and in-app editing (plugin-contributed skills read-only).

**Token accounting & cost archaeology** — input/output tokens split across every LLM call (including sub-agents, compaction, judge, teams); per-call drill-down overlay, per-channel totals, cost persisted in SQLite for archaeology.

**Long-term memory** — automatic fact extraction per turn, importance-tiered decay (critical memories never auto-delete), cosine + FTS5 dual-channel recall, cross-project memory opt-in.

**Overnight goal mode** — set a goal and the agent loops until done: supervisor persona validates each round, quota-aware failover switches models on 5h-window exhaustion, with iteration/time/cost fuses.

**Computer Use (macOS)** — background input injection via CGEventPostToPid: clicks, typing, scrolling without stealing focus; hide-self screenshots.

**Local-first** — everything in local SQLite; BYO API key; no account, no relay server, no telemetry. Ollama works out of the box.

## 四引擎真实业务跑分

同一个 **40 万行医疗器械 CRM** 交叉分析任务(多 Sheet×医院等级×时间窗,产出交互式 ECharts 报告),四引擎同一提示词、零人工干预:

| 引擎 | 得分 /10 | token 消耗 | 关键差异 |
|---|---|---|---|
| **Direct (自研)** | **9.2** | **1.31M** | 原生 SAX 流式 xlsx,文件永不进 context |
| Claude Code | 7.0 | ~2M | context 管理一流,但无插件工具,每步绕道 Bash+python |
| Codex | 5.5 | ~2.4M | sandbox-first 设计,不适合交互式数据任务 |
| PEVJ V2 (自研) | 3.5 | 3.8M+ | 四层架构 verify 环节无护栏 = token 放大器 |

> **最值钱的发现:7.5% 的 API 调用烧掉 63% 的预算。** 根因不是模型,是工具设计——agent 把大文件顺序读了 16 遍,每遍全量重发历史。换成流式读取器后该项成本归零。
> [完整报告:方法论+逐维度打分+逐步 trace](https://github.com/phinn/KinetAios/blob/main/documents/excel-cross-analysis-engines.html) — 包含自家引擎 3.5 分的全部翻车细节。

### 获取

| 档位 | 价格 | 内容 |
|---|---|---|
| **Free** | $0 永久 | 单引擎 + Ollama 本地模型(不是试用,永久免费) |
| **Pro 早鸟** | **$39 买断**(前 500 名,之后 $69) | 四引擎并发 + 全部工具链 + 免费小版本更新 |

**[下载 Mac 版 →](https://phinn.github.io/KinetAppPortal/mac.html?utm_source=github-readme&utm_medium=badge&utm_campaign=launch-m1)** · **[Buy once, $39 →](https://phinn.github.io/KinetAppPortal/mac.html?utm_source=github-readme&utm_medium=pricing-cta&utm_campaign=launch-m1#buy)** · 无订阅。

---

<!-- 原开发者文档(用法/架构/设计取舍)见下 -->

一个 **agent dashboard**:并发跑多个 agent 任务,实时看每个的状态、步骤、工具调用和产出。全局热键 ⌘⌥Space 快速下达任务。本质是 Raycast/Alfred 的 AI 版,底层是真·agent 运行时。

**形态**:Agent 运行时层 · **平台**:macOS · **北极星**:统一入口 + 多 agent 可观测。

## 现状

> 当前状态、续接信息、踩过的坑见 **`WORKLOG.md`**;架构演进见 **`docs/DESIGN-agents.md`**。

- [x] **P0–P3**:菜单栏/热键、shell 工具(带确认)、AgentLoop(ReAct)、SQLite/FTS5 召回
- [x] **dashboard**:会话列表 + 多轮 transcript + 实时状态
- [x] **设置 UI + 应用图标**:⌘,(API key / Base URL / 模型 / 协议 / 测试连接)+ ✨ 图标
- [x] **双协议 Provider**:OpenAI 兼容 + Anthropic(双向转换)
- [x] **Claude Code 引擎**:spawn claude stream-json,api_retry 透传,`--resume` 连续问答
- [x] **连续会话模型**:同一会话连续问答,新建才开新 session
- [x] **markdown 渲染**(迷你 block 解析 + 内联)
- [ ] OpenClaw 引擎、`Engine` 协议抽象、持久化会话、交互式 diff 审批、Keychain 存 key

## 用法

- **下达任务**:dashboard 底部输入条(或 ⌘⌥Space 快速面板)输入,回车提交。
- **并发**:连提多个任务,它们**同时跑**,左侧列表各显示状态(●排队 ●运行中 ●完成 ●失败)。
- **看详情**:点列表里的任务,右侧显示它的工具调用步骤 + 流式最终答案。
- agent 需要回忆过去的事,会自己调 `recall_memory` 搜 SQLite 历史。
- 执行 shell 前弹确认(显示是哪个任务在请求)。

## 跑起来

1. **填 API key**:启动 app → 设置(`⌘,` 或 Dashboard 右上角齿轮或 ✨ 菜单 → 设置…)→ 填 API Key + Base URL + 模型 ID → 点「测试连接」验证通了再跑任务。
2. **生成并编译**(首次、改了 `project.yml`、**或加了/删了 .swift 文件**后都要重跑 `xcodegen generate`):
   ```bash
   cd /Users/phinn/Documents/kinet/KinetAios
   xcodegen generate
   xcodebuild -project KinetAios.xcodeproj -scheme KinetAios build
   ```
   或 `open KinetAios.xcodeproj` 在 Xcode 里 ⌘R。
3. **运行**:启动直接出 dashboard 主窗口;菜单栏有 ✨;⌘⌥Space 唤出快速面板。

## 架构

```
[底部输入条 / ⌘⌥Space 快速面板]
            │ submit(prompt)
            ▼
      ┌─────────────┐
      │ TaskManager │  @Published tasks:[AgentTask]   并发跑多个
      └─────┬───────┘
            │ 每个 task 一个独立 AgentLoop(ReAct)
            ▼
   AgentTask(ObservableObject):status / answer(流式) / steps / error
            │
            ▼
   DashboardView:左侧任务列表(实时状态) + 右侧详情(步骤+答案)
```

| 文件 | 职责 |
|---|---|
| `KinetAiosApp.swift` | @main,WindowGroup 挂 DashboardView |
| `AppDelegate.swift` | 持有 TaskManager + 菜单栏 ✨ + 快速面板 + 热键 |
| `DashboardView.swift` | 主窗口:任务列表 / 详情 / 统计 / 输入条 |
| `QuickView.swift` | ⌘⌥Space 快速面板,提交任务 + 内联看答案 |
| `TaskManager.swift` | 任务注册表 + 并发执行 + 事件回灌 + 确认 |
| `AgentTask.swift` | 单任务状态模型(ObservableObject) |
| `AgentLoop.swift` | ReAct 循环(模型 ↔ 工具) |
| `Tool.swift` | 工具协议 + shell/read_file/web_fetch/recall_memory |
| `GLMProvider.swift` | GLM 流式 + 工具调用解析(OpenAI 兼容) |
| `Store.swift` | SQLite + FTS5 历史(单例) |
| `HotkeyManager.swift` | Carbon 全局热键 |
| `SettingsView.swift` | `⌘,` 设置窗口(API key / URL / 模型 / 测试连接) |
| `AppSettings.swift` | 运行时配置(UserDefaults 持久化,可编辑) |
| `Config.swift` | 读接口,从 AppSettings 取值(GLMProvider 每次请求读) |
| `Secrets.swift` | API key 兜底(gitignored) |
| `Assets.xcassets` | 应用图标(✨ sparkles) |
| `scripts/gen_icon.swift` | 图标生成脚本(CoreGraphics,可改后重跑) |

## 关键配置

- **模型 id**:`Config.swift` 的 `model`,默认 `glm-5.2`(以智谱控制台为准)。
- **端点**:`Config.swift` 的 `baseURL`,国内 `open.bigmodel.cn`;海外换 `api.z.ai`。

## 已知风险 / 注意

- **GLM 流式 tool_call 假设**:若实测"模型永远不调工具、只回答",把 `GLMProvider.streamComplete` 的 `"stream": true` 改 `false`。
- **任务不共享上下文**:每个任务独立,跨任务记忆靠 `recall_memory` 搜历史。
- **任务在内存**:重启后任务列表清空(历史消息仍在 SQLite,可被 recall 搜到)。持久化任务元数据是后续项。
- **并发确认**:多个 agent 同时请求 shell 确认时,模态框在主线程串行排队。

## 编辑器红波浪线?不用管

`swift` 在 PATH 上是 5.3.3 的独立 toolchain,不认识 SwiftUI / async / 协议默认参数,会刷假报错。**以 `xcodebuild` / Xcode 26.6 为准**。

## 设计取舍

- dashboard 用**原生 SwiftUI**(不是 web)。设计-taste skill 是 web 落地页用的,介质不对。
- 不做独立分类 Router:工具挂上,模型自己决定调不调。
- 不做 `write_file` 工具:shell 已能写。
- 不预抽共享客户端:先单个 `GLMProvider`,加第二个 provider 时再提 `OpenAICompatibleClient`。
- 状态指示用语义色点(运行/完成/失败):真实状态,非装饰。
