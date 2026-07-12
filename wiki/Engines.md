# 三引擎

KinetAios 支持三个可切换的 agent 引擎,每个会话独立选。**切换引擎 = 清空跨引擎上下文**(三套引擎的历史格式不互通,Direct 存 `directHistory: ChatMsg[]`,Claude/Codex 各有 session id 走 `--resume`)。

## 一句话区分

| 引擎 | 实现 | 工具系统 | 适用 |
|---|---|---|---|
| **Direct (Kaios)** | 内置 ReAct loop,直连 LLM provider | 本仓库 `tools.ts` 的 10 个工具 + MCP | 想自己控工具、控成本、看每步 |
| **Claude Code** | spawn `claude -p --output-format stream-json` | Claude Code 自带(Read/Write/Edit/Bash/Glob/Grep) | 已习惯 Claude Code CLI 的流 |
| **Codex** | spawn `codex exec --json` | Codex 自带 | 已习惯 Codex CLI 的流 |

CLI 引擎需要先在本机装好 CLI;默认关。⚙ → 行为 → 「启用 CLI 引擎」打开,才会扫 PATH。

## Direct (Kaios)

本仓库的内置引擎。详见 [[Direct-Engine]]。

- **协议**:`OpenAI 兼容` 或 `Anthropic`,二选一。Provider 在 `src/main/glm.ts`。
- **流式**:SSE,双向 OpenAI ↔ Anthropic 转换。
- **工具**:同轮内连续只读工具(`read_file` / `grep` / `glob` / `web_fetch` / `recall_memory` / `git_diff`)并发;写工具(`shell` / `write_file` / `edit_file` / `dispatch_agent`)串行。结果按 `tool_call_id` 配对回填。
- **历史**:`conv.directHistory: ChatMsg[]`,跨轮持久化,FTS5 同步进 `history` 表供 `recall_memory`。
- **超长兜底**:反应式 trim —— API 报 context-too-long 时砍半预算重试本轮一次(`AgentLoop.ts:44`)。
- **摘要压缩**:超 30K 时把头部调一次 LLM 压成摘要,保留尾部完整轮次(`compactHistory`)。

详见 [[Direct-Engine]]、[[Tools-and-MCP]]。

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

- **想用 GLM / DeepSeek / OpenAI / Anthropic 直连 + 自定义工具** → Direct
- **已经付了 Claude / OpenAI 的订阅,想用本地 CLI 的体验** → Claude Code / Codex
- **不确定** → 默认 Direct,跑一阵再决定
