**发布日期：** 2026-08-24(自 v3.2.7 起 3 commits)

### 🍎 macOS 签名公证
- **Developer ID 签名 + notarytool 公证 + staple** — 修复新 Mac 报 malware

### 🐛 修复
- ollama tool_calls arguments 字符串转对象 — 修二轮请求 400
- 巨型会话广播瘦身 — emitConversation 超阈值剥 turns 防 renderer 卡死

---

**English**

- **macOS Developer ID signing + notarytool notarization + staple** — fixes "malware" warnings on new Macs
- ollama tool_calls arguments string→object conversion fixes 400s on the second request
- Giant-conversation broadcasts slimmed: emitConversation strips turns past a threshold to protect the renderer

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.2.7...v3.2.8
