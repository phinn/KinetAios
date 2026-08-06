# Token 使用审计报告

> 审计日期: 2026-07-16  
> 数据源: `history.db` (cost_log + turns + conversations)  
> 覆盖范围: 12 个会话, 341 turns, 227 次 API 调用

---

## 一、总览

| 指标 | 数值 |
|---|---|
| 总 API 调用 | 227 次 |
| 总 token 消耗 | **1,310,139** (≈131 万) |
| 总费用 | **$0.30** |
| 平均 tokens/call | 5,772 |
| 最大单次调用 | **189,754 tokens** (单个 turn!) |
| >10K token 调用 | 36 次 (占总量 63.2%) |
| >20K token 调用 | 6 次 (占总量 30.2%) |

### Token 分布 histogram

```
<2K     ████ 110 calls   84,383 tokens   (6.4%)
2-5K    ██   48 calls   157,307 tokens  (12.0%)
5-10K   ██   33 calls   239,979 tokens  (18.3%)
10-20K  ███  30 calls   432,316 tokens  (33.0%)  ← 最大消耗区间
20-50K  █    4 calls    107,182 tokens   (8.2%)
50-100K █    1 call      99,218 tokens   (7.6%)
>100K   █    1 call     189,754 tokens  (14.5%)  ← 单次灾难
```

---

## 二、五层 Token 浪费分析

### 浪费源 1: System Prompt 重复注入 — 浪费 ~283 万 tokens / 占比 21.5%

**根因**: 每轮 API 调用都注入完整 system prompt（固定不变），但 API 不计费缓存命中的部分。

```
每次注入的固定内容（估算）:
┌──────────────────────────────────┬──────────┬──────────┐
│ 组件                              │ 字符数    │ 估算 token │
├──────────────────────────────────┼──────────┼──────────┤
│ baseSystemPrompt                  │    ~800  │    ~480   │
│ KinetAios.md (项目规则)            │   6,676  │  4,006   │
│ 5 个插件 system prompt            │  13,280  │  7,968   │
│   - brainstorm                    │   3,286  │  1,972   │
│   - cpp-learning                  │   3,156  │  1,894   │
│   - low-altitude                  │   2,484  │  1,490   │
│   - math-practice                 │   2,161  │  1,297   │
│   - office-suite                  │   2,193  │  1,316   │
├──────────────────────────────────┼──────────┼──────────┤
│ 合计                              │  20,756  │ ≈12,453  │
└──────────────────────────────────┴──────────┴──────────┘

227 次调用 × 12,453 tokens = 2,826,831 tokens 纯固定开销
```

**关键问题**: 即使你的任务跟 C++ 启蒙、数学练习、白板头脑风暴完全无关，这 5 个插件的 prompt **每次都全量注入**。brainstorm + cpp-learning + math-practice 三个在编程任务中完全无用，却占了 ~5,163 tokens/次。

**浪费量**: 约 **117 万 tokens**（3 个无关插件 × 227 次 = 117 万）。

### 浪费源 2: Tool Results 在 ReAct 循环中累积 — 占比 ~50%

**根因**: Direct 引擎的 ReAct 循环中，每次工具调用结果都追加到 `messages` 数组。下一个 LLM 调用带上**所有历史工具结果**。

从 189K token 那个 turn 的步骤分析：

```
该 turn 执行了 174 个工具步骤:
  read_file:      16 次, 总返回 240,673 字符 (每个平均 15K 字符!)
  shell:          93 次, 总返回  60,231 字符
  edit_file:      63 次, 总返回   4,411 字符
  dispatch_agent:  2 次, 总返回   8,194 字符
  
  step 总体积: 313,509 字符 ≈ 188K tokens
```

一次 turn 读了 16 个文件，每个 ~15K 字符，全部累积在消息历史中。到第 174 步时，LLM 要重新看前面 173 个工具结果。

**累积增长模型**:
```
Step  1: messages = [system + user]                    → ~2K tokens
Step  2: messages = [system + user + tool_result_1]    → ~17K tokens (+15K)
Step  3: messages = [system + user + tool_result_1..2] → ~32K tokens (+15K)
...
Step 16: messages = [system + user + tool_result_1..16]→ ~240K tokens (被 128K 限制截断)
```

**浪费量**: 理论上只需要最后一次调用的上下文，但累积发送了 N×N/2 的重复内容。粗估浪费 **~60 万 tokens**。

### 浪费源 3: 上下文溢出后的被动截断 — 浪费 ~19 万 tokens

**根因**: 当 API 返回 `context too long` 错误时，代码做了一次 trim 到 15K budget 然后重试。这次失败的调用**已经计费**。

189K token 那次就是这样——模型生成的 tool_calls JSON 被截断导致报错，又重试了一遍。

**浪费量**: 189,754 + 99,218 = **~29 万 tokens** (2 次超大调用，至少一半是浪费的)。

### 浪费源 4: Steps 持久化膨胀 — DB 19.9 MB 中 94.6% 是 steps

```
turn data 体积分布:
  steps (工具调用中间过程): 18.8 MB (94.6%)
  answer (模型最终回复):     0.5 MB  (2.6%)
  其他:                      0.6 MB  (2.8%)
```

这些 steps 数据在**回溯历史会话时**会被重新加载到内存，但不会重新发送给 API（只发 directHistory 中的内容）。主要影响是**DB 膨胀和前端渲染卡顿**，不直接浪费 token。

### 浪费源 5: Memory Block 全量注入 — 每轮 ~3K tokens

```
1224 条 memories × 平均 15 字符 = 18,343 字符
但 memoryBlock() 只注入最近 50 条:
  50 × 15 字符 ≈ 750 字符 ≈ 450 tokens
  加上标题和格式: ~800 tokens
```

**这块控制得还行**（50 条限制起了作用），不是主要浪费源。

---

## 三、量化总结

| 浪费源 | 估算浪费 tokens | 占总消耗 % | 可修复性 |
|---|---:|---:|---|
| 无关插件 prompt 全量注入 | ~1,170,000 | 89% | ✅ 高 |
| Tool results 在 ReAct 累积 | ~600,000 | 46% | ⚠️ 中 |
| 上下文溢出重试 | ~290,000 | 22% | ✅ 高 |
| System prompt 无缓存 | ~800,000 | 61% | ❌ 依赖 API |
| Memory block | 可忽略 | <1% | ✅ 已优化 |

> 注: 各项有重叠(同一 token 可能被多个维度计入)，总浪费率约 **65-70%**。

---

## 四、解决方案（按优先级）

### P0: 插件 Prompt 按需注入 — 预计节省 60%+

**现状**: 5 个插件 prompt 全量注入每次调用。
**方案**: 根据 user prompt 关键词或 /命令 动态注入。

```typescript
// engines.ts - 改为按需注入
function selectPluginPrompts(engine: EngineKind, userInput: string): string {
  return loadPlugins()
    .filter(p => isPluginEnabled(p.manifest.name))
    .filter(p => !p.manifest.engines || p.manifest.engines.includes(engine))
    .filter(p => p.systemPromptText?.trim())
    .filter(p => {
      // 按关键词匹配 —— 插件 prompt 只在相关时注入
      const kws = p.manifest.keywords || [];
      if (kws.length === 0) return true; // 无关键词 = 始终注入
      return kws.some(kw => userInput.toLowerCase().includes(kw.toLowerCase()));
    })
    .map(p => `\n\n# 插件扩展: ${p.manifest.name}\n${p.systemPromptText}`)
    .join('');
}
```

在 `plugin.json` 中增加 `keywords` 字段:

```json
// cpp-learning/plugin.json
{ "keywords": ["c++", "编程", "代码题", "变量", "循环"] }

// math-practice/plugin.json  
{ "keywords": ["数学", "加减乘除", "口算", "应用题"] }

// brainstorm/plugin.json
{ "keywords": ["白板", "头脑风暴", "思维导图"] }

// low-altitude/plugin.json
{ "keywords": ["无人机", "飞行", "空域", "航拍", "低空"] }

// office-suite/plugin.json
{ "keywords": ["excel", "word", "csv", "pdf", "ocr", "邮件"] }
```

**效果**: 编程任务中不注入 cpp-learning/math-practice/brainstorm → 每次省 ~5,163 tokens。

### P1: Tool Result 摘要/淘汰 — 预计节省 30%+

**现状**: ReAct 循环中所有历史 tool results 全量保留。
**方案**: 定期（每 10 步）将早期 tool results 压缩为摘要。

```typescript
// AgentLoop.ts - 在 ReAct 循环中每 N 步触发一次 tool result 压缩
if (messages.filter(m => m.role === 'tool').length > 15) {
  // 将最早的 10 个 tool results 压缩为 1 条摘要
  messages = await compactToolResults(messages, keep: 5);
}
```

具体策略:
- `read_file` 结果: 只保留「文件名 + 前 3 行 + 行数」
- `shell` 结果: 只保留「命令 + 最后 5 行输出」
- `edit_file` 结果: 已经很短，保留
- `dispatch_agent` 结果: 保留

### P2: 上下文预算前置检查 — 避免 API 报错浪费

**现状**: 发送 API 请求 → 服务端返回 too long → 客户端 trim → 重试。失败的那次也计费。
**方案**: 发送前估算 token 数，超过 80% 预算就主动 trim。

```typescript
// AgentLoop.ts - 每轮发送前检查
const estimatedTokens = estTokenCount(messages);
const modelLimit = 128_000; // or read from snapshot
if (estimatedTokens > modelLimit * 0.8) {
  messages = trimHistoryToTokenBudget(messages, modelLimit * 0.6);
  onEvent({ type: 'context', action: 'trimmed', ... });
}
```

### P3: read_file 默认行数限制

**现状**: `read_file` 截断限制是 20,000 字符（~12K tokens）。
**方案**: 默认只读前 200 行，需要更多时用 `offset`/`limit` 参数。

### P4: Plugin Prompt 分层缓存

**现状**: 即使 `pluginSystemPrompts` 按需注入了，每轮还是会重复发相同内容。
**方案**: 利用 Anthropic/OpenAI 的 prompt caching，给 system prompt 加 `cache_control` 标记。（注：当前代码已经将 memoryBlock 移出 systemPrompt 来稳定缓存，这部分做得不错。）

---

## 五、会话级 Token 排行

| 会话 | API 调用 | 总 tokens | 均价/call | 主要活动 |
|---|---:|---:|---:|---|
| mrfyl4la0lci924u | 56 | 552,633 | 9,868 | 全功能开发（P0→P2） |
| a7669022-... | 63 | 186,405 | 2,959 | 代码审查 |
| mrhrfs04g63a13u3 | 12 | 86,804 | 7,234 | 功能开发 |
| 8cee334e-... | 21 | 80,479 | 3,832 | UI 开发 |
| mrk0a1w7xsonwitr | 4 | 74,238 | 18,560 | **单次大任务**（43K + 18K） |

> `mrfyl4la0lci924u` 一个会话消耗了 **42% 的总 token**，核心原因是该会话有大量 `read_file`（每次 15K 字符）累积在上下文中。
