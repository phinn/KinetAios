**发布日期:** 2026-11-06(自 v4.0.9 起 16 commits)

# v4.1.0 — 导出全文修复 / 侧栏信息密度重构 / 可见性广播 / 无障碍

## 修复
- **工具结果导出全文盲区(核心修复)** — 「全文见事件日志」的截断注记名不副实:turns 持久层与 conv_events 事件层**各自截 4000 字符**,工具 result 全文哪一层都不存在,导出(md/html/json)拿到的是双重截断版。现事件层存证上限提至 **50000 字符**(对齐 read_file 工具输出上限,使注记成真),`export-conversation` 按 turn 内工具调用序号从 conv_events **自动回填**截断过的 result,三格式全部吃到全文;pending/interrupted 步骤不消耗序号,老会话事件缺失时降级导出原值不炸
- **composer:running 时贴图发送图片 chip 残留** — 排队消息升级为 `{text, imgs}` 结构,附件随队列入队、回合结束按主发送同款协议发出;steer(⌘/Ctrl+Enter)带附件时降级为排队防丢
- **composer:running+附件按 Enter 被静默丢弃** — 文字照常排队,附件保留不丢,toast 提示停止后可发
- **browser_navigate URL 归一化补全** — Windows 盘符(`C:\x`)转 `file:///C:/x`、`~` 展开、`./`/`../` 相对 cwd 解析、中文/空格路径编码;不再把本地路径强推上 https
- **侧栏 grouped 任务条目 meta 挤压标题** — meta 误设 `width:100%` 把标题挤成单字;改 `flex-shrink:0` 自然占位,标题 `flex:1` 恢复全宽截断
- **侧栏 hover 三钮遮挡标题** — 56px 预留被后声明 8px 同特异性规则压死(从未生效的死规则)+ grouped 分支零预留;删死规则,两分支统一 hover 预留 84px
- **会话终止残留 statusNote** — cancel/error 时清掉「📨 已收到方向修正」不再挂到下一轮发送前

## 侧栏信息密度重构
- **列表点回归状态语义** — 空闲态 dot 统一中性灰,不再按引擎着色(全 Direct 会话下整列粉紫被误读为「全部在跑」);引擎区分交给 workspace 行徽标,列表点只表达状态语义(running/waiting/retrying/ready 四态不变)
- **主题覆盖连根拔起** — 删六处主题层 `.dot.ready` 引擎色覆盖(此前靠声明顺序取胜的同权重覆盖),七主题 CDP 实测统一;craft 保留拟物描边仅去绿底
- **running 频道标题与状态分两行** — `.title-row`(标题+meta)+ `.sb-live` 独立状态行,状态不再挤压标题;flat/grouped 双模式适配
- **主题九宫格并入 ⋯ 更多菜单** — 「外观」分区九宫格常驻菜单末尾,foot 8→6 钮,删独立调色板钮+popup

## 性能
- **广播按窗口可见性裁剪** — arena 渲染层零消费 IPC 广播不再发送;quick/dashboard 不可见时跳过全量 conversation 广播,窗口恢复/置前时全量补偿,零状态丢失;`emitEvent` 同语义。多窗口高频流式场景 IPC 量显著下降

## 无障碍与体验
- **ca-btn 四钮 aria-label** — 上下文/改名/删除/新建钮补 `aria-label`,svg 装饰标 `aria-hidden`
- **折叠标记复述降权扩到四形态** — 模型把 AgentLoop 机械折叠标记当正文复述时,统一渲染为弱化 chip(批次行/续取提示/截图占位/摘要行),不再混进叙述观感
- **composer ⋯ 菜单三分区标签** — 截图/能力/会话增强三个小节头(cm-sep-label),菜单项分组可扫读,四语 i18n

---

**English**

# v4.1.0 — Export Full-Text Fix / Sidebar Density Rework / Visibility-Aware Broadcast / Accessibility

## Fixed
- **Tool-result export full-text blind spot (core fix)** — the truncation note "full text in the event log" was misleading: the turns persistence layer and the conv_events layer each truncated at 4,000 chars, so no layer ever held the full tool result and all exports (md/html/json) delivered a doubly-truncated version. The event-side cap is now **50,000 chars** (aligned with the read_file tool cap, making the note true), and `export-conversation` **refills** truncated results from conv_events by per-turn tool-call order across all three formats; pending/interrupted steps don't consume order slots, and old conversations with missing events degrade gracefully to the truncated value
- **composer: image chip lingering after send while running** — queued messages upgraded to a `{text, imgs}` structure; attachments ride along with the queue and are flushed with the same protocol as a primary send when the turn ends; steer (⌘/Ctrl+Enter) with attachments degrades to queueing to avoid loss
- **composer: attachments silently dropped on Enter while running** — text still queues, attachments are kept with a toast explaining they can be sent after stopping
- **browser_navigate URL normalization completed** — Windows drive letters (`C:\x`) → `file:///C:/x`, `~` expansion, `./`/`../` resolution against cwd, encoding for non-ASCII/spaces; local paths no longer forced onto https
- **sidebar: grouped task meta squeezing titles** — meta was set to `width:100%`, crushing the title into single characters; now `flex-shrink:0` with the title at `flex:1` for full-width truncation
- **sidebar: hover action buttons covering titles** — the 56px reservation was dead (overridden by a later same-specificity 8px rule) and the grouped branch had none; dead rule removed, both branches reserve 84px on hover
- **stale statusNote after turn termination** — cancel/error now clears notes like "📨 steer received" so they don't dangle into the next send

## Sidebar density rework
- **List dots back to status semantics** — idle dots are now a uniform neutral gray instead of per-engine colors (an all-Direct column used to read as "everything is running"); engine identity lives on the workspace row badges, list dots express state only (running/waiting/retrying/ready unchanged)
- **Theme overrides uprooted** — six theme-level `.dot.ready` engine-color overrides deleted (same-specificity rules that only won by declaration order); verified uniform across all seven themes via CDP; craft keeps its skeuomorphic outline minus the green fill
- **running channel title split from status line** — `.title-row` (title+meta) plus a dedicated `.sb-live` status line; flat and grouped modes both adapted
- **Theme grid merged into the ⋯ menu** — a 3×3 "Appearance" section lives at the end of the more-menu; footer buttons 8→6, standalone palette button + popup removed

## Performance
- **Visibility-aware IPC broadcast** — arena, which consumes zero conversation broadcasts, no longer receives them; quick/dashboard skip full conversation broadcasts while hidden and get a full refill on restore/show, with zero state loss; `emitEvent` follows the same rule. Noticeably lower IPC volume in multi-window streaming scenarios

## Accessibility & UX
- **aria-label on the four ca-btn buttons** — context/rename/delete/new; decorative SVGs marked `aria-hidden`
- **Fold-marker echo demotion extended to four forms** — when the model restates AgentLoop's mechanical fold markers in prose, they render as muted chips (batch line / resume hint / screenshot placeholder / summary line) instead of polluting the narrative
- **⋯ menu section labels** — Capture / Abilities / Session boosters headers (cm-sep-label) make the menu scannable; i18n in four languages

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.0.9...v4.1.0
