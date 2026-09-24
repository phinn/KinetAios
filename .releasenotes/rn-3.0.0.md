**发布日期：** 2026-08-17(自 v2.9.1 起 32 commits)

### 🏗️ 性能与稳定
- **turns 按频道懒加载** — 启动只读元数据+首条 prompt,内存基线大幅下降;超长消息 UI 卡死防御(prompt/answer/流式三层截断)
- **流式抖动根因根治** — 全量 md 重渲使块高度震荡,改稳定前缀渲染
- **通知聚焦检测覆盖三窗口** — 盯着 quick/Arena 时不误弹;通知正文补首条 prompt 兜底
- V3 修复包:终态事件单点化消除双发/M3 同层并行写分流/fast·std 轮数跟随用户设置/L2 router 信号压制 fast path/M1 deep planner 支持多轮探查
- V2 checkpoint 三条 abort 路径补齐(planner abort/planner 失败/executor abort);maxTurns 语义修正(用户设置是天花板,内部上限只能更紧)
- **侧栏 3 层结构重构** — 会话/项目分组/底栏合并;右键菜单;视觉三轮精修;每频道草稿 + 滚动位置记忆;日期分割线/长代码行号/AI 头像呼吸光晕;fmtRelative 四语言
- 黑屏根治 — render-process-gone reason=killed 不触发自动重载;默认主题改为 Tahoe 液态玻璃

---

**English**

- Turns lazy-load per channel (startup metadata only — big memory win); triple truncation against huge-message freezes
- Streaming jitter root-caused: full markdown re-renders replaced with stable-prefix rendering
- Notification focus detection covers all three windows; body falls back to first prompt
- V3 fix pack: terminal events single-sourced (no double fire), parallel-node write sharding, loop counts follow user settings, router signals suppress fast path, deep planner multi-round
- DirectV2 checkpoints completed on all three abort paths; maxTurns semantics fixed
- Sidebar rebuilt as a 3-layer structure with context menus and visual polish; per-channel drafts + scroll memory; date separators, line numbers, breathing avatar glow; render-process-gone auto-reload fix; Tahoe Liquid Glass becomes default theme

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v2.9.1...v3.0.0
