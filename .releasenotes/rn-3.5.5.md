**发布日期：** 2026-09-04(自 v3.5.4 起 2 commits)

### 🖥️ Computer Use 后台输入链路
- **macOS 后台投递(CGEventPostToPid)** + deepUnwrap 实锤修复
- mac 后台文本输入改剪贴板粘贴 — CGEventKeyboardSetUnicodeString 合成事件被 Chrome 丢弃(正文键入要求 key window);改 pbpaste 保存→pbcopy 写入→Cmd+V 后台投递→延迟 1.2s 恢复原剪贴板

---

**English**

- **macOS background input**: CGEventPostToPid delivery + deepUnwrap fix
- Background text entry switched to clipboard paste — synthesized keyboard events were dropped by Chrome (body typing requires key-window focus); now saves the pasteboard, writes the target text, posts Cmd+V in background, restores after 1.2s

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.5.4...v3.5.5
