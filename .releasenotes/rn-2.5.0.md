**发布日期：** 2026-08-09(自 v2.3.0 起 47 commits)

### 🎙️ 实时语音对话完整落地(v2.4.0→v2.5.0)
- 说话→ASR 转写→豆包 LLM→自然 TTS 端到端;ASR 文本并行转发本地 Agent 执行,结果经 WS 注入豆包 TTS 朗读
- Agent 执行中间状态实时推送到语音面板;TTS 403 回落系统 speechSynthesis;音频串行播放队列
- 修复:agentBusy 死锁(ASR 回调 unhandled rejection)/语音消息发错频道(硬编码 convs[0])/空回复(crash recovery 误触发)/GLM 500(孤儿 surrogate 字符清洗)

### 📡 飞书机器人接入
- WebSocket 长连接;Agent 产出的图片/文件自动上传回传飞书(feishu_send_file);飞书/企微配置独立「消息」tab

### 🔧 CI/稳定性
- macOS x64/arm64 CI 拆分双 job + native module 显式 rebuild;Intel 黑屏 GPU 多重兜底(disableHardwareAcceleration 仅限 x64)

---

**English**

- **Realtime voice chat completed**: end-to-end speech → ASR → Doubao LLM → natural TTS; ASR text runs the local agent in parallel with results injected into TTS over WebSocket; live agent status in the voice panel; TTS falls back to system speechSynthesis on HTTP 403
- Fixed agentBusy deadlock, voice messages landing in the wrong channel, empty replies from crash-recovery misfires, and GLM 500 via orphan-surrogate cleaning
- **Feishu bot integration**: WebSocket long connection; agent-produced images/files auto-uploaded back to Feishu (feishu_send_file); dedicated "Messaging" settings tab for Feishu/WeCom
- **CI**: macOS x64/arm64 split jobs with explicit native rebuild; Intel black-screen GPU fallbacks

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v2.3.0...v2.5.0
