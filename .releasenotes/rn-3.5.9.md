**发布日期：** 2026-09-10(自 v3.5.8 起 17 commits)

### 🧠 上下文/记忆 P0 修复五项(带 49 项回归测试)
- 最小验证基建落地 — esbuild harness + electron/node:sqlite shim,零新增依赖
- 记忆生命周期三项 — decay 按 importance 分档/切断注入 touch 回路/episodic 滚动 upsert

### ✨ 功能
- **聊天界面 P1/P2** — 语法高亮/嵌套列表/路径可点/规划卡/消息排队/搜索
- **screenshot_window** — 按标题截窗口内容,零置前零打扰;hide_self 截图改透明化;macOS 裸 open 机械重写 open -gj + system prompt 后台窗口纪律;焦点守卫 guardFocus
- **永挂/静默吞根因三处** — fetch 首字节看门狗 + 空回复落库 + 空 completion 重试;GLM 流静默看门狗首 chunk 后被永久撤销修复;飞书 WS 僵尸自愈 watchdog

---

**English**

- **Five P0 context/memory fixes backed by 49 regression tests**; minimal verification infra (esbuild harness + electron/node:sqlite shim, zero new deps)
- Memory lifecycle trio: importance-tiered decay, injection-touch loop cut, episodic rolling upsert
- **Chat P1/P2**: syntax highlighting, nested lists, clickable paths, planning cards, message queueing, search
- **screenshot_window**: capture a window by title without raising it; hide_self now fades instead of minimizing; bare `open` auto-rewritten to `open -gj` + background-window discipline in the system prompt; focus guard
- Three hang/silent-swallow root causes fixed (first-byte watchdog, empty replies persisted, empty completion retry); GLM stream watchdog no longer cancelled after first chunk; Feishu WS zombie self-healing

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.5.8...v3.5.9
