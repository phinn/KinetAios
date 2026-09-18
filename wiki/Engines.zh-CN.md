> 🌐 Language: [English](Engines) | **中文**

# 引擎

KinetAios 内置**三代 Direct 引擎**(V1/V2/V3),加上走插件系统的 CLI 引擎,每个会话独立选。**切换引擎 = 清空跨引擎上下文**(几套引擎的历史格式不互通,Direct 存 `directHistory: ChatMsg[]`,Claude/Codex 各有 session id 走 `--resume`)。在此之上,**插件引擎**(SDK v3)能把任意外部 CLI agent 注册为 `plugin:<name>` —— 见 [[Plugins]]。

## 一句话区分

| 引擎 | 实现 | 工具系统 | 适用 |
|---|---|---|---|
| **Direct V1 (Kaios)** | 内置 ReAct loop,直连 LLM provider | `tools.ts` 内置工具 + MCP | 问答、小修改,精确控成本控步骤 |
| **Direct V2** | 在 V1 工具上做 Plan-Execute-Verify-Judge | 同 V1 + 任务清单卡 | 带验证的多文件改动 |
| **Direct V3** | 意图路由 → fast/std/deep;deep = DAG | 同 V1 + 分析模式 | 数据分析、跨文件重构、不确定用哪个时 |
| **Claude Code** *(插件开关)* | spawn `claude -p --output-format stream-json` | Claude Code 自带(Read/Write/Edit/Bash/Glob/Grep) | 已习惯 Claude Code CLI 的流 |
| **Codex** *(插件开关)* | spawn `codex exec --json` | Codex 自带 | 已习惯 Codex CLI 的流 |
| **DeepSeek Harness** *(插件引擎)* | spawn `dsh` CLI headless profile | 该 CLI 自带 | DeepSeek 一次性任务 |
| **plugin:<name>** | spawn 插件声明的任意 CLI | 该 CLI 自带 | 想接入其它 CLI agent(零代码,纯 manifest) |

CLI 引擎需要先在本机装好 CLI。它们**由插件开关控制**:在 ⚙ → 插件 里启用 `claude-code` / `codex` 插件,引擎才进下拉。V1/V2/V3 怎么选见 [[Choose-Engine]]。

## Direct V1 (Kaios)

本仓库的内置 ReAct 引擎。详见 [[Direct-Engine]]。

- **协议**:`OpenAI 兼容` 或 `Anthropic`,二选一。Provider 在 `src/main/glm.ts`。
- **流式**:SSE,双向 OpenAI ↔ Anthropic 转换。
- **工具**:同轮内连续只读工具(`read_file` / `grep` / `glob` / `web_fetch` / `recall_memory` / `git_diff`)并发;写工具(`shell` / `write_file` / `edit_file` / `dispatch_agent`)串行。结果按 `tool_call_id` 配对回填。
- **历史**:`conv.directHistory: ChatMsg[]`,跨轮持久化,FTS5 同步进 `history` 表供 `recall_memory`。
- **超长兜底**:反应式 trim —— API 报 context-too-long 时砍半预算重试本轮一次(`AgentLoop.ts:44`)。
- **摘要压缩**:超 30K 时把头部调一次 LLM 压成摘要,保留尾部完整轮次(`compactHistory`)。

详见 [[Direct-Engine]]、[[Tools-and-MCP]]。

## Direct V2 — Plan-Execute-Verify-Judge

`src/main/DirectV2Engine.ts`。复杂任务先进**规划阶段**(只读探查,产出分步计划),再按计划逐步执行,每步可带验证命令(类型检查/测试),失败自动重试(每步 ≤3 次,最多重新规划 2 次)。任务清单实时渲染为聊天流里的清单卡(`todo_write`)。太简单的任务自动退化为普通模式。

## Direct V3 — 意图路由器(默认)

`src/main/V3/`。零成本规则路由,按查询自动选三条路径之一:

| 路径 | 触发 | 行为 |
|---|---|---|
| `fast` | 查文档、简单问答 | 单轮直出,零额外开销 |
| `std` | 修 bug、写功能、数据分析 | 多轮工具执行 |
| `deep` | 跨文件重构、架构级变更 | 规划为 **DAG**,无依赖节点并行 |

deep 路径增强(v3.8.0):

- **后台执行** —— deep 任务提交 `JobManager`(`src/main/JobManager.ts`),会话立即解锁可继续对话;期间实时显示运行节点数与成本,完成自动回贴。开关:⚙ →「复杂任务后台执行(V3)」(默认开)。
- **节点级 checkpoint** —— 每个 DAG 节点完成即落 checkpoint;任务被杀/失败/重启后从最后断点继续,不再整图作废。带断点的 job 重启后标 `paused`,一键恢复。
- **同层受限并行** —— 同层只读节点按 `dagConcurrency`(缺省 3)分批并行;写节点保持串行防竞态。
- **分析模式** —— 任务描述里出现数据文件(csv/xlsx/db)时,V3 自动加载 `data-analysis` 工作法:先摸 schema 再下结论、计算交给工具(python/sqlite)不心算、中间产物落盘、结论可溯源、关键数字交叉验证。状态栏出现「📊 分析模式」即已生效。

逐任务对比见 [[Choose-Engine]]。

## Claude Code

spawn `claude -p --output-format stream-json --verbose --include-partial-messages`。逐行解析 NDJSON。

| 行为 | 实现 |
|---|---|
| 工具白名单 | `--allowedTools Read,Edit,Write,Bash,Glob,Grep` |
| 沙箱 | `--permission-mode plan/acceptEdits/bypassPermissions`(按 setting 的 sandbox) |
| 工作目录 | `--add-dir <cwd>` |
| 恢复会话 | `--resume <session_id>`(存 conv.engineSessionId,每 turn 后更新) |
| 注入记忆/规则 | `--append-system-prompt <rules+context+memory>` |

事件模型见 `engines.ts:264` 附近的 `ClaudeCodeEngine`。`init` 抓 session id,`assistant` 抓 tool_use,`user` 抓 tool_result,`result` 抓 cost + done/error。

## Codex

spawn `codex exec --json --skip-git-repo-check -C <cwd> --add-dir <cwd> -s <sandbox>`。逐行解析 JSONL。

| 行为 | 实现 |
|---|---|
| 沙箱 | `-s read-only/workspace-write/danger-full-access`(按 setting 的 sandbox) |
| 恢复会话 | `resume <session_id>` |
| 注入记忆/规则 | codex 没有 `--append-system-prompt` flag → rules + context + memory 前置拼到 prompt |

事件模型见 `engines.ts:349` 附近的 `CodexEngine`。

## 插件引擎(SDK v3)

任意外部 CLI agent 都能用纯 manifest 插件注册成引擎 —— 零 JS。引擎以 `plugin:<name>` 出现在下拉里,跑在与 Claude Code / Codex **同一套 `CliEngineAdapter` 骨架**上(spawn → 逐行解析 → resume → 退出兜底),由 `plugin.json` 的声明式 spec 配置:

- `bin` — 要 spawn 的 CLI(解析方式同 claude/codex)
- `protocol` — 四选一:`ndjson` / `jsonl-claude` / `jsonl-codex` / `plain`(行→事件预设)
- `resume` — 哪个事件字段携带 session id + 续接方式(`--resume <id>` flag 或 codex 式子命令)
- `inject` — persona/规则/记忆走 `--append-system-prompt` 式 flag 或前置拼 prompt

细节与可跑示例(裸 `git` 包装成引擎)见 [[Plugins]]。

## 跨平台 CLI spawn(重要)

npm-global 装的 CLI 是 `.cmd` shim(Windows)。Node 不允许直接 spawn `.cmd` / `.bat`(CVE-2024-27980),所以 `engines.ts:resolveBin` 把 `.cmd/.bat` 走 `shell: true`,真 `.exe` / unix bin 直接 spawn(干净的 argv、更小的 prompt 注入面)。

还有 `binEnv()` 给 PATH 补常见安装目录(`%APPDATA%\npm` / `~/.npm-global` / `/opt/homebrew/bin` 等),因为 GUI 启动的 Electron 默认拿到的 PATH 很稀疏,会找不到 `claude` / `codex`。

abort 时:Windows 上 `.cmd` shim 把 cmd.exe 作为直接子进程,`child.kill()` 只杀 cmd.exe,真正的 claude/codex 还在跑(继续计费!)—— 所以走 `taskkill /PID <pid> /T /F` 杀整棵树。Unix 直接 `child.kill()`。

## 切引擎会丢什么

切换 `conv.engine` 时:
- `directHistory` 保留(切回 Direct 还能继续)
- `engineSessionId` 清掉(对应引擎的 CLI session id 失效)
- 跨引擎的对话上下文不互通(各引擎各存各的)

设计上**有意如此**:三套引擎的世界模型、工具集、状态机都不一样,硬塞会让用户混淆。

## 共享的注入

不管哪个引擎,以下三块**每轮都注入**(在 `TaskManager.runTurn` 拼):
- **memoryBlock** —— 长期记忆(`extractMemories` 抽出来的用户事实)。Direct 走 history[0] user 消息;Claude 走 `--append-system-prompt`;Codex 拼到 prompt 头。详见 [[Long-Term-Memory]]。
- **rulesBlock** —— `KINET.md`(app UI 维护的项目规则)
- **contextBlock** —— `KINET-CONTEXT.md`(项目级背景知识)

Direct 还额外注入 `AGENTS.md` / `CLAUDE.md`(约定大于配置)。详见 [[Rules-and-Context]]。

## 怎么选

- **想用 GLM / DeepSeek / OpenAI / Anthropic 直连 + 自定义工具** → Direct(快任务 V1,多步任务 V3)
- **已经付了 Claude / OpenAI 的订阅,想用本地 CLI 的体验** → Claude Code / Codex
- **不确定** → 默认 V3,它自己路由 fast/std/deep。逐任务对比见 [[Choose-Engine]]
