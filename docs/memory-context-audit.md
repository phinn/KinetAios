# KinetAios 记忆与 Context 管理全链路审计报告

> 审计范围：`AgentLoop.ts` · `DirectV2Engine.ts` · `TaskManager.ts` · `store.ts` · `tools.ts` · `engines.ts` · `shared/types.ts`
> 审计时间：2025-06-12

---

## 一、架构总览 — 三条 Context 生命周期线

KinetAios 有三条独立的 Context 管理线，它们在概念上正交，但在实现上有交叉：

```
┌─────────────────────────────────────────────────────────────────────┐
│                      单轮 ReAct (v1 Direct)                          │
│  runAgentLoop() → tool batch → trim → compactHistory → persist     │
│  Context 寿命: 单次 send()                                         │
├─────────────────────────────────────────────────────────────────────┤
│                    多步 Plan-Execute (DirectV2)                      │
│  Planner → [step loop: execute → verify → interStepCompact]       │
│  → Judge → [replan?] → finalizeContext                            │
│  Context 寿命: 单次 send()，但内部有 plan 级 checkpoint           │
├─────────────────────────────────────────────────────────────────────┤
│                    跨轮记忆系统 (Memory)                              │
│  extractMemories() → facts + triples + embeddings                 │
│  → memoryBlock() 注入 → recall_memory 工具检索                    │
│  Context 寿命: 永久（衰减清理），每轮注入                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、记忆子系统深度分析

### 2.1 记忆写入链路

```
对话完成 → extractMemories()
  ├── LLM 提取 facts[] + triples[] (串行锁防并发)
  ├── 三级去重:
  │   ├── 精确匹配 (existingFacts.includes)
  │   ├── 文本模糊 (textSimilarity ≥ 0.65, bigram Jaccard)
  │   └── 语义去重 (embedding cosine > 0.85)
  ├── store.addMemory() → memories 表
  ├── store.addMemoryTriple() → memory_triples 表 (s|p|o 小写去重)
  └── embed() → store.setMemoryEmbedding() → memory_embeddings 表
```

**评价**：
- ✅ 去重链路设计严谨，三级递进（精确→文本→语义），实测有效
- ✅ 同会话 extraction 串行化（`extractionLocks`）防止并发产生重复
- ✅ embedding 批量化（一次 API 调用处理所有新 fact），避免 N+1
- ⚠️ **问题 1**：`extractMemories` 的 LLM prompt 只截取 `turn.answer.slice(0, 2000)`，长回答的后半段记忆信号丢失
- ⚠️ **问题 2**：extraction 只从 `answer` 提取，不看 `tool_calls` 的工具使用模式（如用户频繁用 `edit_file` 修改同一文件，这个行为偏好不会被提取）

### 2.2 记忆注入链路 (memoryBlock)

```
memoryBlock(conv)
  ├── 构造 query: 最近 3 轮 user prompt 拼接, slice(500)
  ├── recallForInjection(query):
  │   ├── Stage 1: embedding cosine > 0.25, ≥3 条才用
  │   ├── Stage 2: FTS5 searchMemories LIKE, ≥2 条才用
  │   └── Stage 3: recent-N 兜底 (最新 15 条)
  ├── triples 注入: searchMemoryTriples(query, 5)
  └── cwd 注入
```

**评价**：
- ✅ 三级回退设计合理，保证了"总有记忆注入"
- ✅ embedding 阈值 0.25 适中（太低噪入噪声，太高漏召回）
- ⚠️ **问题 3**：注入的 query 只取 user prompt，**不含 assistant 的回答**。如果用户问"帮我改一下"这种短 prompt，语义信号极弱，embedding 检索形同虚设
- ⚠️ **问题 4**：recent-N 兜底取的是 `store.loadMemories()` 全量再 slice，3172 条记忆时做一次全量 SELECT + 排序，有性能隐患（虽然有 `created_at DESC` 索引，但全量读入内存再 slice(15) 仍有浪费）
- ⚠️ **问题 5**：triples 注入用的是 LIKE 模糊匹配，对中文分词几乎无效果（"用户偏好Tailwind" 搜不到 "用户在做Tailwind项目"）

### 2.3 记忆检索链路 (recall_memory 工具)

```
recall_memory.run(query)
  ├── Stage 1: embedding cosine(facts) — 命中 ≥3 直接返回 + triples
  ├── Stage 2: FTS5(history) 召回 30 条 → embedding 重排 → top-20
  │   + memories LIKE + triples LIKE
  └── 合并输出: memories + triples + history
```

**评价**：
- ✅ 两阶段检索（FTS5 宽召回 + embedding 精排）是工业最佳实践
- ✅ embedding 重排是实时算的，不需要预存 history embedding，零迁移成本
- 🔴 **问题 6**：Stage 1 的阈值 `score > 0.2` 与 `recallForInjection` 的 `> 0.25` **不一致**。同一套 embedding 数据，两个调用方用不同阈值，会导致工具检索和自动注入的召回率不同
- 🔴 **问题 7**：Stage 2 的 embedding 重排每次调用都实时 embed 全部 FTS5 结果（最多 30 条 × 500 字符 = 15K tokens），**延迟开销大**（一次 embed API 调用 + 30 条文本）。用户主动调 `recall_memory` 时可接受，但如果将来被 agent 频繁调用，会有累积延迟
- ⚠️ **问题 8**：FTS5 搜索的 fallback 是 `q.replace(/["*]/g, ' ')`，但 FTS5 的特殊字符远不止 `"` 和 `*`（还有 `:`, `(`, `)`, `OR`, `AND`, `NOT`, `NEAR` 等）。遇到复杂查询仍可能报语法错误

### 2.4 记忆衰减与清理

```
pruneMemories(now):
  weight = memory_meta.weight ?? 1.0
  days = (now - lastUsed) / dayMs
  decayed = weight * 0.95^days
  if decayed < 0.1 → DELETE memory + meta + embedding
  else → UPDATE weight = decayed
```

**评价**：
- ✅ 衰减公式合理（0.95^days ≈ 14 天半衰期）
- ✅ 级联清理（memory + meta + embedding 一起删）
- ⚠️ **问题 9**：`touchMemoryUsed` 只在 embedding 检索命中时调用，FTS5 / recent-N 路径**不 touch**。意味着：如果 embedding 接口不可用，所有记忆都不会被 touch → 按创建时间衰减 → 旧但常用的记忆可能被误删
- ⚠️ **问题 10**：pruneMemories 是手动调用的（没有定时器），如果用户不触发，记忆只增不减

---

## 三、Context 管理深度分析

### 3.1 单轮 Context 生命周期 (AgentLoop)

```
runAgentLoop():
  messages = [system, ...memMsg, ...history, user]
  loop:
    LLM stream → assistant message
    if no tool_calls → return dropTransient(messages)
    runToolBatch → tool results (截断 truncateForModel)
    trim: if contextTooLong → trimHistoryToTokenBudget(budget/2) → retry once
  maxTurns → error
```

**Context 控制点**：

| 控制点 | 机制 | 阈值 | 触发时机 |
|--------|------|------|----------|
| tool result 截断 | `truncateForModel` | direct 4K / v2 6K / hifi 翻倍 | 每条工具输出 |
| reactive trim | `trimHistoryToTokenBudget` | direct 15K / v2 30K | API 报超长时 |
| 摘要压缩 | `compactHistory` | direct 30K / v2 20K | 每轮结束 |
| _memory 永留 | trim/compact 跳过 | — | 始终 |
| _pinned 永留 | trim/compact 跳过 | — | 始终 |

**评价**：
- ✅ token 估算校准（滑动平均 0.5/0.5，按协议分别保存）是巧妙设计
- ✅ `sanitizeToolPairs` 清理孤儿 tool 消息是必须的（否则 API 报错）
- ⚠️ **问题 11**：`truncateForModel` 的头尾比例 37.5%/37.5% 是硬编码的。对于 shell 命令输出（重要信息在尾部）和 read_file 输出（重要信息在头部）应该有不同策略
- 🔴 **问题 12**：reactive trim 的 fallback 是**砍半预算**（`trimBudget / 2`），但只重试**一次**。如果砍半后仍然超长（system prompt 本身就很长），第二次报错直接 return `dropTransient(messages)` — 丢失整个 turn 的执行结果。应该有第三级 fallback：激进 trim 到更小预算或摘要

### 3.2 V2 多步 Context 生命周期

```
DirectV2.run():
  Planner (readOnly tools, full history)
    → execHistory = [userMsg, planConclusion]  // P0-3 隔离
  
  for each step:
    runAgentLoop(history: execHistory)  // 继承前步
    → execHistory = stepMessages
    interStepCompact(execHistory)  // 压缩
    + appendStepSummary  // 追加摘要消息
  
  Judge → replan? → finalizeContext → saveV2Checkpoint('final')
```

**评价**：
- ✅ P0-3 隔离设计正确：Planner 的探查中间过程不进 Executor
- ✅ interStepCompact fingerprint 缓存防止重复压缩
- ✅ P2-1 checkpoint 逐步持久化 + crash recovery 接通
- 🔴 **问题 13**：`interStepCompact` 的 fingerprint 太粗糙 — `${messages.length}:${lastContent.length}`。两条完全不同的消息但条数相同 + 最后一条长度相同 → 误判为"没变"，跳过压缩。应该用最后一条消息内容的前 200 字符做 hash，而不仅是长度
- 🔴 **问题 14**：crash recovery 恢复的 `execHistory` 是上次 crash 时的完整 messages（可能很长），直接传入 Executor 不做 trim。如果 crash 发生在步骤 8，恢复后步骤 9 拿到的 execHistory 已经累积了 8 步的完整历史（可能 50K+ 字符），第一轮 LLM 调用就会超长
- ⚠️ **问题 15**：replan 路径（line 570）的 `execHistory = plannerMessages` 把 Planner 的探查消息全部带入后续 Executor，**破坏了 P0-3 的隔离设计**。主 run() 正确隔离了（只取 planConclusion），但 replan 没做
- ⚠️ **问题 16**：`appendStepSummary` 追加的是 `role: 'user'` 消息。在连续多步后，execHistory 里会塞多条 user 消息（非对话回合），虽然 OpenAI/Anthropic 协议允许，但模型的 attention 机制可能将它们视为"多次用户指令"，导致行为偏移

### 3.3 Token 估算体系

```
estTokenCount(msgs):
  chars = Σ(content.length + tool_calls_json.length)
  tokens = Σ(floor(chars × coef) + 20)  // +20 per-message overhead
  coef: 按协议滑动平均校准, 默认 0.75
```

**评价**：
- ✅ 按协议分别校准（GLM ≠ Claude）是正确的
- ✅ +20 per-message overhead 贴合实际（OpenAI 有 ~4 token 的消息包装开销）
- ⚠️ **问题 17**：`coefFor` 用模块级变量 `tokenCoefByProto`，**全局共享**。如果有多个并发会话（不同模型/协议），它们的校准会互相覆盖。应该按 `proto + model` 维度分别保存

### 3.4 compactHistory 摘要压缩

```
compactHistory(msgs, budget):
  tail = trimHistoryToTokenBudget(rest, budget)
  if tail.length === rest.length → 不超预算, 直接返回
  head = rest - tail
  transcript = head → text (截断 12K)
  LLM 摘要 → summary
  return [...memory, ...pinned, { summary msg }, ...tail]
```

**评价**：
- ✅ 摘要保留任务目标、关键决策、文件路径 — prompt 设计好
- ⚠️ **问题 18**：transcript 截断到 12K 但是在**行边界**截断，如果一条 tool result 就有 10K，head 里只能放 1 条消息 → 摘要质量极差。应该限制单条消息的最大长度（如 2K），保证 head 里至少有 5-6 条消息供摘要
- ⚠️ **问题 19**：摘要结果作为 `role: 'user'` 消息插入，如果 compact 被多次调用（v2 interStepCompact + finalizeContext），execHistory 里会累积多条 `[早期对话摘要]` 消息，它们之间可能内容重复

---

## 四、dispatch_agent / sub-agent Context 隔离

```
resolveSpawnHistory(parentHistory, scope):
  'none' → 空字符串
  'last_n_turns' → 尾部 6 条消息(3 轮) → 文本
  'summary_only' → 全文 → 10K 截断 → LLM 摘要(独立调用, 不借 compactHistory)
  'full_history' → 全文, >8K 走 compactHistory
```

**评价**：
- ✅ 四档 scope 设计清晰
- ✅ summary_only 改用独立 LLM 摘要（不借 compactHistory）是正确的修复
- 🔴 **问题 20**：`last_n_turns` 的实现是 `parentHistory.slice(-6)` — 6 条消息不等于 3 轮。如果最后一条是 tool result（1 条 user + 1 assistant(tool_calls) + 1 tool + 1 assistant(text) = 4 条 = 1 轮），slice(-6) 可能切到上一轮中间，产生不完整上下文。应该按 assistant 消息边界来计数轮次

---

## 五、按优先级排序的问题清单

### P0 — 影响核心功能

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| 12 | reactive trim 只重试一次, 第二次直接丢失 turn | AgentLoop.ts:86 | 用户对话丢失 |
| 14 | crash recovery 恢复的 execHistory 不 trim | DirectV2Engine.ts:262 | 恢复后立即超长 |
| 15 | replan 破坏 P0-3 隔离, 把 Planner 探查带入 Executor | DirectV2Engine.ts:570 | Executor 上下文膨胀 |

### P1 — 影响质量/性能

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| 13 | interStepCompact fingerprint 太粗糙(条数+长度) | DirectV2Engine.ts:1047 | 跳过该做的压缩 |
| 6 | recall_memory 阈值 0.2 ≠ memoryBlock 阈值 0.25 | tools.ts:682 vs TaskManager.ts:488 | 召回不一致 |
| 3 | memoryBlock query 不含 assistant 回答 | TaskManager.ts:449 | 短 prompt 检索失效 |
| 17 | tokenCoef 全局共享, 并发会话互相干扰 | AgentLoop.ts:369 | 估算不准 |
| 20 | last_n_turns 按消息条数而非轮次切分 | engines.ts | 子 agent 上下文不完整 |

### P2 — 可优化项

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| 1 | extraction 只看 answer 前 2000 字符 | TaskManager.ts:538 | 长回答记忆丢失 |
| 7 | recall_memory FTS5 重排每次实时 embed 30 条 | tools.ts:727 | 延迟开销 |
| 8 | FTS5 特殊字符转义不完整 | tools.ts | 复杂查询报错 |
| 9 | FTS5/recent-N 路径不 touchMemoryUsed | tools.ts | 常用记忆被误衰减 |
| 10 | pruneMemories 无定时器 | store.ts | 记忆只增不减 |
| 11 | truncateForModel 头尾比例硬编码 | AgentLoop.ts:582 | shell/read_file 截断不理想 |
| 18 | compactHistory transcript 单条消息可能占满 12K | AgentLoop.ts:485 | 摘要质量差 |
| 19 | 多次 compact 累积重复摘要消息 | AgentLoop.ts:514 | 上下文浪费 |

---

## 六、与 Codex/Claude Code 的差距

| 维度 | KinetAios | Codex (Rust) | Claude Code |
|------|-----------|-------------|-------------|
| Context 压缩 | compactHistory(摘要+尾部保留) | Rolling window + selective retention | Conversation summarization |
| 记忆注入 | embedding + FTS5 + recent-N 三级 | 无长期记忆 | --append-system-prompt |
| Token 估算 | 字符×校准系数(滑动平均) | 精确 tokenizer | 精确 tokenizer |
| 多步 Context | interStepCompact + stepSummary | Step-local context (零累积) | 每步独立 context |
| Crash recovery | checkpoint + resume ✅ | Session persistence | --resume |
| 并发隔离 | 按协议分别校准(但全局共享) | Actor model 天然隔离 | 独立进程 |

**核心差距**：
1. **Token 估算精度**：Codex/Claude Code 用精确 tokenizer，KinetAios 用估算。虽然校准系数缩小了误差，但首轮调用和模型切换时的误差仍可能导致 trim 不准
2. **多步 Context 零累积**：Codex 的 StepContext 是每步独立的，不累积。KinetAios 的 interStepCompact 是"压缩后累积"，仍然在增长（只是慢了）。Codex 的设计更干净
3. **子 agent Context 隔离**：Codex 的子 agent 完全独立（独立进程 + 独立 context），KinetAios 的 sub-agent 只是"只读 + 限制 scope"，仍在同一进程内

---

## 七、推荐改进路线

### 立即修复 (P0)
1. **AgentLoop reactive trim 三级 fallback**：超长 → trim(budget/2) → trim(budget/4) → 激进摘要
2. **crash recovery 恢复后 trim**：resume 的 execHistory 先走一遍 `trimHistoryToTokenBudget`
3. **replan 隔离**：与 run() 一致，只取 planConclusion

### 短期改进 (P1)
4. **interStepCompact fingerprint 改用内容 hash**：`messages.length + sha256(lastContent.slice(0,200))`
5. **统一 embedding 阈值**：tools.ts 和 TaskManager.ts 统一用 0.25（或提取为常量）
6. **memoryBlock query 增强**：拼入最近 assistant 回答的关键句（如前 200 字符）
7. **tokenCoef 按 model 维度保存**：`tokenCoefByProto[`${proto}:${model}`]`
8. **last_n_turns 按轮次切分**：从尾部往前找 assistant(无 tool_calls) 消息，按轮次边界取

### 中期优化 (P2)
9. **extraction prompt 增大窗口**：answer slice 2000 → 4000，或分段提取后合并去重
10. **FTS5 特殊字符完整转义**：用 `q.replace(/[^a-zA-Z0-9\u4e00-\u9fff\s]/g, ' ')` 只保留字母数字中文空格
11. **truncateForModel 策略化**：read_file → 头重(60/20)，shell → 尾重(20/60)，默认 → 均衡(37.5/37.5)
12. **compactHistory 单条消息限长**：transcript 里每条消息截断到 2K，保证至少 5-6 条进入摘要

---

## 八、深度二次审计 — 逐行精读发现的额外问题

> 以下是对全部核心文件逐行精读后新发现的问题，与第一轮审计互补。

### A. V2 Executor 步骤间上下文断层（架构级）

**位置**：`DirectV2Engine.ts:400` + `DirectV2Engine.ts:620`

```ts
// 主 run() Phase 2:
execHistory = stepMessages;  // line 400 — 整个 stepMessages 覆盖 execHistory

// replan Phase 2:
execHistory = stepMessages;  // line 620 — 同样覆盖
```

**问题**：每个步骤的 `runAgentLoop` 返回的是该步**完整**的 messages（含 system + memory + execHistory + step input + step execution），而 `execHistory = stepMessages` **整体覆盖**。这意味着：

- 步骤 2 的 `execHistory` 包含步骤 1 的全部执行过程（assistant + tool_calls + tool results）+ 步骤 2 的 input + 执行过程
- 到步骤 5 时，`execHistory` 累积了 4 步完整历史（即使 interStepCompact 压缩了，也只是减缓）
- **关键遗漏**：步骤 2 的 `execHistory` 里包含了步骤 1 的 `STEP_EXECUTOR_PROMPT`（user 消息），步骤 3 又包含步骤 2 的。模型看到的是一串不连续的"执行阶段"指令，每一个都说"当前步骤 X"，但实际在步骤 Y 的上下文里

**Codex 对比**：Codex 的 StepContext 是每步独立的 — 只传 plan goal + 当前 step description + 前步 summary，不传前步的完整 ReAct 历史。KinetAios 的设计让模型在前步的探查噪声中找当前步的信号。

**建议**：`execHistory = stepMessages` 改为 `execHistory = [...execHistory, ...stepNewMessages]`（只追加增量），或在步骤完成后只保留 summary + 关键 tool results（类似 extractExecEvidence 的思路，但在步骤间而非 Judge 前做）。

### B. memoryBlock 每步重复注入但不累积（设计正确但有浪费）

**位置**：`DirectV2Engine.ts:387`

```ts
memoryBlock, // 每步都注入长期记忆：dropTransient 会从返回值里剔除
```

每次 `runAgentLoop` 都注入完整的 memoryBlock（可能 15 条 × 200 字 = 3000 字符）。在 10 步 plan 中，memoryBlock 被 embed 进 10 次 LLM 调用的 prompt（每次 ~3000 tokens），但每次都是**同样的内容**。这对 Anthropic 的 cache_control 有效（cache 命中省钱），但对 GLM 等 OpenAI 协议的 provider 是纯浪费 — 每次 3000 tokens 的 input 多算。

**建议**：V2 步骤间可以只注入"与本步相关的记忆子集"（用 step.description 做 query 检索），而非全量 memoryBlock。或设置一个 `memoryBlockPerStep` 标志，对 ≥5 步的 plan 只在前两步和最后一步注入全量。

### C. V2 退化模式（无 plan）丢失 verifyCommand

**位置**：`DirectV2Engine.ts:318-338`

```ts
if (!plan || plan.steps.length === 0) {
  // 简单任务退化为 v1 模式
  const execMessages = await runAgentLoop({...});
  await this.autoVerifyFromSteps(conv, ctx, signal, onEvent, execMessages);
  this.finalizeContext(conv, execMessages, provider, snap, signal);
  onEvent({ type: 'done' });
  return; // ← 直接 return，不进 Judge
}
```

退化模式（无 plan）直接执行 + autoVerify + finalizeContext 后 return，**跳过了 Judge**。这意味着简单任务没有质量验收。虽然 autoVerify 做了 tsc/test 验证，但如果任务不是代码修改（如分析报告生成），autoVerify 不会触发（`hasFileChange` 为 false），任务就以 runAgentLoop 的原始输出为准，没有 Judge。

**影响**：用户问"分析这个 CSV 并生成报告"，模型可能只读了一部分数据就给了答案（maxTurns 到了或模型自认为完成），退化模式不经过 Judge → 质量无保障。

**建议**：退化模式也应该走 Judge（至少做一次轻量判定），或者 autoVerify 不触发时加一个 "answer quality check"。

### D. wasTruncatedByMaxTurns 的假阳性

**位置**：`DirectV2Engine.ts:937-944`

```ts
private wasTruncatedByMaxTurns(messages: ChatMsg[]): boolean {
  const last = messages[messages.length - 1];
  if (last.role === 'assistant' && (!last.tool_calls || last.tool_calls.length === 0)) return false;
  return true; // tool 消息或带 tool_calls 的 assistant → 截断
}
```

**问题**：如果用户 abort 了当前步骤（signal.aborted），`runAgentLoop` 返回 `finalizeAbortedMessages(messages)` — 最后一条是 `{ role: 'assistant', content: '[已中断]' }`。这条消息没有 tool_calls → `wasTruncatedByMaxTurns` 返回 false → 代码继续执行 `extractLastAssistantText` → 提取到 `'[已中断]'` → 步骤被标记 done，result 为 `'[已中断]'`。

但 line 371/594 有 `if (signal.aborted) break` 保护 — 所以这个路径要触发需要 abort 发生在 `runAgentLoop` 返回后、`wasTruncatedByMaxTurns` 调用前的微任务窗口。概率极低但不是零。

**实际更大问题**：`finalizeAbortedMessages` 在 `last.role === 'tool'` 时补了 `'[已中断]'` assistant。但 `wasTruncatedByMaxTurns` 看到的是补了之后的 — 如果补尾逻辑正确执行，最后一条就是 assistant 无 tool_calls → 返回 false → 步骤"完成"了。实际上用户 stop 了，步骤不应该标记 done。

**建议**：在 `wasTruncatedByMaxTurns` 之前加 `if (signal.aborted)` 检查（虽然 for 循环顶部有 break，但在 `runAgentLoop` 返回值赋给 `stepMessages` 之后、break 检查之前的代码块仍然会执行）。

### E. checkpoint 的 history_json 序列化膨胀

**位置**：`DirectV2Engine.ts:468`

```ts
store.saveV2Checkpoint(conv.id, step.id, JSON.stringify(plan), JSON.stringify(execHistory));
```

每个步骤完成后将**整个 execHistory** 序列化为 JSON 存入 SQLite。步骤 5 的 checkpoint 包含步骤 1-4 的完整 messages（即使压缩过，可能仍有 20K+ 字符）。10 步 plan 有 10 个 checkpoint（主 run）+ 可能 2 × 10 个（replan），每个 20-50K JSON → **SQLite 单会话 V2 表膨胀到 500K-1MB**。

`clearV2State` 在下次 run 开始时清理，但如果 crash 了就永远不清理（除非用户再次 send）。

**建议**：
1. checkpoint 只存 plan JSON（轻量），execHistory 不存 — crash recovery 时从 turns 表重建
2. 或存 execHistory 的 hash + 最后 N 条消息（轻量 resume 所需的最小集）
3. 加一个启动时清理 >24h 的 V2 checkpoint 的逻辑

### F. Judge 的 default-to-complete 倾向

**位置**：`DirectV2Engine.ts:795-800`

```ts
// JSON 解析失败 → 默认判定完成(不阻塞用户)
return { completed: true, reason: 'Judge 响应解析失败,默认判定完成' };
// ...
// Judge 出错 → 默认判定完成(不因 Judge 故障阻塞流程)
return { completed: true, reason: 'Judge 调用失败,默认判定完成' };
```

两次 fallback 都返回 `completed: true`。这意味着：
- Judge LLM 返回非 JSON（如纯文本"是的完成了"）→ 判定完成
- Judge API 调用失败（网络超时、限流）→ 判定完成
- Judge 的 systemPrompt 里有"严格判定，不要因为模型说完成了就轻信" → 但如果 Judge 自己都调不通，就没有任何质量门禁了

**对比 Codex**：Codex 没有独立 Judge（它的 verify 是命令式的 — 跑 test/build，非零退出码直接 fail）。KinetAios 的 Judge 是 LLM 判定，太容易形同虚设。

**建议**：Judge 解析失败时改为 `completed: false` — 让 replan 接管（宁可多做一轮也不要假完成）。API 失败时可以保持 `completed: true`（不能因为基础设施问题阻塞用户）。或者加一个 `judgeStrictMode` 设置，让用户选择。

### G. extractExecEvidence 的时间采样偏差

**位置**：`DirectV2Engine.ts:965-1007`

```ts
for (const m of relevant) {
  // ...
  if (totalLen > BUDGET) break;  // line 1002 — 到 8000 字符就停
  parts.push(line);
}
```

**问题**：按时间顺序线性扫描，到 8000 字符预算就 break。这意味着：
- 如果前 3 步的 assistant 回答都很长（每条 600 字符），8000 / 600 ≈ 13 条消息就停
- 后面步骤（可能是最关键的最终步骤）的证据被完全丢弃
- Judge 看到的是前步证据，对后步一无所知

**建议**：改为**均匀采样** — 计算每步的 evidence，然后按步骤均分 8000 字符预算（如 10 步 × 800 字符/步）。或改为尾部优先（最后 N 步全保留，前面共享剩余预算）。

### H. compactHistory 的摘要消息角色冲突

**位置**：`AgentLoop.ts:514`

```ts
return [...memoryMsgs, ...pinnedMsgs, { role: 'user', content: `[早期对话摘要]\n${summary}` }, ...tail];
```

摘要作为 `role: 'user'` 插入。如果 tail 的第一条也是 `role: 'user'`（如步骤摘要消息），就会出现连续两条 user 消息 — OpenAI 协议虽然允许，但某些模型（尤其 Claude 协议）会报错或表现异常。

V2 场景更容易触发：步骤间 interStepCompact 压缩后插入 `[早期对话摘要]` user 消息，然后 `appendStepSummary` 又插入 `📋 步骤[X] 完成` user 消息 → 两条连续 user。

**建议**：摘要消息改用 `role: 'system'`（但 system 在 dropTransient 会被过滤），或加一个 `_summary: true` 标志，在 dropTransient 时保留但标记为非对话消息。或者直接合入 systemPrompt 的动态部分。

### I. parsePlan 的 ID 冲突风险

**位置**：`DirectV2Engine.ts:728-738`

```ts
const steps: PlanStep[] = raw.steps.map((s, i) => {
  const obj = s as Record<string, unknown>;
  return {
    id: String(obj.id ?? i + 1),  // ← 如果模型给重复 ID 或不按序
    // ...
  };
});
```

模型可能生成重复 ID（如两个步骤都叫 "1"），或者 ID 不连续（"1", "3", "5"）。checkpoint saveV2Checkpoint 用 `step.id` 做 `ON CONFLICT(conv_id, step_id)` 的唯一键 — 如果两个步骤 ID 相同，第二个会覆盖第一个的 checkpoint。

**建议**：在 parsePlan 中强制 ID 去重（如 `id: String(obj.id ?? i + 1)` 后检查重复，有重复则追加序号）。

### J. recent-N 兜底全量加载

**位置**：`TaskManager.ts:515`

```ts
return store.loadMemories().slice(0, INJECT_LIMIT).map(({ content }) => ({ content }));
```

`loadMemories()` 无参数时执行 `SELECT id, content, conversation_id FROM memories ORDER BY created_at DESC` — **全量加载所有记忆到内存**，然后 slice(15)。3172 条记忆 × 平均 50 字符 = ~160K 数据量全量读入再扔掉 99.5%。

**建议**：加 LIMIT：`store.loadMemories(undefined, INJECT_LIMIT)`，或新建 `loadRecentMemories(limit)` 函数。

### K. extractMemories 的 embedding 语义去重 O(N×M) 暴力扫描

**位置**：`TaskManager.ts:591-599`

```ts
for (let i = 0; i < candidates.length; i++) {
  const candVec = new Float32Array(candVecs[i]);
  for (const ex of embeddings) {
    if (store.cosine(candVec, ex.vec) > 0.85) { isDup = true; break; }
  }
}
```

候选 N 条 × 已有 M 条 embedding → O(N×M) 暴力 cosine。3172 条已有 × 5 条候选 = 15860 次 cosine（每次 1024 维 Float32Array 点积）。虽然单次 cosine 很快（~0.01ms），总计 ~160ms 可接受，但随着记忆增长到 5000+ 条，这个时间会线性增长。

**建议**：优先用 FTS5/Jaccard 预筛（已有），只对预筛通过的候选做 embedding 精排。当前代码已经是这个流程（先 Jaccard > 0.65 过滤再 embedding），所以实际 N 很小。这个问题是"未来隐患"而非当前瓶颈，优先级低。

### L. V2 超时风险：单步 maxTurns=30 + interStepCompact LLM 调用

**位置**：`DirectV2Engine.ts:393` + `DirectV2Engine.ts:1054`

每步 maxTurns=30，每轮一个 LLM 调用 + 可能多次工具执行。假设每轮 3 秒（含网络 + 工具），30 轮 = 90 秒/步。10 步 plan = 15 分钟。加上 interStepCompact 每步一次额外的 LLM 摘要调用（~5 秒/次）+ Judge（~5 秒）+ 可能的 2 次 replan（每次完整执行 + Judge）。

**极端情况**：10 步 × 90 秒 + 10 × compact(5s) + 3 × Judge(5s) + 2 replan × (10步 × 90s + compact + Judge) ≈ 45 分钟。用户可能以为卡死了。

**建议**：
1. 加一个全局超时（如 10 分钟），到时间优雅终止 + 保存 checkpoint
2. interStepCompact 的 LLM 调用加 15 秒超时（当前用 provider 的 signal，但没有独立 timeout）
3. 步骤间发 status 事件报告进度（"步骤 3/10，已用 4 分钟"）

### M. dispatch_agent 子 agent sandbox 绕过（安全漏洞）

**位置**：`DirectV2Engine.ts:1178`

```ts
ctx: { cwd: conv.cwd, confirm: this.confirm, convId: conv.id },
// ← 没有 sandbox 字段
```

`sandboxCheck` 逻辑：`if (!sandbox || sandbox === 'fullAccess') return null`。ctx.sandbox 为 undefined → `!sandbox` 为 true → **直接放行，不检查路径**。

子 agent 拿到 `readOnlyTools()`（含 read_file），ctx 无 sandbox → 可读取 **cwd 外任意文件**（`~/.ssh/id_rsa`、`/etc/passwd`）。虽然子 agent 是 LLM 驱动，但 prompt injection（web_fetch/read_file 读到的恶意内容）可能诱导读取敏感文件。

v1 DirectEngine 和 V2 主 ctx 都设了 `sandbox: getSettings().sandbox`，但 dispatch_agent 的 spawn 路径**漏了**。

**建议**：`ctx: { cwd: conv.cwd, confirm: this.confirm, convId: conv.id, sandbox: 'readOnly' as const }`。

### N. V2 退化模式不传 policy

**位置**：`DirectV2Engine.ts:319-334`

退化模式（无 plan 直接执行）的 `runAgentLoop` 调用没有传 `policy` 字段。`runAgentLoop` 里 `trimBudget = opts.policy?.trimBudget ?? 15_000` → 退化模式用默认 15K（而非 V2 的 30K），truncateThreshold 也退化为 8K（而非 V2 的 6K）。

退化模式的上下文管理比正常 V2 模式**更激进**，行为不一致。

**建议**：加 `policy: resolveEnginePolicy('directV2', conv.contextMode)`。

### O. compactHistory 摘要 + interStepCompact 摘要 + appendStepSummary 三重叠加

V2 多步执行中 execHistory 可能同时存在三种压缩消息：

1. `[早期对话摘要]...` — compactHistory/interStepCompact 产生
2. `📋 步骤[X] 完成...` — appendStepSummary 产生  
3. `[早期对话摘要]...` — 下一次 interStepCompact 又产生一条

到步骤 8 时，execHistory 可能长这样：
```
[早期对话摘要] 步骤1-3 的摘要...
📋 步骤[3] 完成: 结果摘要...
[早期对话摘要] 步骤4-6 的摘要(包含上面的摘要)...
📋 步骤[6] 完成: 结果摘要...
📋 步骤[7] 完成: 结果摘要...
```

摘要的摘要 — 信息损失指数级增长。步骤 1 的关键产出经过两次摘要后可能只剩模糊关键词。

**建议**：interStepCompact 改为**替换式** — 压缩后删掉旧的 `[早期对话摘要]` 消息，只保留最新的。

### P. V2 多步 plan 的 cost 事件风暴

每步 `runAgentLoop` 会发 `cost` 事件（每轮 LLM 调用一个）。10 步 plan × 平均 15 轮/步 = 150 个 cost 事件。加上 interStepCompact（10 个）、Judge（3 个）、Planner（1 个）、replan（可能 20+ 个）→ 总计 ~200 个 cost 事件。

UI 如果对每个 cost 事件做重渲染（更新成本看板），会有性能问题。`forwardEvent` 只拦截 done/error，cost 全透传。

**建议**：forwardEvent 对 cost 事件做节流（500ms 内只转发最后一个）。

### Q. parsePlan ID 冲突导致 checkpoint 覆盖

**位置**：`DirectV2Engine.ts:731` + `store.ts:521`

模型可能生成重复 step ID（两个步骤都叫 "1"）。`saveV2Checkpoint` 用 `ON CONFLICT(conv_id, step_id) DO UPDATE` → 第二个同 ID 步骤的 checkpoint **覆盖**第一个。crash recovery 时只恢复到最后一个同 ID 步骤。

**建议**：parsePlan 中强制 ID 去重。

### R. Judge default-to-complete 倾向

**位置**：`DirectV2Engine.ts:795-800`

Judge 的两个 fallback 都返回 `completed: true`。LLM 返回非 JSON → 判定完成。API 调用失败 → 判定完成。Judge 形同虚设。

**建议**：JSON 解析失败改为 `completed: false`（让 replan 接管，宁可多做一轮）。

---

## 九、全量问题汇总（按优先级排序）

### P0 — 影响核心功能 / 安全

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 12 | reactive trim 只重试一次,第二次丢失 turn | AgentLoop.ts:86 | 用户对话丢失 |
| 14 | crash recovery 恢复的 execHistory 不 trim | DirectV2Engine.ts:262 | 恢复后立即超长 |
| 15 | replan 破坏 P0-3 隔离 | DirectV2Engine.ts:570 | Executor 上下文膨胀 |
| A | V2 步骤间 execHistory 整体覆盖(非增量追加) | DirectV2Engine.ts:400/620 | 步骤间上下文累积爆炸 |
| M | dispatch_agent 子 agent sandbox 绕过 | DirectV2Engine.ts:1178 | 安全漏洞:可读 cwd 外文件 |

### P1 — 影响质量 / 一致性

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 13 | interStepCompact fingerprint 太粗(条数+长度) | DirectV2Engine.ts:1047 | 跳过该做的压缩 |
| 6 | recall_memory 阈值 0.2 ≠ memoryBlock 阈值 0.25 | tools.ts:682 vs TaskManager.ts:488 | 召回不一致 |
| 3 | memoryBlock query 不含 assistant 回答 | TaskManager.ts:449 | 短 prompt 检索失效 |
| 17 | tokenCoef 全局共享 | AgentLoop.ts:369 | 并发会话互相干扰 |
| 20 | last_n_turns 按条数非轮次切分 | engines.ts | 子 agent 上下文不完整 |
| C | 退化模式(无 plan)跳过 Judge | DirectV2Engine.ts:337 | 简单任务无质量门禁 |
| G | extractExecEvidence 时间采样偏差(前步占满预算) | DirectV2Engine.ts:1002 | Judge 看不到后步证据 |
| N | 退化模式不传 policy(降级为 direct 策略) | DirectV2Engine.ts:332 | 行为不一致 |
| O | 摘要三重叠加(摘要的摘要) | AgentLoop.ts:514 + DirectV2Engine.ts:463 | 信息损失指数增长 |
| R | Judge default-to-complete | DirectV2Engine.ts:795 | Judge 形同虚设 |

### P2 — 可优化 / 未来隐患

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 1 | extraction 只看 answer 前 2000 字符 | TaskManager.ts:538 | 长回答记忆丢失 |
| 7 | recall_memory FTS5 重排每次实时 embed 30 条 | tools.ts:727 | 延迟开销 |
| 8 | FTS5 特殊字符转义不完整 | tools.ts:718 | 复杂查询报错 |
| 9 | FTS5/recent-N 路径不 touchMemoryUsed | tools.ts | 常用记忆被误衰减 |
| 10 | decayMemories 无定时器 | store.ts | 记忆只增不减 |
| 11 | truncateForModel 头尾比例硬编码 | AgentLoop.ts:582 | 截断策略单一 |
| 18 | compactHistory transcript 单条可能占满 12K | AgentLoop.ts:485 | 摘要质量差 |
| 19 | 多次 compact 累积重复摘要消息 | AgentLoop.ts:514 | 上下文浪费 |
| B | V2 每步注入全量 memoryBlock(3000+ tokens × N步) | DirectV2Engine.ts:387 | GLM 协议下纯浪费 |
| D | wasTruncatedByMaxTurns + abort 竞态(概率极低) | DirectV2Engine.ts:937 | 步骤误判 done |
| E | checkpoint history_json 序列化膨胀 | DirectV2Engine.ts:468 | SQLite 膨胀 |
| H | compactHistory 摘要消息 role:'user' 可能连续两条 user | AgentLoop.ts:514 | Claude 协议可能报错 |
| J | recent-N 兜底全量加载 memories | TaskManager.ts:515 | 性能浪费 |
| K | embedding 去重 O(N×M) 暴力扫描 | TaskManager.ts:591 | 未来隐患 |
| L | V2 超时风险(10步plan最坏45分钟) | DirectV2Engine.ts | 用户以为卡死 |
| P | cost 事件风暴(200+ 事件/plan) | DirectV2Engine.ts | UI 性能 |
| Q | parsePlan ID 冲突导致 checkpoint 覆盖 | DirectV2Engine.ts:731 | crash recovery 丢步 |
