**发布日期：** 2026-08-24(自 v3.2.6 起 5 commits)

### 🐛 修复
- **子 agent 跑偏/超时根治** — SUBAGENT_PROMPT 加执行纪律+汇报格式;超时 3min→8min 共享常量;maxTurns 8→15;超时错误信息可读化;model 参数文档与实现对齐
- 子 agent maxTurns 跟随用户全局设置(0=无限),移除三处硬编码 15
- cancel 后 send 误 resume 旧 plan — checkpoint 秒级 tie 导致 final 墓碑行输给 step 行
- 取消后三点占位/流式态残留 — 增量渲染路径缺终态切换

---

**English**

- **Sub-agent drift/timeout overhaul**: execution discipline + report format added to SUBAGENT_PROMPT; shared 8-min timeout constant (was 3), maxTurns 8→15, readable timeout errors, model param docs aligned with implementation
- Sub-agent maxTurns follows the user's global setting (0 = unlimited); three hard-coded 15s removed
- Send-after-cancel no longer resumes a stale plan — second-level checkpoint ties made the final tombstone row lose to step rows
- Cancel no longer leaves typing/thinking placeholders behind

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.2.6...v3.2.7
