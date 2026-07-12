# Direct 引擎

内置 ReAct loop。`src/main/AgentLoop.ts` 是核心,搭配 `src/main/glm.ts`(provider)、`src/main/tools.ts`(工具)。

## 核心循环

`runAgentLoop(opts)`(`AgentLoop.ts:23`):

```
messages = [system, ...memMsg?, ...history, userInput]
loop:
  1. provider.streamComplete(messages, tools)
  2. push assistant 回应
  3. 没有 tool_calls → done,return
  4. 跑工具(runToolBatch),push tool 结果
  5. 回到 1
```

**默认 maxTurns = ∞**(`AgentLoop.ts:26`)。模型不收敛(一直 tool_call)会持续消耗,需手动点停止。原来是 50,改成 ∞ 是为了让复杂任务不被中途砍断。

## 系统提示拼装

`DirectEngine.run`(`engines.ts:91`)拼 `systemPrompt`:

```
baseSystemPrompt
  + skillSection(用户用 / 调用的 skill body)
  + loadProjectRules(AGENTS.md / CLAUDE.md)
  + rulesBlock(KINET.md,app 维护)
  + contextBlock(KINET-CONTEXT.md)
```

**注意:memoryBlock 不在 systemPrompt 里**。从 v1.0 起改走 `history[0]` 注入(见下)。

## memoryBlock 走 history[0](重要)

长期记忆块作为一条 user 消息插在 history 头部,带 `_memory: true` 标记。理由:

- Anthropic 的 `cache_control` 标在整个 system 上。memory 拼进 system 时,记忆每变一次就打穿整个 base+rules+context 系统缓存。
- 拆出来后,system 跨轮稳定,缓存命中;记忆只在自身变化时失效(本来就少量 token)。

代码:
- `AgentLoop.ts:36-39` —— `memMsg` 仅在当轮 `messages` 里出现
- `dropTransient`(`AgentLoop.ts:98`)—— 在 return 时过滤 system + `_memory`,**不写回 `directHistory`**(否则会跨轮堆积、变陈旧)
- `trimHistoryToTokenBudget`(`AgentLoop.ts:131`)—— `_memory` 消息永远保留,不参与预算裁剪
- `compactHistory`(`AgentLoop.ts:158`)—— `_memory` 不参与头部摘要
- `glm.ts` OpenAI provider 序列化前剥掉 `_memory`(避免发到 API);Anthropic provider 合并连续 user 消息(满足严格交替)

详见 [[Long-Term-Memory]]。

## 工具调用执行

`runToolBatch`(`AgentLoop.ts:197`):

- **连续只读工具并发**(read_file / grep / glob / web_fetch / recall_memory / git_diff / dispatch_agent)—— `Promise.all` 一起跑
- **写工具串行**(shell / write_file / edit_file)—— 防竞态
- 结果按原 `toolCalls` 顺序回填(`tool_call_id` 配对)
- abort 时补「[已停止]」占位以维持配对(OpenAI 和 Anthropic 都拒绝孤儿 tool 消息)
- UI 拿完整原文;模型拿截断版(见下)

## 长 tool result 截断

`truncateForModel`(`AgentLoop.ts:250`):

- 头尾各 3000 字符
- 中间替换成 `…[省略 N 字符;UI 步骤详情可见完整结果]…`
- 阈值 8192 字符

为什么:一个 4MB 文件 / 几 MB shell 输出 / web_fetch 全页不截的话,下一轮全字面进 input token,爆。模型基本只需头尾(路径/错误/概要)。真要全文可加 follow-up 让 read_file 偏移读。

## Token 估算与校准

`tokenCoef`(`AgentLoop.ts:113`):初始 0.6(中英混合经验值)。

每轮拿 API 真实 `prompt_tokens` 反推 token/char 比,滑动平均 0.5/0.5(`calibrateTokens`)。**自动贴合实际模型**(GLM/Claude/OpenAI 的 tokenizer 各不同且不公开 → 不上 tiktoken,加 ~1MB 依赖、打包变大)。

`estMsgChars`:`content.length + JSON.stringify(tool_calls).length`。tool_calls 之前漏算 → 大 tool result 误判余量、超发。

## 超长兜底

API 报 context-too-long 时(`AgentLoop.ts:44`):

```
isContextTooLong(e) → 砍半预算(15K)trim history → 重试本轮一次
```

`isContextTooLong` 是 best-effort:match `context length|too long|maximum context|上下文|exceed|prompt is too` 等关键字 + HTTP 413。**只重试一次**(ponytail:没做更激进的递归回退,够用)。

## 摘要压缩(compactHistory)

`compactHistory`(`AgentLoop.ts:158`):

- turn 末尾按需(超 30K token)调一次
- tail 保留完整轮次(`trimHistoryToTokenBudget`)
- head 调一次 LLM 压成「[早期对话摘要]」user 消息
- 摘要 prompt 保留:任务目标、关键决策、已确定的结论、重要的文件路径/命令/技术栈
- 失败 → 回退纯尾部 trim(不丢功能)

`ponytail:`:① 每 turn 末尾按需摘一次,未做摘要缓存(同段历史可能被反复摘要);② head 只取 `slice(0, 12_000)` 字符(超长历史头部摘要不全)。

## 子 agent(dispatch_agent)

工具 `dispatch_agent`(`tools.ts`)派发一个子任务:

- 复用 `runAgentLoop`,独立 history
- 只读工具(`readOnlyTools()`)
- maxTurns 限 8
- 事件只转发 cost(也花钱)+ tool(带前缀供 UI 观感),吞掉 token 防刷屏
- 返回值 = 子 agent 的 assistant 文本输出

主 agent 不看到子 agent 的中间过程,只看到最终文本 —— 隔离上下文,避免主对话被刷屏。

## Provider 双协议

`src/main/glm.ts`:

- **OpenAICompatibleProvider** —— `/chat/completions` + Bearer,自动前缀缓存(GLM 智谱 / DeepSeek / Qwen / OpenAI 端点都自动)
- **AnthropicProvider** —— `/v1/messages` + x-api-key + anthropic-version,显式 `cache_control` 断点(system + 末个 tool,覆盖整个 tools 数组)

两个 provider 都把响应 normalize 成同一个 `Completion`:

```ts
{ content: string; toolCalls: ToolCall[]; rawAssistant: ChatMsg; tokensIn: number; tokensOut: number }
```

`rawAssistant` 是 OpenAI-format,无论原始协议是什么 → AgentLoop history 协议无关。

## Retry 策略

`fetchUntil200`(`glm.ts:62`):

- 可重试状态码:`429 / 500 / 502 / 503 / 529`
- 指数退避:1s / 2s / 4s,±25% jitter
- 最多 3 次
- **SSE 流一旦开始就不能重试**(会重复 token),所以重试只覆盖「建连 → 拿到 200 响应」这一段

## 成本计算

`priceUSD(model, tokensIn, tokensOut)`(`glm.ts:96`):

- GLM 系列用 GLM 价(`0.00000007 / token` in)
- 其他用 OpenAI 默认价(`0.000003 / token` in)
- ⚙ → 价格 可以覆盖(API key 旁边)

Anthropic cache token 计费:`cache_read_input_tokens` 按 input 价算(实际 ~10%,高估但比漏掉好);`cache_creation_input_tokens` 按 input 价算(实际 ~125%)。

## 关键源文件

- `src/main/AgentLoop.ts` —— ReAct loop + trim + compact
- `src/main/engines.ts:91` —— `DirectEngine.run`
- `src/main/glm.ts` —— provider + 流式
- `src/main/tools.ts` —— 10 个工具

详见 [[Tools-and-MCP]]、[[Long-Term-Memory]]。
