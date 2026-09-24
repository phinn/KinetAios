**发布日期：** 2026-08-13(自 v2.8.0 起 21 commits)

### 🖥️ Computer Use 成熟
- `screenshot()` 走 desktopCapturer,多模态图片直注 LLM(GLM/OpenAI/Anthropic vision 均可)
- 鼠标点击/滚轮/拖拽/键盘:Win=PowerShell+user32.dll、Mac=cliclick、Linux=xdotool,零原生依赖;典型 ReAct:截屏→分析→操作→再截屏

### 🎨 图标与数据
- **设置 icon 热切换**(外观 tab picker);蓝紫渐变 K 图标修正;任务栏显示名修复(app.setName)
- **userData 迁移** kinetaios-win → KinetAios(启动自动搬迁);子 agent model 不再被 LLM 幻觉参数覆盖

### 🐛 稳定性
- 频道切换内存泄漏 3 处;UI 全量审查(rem 统一/窄窗口适配/step pre 横向滚动);打包 icon 缺失修复

---

**English**

- **Computer Use matures**: `screenshot()` via desktopCapturer with multimodal image injection (GLM/OpenAI/Anthropic vision); mouse click/scroll/drag/keyboard via PowerShell+user32.dll (Win), cliclick (macOS), xdotool (Linux) — zero native dependencies. Classic ReAct loop: screenshot → analyze → act → verify.
- **Icon hot-swap** in settings; gradient-K icon fixes; taskbar name fixed via app.setName
- **userData migration** kinetaios-win → KinetAios at startup; sub-agent model no longer overridden by hallucinated LLM parameters
- Three channel-switch memory leaks fixed; full UI audit (rem units, narrow-window adaptation)

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v2.8.0...v2.9.0
