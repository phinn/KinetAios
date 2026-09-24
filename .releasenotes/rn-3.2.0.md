**发布日期：** 2026-08-19(自 v3.1.3 起 11 commits)

### 🔌 引擎插件化收口
- claudeCode/codex 引擎插件化,删除 enableCliEngines 全局开关;deepseek-harness 插件引擎(dsh headless profile, plain 协议)
- **claudeCode 引擎透传 result.usage 的 in/out token 统计(含 cache)**;plain 协议支持 cost JSON 行
- 修复:CLI 引擎 spawn 后立即关 stdin(codex 0.135 等 stdin EOF 假死);自动放行(approval=never/sandbox=fullAccess)传导到所有引擎;team 成员接入子模型配置(频道 > 全局 > 主模型)
- brand.json 支持 icon 字段,改品牌时窗口/托盘图标跟随

---

**English**

- claudeCode/codex engines pluginized; the enableCliEngines global switch removed; deepseek-harness ships as a plugin engine (dsh headless profile, plain protocol)
- claudeCode passes through result.usage in/out token stats (incl. cache); plain protocol accepts cost JSON lines
- Fixes: stdin closed immediately after CLI spawn (codex 0.135 hung waiting for EOF); auto-approve (approval=never / sandbox=fullAccess) propagates to all engines; team members honor sub-model config (channel > global > main)
- brand.json gains an icon field — window/tray icons follow brand changes

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.1.3...v3.2.0
