**发布日期:** 2026-11-14(自 v4.2.1 起 8 commits)

# v4.2.2 — MiniMax 订阅余额 / ⌘P 智能速跳 / 主进程卡顿双修

## 新功能
- **MiniMax 订阅套餐余额查询** — 订阅 JWT key 配置档可在配置里显式勾选「订阅 Token Plan」:余额按钮直读 `/v1/token_plan/remains`,按 5h 窗口 + 本周窗口显示已用百分比与重置时间(与智谱 Coding Plan 同款展示);接口的「剩余」口径自动换算为「已用」;无效 key 时业务码(HTTP 200 里的 status_code 1004)原样透出,不再误报"无数据"
- **⌘P 频道速跳智能化** — 空查询改三段式直达:📌 置顶 → 🔥 常用(frecency 使用频率加权 top)→ 最近打开;关键词搜索同样吃使用信号,高频频道稳定排前。383 个会话/48 个项目下,两级导航(项目→频道)一步到位
- **常用条目显示所属项目标签** — 侧栏「最近常用」区条目名字右缀弱色项目 tag,与命令面板同口径,置顶/常用归属一眼可辨

## 性能
- **记忆去重工作集 cap 3000** — 长期记忆涨到 4.5 万条时,后台去重曾退化成 ~7.8 亿对相似度计算(实测 83% CPU × 2 分钟,输入框顿挫)。现只取最新 3000 条参与配对(≈450 万对,亚秒级),更老的交给遗忘/低重要性清理自然回收
- **conv_events 时间戳索引** — 90 天事件清理(每 5 次会话结束触发一次)此前每次全表扫 60 万+行,加范围索引后走 range scan
- **主进程广播按窗口可见性裁剪** — 隐藏窗口不再吃全量事件流,切回时全量补偿,渲染进程更轻

## 修复
- **CI 不再携带个人标识** — mac 构建签名身份改走 GitHub secret,源码零 Team ID

---

**English**

**Release date:** 2026-11-14 (8 commits since v4.2.1)

# v4.2.2 — MiniMax plan balance / smart ⌘P jump / main-process stall fixes

## New
- **MiniMax subscription plan balance** — profiles using a subscription JWT key can now be explicitly marked "Token Plan": the balance button reads `/v1/token_plan/remains` and shows 5h-window and weekly usage percentages with reset times (same layout as the Zhipu Coding Plan tiers); the API's "remaining" figures are converted to "used"; invalid keys surface the real business error (status_code 1004 inside HTTP 200) instead of a misleading "no data"
- **Smart ⌘P channel jump** — empty query now lands in three tiers: 📌 pinned → 🔥 frequently used (frecency-weighted top) → recent; keyword search also weighs usage signals so high-traffic channels rank first. Two-level navigation (project → channel) in one step across 383 sessions / 48 projects
- **Project labels on frequent items** — sidebar "recent & frequent" entries show a subtle project tag after the name, matching the command palette convention

## Performance
- **Memory dedup working set capped at 3000** — at 45K long-term memories, background dedup degraded into ~780M similarity pairs (measured 83% CPU for 2 minutes, input lag). Only the newest 3000 memories are paired now (≈4.5M pairs, sub-second); older ones recycle naturally via decay / low-importance pruning
- **conv_events timestamp index** — the 90-day event prune (runs every 5th conversation end) previously full-scanned 600K+ rows each time; a range index makes it a range scan
- **IPC broadcast filtered by window visibility** — hidden windows no longer receive the full event stream; a full catch-up runs on restore

## Fixed
- **CI no longer embeds personal identifiers** — the mac build signing identity moved to a GitHub secret; zero Team ID in source

*KinetAios 是 [Kinet 家族](https://phinn.github.io/kinetapp/index.html)的一员 —— 22 个应用,全部在架。*

*KinetAios is part of the [Kinet family](https://phinn.github.io/kinetapp/index.html) — 22 apps, all live.*

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.2.1...v4.2.2
