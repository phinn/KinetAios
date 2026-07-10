# agent-code-rev-main vs Direct(KinetAios)对比

> 对比对象
> - **CC-rev**:`/Users/phinn/Documents/kinet/agent-code-rev-main` —— Claude Code CLI 的源码级 TypeScript 重构/逆向版
> - **Direct**:`/Users/phinn/Documents/kinet/KinetAiosWin` 的 Direct/Kaios 模式 —— KinetAios 内置的 ReAct agent loop
>
> 引用说明:CC-rev 的 `file:line` 省略 `/Users/phinn/Documents/kinet/agent-code-rev-main/` 前缀;Direct 的省略 `/Users/phinn/Documents/kinet/KinetAiosWin/` 前缀。

## 核心对比

| 维度 | CC-rev(Claude Code 重构) | Direct(KinetAios) |
|---|---|---|
| **整体定位** | 生产级 agent CLI,完整 Claude Code 架构 | MVP 级 ReAct loop,~500 行核心 |
| **循环层数** | 两层:`QueryEngine.submitMessage`(turn 管理)→ `queryLoop`(`src/query.ts:241`,真 `while(true)` ReAct) | 一层:`runAgentLoop`(`src/main/AgentLoop.ts:21`),一个 `for` 跑完多步 ReAct |
| **停止判定** | 无 tool_use → 跑 `stopHooks`(`src/query/stopHooks.ts:65`)→ 还要过 prompt-too-long / max_output_tokens / token budget 恢复,`reason` 状态机(`next_turn` / `stop_hook_blocking` / `reactive_compact_retry` / ...) | 无 tool_calls → 直接 `done`(`AgentLoop.ts:56`)。轮数上限已改 `Infinity`(`AgentLoop.ts:24`),靠用户点停止 |
| **流式执行工具** | 有。`StreamingToolExecutor`(`src/services/tools/StreamingToolExecutor.ts:40`)边收边执行 tool_use,模型还在吐就开跑 | 无。先收完所有 tool_calls,再 `for ... await execute` 串行(`AgentLoop.ts:61`) |
| **工具并行** | 有。`runTools`(`src/services/tools/toolOrchestration.ts:19`)按 `isConcurrencySafe` 分批,只读批并发 10,写批串行 | 无。全程串行(`AgentLoop.ts:61-65`) |
| **Tool 抽象** | 泛型 `Tool<I,O,P>`(`src/Tool.ts:362`)+ Zod schema + `checkPermissions` / `isReadOnly` / `isDestructive` / `mapToolResult` / `render*` + `ToolUseContext` 巨型上下文 | 极简 `interface Tool { name; description; parameters; run(args,ctx) }`(`src/main/tools.ts:15-25`),裸 JSON schema |
| **内置工具** | 几十个(Bash / FileRead / FileEdit / Glob / Grep / Agent / Task / ...),feature flag 条件展开 | 8 个:shell / read_file / write_file / edit_file / grep / glob / web_fetch / recall_memory |
| **工具结果回传** | `mapToolResultToToolResultBlockParam` 包成 Anthropic `tool_result` block(`src/services/tools/toolExecution.ts:1292`) | 直接 `{role:'tool', tool_call_id, content: string}`(`AgentLoop.ts:64`) |
| **事件流** | `Message` union(assistant / user / system / stream_event / tool_use_summary / ...) + SDKMessage,事件多态丰富 | 统一 `AgentEvent` 7 类:`token / tool / cost / status / sessionStarted / done / error`(`src/shared/types.ts:66`),单一 `applyEvent` fold |
| **上下文压缩** | **五级流水线**,每轮跑:toolResultBudget → snipCompact → microcompact → contextCollapse → autocompact(子 agent 摘要) + reactive compact(413 兜底) | **只有尾部截断** `trimHistoryToTokenBudget(30000)`(`AgentLoop.ts:99`),从后往前丢,无摘要 |
| **token 预算** | `taskBudget` 跨 compact 边界跟踪 + max_output_tokens 三段恢复(escalate → nudge → surface) | 字符数 ×0.6 估算(`AgentLoop.ts:104`),单预算 30000 |
| **System prompt** | 分层:`custom ?? default` + memory + append;`getSystemPrompt`(`src/constants/prompts.ts:444`)分**静态可缓存段** + **动态段**(session_guidance / memory / env / language / output_style / mcp / frc / ...),有 `DYNAMIC_BOUNDARY` cache 标记(`prompts.ts:573`) | 字符串拼接:`baseSystemPrompt`(中文)+ skill 段 + AGENTS.md/CLAUDE.md 规则(截 8000)+ memory block(`src/main/engines.ts:62-85`) |
| **Subagent** | 有。`AgentTool`(`src/tools/AgentTool/AgentTool.tsx:196`)→ `runAgent`(`src/tools/AgentTool/runAgent.ts:248`)→ **递归调同一个 `query()`**,支持 `run_in_background`、team / swarm | **没有**(`src/main/skills.ts:3` 注释明说"不真正起 subagent") |
| **Provider** | 单一 Anthropic(含 Bedrock / Vertex 分支),`withRetry`(429/500/529)+ fallback model + 非流式兜底 + VCR 录制 | GLM / 智谱默认,OpenAI 兼容 + Anthropic 双向(`src/main/glm.ts`),**无 retry**,失败直接抛 |
| **模型选择** | plan 模式 / 超 200k token 自动切模型 | 每会话独立 `conv.model`,无动态切换 |
| **Memory 长期记忆** | 两层:CLAUDE.md 进 userContext + typed memory(`src/memdir/memdir.ts`,按主题分文件 append-only),stopHooks fire-and-forget 抽取 | 一层:SQLite `memories` 表,done 后 `extractMemories`(`src/main/TaskManager.ts:278`)调 LLM 抽"用户事实"(≤18 字),注入时 `shellSafeMemory` strip shell 元字符 |
| **Skills** | `.claude/skills` 加载成 `Command`,模型通过 `SkillTool` 执行,`session_guidance` 段告知可调用,每轮 prefetch | 扫 Claude / Codex 的 skills / commands / agents,**body 直接注入 system prompt** 当指令,agent 类型不当 subagent(`src/main/skills.ts`) |
| **MCP** | `MCPConnectionManager` 全生命周期,stdio + SSE + HTTP,工具进 `mcp_instructions` 段 | `McpRegistry`(`src/main/mcp.ts`)**只做 stdio**,扫 3 处 config,JSON-RPC,5 次重连,SSE / HTTP 标 TODO |
| **Permission** | `hasPermissionsToUseTool`,规则 alwaysAllow / Deny / Ask + 5 种 mode(default / plan / acceptEdits / bypass / auto),auto 有 classifier 旁路 | 仅 shell 一个确认桥 `confirm()`(`src/main/main.ts:37`),`approval:'never'` 直放行,其余弹窗 |
| **Commands / 斜杠** | `getCommands` 合并 built-in + skills + mcp,`processUserInput` 在 query 前展开 | `/[\w-]+` 开头即 `loadSkillBody` 注入(`TaskManager.ts:193`),**slash 命令本质就是 skill**,无独立系统 |
| **持久化** | transcript JSONL(`src/utils/sessionStorage.ts`),subagent 走 sidechain | SQLite:conversations / turns / history(FTS5)/ memories(`src/main/store.ts`) |

## 本质差异(三句话)

1. **CC-rev 是"工程完备版",Direct 是"概念同构的最小实现"。** 两者的 ReAct 骨架完全一致(调模型 → 有 tool_use → 执行 → 喂回 → 再调 → 无 tool_use → 结束),Direct 几乎是 CC-rev 去掉所有"非必要复杂度"后的骨架版——但骨架是对的。

2. **Direct 真正缺的、影响能力的只有三块:** ① **上下文压缩**(CC-rev 五级,Direct 只有尾部丢;长任务会爆 token)② **subagent / 工具并行**(影响大任务分解效率)③ **retry / 错误恢复**(CC-rev 有 withRetry + fallback + reactive compact,Direct 一次失败就停)。

3. **Direct 没缺的:** 统一事件 fold、FTS5 长期记忆 + 抽取、MCP stdio、skill 注入、shell 确认桥——这些核心机制都有,只是更简。GLM 直连 + OpenAI↔Anthropic 双向这块反而是 Direct 独有的灵活性。
