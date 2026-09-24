**发布日期：** 2026-08-20(自 v3.2.3 起 2 commits)

### ⚡ 性能
- 高频贴底走轻量路径 — 流式 token 每帧调 snapToBottomReal 的全量 strip 循环(O(n) rect 读取+双强制 reflow)在长会话下卡主线程
- tool/status 事件贴底走轻量路径 — 修复多步任务 UI 卡死

---

**English**

- Lightweight path for high-frequency bottom-snapping — per-token snapToBottomReal ran an O(n) strip with double forced reflow, stalling long sessions
- Same for tool/status events — fixes UI freezes during multi-step tasks

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.2.3...v3.2.4
