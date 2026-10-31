**发布日期:** 2026-10-31(自 v4.0.4 起 14 commits)

> 4.0.5 是「记忆与秩序」版本:会话置顶(📌 + SQLite 列)、发送历史 ↑ 回调持久化、侧栏 ⌥↑/⌥↓ 全局切换、任务清单卡折叠记忆。同时做了两场 DB 减肥:turns 表持久化层截断工具结果(历史实测 steps[].result 占 942MB 表的 55%)、FTS content cap 4000→1200 + 启动异步重缩存量。视觉上完成设计 token 收敛(字号 25 散值→8 档/圆角 12→5 档)与 ReAct 多轮叙述拼接修复。

### 📌 会话置顶

- **SQLite 全链路**:`pinned`/`pinned_at` 列幂等迁移,`setPinned` IPC 三层桥(main/preload/renderer),导出导入同步带列;置顶组固定渲染在侧栏最顶,📌 徽标 + 右键菜单四语入口。
- **侧栏日期桶可折叠**:点击桶头折叠/展开,状态 localStorage 持久化。

### ⌨️ 键盘操作闭环

- **发送历史 ↑ 回调,重启不丢**:此前 sendHistory 纯内存,重启即空;现持久化 localStorage(保留 50 条),且补齐 queue/steer 两条发送路径的漏记——排队与修正消息此前永不进历史,运行中会话用户的 ↑ 回调必空。
- **⌥↑/⌥↓ 全局切换会话**:裸 ↑/↓ 让给 composer(光标移动/回填),但发送后焦点自动回输入框 = 常态下裸键永远到不了侧栏;Alt 通道不受焦点限制,任意状态可切。
- **命令面板 Home/End** 跳转;快捷键速查表(? )补 ⌘P / ↑ 回调 / ⌥↑⌥↓ 条目,四语。

### 🗜 DB 减肥双刀

- **turns 表止血**:持久化层截断 `steps[].result`(实测采样占 942MB 表的 55%);阈值 4000 字符,超限保头 2000 + 截断注记。LLM 上下文走独立持久化的 directHistory 全文,不受影响;全文回查走 conv_events。
- **FTS 减负**:content cap 4000→1200,启动时异步重缩存量行(不阻塞启动)。
- **置顶列迁移通道**:`assertDdlIdent` 放行「类型 + DEFAULT 数字字面量」DDL。

### 💬 阅读体验

- **ReAct 多轮叙述不再缝成一坨**:中间轮过渡叙述与最终答案之间注入轮间分隔;正文中的「[已折叠工具调用批次]」复述渲染为弱化 chip,不再以原文形式打断阅读。
- **meta 紧凑模式**:设置页开关(默认关),开启后耗时/token/费用元信息行默认隐藏、悬停显示——把此前写好但没接线的 `meta-compact` 死样式接上。
- **任务清单卡折叠记忆**:手动收起后,增量重建不再弹回展开。
- **浮层遮罩统一**:命令面板/确认弹窗遮罩补 backdrop blur,与整体玻璃质感一致。
- **正文字号统一**:chat-flow 内行内 code/工具卡从 12px 归一到正文 13px 档,反差消除。
- **侧栏品牌名下显示当前版本号**(动态读 app version,升级自见)。

### Full Changelog

https://github.com/phinn/KinetAios/compare/v4.0.4...v4.0.5

---

**English**

**Release date:** 2026-10-31 (14 commits since v4.0.4)

> 4.0.5 is the "memory & order" release: pin conversations (📌 backed by SQLite columns), persistent send history with ↑ recall, global ⌥↑/⌥↓ conversation switching, and collapse memory for the task-list card. It also ships two database diets: truncating tool results at the persistence layer (steps[].result measured at 55% of the 942MB turns table) and shrinking the FTS content cap from 4000 to 1200 with async backfill. Visually, design tokens consolidate (25 font sizes → 8 steps, 12 radii → 5) and ReAct multi-turn narration is no longer glued into one wall of text.

### 📌 Conversation pinning

- **Full SQLite chain**: idempotent `pinned`/`pinned_at` column migration, `setPinned` IPC bridge across main/preload/renderer, export/import carry the columns; pinned group renders at the very top of the sidebar with a 📌 badge and localized context-menu entries.
- **Sidebar date buckets collapsible**: click a bucket header to fold/unfold; state persists via localStorage.

### ⌨️ Keyboard loop closed

- **Send history recall survives restart**: sendHistory was memory-only and died on every relaunch; it now persists to localStorage (last 50 entries) and the queue/steer send paths are recorded too — queued and steer messages never made it into history, so users running long conversations always got an empty ↑ recall.
- **⌥↑/⌥↓ global conversation switching**: bare ↑/↓ are ceded to the composer (caret movement / recall), but focus auto-returns to the input after send, so bare keys could never reach the sidebar in the common state; the Alt channel works regardless of focus.
- **Command palette Home/End** navigation; the shortcut cheat sheet (? ) gains ⌘P / ↑ recall / ⌥↑⌥↓ rows in all four languages.

### 🗜 Two DB diets

- **Turns table bleed stopped**: `steps[].result` is truncated at the persistence layer (measured 55% of the 942MB table by sampling); cap is 4,000 chars, over-cap keeps the first 2,000 plus a truncation marker. LLM context uses separately persisted directHistory full text and is unaffected; full-text lookups go through conv_events.
- **FTS slimmed**: content cap 4000→1200, with an async startup backfill that re-shrinks existing rows without blocking launch.
- **Pin column migration path**: `assertDdlIdent` now allows "type + DEFAULT numeric literal" DDL.

### 💬 Reading experience

- **ReAct multi-turn narration un-glued**: inter-turn separators are injected between transitional narration and the final answer; folded-batch markers echoed inside the answer body render as de-emphasized chips instead of raw text.
- **Compact meta mode**: a Settings toggle (off by default) hides per-turn duration/token/cost lines and reveals them on hover — wiring up the previously dead `meta-compact` style.
- **Task-list card collapse memory**: manually collapsed stays collapsed across incremental rebuilds.
- **Overlay blur unified**: command palette and confirm dialogs get backdrop blur, matching the glass design language.
- **Body font size unified**: inline code / tool cards inside chat-flow normalize from 12px to the 13px body scale, removing the contrast mismatch.
- **Current version shown under the sidebar brand** (read dynamically from app version, updates itself).

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.0.4...v4.0.5
