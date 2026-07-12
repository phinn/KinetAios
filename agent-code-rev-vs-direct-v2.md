# agent-code-rev-main vs Direct v2(补齐三块后)对比

> v2 = Direct 补齐了「上下文压缩 / subagent+工具并行 / 重试与恢复」三块后的状态。本表更新 Direct 列,CC-rev 列与 v1 一致。
>
> - **CC-rev**:`/Users/phinn/Documents/kinet/agent-code-rev-main`(Claude Code 源码级 TS 重构)
> - **Direct v2**:`/Users/phinn/Documents/kinet/KinetAiosWin` Direct/Kaios 模式(补齐后)

## 核心对比(v2)

| 维度 | CC-rev | Direct v2(补齐后) |
|---|---|---|
| **循环结构** | 两层 `QueryEngine` → `queryLoop`(`src/query.ts:241`) | 一层 `runAgentLoop`(`src/main/AgentLoop.ts:21`) |
| **停止判定** | 无 tool_use → `stopHooks` + prompt-too-long/max_output_tokens/budget 恢复,`reason` 状态机 | 无 tool_calls → `done`;轮数 `Infinity`,靠停止;**新增 reactive trim**(超长报错→预算砍半重试本轮一次,`AgentLoop.isContextTooLong`) |
| **流式执行工具** | `StreamingToolExecutor` 边收边执行 | 无(先收完 tool_calls 再执行) |
| **工具并行** | `runTools` 按 `isConcurrencySafe` 分批,只读并发 10 | **有**(`runToolBatch`:连续只读工具 `Promise.all` 并发,写工具串行;`Tool.readOnly` 标记) |
| **Tool 抽象** | 泛型 `Tool<I,O,P>` + Zod + `checkPermissions`/`isReadOnly`/... | `interface Tool` 加 `readOnly?`;**工具增至 10 个**(+`dispatch_agent` +`git_diff`) |
| **工具结果回传** | `mapToolResultToToolResultBlockParam` | `{role:'tool', tool_call_id, content}`,按原序回填;长结果(>8192 字符)头尾 3K + 中间省略回流 |
| **事件流** | `Message` union + SDKMessage | 统一 `AgentEvent` 7 类,`applyEvent` fold(subagent 转发 cost + tool-status,吞 token) |
| **上下文压缩** | 五级:toolResultBudget→snip→microcompact→contextCollapse→autocompact + reactive compact | **sanitize 尾部 trim**(修 tool 配对切断 bug)+ **`compactHistory` 摘要压缩**(超 30000 时把头部调 LLM 压成一条)+ reactive 超长自缩 |
| **token 预算** | `taskBudget` + max_output_tokens 三段恢复 | 30000 字符预算(`length*0.6` 估算);摘要触发阈值同;reactive 砍半到 15000 |
| **System prompt** | 静态可缓存段 + 动态段(session_guidance/memory/mcp/...),`DYNAMIC_BOUNDARY` cache | 字符串拼接:base(中文)+ skill + AGENTS.md/CLAUDE.md + memory;子 agent 用 `SUBAGENT_PROMPT` |
| **Subagent** | `AgentTool` → `runAgent` 递归调 `query()`,`run_in_background`/team/swarm | **有(最小版)**:`dispatch_agent` 工具复用 `runAgentLoop`(独立 history、`readOnlyTools()`、maxTurns 8),不含 MCP/写工具,防递归 |
| **Provider** | Anthropic(含 Bedrock/Vertex),`withRetry` + fallback model + 非流式兜底 + VCR | GLM/OpenAI/Anthropic 双向(`glm.ts`),**新增 `fetchUntil200`**(429/500/502/503/529/网络错指数退避重试 3 次,带 jitter) |
| **Memory / Skills / MCP / Permission / 持久化** | typed memory(`memdir`)、SkillTool、全 transport MCP、5 种权限 mode、transcript JSONL | SQLite memories + done 后抽取、skill body 注入、stdio-only MCP、shell 确认桥、SQLite —— **均与 v1 相同(本轮未改)** |

## v1 → v2 变化(补齐的三块)

| 块 | v1(补齐前) | v2(补齐后) | 实现位置 |
|---|---|---|---|
| **① 上下文压缩** | 只有尾部按字节截断,且会切坏 `tool_calls↔tool` 配对 | `trimHistoryToTokenBudget` 加 `sanitizeToolPairs`(丢孤儿 tool);新增 `compactHistory`(超阈值摘要头部);reactive 超长自缩重试本轮 | `AgentLoop.ts` |
| **② subagent / 工具并行** | 工具全程串行、无 subagent | `runToolBatch`(只读并发/写串行);`dispatch_agent` 工具复用 `runAgentLoop` 起只读子任务;`ToolCtx.spawn/signal` 注入 | `AgentLoop.ts` / `tools.ts` / `engines.ts` |
| **③ 重试 / 恢复** | 无 retry,一次失败即停 | `fetchUntil200`(建连→200 退避重试,不覆盖 stream);`isContextTooLong` reactive trim | `glm.ts` / `AgentLoop.ts` |

## 补齐后仍未追平 CC-rev 的(刻意 MVP 留白)

- **流式边收边执行工具**(CC-rev `StreamingToolExecutor`)——Direct 仍先收完再执行。
- **五级压缩里的 microcompact / contextCollapse / snip**(编辑缓存折叠、僵尸消息清理)——Direct 只有「摘要 + 尾部 sanitize」两级。
- **subagent 的 `run_in_background` / team / swarm**——Direct 的 `dispatch_agent` 是同步串行的最小版。
- **fallback model / 非流式兜底 / VCR**——Direct 只有同模型退避重试。
- **prompt cache 友好的分段 system prompt**——Direct 仍是单字符串。

> 验证:`npm run typecheck` 通过。运行时验证(长对话触发摘要、并行耗时、`dispatch_agent`、5xx 重试、超长自缩)需 `npm start` 在 Direct 引擎实测,Windows shell 行为留 Windows 机。
