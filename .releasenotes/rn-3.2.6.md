**发布日期：** 2026-08-22(自 v3.2.5 起 5 commits)

### 🐛 渲染性能与视觉
- onConversation 双重渲染根治 — renderSidebar+renderMain 每个 emitConversation 全量重建,goal loop 20 轮迭代卡死
- turn-fade-in 只作用于最后一个 turn — 修 agent 执行中每次广播整屏重放淡入动画闪屏
- sendBtn 图标按状态变化才重写 — 修 renderHead 高频跑导致按钮闪烁
- 内存哨兵 v2 — getAppMetrics 全进程 RSS 每分钟无条件写(能看到原生泄漏)

---

**English**

- Root-caused double rendering on onConversation — full sidebar+main rebuilds per broadcast froze goal loops
- turn-fade-in now applies only to the newest turn — no more full-screen fade replays on every broadcast
- sendBtn icon rewritten only on state change — fixes flicker from high-frequency renderHead runs
- Memory sentinel v2: unconditional full-process RSS sampling each minute (catches native leaks)

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.2.5...v3.2.6
