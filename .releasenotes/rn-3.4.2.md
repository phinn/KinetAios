**发布日期：** 2026-08-31(自 v3.4.1 起 2 commits)

### 🐛 修复
- ollama 原生 /api/chat 收数组 content 就 400 — 多模态消息转原生格式

### 🔧 CI
- release notes 抽取 ReferenceError 根治(v3.3.1/v3.4.1 两次被吞,三个 job 构建产物成功却死在收尾,Release 从未创建;抽不到段落时回落 GH 自动 notes)

---

**English**

- ollama native /api/chat 400s on array content — multimodal messages now convert to the native format
- CI: the release-notes extraction ReferenceError killed three successful builds after artifact upload (twice: v3.3.1/v3.4.1), so Releases were never created; now falls back to GH auto notes when no section matches

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.4.1...v3.4.2
