**发布日期：** 2026-09-22(自 v3.8.2 起 1 commit)

### ✨ 功能

- **Steer 用户打断通道**(96eafbb)—— 运行中的会话不等它跑完,⌘Enter 原地转向:消息进 latest-wins 打断缓冲,引擎在循环边界取走注入为 `[⚡ 用户打断]`,不 abort、不换 turn、上下文延续;打断失败自动降级为排队;发送键 ⌘ 分流(Enter 排队/⌘Enter 立即转向),队首消息带 ⚡ 转向按钮;仅 Direct 系引擎

---

**English**

### ✨ Features

- **Steer user-interruption channel** (96eafbb) — a running session no longer must finish first: ⌘Enter steers in place. The message enters a latest-wins interruption buffer; the engine picks it up at loop boundaries and injects it as `[⚡ 用户打断]` — no abort, no new turn, context continues; failed interruption degrades to queueing automatically; Enter queues / ⌘Enter steers immediately via send-key split, the head-of-queue message carries a ⚡ steer button; Direct-family engines only

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.8.2...v3.9.0
