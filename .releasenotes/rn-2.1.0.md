**发布日期：** 2026-08-06(自 v2.0.0 起 51 commits)

### ✨ 功能
- **跨引擎切换自动注入上下文摘要** — 切引擎不断上下文;dispatch_agent 支持 model 参数(子 agent 指定不同模型)
- **会话级替身画像开关** — composer 🧬 toggle,每会话独立持久化
- 记忆提取扩展至项目/工作流维度

### 🐛 修复
- 流式输出抖动四连修(首 token 同步贴底/每 token reflow 丢帧/贴底时机)

---

**English**

- **Cross-engine context summaries** injected automatically when switching engines; dispatch_agent accepts a `model` parameter
- **Per-session persona toggle** (🧬 in composer), persisted independently
- Memory extraction extended to project/workflow dimensions
- Four streaming-scroll jitter fixes (first-token sync snap, per-token reflow frame drops)

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v2.0.0...v2.1.0
