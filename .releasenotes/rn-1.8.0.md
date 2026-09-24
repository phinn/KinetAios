**发布日期：** 2026-08-03(自 v1.7.0 起 21 commits)

### 🎙️ 实时语音对话(豆包实时语音大模型)
- 全链路:说话 → ASR → LLM → 自然 TTS;WebSocket 二进制协议重写(修 1006 拒连)
- 分栏模式(点击后 main 区一分为二);语音对话接入频道 Agent — ASR 文本→Agent 执行→结果语音播报;注入当前项目上下文;四语言

### 🧬 替身画像(Persona)
- 分析历史对话+记忆生成用户风格画像;persona section 自动注入三引擎 systemPrompt

---

**English**

- **Realtime voice chat** (Doubao realtime voice LLM): full pipeline speech → ASR → LLM → natural TTS; WebSocket binary protocol rewritten (fixes 1006 rejection); split-pane mode; wired to the channel agent — ASR text runs the agent and results are spoken back; project context injected; 4-language i18n
- **Persona**: generates a user-style profile from history + memory and injects it into all three engines' system prompts

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v1.7.0...v1.8.0
