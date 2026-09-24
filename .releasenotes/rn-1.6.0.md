**发布日期：** 2026-08-01(自 v1.5.0 起 72 commits)

### 🎨 主题大爆发
- **Tahoe** macOS 26 液态玻璃 / **Sierra** 暖调液态玻璃 / **Craft** 我的世界方块像素 / **SEED** 高达机甲主题;Town 视图风格切换(经典/我的世界)

### ✨ 功能
- **/goal 会话目标**;模型配置档支持编辑;语音实时输入(Web Speech API);Git 面板操作菜单(stage/unstage/commit/pull/push/stash);Ollama 预设一键读本地模型

### 🐛 修复
- **三处高危内存泄漏根治** — renderMain 频率+DOM 重建、statement 缓存、confirm Promise 悬挂 + ollamaStream reader
- 发送闪屏(DocumentFragment 离屏构建)、输入法语音输入误拦、光标/回车间歇失灵

---

**English**

- **Theme explosion**: Tahoe Liquid Glass, Sierra warm glass, Craft (Minecraft pixel), SEED (mecha) themes; Town view style switcher
- **Features**: /goal session objectives; editable model profiles; live voice input (Web Speech API); Git panel command menu (stage/commit/push/stash); one-click local model list for Ollama
- **Fixes**: three high-severity memory leaks eradicated (renderMain rebuilds, statement cache, hanging confirm Promise + ollama reader); send-flicker fixed via DocumentFragment offscreen rendering; IME voice-input interception fixed

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v1.5.0...v1.6.0
