**发布日期：** 2026-07-14(自 v1.0.0 起 49 commits)

### ✨ 功能
- **Git diff 界面大改** — word-level diff + 文件分段 + staged/unstaged 分组
- **文件编码自动检测** — read_file / edit_file / grep 自动识别 UTF-8 / GBK / GB18030
- 每条 AI 回复增加复制按钮;landing/index 可视化大幅升级;引擎名统一为 Kaios;全站跨平台表述

### 🐛 修复(23 项两轮审查)
- 二进制文件读取崩溃(检测+跳过)、截图空白图(改 getDisplayMedia)、中断后连续对话上下文断裂
- cost 重复记录 / 记忆 1970 时间戳 / 孤儿数据 / 栈溢出 / 命令注入加固(execFile 替代 exec)/ i18n 缺失

---

**English**

- **Git diff overhaul** — word-level diff, per-file sections, staged/unstaged groups
- **Auto file-encoding detection** (UTF-8 / GBK / GB18030) for file tools; copy button on every AI reply
- Fixed 23 issues across two audit rounds: binary-file crash, blank screenshots, broken context after interrupt, duplicate cost records, orphan data, command-injection hardening (execFile)

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v1.0.0...v1.1.0
