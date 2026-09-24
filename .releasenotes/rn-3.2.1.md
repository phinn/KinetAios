**发布日期：** 2026-08-20(自 v3.2.0 起 5 commits)

### 🐛 修复
- **BIN_EXT 补 xlsx/docx/pptx 等 Office 扩展名** — 拖入 Excel 被当文本读成乱码拼进 prompt
- **DirectV2 forwardEvent 不再静默吞 error** — 网络/API 错误转 status 透出,修复执行到一半静默停止

---

**English**

- BIN_EXT now covers Office extensions (xlsx/docx/pptx) — dropped-in Excel files were being read as garbled text into the prompt
- DirectV2 forwardEvent no longer swallows errors silently — network/API errors surface as status events, fixing mid-run silent stops

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.2.0...v3.2.1
