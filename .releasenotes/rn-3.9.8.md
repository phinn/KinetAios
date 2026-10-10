**发布日期:** 2026-10-20(自 v3.9.7 起 3 commits)

### 📦 流式步骤 run-length 聚合 —— 流式中不再逐卡刷屏(28cd1d1)

- 此前步骤聚合只在回合 done 后生效,流式期间 15 连 `read_file` 会逐张刷卡把回答正文顶出屏幕。现在流式增量渲染(`buildStepsEl` expanded 分支)同样做**连续同名 ≥3 run-length 聚合**,与 done 态同一套视觉。
- 聚合卡 O(1) 吸收:尾段聚合卡标记 `data-tail=1`,后续同名步骤到达时只刷 ×N 计数与区间耗时(absorbIntoAggCard),子卡懒构建,零 DOM 重建成本。
- 渲染对齐锚点:单卡带 `data-i`、聚合卡带 `data-from+to` 区间标记,`lastCoveredIdx` 返回已覆盖游标;历史渲染产物无标记 → -1 → 全量重建兜底自愈。pending→done 原位替换按 `data-i` 对齐,不依赖会漂移的序号。
- 修复两个隐藏 bug:吸收时区间耗时误算(slice 起点误用 to+1)、×N 计数错位;renderStep 统一打 `data-name` 供三连检测。
- 真机验证:14 步流式只渲染 8 张卡,`shell ×4` / `read_file ×5` 聚合卡 ×N 实时增长,单发不聚合。

### 🔧 Release 页建页动作焊进流程(3a85fe3 + 5be2147)

- tag 推上去**不会**带正文,GitHub Release 页只有 Full Changelog 一行 —— v3.9.5/3.9.6/3.9.7 三页曾因此空白。KinetAios.md checklist 新增第 8 步:push 后立即 `gh release edit --notes-file` 建页,并核验 body 字符数。
- `scripts/pre-tag-check.sh` 增加 Release 页非空校验(警告不阻断);恢复脚本可执行位。

---

**English**

**Release date:** 2026-10-20 (3 commits since v3.9.7)

### 📦 Streaming step run-length aggregation — no more card-by-card flooding mid-stream (28cd1d1)

- Previously aggregation only kicked in after the turn finished; 15 consecutive `read_file` calls streamed in as 15 separate cards, pushing the answer body off-screen. Streaming incremental rendering (`buildStepsEl` expanded branch) now applies the same **consecutive same-name ≥3 run-length aggregation** as the done state.
- O(1) absorption into aggregate cards: the tail aggregate card carries `data-tail=1`; later same-name steps only bump the ×N count and interval duration (absorbIntoAggCard) — child cards are lazily built, zero DOM rebuild cost.
- Rendering alignment anchors: single cards carry `data-i`, aggregate cards `data-from+to` interval markers, `lastCoveredIdx` returns the covered cursor; legacy rendered output without markers → -1 → full rebuild as a self-healing fallback. pending→done replacement aligns on `data-i` instead of drifting sequence numbers.
- Two hidden bugs fixed: interval-duration mis-accumulation on absorption (slice start wrongly used to+1) and ×N counter misalignment; renderStep now stamps `data-name` for the triple-run detection.
- Verified live: 14 streaming steps render as 8 cards, `shell ×4` / `read_file ×5` aggregate cards grow ×N in real time, single calls stay standalone.

### 🔧 Release-page creation is now part of the release flow (3a85fe3 + 5be2147)

- Pushing a tag does **not** carry the notes body — the GitHub Release page used to contain only the Full Changelog line, leaving v3.9.5/3.9.6/3.9.7 blank. KinetAios.md checklist gains step 8: right after push, run `gh release edit --notes-file` to create the page and verify the body length.
- `scripts/pre-tag-check.sh` adds a Release-page non-empty check (warning, non-blocking); executable bit restored.

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.9.7...v3.9.8
