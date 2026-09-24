**发布日期：** 2026-08-20(自 v3.2.2 起 5 commits)

### 🐛 修复
- **(critical) userData 迁移绝不再 rmSync 已存在的 KinetAios 目录** — 源码运行重新生成 kinetaios-win 后,打包版启动会删光用户数据;改为仅目标不存在时单向搬迁
- IME 组合期间跳过 autosize — 拼音逐字母 reflow 阻塞 IME 消息泵,输入框打不出字
- 流式滚动上下抖动 — strip 后未恢复 content-visibility + 同帧多次写 scrollTop;改为恢复 cv + 全程唯一一次写入 + rAF 去重

---

**English**

- **(critical) userData migration no longer rmSync's an existing KinetAios directory** — running from source could regenerate kinetaios-win, and the packaged app would then wipe user data on launch; migration is now one-way and only when the target is absent
- autosize skipped during IME composition — per-letter reflow blocked the IME message pump, making typing impossible under streaming load
- Streaming scroll jitter fixed: content-visibility restored after strip, exactly one scrollTop write per frame, rAF dedupe fallback

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.2.2...v3.2.3
