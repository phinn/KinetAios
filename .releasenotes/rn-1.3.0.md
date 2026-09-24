**发布日期：** 2026-07-15(自 v1.2.0 起 24 commits)

### 🏘️ Town View — 等距像素风 Agent 小镇(新)
- 项目=房子、会话=村民、远程节点=云端房子;村民头顶实时状态徽章(空闲/工作中/完成/出错)
- 点击村民地图内直接聊天;新建项目=选目录盖房子;四语言 i18n;主题联动

### 🔒 安全加固(两轮审查)
- **SSRF 防护** — web_fetch 禁止内网地址(127.x/10.x/172.16-31.x/192.168.x/IPv6 ULA)
- shell-open 防护(阻 shell:/file: 协议)、grep 正则转义防 ReDoS、CLI spawn 参数校验防注入
- 剪贴板修复(contextIsolation 下改 IPC 通道)

### 🎨 UX
- 关闭按钮行为设置(退出/最小化到托盘);KinetAios vs Claude Code vs Codex 对比页

---

**English**

- **Town View**: isometric pixel-art town where projects are houses, sessions are villagers with live status badges, and remote MCP nodes are cloud houses. Chat with villagers in-map; fully localized (4 languages).
- **Security hardening (2 audit rounds)**: SSRF protection (private ranges blocked in web_fetch), shell:/file: protocol blocking, regex-escaping against ReDoS, CLI argument-injection guards, clipboard via IPC under contextIsolation
- Close-button behavior setting (quit / minimize to tray); comparison page vs Claude Code & Codex

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v1.2.0...v1.3.0
