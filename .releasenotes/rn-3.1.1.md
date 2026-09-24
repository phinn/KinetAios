**发布日期：** 2026-08-17(自 v3.1.0 起 13 commits)

### ✨ 功能
- **企微通道支持发送文件** — wecom_send_file 工具(uploadMedia 分片上传 + replyMedia 被动回复)
- **Git diff 改 VS Code 风格 side-by-side 表格**(全量/commit diff);未跟踪文件点 diff 用 --no-index 对 /dev/null
- SEO:补 sitemap.xml + robots.txt(Bing/Webmaster 提交前置)

### 🐛 修复
- git diff 对比表长行横向滚动;scroll 系列两处(贴底目标偏小/流式抖动统一 clampedBottom)

---

**English**

- **WeCom file sending**: wecom_send_file tool (chunked uploadMedia + passive replyMedia)
- **Git diff as VS Code-style side-by-side tables**; untracked files diff via --no-index against /dev/null
- SEO: sitemap.xml + robots.txt (prerequisite for Bing Webmaster)
- Fixes: horizontal scroll for long diff rows; two scroll fixes (clamp target, unified clampedBottom)

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.1.0...v3.1.1
