**发布日期:** 2026-10-19(自 v3.9.5 起 3 commits)

### 💰 Token 记账口径修正 —— 全库成本数据回归真实(990364e)

- **根因**:TaskManager 在 turn 结束时会把该轮**累计值**再写一条无 source 的 turn/meta 事件,与逐次 LLM 调用行重复记账 —— 一个烧 74M 的 turn 被算成 148M。此前对外引用的「68.5B input / $495」全是虚高 ~2.4× 的重复口径。
- **修复**:汇总行打 `source:'sum'` 标记;明细浮层排除 sum 行,标签改为「本轮累计」。
- **全库真实口径**(以独立 cost_log 表为准):5135 次调用 / 9.3B input tokens / 总成本 $670。llm 单次调用分布:<30K 1.4% / 30-120K 78.6% / 120-300K 19.1% / >300K 1.1%。

### ✂️ Tail 窗口 write/edit 巨型参数退化(990364e)

- fold 折叠旧工具结果时,最近 6 条豁免窗口内的 `write_file`/`edit_file` 调用,**参数原文**(数万字符的文件内容)永不折叠,每轮全量重发。
- 现在豁免窗口内的 write/edit args 退化为 `[已写入 path (12.3K)]` 摘要 —— 下一轮模型并不需要刚写过的文件原文,内容在磁盘上。

### 🛠️ file_registry 畸形存量容错(3a3886a)

- 旧版本构建写入的 `file_registry` 可能缺键(实锤:`{"read":[...],"edited":[...]}` 无 `written`)→ `[...existing.written]` 展开 undefined 抛 `not iterable`,**整个 compaction 被拖垮**。
- 读取侧逐键归一化(缺键/非数组 → `[]`,过滤非字符串元素),畸形数据自我修复而非炸流程;库内 2 条畸形存量已数据修复归零。全库同类「持久化 JSON 读出即解构」模式已穷尽排查,无其它炸点。

---

**English**

**Release date:** 2026-10-19 (3 commits since v3.9.5)

### 💰 Token accounting fix — repo-wide cost data returns to reality (990364e)

- **Root cause**: at turn end, TaskManager wrote the turn's **cumulative totals** as an extra sourceless `turn/meta` event, double-counting against the per-call LLM rows — a 74M turn was booked as 148M. The previously cited "68.5B input / $495" was this inflated ~2.4× duplicate.
- **Fix**: summary rows are now tagged `source:'sum'`; the detail overlay excludes sum rows and labels the aggregate "turn total".
- **True repo-wide figures** (from the independent cost_log table): 5,135 calls / 9.3B input tokens / $670 total. Per-call distribution: <30K 1.4% / 30-120K 78.6% / 120-300K 19.1% / >300K 1.1%.

### ✂️ Tail-window write/edit mega-args collapsed (990364e)

- When folding old tool results, `write_file`/`edit_file` calls inside the recent-6 exempt window kept their **full arguments** (tens of thousands of characters of file content) forever, resent in full every turn.
- Write/edit args in the tail window now degrade to a `[written path (12.3K)]` summary — the next turn doesn't need the just-written file's full text; it's on disk.

### 🛠️ Malformed file_registry tolerance (3a3886a)

- `file_registry` written by older builds could miss keys (confirmed case: `{"read":[...],"edited":[...]}` without `written`) → `[...existing.written]` spreads undefined and throws `not iterable`, **taking down the entire compaction pass**.
- Read side now normalizes key-by-key (missing/non-array → `[]`, non-string elements filtered), so malformed data self-heals instead of crashing; the 2 malformed rows in the DB were repaired to zero. All similar "parse persisted JSON then destructure directly" patterns repo-wide have been audited — no other failure points.

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.9.5...v3.9.6
