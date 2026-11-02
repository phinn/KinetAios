**发布日期:** 2026-10-30(自 v4.0.3 起 42 commits)

> 4.0.4 是「过程可视化」版本:AI 干活的每一步都看得见——思维链折叠卡、产物(HTML)版本面板可回看、工具产图内联预览+多图画廊灯箱、聚合卡内嵌 ±行数徽章。同时把侧栏补到位:⌘P 频道速跳、项目组折叠持久化,以及一整串搜索框 × 的连环修复。消息流对齐 WorkBuddy 视觉气质,AI 去框裸排、用户消息中性 chip。

### 🧠 思维链(reasoning)全链路

- **三协议 SSE 转发**:Anthropic / OpenAI / Gemini 协议的 reasoning 增量统一转成 `token` 事件 `channel: 'reasoning'`,不污染正文;只渲染尾部 6000 字防刷屏。
- **折叠卡渲染**:流式期自动展开、正文留尾自动滚底;完成后折叠为「✦ 思考过程」卡,SVG sparkles 图标 + chevron,四语标牌。
- **变更量徽章**:write/edit 工具步骤内嵌 +N/−M 行数,折叠态直读改动量。

### 🖼 产物版本面板 + 预览质量

- **版本序列可回看**:同一会话内多次生成的 HTML 产物,预览面板顶部版本条逐版切换,回看历史版有黄色提示条;版本数据由 turns 派生并随 SQLite 持久化,重启/翻历史会话不丢。
- **检测零协议改动**:纯正则检测三引擎(Direct / Claude Code / Codex)通用;同 turn 流式覆盖当前版,跨 turn 新版本。
- **白闪根治**:预览刷新同内容短路,不再每 600ms 重建 iframe;刷新按钮强制重载语义保留。
- **多图画廊灯箱**:工具产图内联缩略图,点开 ←/→ 循环浏览 + n/N 计数 + Esc 关闭。

### 📌 会话与通知

- **通知点击直达会话**:系统通知点击跳转对应会话(main/preload/renderer 三层桥),会话已删静默留在当前。
- **排队反馈**:消息入队 toast 四语;goal 会话整队转修正(latest-wins),steer 失败自动降级排队。
- **quick panel 发送失败保留草稿 + 防连按**。
- **上下文 ≥90% 劝导 banner**:每会话一次,一键跳上下文检查器;approval 档位常驻 pill、jump 按钮呼吸提示。

### 🗂 侧栏三连修 + ⌘P 速跳

- **⌘P 频道速跳面板**:模糊搜索全频道,回车直达;项目组折叠状态持久化(collapse-all/expand-all 入口补齐)。
- **搜索框 × 三连修**:飘出输入框(负 margin 定位数学)→ 归位 → 被 flex 压成 0 宽(全局 button padding 未重置)逐层根治;`[hidden]` 全局兜底防 display:flex 压过 UA 隐藏。
- **56 条频道裁切修复**:展开组 max-height:1000px 静默裁切 → 不设上限;`#conv-list` 补 min-height:0 防 flex 撑破。

### 💬 视觉对齐 WorkBuddy

- **消息流减负**:AI 回复去框裸排 + 46rem 阅读限宽,用户消息中性 chip(修复亮色主题下脏淡紫便签底),圆角输入卡。
- **品牌四角星重绘**:手绘直线菱形换曲线凹边星,头像/托盘/SVG 集三处统一。

### 🛠 其他修复

- 余额气泡不再被流式事件秒关(renderHead 高频触发按会话变化条件收起)。
- IME composing 标记卡死自愈(焦点被抢后 Enter 被吞)。
- cron 同任务固定复用一个频道,触发前清空上下文。
- generatePersona 画像采样按 cwd 分桶防串味。
- 老 turn 数据兼容 + error 轮持久化两处数据丢失。

### Full Changelog

https://github.com/phinn/KinetAios/compare/v4.0.3...v4.0.4

---

**English**

**Release date:** 2026-10-30 (42 commits since v4.0.3)

> 4.0.4 is the "make the process visible" release: everything the agent does is now observable — a reasoning collapsible card, an artifact (HTML) version panel you can browse back through, inline image previews of tool output with a multi-image gallery lightbox, and ±line badges embedded in aggregate cards. The sidebar gets its due too: ⌘P quick-jump, persisted group collapse, and the full chain of search-box × fixes. The message stream adopts WorkBuddy's visual language — frameless AI prose, neutral user chips.

### 🧠 Reasoning end-to-end

- **Three-protocol SSE forwarding**: reasoning deltas from Anthropic / OpenAI / Gemini protocols are normalized into `token` events with `channel: 'reasoning'`, never touching the answer body; only the last 6,000 chars are rendered to prevent flooding.
- **Collapsible card rendering**: auto-expanded while streaming with tail-follow autoscroll; collapses into a "✦ Reasoning" card (SVG sparkles + chevron, localized label) when done.
- **Change-size badges**: write/edit tool steps show inline +N/−M line counts, readable even collapsed.

### 🖼 Artifact version panel + preview quality

- **Browsable version history**: HTML artifacts generated repeatedly within one conversation get a version strip atop the preview pane; viewing an older version shows a yellow retro banner. Versions derive from turns and persist via SQLite — they survive restarts and history browsing.
- **Zero-protocol-change detection**: pure-regex detection works across all three engines (Direct / Claude Code / Codex); same-turn streaming overwrites the current version, new turns create new versions.
- **White-flash fixed**: same-content short-circuit stops the iframe from reloading every 600 ms; the refresh button keeps its force-reload semantics.
- **Multi-image gallery lightbox**: tool-output images render as inline thumbnails; click to open ←/→ cycling with n/N counter and Esc to close.

### 📌 Sessions & notifications

- **Notification click-to-conversation**: clicking a system notification jumps straight to that conversation (three-layer bridge); silently stays put if it was deleted.
- **Queue feedback**: localized enqueue toast; goal conversations convert the whole queue into a correction (latest-wins), with automatic fallback to queuing when steering fails.
- **Quick panel**: failed sends keep the draft; double-submit guarded.
- **Context ≥90% advisory banner**: once per conversation, one click to the context inspector; approval-mode pill is always visible, jump button breathes.

### 🗂 Sidebar fixes + ⌘P quick-jump

- **⌘P quick-jump panel**: fuzzy search across channels, Enter to jump; project-group collapse state persists (collapse-all/expand-all wired too).
- **Search-box × fixed three times over**: floating out of the field (negative-margin math) → repositioned → crushed to 0 width (global button padding not reset) — each layer addressed; a global `[hidden]` guard now prevents display:flex from beating UA hiding.
- **56-channel clipping fixed**: expanded groups' max-height:1000px silently truncated content → no cap; `#conv-list` gets min-height:0 so flex can't blow past the sidebar.

### 💬 Visual alignment with WorkBuddy

- **Message-stream slimming**: AI replies go frameless within a 46rem reading column; user messages become neutral chips (fixing the dingy lavender background in light themes); rounded input card.
- **Brand four-point star redrawn**: hand-drawn straight-edged diamond replaced with a curved concave star, unified across avatar/tray/SVG set.

### 🛠 Other fixes

- Balance popover no longer snapped shut by streaming events (renderHead now closes on conversation change only).
- IME composing-flag deadlock self-heals (Enter swallowed after focus theft).
- Cron tasks pin to one reused channel and clear context before firing.
- generatePersona samples per-cwd buckets to stop persona cross-contamination.
- Two data-loss paths: legacy turn compatibility and error-turn persistence.

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.0.3...v4.0.4
