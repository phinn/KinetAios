**发布日期:** 2026-11-11(自 v4.2.0 起 27 commits)

# v4.2.1 — 侧栏实时状态 / viz-card 空白根修 / 错误路径加固

## 新功能
- **侧栏「最近常用」实时状态行** — 频道条目与主列表同构:运行中在名字下方显示细粒度状态(正在执行的工具/重试/压缩等,来自 statusNote),空闲自动收起该行;连带修掉一个隐藏 bug——增量刷新的选择器被置顶的常用条目抢先命中,主列表那条反而收不到实时状态(只靠全量重渲兜底)
- **品牌家族行** — 侧栏品牌区显示 Kinet 家族行(22 apps),由 `brand.json` 驱动,带一键关闭开关
- **图片模态「防」代「治」** — `textOnlyModel` 运行时标志:识别到纯文本模型后不再重复送图挨 400,一次学费终身免疫
- **HTTP 错误原始体落盘** — glm 通道裸 400 不再不可读:响应原始体落盘 `userData/http-errors/`,错误详情直接带文件路径
- **winget 本地清单校验器**(scripts)— 离线校验 winget manifest:schema(v1.28.0 JSON Schema)+ 跨文件规则(ManifestType 绑定/locale 唯一性/ReleaseDate 重复/ProductCode-ARP 一致性),发版前先本地过一遍再提 PR

## 修复
- **viz-card 大片空白(两个根因全拔)** — ① iframe 高度 100vh 写回形成正反馈,撑出整屏空白;② quirks 模式下 documentElement.scrollHeight 量高失真。双修后内嵌可视化卡片恢复正常
- **fence 提取双写退化** — 提取逻辑改 CommonMark 逐行状态机,修 ```` ``` ```` 双写导致 viz-card 整块退化为转义文本
- **流式期间滚不上去** — 贴底逻辑用 rAF 逐帧执行,把用户的向上滚动每帧都拽回底部,还伴随上下抖动;改为仅在真正贴底时跟随
- **营销控制台刷新超时** — 面板桥接 hostCall 支持按调用传超时(promoRefresh 单独 180s),单条站点扫描预算收紧(HEAD 6s/GET 8s);51 条实测 8.4s 跑完,不再 30s 整批超时
- **技能市场搜索空结果三连根因** — raw 域代理黑洞 + YAML 折叠描述 + 空态文案混淆,逐一修复
- **anthropic SSE 流内 error 事件被吞** — 流中 error 事件现显式抛错,与 OpenAI 路径对齐,不再静默挂住
- **纯文本模型拒收图片自愈** — aliyun tokenplan 送图 400 时自动剥图降级重发,readErr 兼容 SSE 错误体

## 文档
- README 家族区改版:22-app 图标墙(GitHub 渲染兼容)+ 文末 star CTA + wiki 入口页(中英)
- winget manifest 结构指南:ManifestType/文件名绑定、ProductCode 推导、删文件即关 PR 的坑

---

**English**

**Release date:** 2026-11-11 (27 commits since v4.2.0)

# v4.2.1 — Sidebar live status / viz-card blank root fix / error-path hardening

## New
- **Live status line in "Frequent" sidebar entries** — frequent channels now mirror the main list: while running, a second line under the name shows fine-grained status (tool execution / retries / compaction via statusNote); it collapses when idle. Also fixes a hidden bug where the incremental refresher's selector hit the pinned frequent entry first, so the main-list row never received live updates
- **Brand family row** — the sidebar brand area shows the Kinet family line (22 apps), driven by `brand.json` with a kill switch
- **Image modal: prevention over cure** — a `textOnlyModel` runtime flag stops re-sending images to text-only models after the first 400; learn once, never repeat
- **Raw HTTP error bodies on disk** — bare 400s from the glm channel are no longer unreadable: the raw response body is saved under `userData/http-errors/` and the error detail carries the file path
- **Local winget manifest validator** (scripts) — offline validation of winget manifests: schema (v1.28.0 JSON Schema) plus cross-file rules (ManifestType binding, locale uniqueness, ReleaseDate duplication, ProductCode/ARP consistency); validate locally before filing a PR

## Fixed
- **viz-card giant blank area (both root causes)** — ① the iframe height write-back at 100vh formed a positive feedback loop filling the screen; ② in quirks mode documentElement.scrollHeight measured wrong. Both fixed; embedded viz cards render normally again
- **Fence extraction double-write degradation** — extraction now uses a CommonMark line-by-line state machine, fixing doubled ```` ``` ```` fences that turned whole viz cards into escaped text
- **Can't scroll up while streaming** — the stick-to-bottom logic ran per-frame in rAF, dragging the user back to the bottom every frame with jitter; it now only follows while truly pinned to the bottom
- **Marketing console refresh timeout** — the panel bridge hostCall accepts a per-call timeout (promoRefresh gets 180s) and per-site scan budgets were tightened (HEAD 6s / GET 8s); 51 entries finish in 8.4s instead of timing out as a 30s batch
- **Skills market search returning empty — three stacked causes** — raw-domain proxy black hole + YAML-folded descriptions + confusing empty-state copy, all fixed
- **anthropic SSE in-stream error events swallowed** — error events inside the stream now raise explicitly, aligned with the OpenAI path, instead of hanging silently
- **Self-healing for text-only models rejecting images** — on a 400 from aliyun tokenplan, images are stripped automatically and the request retried; readErr now also parses SSE error bodies

## Docs
- README family section revamp: 22-app icon wall (GitHub-rendering safe) + star CTA at the tail + wiki entry pages (EN/zh)
- winget manifest structure guide: ManifestType/filename binding, ProductCode derivation, and the delete-files-closes-PR trap

*KinetAios 是 [Kinet 家族](https://phinn.github.io/kinetapp/index.html)的一员 —— 22 个应用,全部在架。*

*KinetAios is part of the [Kinet family](https://phinn.github.io/kinetapp/index.html) — 22 apps, all live.*

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.2.0...v4.2.1
