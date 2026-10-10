**发布日期:** 2026-10-20(自 v3.9.6 起 4 commits)

### 🗜️ Direct 主循环步间主动压缩 —— 估算超线就压,不等 400 报错(24c2857)

- 此前单轮 ReAct 长跑只靠 API 的 `contextTooLong`(400)被动触发 `compactWithSpill`:一轮烧满才知道超了(KinetVM 实测稳态爬到 520-527K)。现在每步工具结果落地后、下一轮 LLM 调用前,`estTokenCount` 估算超预算即**主动压缩**,失败自动降级为仅 fold、不中断回合。
- 预算单一收口:取 `ENGINE_POLICIES.directV2` 的 `v2ModelWindow×v2BudgetRatio` 下限,与 interStepCompact 同源,不另设常量。

### 💸 成本计价拆出缓存列 —— cache_read ~10% 价 / cache_creation ~125% 价(199df59)

- `tokensIn` 保持总注入口径(input+cache_creation+cache_read)不变,新增缓存拆分单列;`priceUSD(model, in, out, cacheRead, cacheCreation)` 分段计价,**修复此前 cache_read 全按全价 input 算导致的系统性成本高估**。
- Completion / AgentEvent / turn/meta 三层透传,conv_events JSON 存证;Anthropic 协议 `message_start`/`message_delta` 双处跟踪,OpenAI 协议读 `prompt_tokens_details.cached_tokens`(两处 streamComplete)。
- 明细浮层逐行 ⚡cacheRead 标记 + 合计行缓存列。

### 💰 cost_log 落库缓存拆分 —— 用量看板缓存命中率回归真口径(9d6e35c)

- cost_log 新增 `cache_read`/`cache_creation` 列(idempotent 迁移,旧行默认 0);Turn 类型 + applyEvent 逐次累加,done 时 logCost 落库,usageAggregate 聚合。
- 看板 KPI 缓存命中率改真口径 `cacheRead / inputTokens`(替换原先 `inputTokens/totalTokens` 的伪近似占位);旧数据显示 0% = 无数据,准确不误导。

### 🔧 teams runMember token 口径修正 + history 窗口折叠(6d1467d)

- member 的 `tokensIn` 此前用 `content.length` 字符数冒充(虚高数倍)且 history 持久累积从不折叠。改为挂 runAgentLoop cost 事件累加(与主循环同口径),memberUsd 由 priceUSD 精确计价,三条 team 汇总路径统一。
- member history 存回前剪枝:保 system+首条,窗口 40 条,超出从旧 assistant/tool 对折叠为一行摘要占位,防跨轮无界膨胀。

---

**English**

**Release date:** 2026-10-20 (4 commits since v3.9.6)

### 🗜️ Proactive mid-run compaction in the Direct main loop — compact on estimate, don't wait for the 400 (24c2857)

- Single-turn ReAct runs previously relied on the API's `contextTooLong` (400) to passively trigger `compactWithSpill`: a whole turn had to burn first before compaction kicked in (KinetVM plateaued at 520-527K in the wild). Now, after each tool result lands and before the next LLM call, an `estTokenCount` estimate past budget triggers **proactive compaction**; on failure it degrades to fold-only without aborting the turn.
- Single source of truth for the budget: the `v2ModelWindow×v2BudgetRatio` floor from `ENGINE_POLICIES.directV2`, same as interStepCompact — no extra constants.

### 💸 Cost pricing gains cache columns — cache_read at ~10% price / cache_creation at ~125% (199df59)

- `tokensIn` keeps its total-injection definition (input+cache_creation+cache_read); a separate cache split is added. `priceUSD(model, in, out, cacheRead, cacheCreation)` prices tiers separately, **fixing a systematic cost overestimate from billing cache_read at full input price**.
- Threaded through Completion / AgentEvent / turn/meta and persisted in conv_events JSON; Anthropic protocol tracks cache fields at both `message_start` and `message_delta`; OpenAI protocol reads `prompt_tokens_details.cached_tokens` (both streamComplete sites).
- Per-row ⚡cacheRead markers and a cache column in the detail overlay totals.

### 💰 cost_log persists the cache split — dashboard cache-hit rate returns to the true metric (9d6e35c)

- cost_log gains `cache_read`/`cache_creation` columns (idempotent migration, legacy rows default 0); Turn + applyEvent accumulate per call, logCost persists at done, usageAggregate aggregates.
- The dashboard KPI cache-hit rate now uses the true ratio `cacheRead / inputTokens` (replacing the previous `inputTokens/totalTokens` pseudo-approximation); legacy data shows 0% = no data — accurate, not misleading.

### 🔧 teams runMember token accounting fixed + history window folding (6d1467d)

- Member `tokensIn` was previously faked from `content.length` character counts (inflated several-fold), and member history grew unbounded with no folding. Now accumulated from runAgentLoop cost events (same metric as the main loop), memberUsd priced precisely via priceUSD, with all three team summary paths unified.
- Member history is pruned before persistence: keep system + first message, 40-message window, older assistant/tool pairs collapsed into one-line placeholders to prevent unbounded cross-turn growth.

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.9.6...v3.9.7
