**发布日期：** 2026-09-04(自 v3.5.5 起 4 commits)

### 👁️ Goal 监工模式(Supervisor ↔ Worker)
- **监工循环** — 替身(画像)验收 Worker 产出,不合格打回重做;**failover 接力** — 监工模型链自动切换;**过夜保险丝** — 无人值守安全阀
- **GLMError 错误分类器**(quota/auth/network);设置新增 Goal 监工 tab(开关/监工模型/接力链编辑器/保险丝参数);goal 事件类型 + save-settings 归一化

---

**English**

- **Goal Supervisor mode**: a persona-driven supervisor validates worker output and rejects failures for rework; **failover relay** auto-switches supervisor models; **overnight fuse** as an unattended safety valve
- **GLMError classifier** (quota/auth/network); new Goal Supervisor settings tab (toggle, supervisor model, relay-chain editor, fuse params); goal event types + save-settings normalization

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.5.5...v3.5.6
