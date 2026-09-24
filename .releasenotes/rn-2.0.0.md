**发布日期：** 2026-08-06(自 v1.9.0 起 53 commits)

### 🏗️ 架构级升级
- **流式抖动根因根治** — 全量 md 重渲改稳定前缀渲染;turns 按频道懒加载,启动只读元数据,内存基线大幅下降;超长消息三层截断防卡死
- **任务完成/出错系统通知** — done/error 钩子 + 设置开关 + 聚焦检测(盯着别的窗口才弹)
- **V3 引擎修复包** — 终态事件单点化/fast·std 轮数跟随设置/L2 router 信号压制 fast path/M3 并行写分流/M1 deep planner 支持多轮探查
- **DirectV2 checkpoint 补齐** — planner abort/失败/executor abort 三条路径;maxTurns 语义修正(用户设置是天花板)
- **侧栏 3 层结构重构** + 右键菜单 + 视觉精修;每频道草稿 + 滚动位置记忆;日期分割线/长代码行号/呼吸光晕;黑屏(render-process-gone)自动重载修复;Tahoe 设为默认主题

---

**English**

- **Architecture-level upgrade**: streaming jitter eradicated via stable-prefix rendering; turns lazy-load per channel (startup reads metadata only — big memory win); triple truncation guards against huge-message freezes
- **System notifications** on done/error with focus detection; **V3 engine fix pack** (terminal-event single-sourcing, router signal handling, parallel write sharding, multi-round deep planner)
- **DirectV2 checkpoints** completed on all three abort paths; maxTurns semantics corrected (user setting is the ceiling)
- **Sidebar rebuilt** (3-layer structure, context menus, visual polish); per-channel drafts + scroll memory; date separators, line numbers, breathing glow; render-process-gone auto-reload; Tahoe becomes the default theme

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v1.9.0...v2.0.0
