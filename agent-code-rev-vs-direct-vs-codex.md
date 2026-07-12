# 三方对比:Claude Code (CC-rev) / Direct v2 / Codex

> 横向对比三个 agent 实现。Direct 用补齐三块后的 v2 状态。
>
> - **CC-rev**:`/Users/phinn/Documents/kinet/agent-code-rev-main` —— Claude Code 源码级 TS 重构
> - **Direct v2**:`/Users/phinn/Documents/kinet/KinetAiosWin` 的 Direct/Kaios 模式(补齐后)
> - **Codex**:`/Users/phinn/Documents/kinet/codex-main` —— OpenAI Codex CLI,Rust 工作区(~90 crate,核心在 `codex-rs/core/`)

## 核心对比

| 维度 | CC-rev(Claude Code) | Direct v2(KinetAios) | Codex(OpenAI) |
|---|---|---|---|
| **语言/形态** | TS,REPL/SDK 库 | TS,Electron 后端 | Rust 工作区 + TS npm 壳 |
| **主循环** | 两层:`QueryEngine.submitMessage` → `queryLoop`(`query.ts:241`,`while(true)`) | 一层:`runAgentLoop`(`AgentLoop.ts:21`) | 三层:`Op` 通道 → `submission_loop`(`handlers.rs:714`)→ `run_turn` ReAct(`turn.rs:225`) |
| **停止判定** | 无 tool_use → `stopHooks` + prompt-too-long/max_tokens/budget 恢复,`reason` 状态机 | 无 tool_calls → `done`;`Infinity` 轮靠停止;reactive 超长自缩重试本轮 | 无 tool_use(`needs_follow_up=false`)→ `run_turn_stop_hooks` 可重入,否则 `break`;token 超限 → autocompact 后 continue |
| **流式边执行** | 有,`StreamingToolExecutor` 模型边吐边跑工具 | 无(先收完 tool_calls 再执行) | 有,`FuturesOrdered`(`turn.rs:2129`)工具产出即 `tokio::spawn`,流不停 |
| **工具并行** | 有,`runTools` 按 `isConcurrencySafe` 分批(只读并发 10/写串行) | 有,`runToolBatch`(连续只读 `Promise.all`/写串行) | 有,`RwLock` 门控(`parallel.rs:133`):并行工具读锁、独占工具写锁,各自 `tokio::spawn` + 可取消 |
| **工具清单(特色)** | Bash/FileEdit/Glob/Grep/Agent/Task/...(数十个,feature flag 展开) | shell/read_file/write_file/edit_file/grep/glob/web_fetch/recall_memory/**git_diff**/**dispatch_agent**(共 10 个,git_diff 只读免确认) | shell、**unified_exec**(后台进程)、**apply_patch**(文件编辑)、view_image、plan、tool_search、sleep、**spawn_agent** 系列、MCP |
| **工具结果回传** | `mapToolResultToToolResultBlockParam` → `tool_result` block | `{role:'tool',tool_call_id,content}`,原序回填;长结果(>8192 字符)**头尾 3K + 中间省略**回流 | `ResponseItem::FunctionCallOutput` 追加进 `ContextManager` |
| **事件流** | `Message` union + SDKMessage(多态丰富) | 统一 `AgentEvent` 7 类,`applyEvent` 单点 fold | `EventMsg` 枚举(~380 行:TurnStarted/AgentMessage/TokenCount/ContextCompacted/...)经 `Session::send_event` |
| **上下文压缩** | 五级:toolResultBudget→snip→microcompact→contextCollapse→autocompact + reactive | 两级:`sanitizeToolPairs` 修配对 + `compactHistory` 摘要 + reactive 超长自缩 | autocompact(内联 `SUMMARIZATION_PROMPT` 或 **远程 `/responses/compact`**)+ pre-sampling compact + rollout truncation + `WorldState` 增量 diff |
| **token 预算** | `taskBudget` 跨 compact 边界 + max_output_tokens 三段恢复 | 30000(`length*0.6` 估算);reactive 砍半 15000 | `context_window.rs`/`token_budget.rs` 追踪 `full_context_window_limit`,溢出触发 autocompact |
| **Subagent / 多 agent** | `AgentTool`→`runAgent` 递归调 `query()`,支持 `run_in_background`/team/swarm | `dispatch_agent` 复用 `runAgentLoop`(独立 history、只读工具含 git_diff、maxTurns 8),同步最小版 | `spawn_agent`/`resume_agent`/`send_input`/`wait_agent`(`AgentControl`),子线程**继承 provider/批准/沙盒/cwd**,有生成深度限制 |
| **Provider / 传输** | Anthropic(含 Bedrock/Vertex) | GLM/OpenAI/Anthropic 双向 | Responses API,**HTTP/SSE 或 WebSocket**(`x-codex-turn-state` 粘性路由);可选 Bedrock/Ollama/LMStudio |
| **Retry / 恢复** | `withRetry`(429/500/529)+ fallback model + 非流式兜底 + VCR | `fetchUntil200`(429/5xx/网络错退避 3 次,只覆盖建连→200) | `responses_retry` 指数退避 → **传输回退(WebSocket→HTTPS)**;无通用 model fallback |
| **★ 沙盒执行** | **无** —— 靠 permission 确认拦截 | **无** —— shell 确认桥 `confirm()` | **核心特色,OS 级**:macOS Seatbelt(`/usr/bin/sandbox-exec`+.sbpl)、Linux bubblewrap+landlock/seccomp(独立 helper)、Windows 受限令牌;`ToolOrchestrator` 批准→沙盒→拒绝则升级重试 |
| **System prompt** | 静态可缓存段 + 动态段(skills/memory/mcp/frc/...),`DYNAMIC_BOUNDARY` cache | 单字符串拼接:base(中文)+ skill + AGENTS.md/CLAUDE.md + memory;子 agent `SUBAGENT_PROMPT` | 三层:**模型专属 `.md`**(gpt_5_codex_prompt 等)+ 动态权限/沙盒模板 + AGENTS.md;行为在工具层非 prompt 层 |
| **Permission / 批准** | 5 种 mode(default/plan/acceptEdits/bypass/auto)+ auto classifier 旁路 | 二值 `approval`(always/never)+ shell 确认模态 | `AskForApproval` 策略 + `PermissionProfile`(read-only/workspace-write/danger)+ **Guardian 自动审查**(`guardian/`) |
| **MCP** | `MCPConnectionManager` 全 transport,工具进 `mcp_instructions` 段 | `McpRegistry` **只 stdio**,扫 3 处 config,JSON-RPC,5 次重连 | `McpManager` + `rmcp-client`/`codex-mcp` crate,可刷新 |
| **Memory 长期** | CLAUDE.md → userContext + typed memory(`memdir`,分文件 append-only) | SQLite `memories`(加 `conversation_id` 列)done 后 LLM 抽"用户事实"(≤18 字),注入 strip shell 元字符;**🧠 面板 UI**(按频道过滤/行内编辑/删除/JSON 导入导出) | `memories/read`+`memories/write` crate,经 `/memories/trace_summarize` 远程生成(memgen) |
| **持久化 / resume** | transcript JSONL,subagent 走 sidechain | SQLite(conversations/turns/history FTS5/memories) | `codex-rollout`:磁盘 + SQLite `state_db`,`RolloutRecorder` 支持 `--resume`/`fork`/`archive` |

## 各自最显著的差异化

- **CC-rev**:工程完备度 + prompt-cache 友好的分段 system prompt + subagent 全家桶(`run_in_background`/team/swarm)。**抽象最重**(`Tool<I,O,P>` 泛型 + Zod + 巨型 `ToolUseContext`)。
- **Direct v2**:概念同构的最小实现。骨架与 CC 一致但去尽复杂度;**独有的 GLM 直连 + OpenAI↔Anthropic 双向**;v2 补齐了压缩/并行+subagent/retry 三块后,核心 agent 能力已追平,只是深度浅。**v1.0 后追加**:git_diff 工具、长 tool 结果自动截断、Memory 面板(per-conv 标签 + 行内编辑 + JSON 导入导出)。
- **Codex**:**唯一带 OS 级沙盒执行**(seatbelt/landlock/windows token)+ Guardian 自动审查 + Responses API WebSocket 传输 + 远程 compact 端点。**Rust 多 crate 架构最重**,工程化最高。三者里唯一把"安全执行"做成一等公民的。

## 一句话定位

CC-rev = 最完备的 agent 抽象;Direct v2 = 最精简的同构骨架(够用、可读、易改);Codex = 最硬核的安全执行工程(沙盒 + Guardian + 远程压缩)。三者 ReAct 骨架(调模型→有 tool_use→执行→喂回→无 tool_use→停)完全一致,差异全在**执行安全、上下文管理、子任务**这三条副线上。
