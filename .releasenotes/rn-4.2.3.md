**发布日期:** 2026-11-19(自 v4.2.2 起 19 commits)

# v4.2.3 — workflow 后台断点续跑 / 技能自沉淀蒸馏 / 5h 窗口消耗解剖

## 新功能
- **workflow 后台 Job 断点续跑(P0-3)** — 多阶段工作流可一键提交为后台 Job:阶段级 checkpoint + DAG 执行图,app 重启后从断点继续而非从零重跑;长流水线(分钟级以上)不再阻塞对话。配套 team 全生命周期管理(spawn/broadcast/send/close)与看板可视化
- **技能自沉淀蒸馏(P0-2)** — 成功任务自动蒸馏出可复用 skill,存入 distilled 技能区;附带「来源裁决」机制:蒸馏产物记录源任务,任务结论后来被推翻时来源技能自动降级,死技能移入 `.archive/` 归档而非直接删除。技能目录从 90 涨到 240 后按来源分层展示:自有技能带一句话简介、外部副本只列名,预算内信息密度最大化
- **5h 窗口消耗解剖看板** — 仪表盘新增 quota 实时条 + turn 粒度消耗视图:单 turn 超过阈值的"肥 turn"标红,输入/缓存占比、命中与重写一目了然;窗口汇总走全量聚合口径,排行只取 top20
- **团队看板** — 活跃团队 × 成员状态 × 共享黑板沉淀一屏可视;黑板(成员探查缓存+结论沉淀)接通团队工作流
- **codemode 用量提升(可回滚)** — 提示词按数量阈值(≥3 个目标即脚本化)引导合批探查,探索型任务自动 nudge;两项均带设置开关,可随时关回
- **V1 折叠滞后模式** — 长会话前缀改写次数降 96%:折叠不再每轮立刻重写,改为滞后触发,省下的是真金白银的 token 缓存

## 修复
- **技能目录两个"已接通但实际不生效"的坑** — ①技能数 90→240 后纯名列表把简介预算吃干,模型看到的是裸名字,自加载形同虚设:改按"信息边际价值"分层分配预算(自有带简介/外部只列名),预算 3800→5800;②空胎技能的观察期按文件 mtime 计算,被外部覆盖写一次就重置一次,永远进不了归档:改锚"首次见到"的最早时间证据(蒸馏溯源 created_at 与目录 birthtime/mtime/文件 mtime 取早),覆盖写洗不白出生时间
- **显式 /name 调用也计入使用频次** — 否则 autoLoadSkills 关闭时,淘汰机制会误杀手动在用的技能
- **web-companion 手机页** — 详情页滚动跳屏修复、发送防重;新增列表停止按钮、步骤点按展开、相对时间显示、输入框自适应
- **团队窗口视图渲染** — 对齐既有 u-win-* 样式体系,窗口汇总口径修正为全量聚合

---

**English**

**Release date:** 2026-11-19 (19 commits since v4.2.2)

# v4.2.3 — Workflow background resume / skill self-distillation / 5h-window consumption breakdown

## New
- **Workflow background jobs with checkpoint resume (P0-3)** — multi-stage workflows can now be submitted as background jobs: stage-level checkpoints + a DAG execution graph, and after an app restart they resume from the breakpoint instead of starting over. Long pipelines (minutes and up) no longer block the conversation. Comes with full team lifecycle management (spawn/broadcast/send/close) and a dashboard view
- **Skill self-distillation (P0-2)** — successful tasks automatically distill into reusable skills under the distilled root. Includes a provenance-verdict mechanism: distilled artifacts record their source task, and when a task's conclusion is later overturned, the source skill is automatically demoted; dead skills move to `.archive/` instead of being deleted. After the skill catalog grew from 90 to 240, entries are layered by origin: own skills show a one-line description, external copies list names only — maximum information density within budget
- **5h-window consumption breakdown** — the dashboard gains a live quota bar plus per-turn consumption: oversized "fat turns" are flagged in red, with input/cache share, cache hits and rewrites at a glance; window totals aggregate everything, rankings keep top 20
- **Team dashboard** — active teams × member status × shared blackboard in one screen; the blackboard (member exploration cache + conclusions) is wired into the team workflow
- **Higher codemode share (reversible)** — the prompt now nudges batched exploration above a count threshold (≥3 targets → script it), with an exploration nudge; both ship with settings toggles
- **Hysteresis-mode V1 folding** — long-session prefix rewrites drop by 96%: folding no longer rewrites every turn, it triggers on hysteresis, saving real cache tokens

## Fixed
- **Two "wired but silently broken" skill-catalog bugs** — (1) after skills grew 90→240 the name-only list ate the entire description budget, so the model saw bare names and auto-loading was effectively dead: budget is now layered by marginal information value (own skills with descriptions / external copies names only), raised 3800→5800. (2) empty-shell skills measured their observation window by file mtime, so any external overwrite reset it and they never reached archival: the anchor is now the earliest "first seen" evidence (distillation provenance created_at vs directory birthtime/mtime vs file mtime) — overwrites can no longer launder a skill's age
- **Explicit /name calls now count as usage** — otherwise, with autoLoadSkills off, the eviction mechanism would kill skills that are actively used manually
- **Web companion (phone page)** — fixed detail-page scroll jumps and double-sends; added a stop button on the list, tap-to-expand steps, relative timestamps, adaptive input
- **Team window view rendering** — aligned with the existing u-win-* style system; window totals fixed to aggregate everything

---

Part of the Kinet family — 22 apps, all live: https://phinn.github.io/kinetapp/index.html
Kinet 家族成员 —— 22 个应用,全部在架: https://phinn.github.io/kinetapp/index.html

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.2.2...v4.2.3
