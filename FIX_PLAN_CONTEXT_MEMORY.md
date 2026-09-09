# 修复计划:上下文管理与记忆系统(第一批 5 项,带验证方案)

> 来源:2025-09 上下文管理/记忆功能问题分析。
> 原则:每个修复 = 改动设计 + 单元测试(回归锁)+ 手动 E2E 场景;独立 commit,可单独回滚。
>
> **实施状态(2025-09):✅ 全部完成。** `npm run test` 49 项断言全绿(6 个测试文件),
> `npm run typecheck` + `npm run build` 通过。实施记录:
> - 基建:`scripts/run-tests.js` + `scripts/test/`(electron shim + node:sqlite 版 better-sqlite3 shim + harness)。
>   Electron 二进制本地未下载全且 ABI 锁死 better-sqlite3 → shim 基于 node:sqlite(同款 SQLite/FTS5,行为一致)。
> - Fix 2:`store.ts` `MemoryBlockWriteResult`(stored/droppedHead/droppedTail)+ append 满块滚动淘汰头部 + 工具回执如实上报;`main.ts` IPC 透出 droppedTail。
> - Fix 3:`AgentLoop.ts` `isContextTooLong` 导出,正/负 pattern(POS 上下文措辞 / NEG 限流配额),负向优先。
> - Fix 5:`AgentLoop.ts` `MAX_SUMMARY_MSGS=3` + `consolidateSummaries`(LLM 合并,失败退化拼接 6K 截断);
>   摘要 tokens > budget×50% 同样触发;`compactWithSpill` 取最新摘要。
> - Fix 1:新增 `src/main/memory-recall.ts` 统一检索链(embed 可注入);`store.scoredMemories` 加
>   restrictConvId + relevanceFn 带 id;TaskManager 两个 recall 方法改薄委托。
> - Fix 4:新增 `src/main/pin-history.ts` `applyPin`;`Turn.histStart` 在 send/goal-loop 记录;
>   `pinTurn` 映射消息级 `_pinned` 并持久化;AgentLoop trim 路径新增受保护头部超预算告警。
> - 计划外发现并修复:摘要消息也是 user role,压缩重排后会骗过 pin 的区间校验 → applyPin 排除摘要起点。
> - 批次 2 未动(见文末);全局模式下"importance=10 但 relevance=0 可挤掉相关记忆"属批次 2 #11,有单测圈定行为。

---

## 0. 前置:最小验证基建(一次搭好)

现状:工程无任何测试框架(package.json 只有 `typecheck`/`build`,无 jest/vitest)。

方案:用现有 devDependency **esbuild** 搭最小 harness,零新增依赖:

- `scripts/test/shims/electron.ts`:`export const app = { getPath: () => <每测试独立的 tmp dir> }`;
  esbuild 打包时 `--alias:electron=` 指向该 shim → `store.ts` 可在纯 node 下用真实
  better-sqlite3(`--external:better-sqlite3`)在临时目录建库。
- `scripts/test/harness.ts`:`test(name, fn)` 顺序执行 + 失败打印期望/实际 + 非 0 退出码。
- `scripts/test/*.test.ts`:每个修复一个测试文件,setup 各自建独立 tmp dir(防串库)。
- `scripts/run-tests.js`:esbuild 逐个 bundle 到 `tmp-test/` 后 node 执行。
- package.json 增:`"test": "npm run typecheck && node scripts/run-tests.js"`。

**验收门:每步改动后 `npm run test` 全绿。**

---

## Fix 1 — 默认会话记忆注入"查询盲"(高严重度)

**位置**:`TaskManager.ts:889-908` `recallForInjectionSession`

**问题**:跨项目记忆关闭(默认)时,只要库里有 embedding,直接
`listMemoryEmbeddings(convId).slice(0, 15)` 返回——不算相似度、SQL 无 ORDER BY
(按 rowid 即最旧优先)。注入的"检索式记忆"与当前对话完全无关。

**改动**:
1. 新建 `src/main/memory-recall.ts`,把全局/会话两条检索链抽成同一实现(embed 可注入以便测试):

   ```ts
   export async function recallMemories(opts: {
     query: string; limit: number;
     restrictConvId?: string;   // undefined = 全局
     embed: (texts: string[]) => Promise<number[][]>;
   }): Promise<Array<{ id: string; content: string; conversationId: string | null; score: number }>>
   ```

2. 统一三级链(session/global 只差 `restrictConvId`):
   embedding cosine 召回 top-30(score>0.2)→ `scoredMemories` 重排 → <3 条走 FTS/LIKE
   → 再不足走 recent-N(restrict 下维持现有过滤);命中一律 `touchMemoryUsed`。
3. `store.scoredMemories` 加可选 `restrictConvId` 参数(SQL 补
   `conversation_id IS NULL OR = ?`),否则 session 模式无法安全复用它。
4. TaskManager 两个私有方法改为薄委托,删除直返逻辑。

**验证**:
- 单测 `memory-recall.test.ts`(fake embed):
  - a. 相关性排序:15 条旧记忆 + 1 条高相关记忆,断言高相关者入选且不再"最旧优先";
  - b. restrict 过滤:其它会话的记忆不出现,`conversation_id IS NULL` 的全局记忆出现;
  - c. 降级链:embed 抛错 → LIKE 兜底;LIKE 空 → recent-N 且遵守 restrict;
  - d. `scoredMemories` restrict 生效:高 importance 但归属其它会话的记忆不挤入。
- 手动 E2E:同会话先聊"喜欢 Tailwind",插入大量无关内容后再提问 → 回答引用的
  "关于用户"记忆块包含 Tailwind(修前是最旧 15 条)。

---

## Fix 2 — memory_append/replace 静默截断(高严重度)

**位置**:`store.ts:788-807`(`updateMemoryBlock`/`appendMemoryBlock`),`tools.ts:1349-1415`

**问题**:append 满块时 `(old + '\n' + content).slice(0, charLimit)` 截掉的是**新内容**,
却返回 `true`,工具回"✅ 已追加";描述写"从头部截断"与实现相反。update 超限同样静默。

**改动**:
1. store 返回结构化结果:`{ ok: boolean; stored: number; droppedHead?: number; droppedTail?: number }`。
2. 语义修正(与工具描述对齐):append 满块时**滚动淘汰头部、保留新尾部**
   (`slice(-charLimit)`),`droppedHead` 如实上报;update 超 limit 截尾并报 `droppedTail`。
3. tools 回执:发生淘汰时返回"⚠️ 已写入但块满,头部最旧 N 字符被淘汰,建议 memory_replace 整理";
   修正 `tools.ts:1390` 文案。
4. 适配 `main.ts` IPC `memory-block-update` 调用点。

**验证**:
- 单测 `memory-blocks.test.ts`(limit=100):空块 append 50 → stored=50 无淘汰;
  满 100 再 append 30 → stored=100、droppedHead=30、**新内容完整在块尾**;
  content>limit 的 update → 截尾且返回 dropped;persona 只读拒绝不变。
- 手动:把 user_profile 的 limit 调小,让 agent memory_append 超限 → 回执出现淘汰警告(修前静默 ✅)。

---

## Fix 3 — isContextTooLong 误判触发破坏性裁剪(高严重度)

**位置**:`AgentLoop.ts:903-908`

**问题**:正则含裸 `exceed|上下文`,"rate limit exceeded"、"quota exceeded"、
"Max retries exceeded" 全部命中 → 历史被砍到 1/4,一次限流错误永久摧毁会话上下文。

**改动**:
1. 导出函数;正向短语 + 负向排除:

   ```ts
   const NEG = /(rate.?limit|quota|billing|insufficient|429|too many requests)/i;
   const POS = /(context length|maximum context|context_window|prompt is too|too long|上下文(长度|过长|超出|窗口))/i;
   // isContextTooLong = code === 413 || (POS.test(text) && !NEG.test(text))
   ```

2. 删除裸 `exceed`;三级 fallback 行为不变,仅判定收紧。

**验证**:
- 单测 `ctx-detect.test.ts` 措辞表:
  - true:`maximum context length is 8192 tokens` / `prompt is too long: 200000 > 128000` /
    `上下文长度超出限制` / HTTP 413;
  - false:`rate limit exceeded, retry after 30s` / `quota exceeded for this model` /
    `Max retries exceeded` / `insufficient quota` / `429 Too Many Requests` / 普通网络错误。
- 行为级:`runAgentLoop` + fake provider 第一轮 throw "rate limit exceeded" →
  断言收到 error 事件、messages 未被 trim、无 `context/trimmed` 事件;
  再 throw context 措辞 → 断言确实 trim 并重试。

---

## Fix 4 — pinTurn 压缩保护整体失效

**位置**:`TaskManager.ts:1211-1220`(`pinTurn`);保护代码 `AgentLoop.ts:636,698` 闲置

**问题**:`pinTurn` 只写 `turn.pinned`(UI 元数据),没有任何代码把 pinned 映射成
directHistory 消息上的 `_pinned` → "锁定 turn 不被压缩"功能整体不生效。

**改动**(已确认可落地:`saveTurn`/`saveDirectHistory` 均整体 JSON 序列化,新字段与
消息标记跨重启存活):
1. send 流程(engine.run 前后)记录 `startIdx = conv.directHistory?.length ?? 0`,
   结束后把本 turn 的消息区间起点存到 turn 新字段 `histStart`(旧数据无此字段 → 兼容)。
2. `pinTurn(un)`:按 `histStart` 定位该 turn 的消息区间,对 directHistory 对应消息
   设/清 `_pinned`,并 `saveDirectHistory`。
3. 边界处理:
   - 旧 turn 无 `histStart` → pin 时提示"该轮早于版本升级,锁定对本会话后续压缩不生效";
   - 手工编辑过 directHistory(IPC saveDirectHistory)→ pinTurn 校验区间首条是否 user 消息,
     不符则报错让用户重新 pin;
   - branchFrom 新会话 directHistory 清空 → pinned 自然无效(文档注明);
   - 非 Direct 引擎无 directHistory → 维持现状(UI 元数据)。
4. trim/compact 的 `_pinned` 保护已存在,无需改;补一处防御:memory+pinned+摘要合计
   超预算时 nuclear 兜底保留最新 pinned 并发 warning status,避免撑爆窗口后死循环。

**验证**:
- 单测 `pin.test.ts`:3 turn 的 directHistory,中间 turn 置 `_pinned` →
  `trimHistoryToTokenBudget`(极小预算)断言中间 turn 的 user+assistant 存活、前后被裁;
  `compactHistory`(fake provider)同理;pinned 合计超预算 → 不死循环、有 status 警告。
- 手动:长会话 pin 中间一轮 → 继续灌长内容触发压缩 → 「上下文检查器」确认 pinned 消息仍在;
  unpin 后再压缩 → 被正常摘要。

---

## Fix 5 — 压缩摘要无界膨胀

**位置**:`AgentLoop.ts:688-780`(`compactHistory`)、`AgentLoop.ts:24`(spill 取错摘要)

**问题**:每次压缩新增一条 `[早期对话摘要]`,旧摘要永不参与二次压缩,且
memory+pinned+全部摘要不占任何预算 → 长会话保护头部线性增长,最终撑爆窗口走 nuclear 报错。

**改动**:
1. 常量 `MAX_SUMMARY_MSGS = 3`;
2. 生成新摘要前:若已有摘要数 ≥ MAX,把「旧摘要 + 本次 head」合并为一次结构化摘要调用
   (复用现有 prompt,追加"合并去重历次摘要"指令),产出单条替换全部旧摘要;
   LLM 失败 → 非 LLM 退化合并(拼接截断到单条上限),保证条数收敛;
3. 保护头部(memory+pinned+摘要)tokens > budget×50% 时同样触发合并(即使条数未超);
4. 顺带修正 spill 审计:`after.find(...)` 取到的是最旧摘要 → 改取本次新生成的那条。

**验证**:
- 单测 `summary-cap.test.ts`(fake provider):
  - a. 连续 10 轮 compact → 产物中 `[早期对话摘要]` 消息 ≤3;
  - b. 合并保真:旧摘要含"决策A/B/C"、新 head 含"决策D" → 合并产物含 D 且保留 A/B/C 要点;
  - c. LLM 永远失败 → 条数仍收敛(退化合并)、不抛错;
  - d. 与 trim 联动:cap 内的三条摘要在小预算 trim 下不丢。
- 手动:刻意超长的 v2 会话反复触发压缩 → token 进度条不因摘要堆积持续上涨;
  traj 面板 compacted 消息 ≤3;conv_events 的 `compaction/spill.summary` 为本次新摘要。

---

## 批次 2(本轮不修,登记在案)

touch 反馈回路(注入即 touch → 固定 15 条轮播)、decay 按 importance 加权、
episodic per-conv upsert(每轮 done 新增一条重复摘要)、dedup 保留旧值问题、
审计 spill 的 dropped 全文落库、memoryBlock 注入位置与总量上限、
`hifiContextBudget` 死设置清理、上下文进度条 modelMax 硬编码 128K、
`factsAsBlock` 未接线、file_registry 只增不减。

## 实施顺序与回归策略

顺序:**基建 → Fix 2 → Fix 3 → Fix 5 → Fix 1 → Fix 4**
(2/3 最独立先做;Fix 4 动 send 主流程,放最后)。

每步:独立 commit → `npm run test`(typecheck + harness 全量)→ `npm run dev` 起应用冒烟
(发一轮带工具调用的对话,确认工具执行/流式/落库无回归)。
