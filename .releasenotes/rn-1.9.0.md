**发布日期：** 2026-08-04(自 v1.8.0 起 47 commits)

### 🧠 DirectV2 引擎(预览)
- **Plan → Execute → Verify → Judge 四层架构** 落地;支持数据分析等复杂多步任务;移除 Planner/Replan 轮数硬限制
- V2 大规模审查修复:done 泄漏/replan 断裂/Judge 盲判/autoVerify 跨会话泄漏/验证超时误判/长期记忆步骤丢失/Windows emoji 崩溃等

### ✨ UI
- 侧栏频道显示时间 + 按最近活动排序;「只看运行中」筛选;memoryBlock 从全量注入改检索注入
- dispatch_agent 子任务独立超时(API/CLI hang 不再永久卡住)

---

**English**

- **DirectV2 engine (preview)**: the Plan → Execute → Verify → Judge architecture lands, enabling complex multi-step tasks like data analysis; hard-coded planner turn limits removed
- Extensive V2 audit fixes: done-event leaks, replan breakage, blind judging, cross-session autoVerify leakage, verify-timeout false positives, memory loss during steps, Windows emoji crashes
- Sidebar shows time + sorts by recent activity; "running only" filter; memoryBlock switches to retrieval-based injection; dispatch_agent gets independent timeouts

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v1.8.0...v1.9.0
