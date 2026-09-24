**发布日期：** 2026-09-04(自 v3.5.3 起 3 commits)

### ⚡ 流式速率
- **流式 token 速率指示** — 5s 滑窗速率 + 累计 tok 数

### 🦙 多模态根治
- ollama 多模态 content 数组扁平化 — 根治带图历史每轮 400

### 👥 子代理透视
- memberTool args/result 透传 + dispatch_agent 工具步骤进主聊天流 + team/* 事件入 conv_events 考古可回放

---

**English**

- **Streaming token-rate indicator**: 5s sliding-window rate + cumulative tokens
- **Ollama multimodal fixed**: content array flattening eradicates per-turn 400s on image-bearing history
- **Sub-agent transparency**: memberTool args/results pass through, dispatch_agent steps appear in the main chat flow, team/* events land in conv_events for replay

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.5.3...v3.5.4
