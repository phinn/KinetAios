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
