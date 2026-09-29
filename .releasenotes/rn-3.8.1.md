**发布日期：** 2026-09-21(自 v3.8.0 起 30 commits)

### 🔒 安全加固(五连修)

- **P0 凭据加密全覆盖**(d4c7518)—— `settings.json` 敏感字段统一 `@enc:` 加密封装:`modelProfiles[].apiKey`/`balanceApiKey`(此前明文落盘)、wecomBot.secret、feishu 全字段、MCP token;`web_fetch` 重定向 SSRF 修复(重定向到内网地址拒绝跟随)
- **P0 插件工具统一审批门**(c61f38a)—— `pluginTools()` 按 manifest `approval` 声明制统一包装,默认 `always`:修前 office-suite 18 工具全 exec 零 confirm、hw-diag 整插件绕过审批链
- **P1 三处**(941f4f6)—— CSP 收敛(删 unpkg 远程脚本残留源)+ 主窗口导航防护(拦截 `will-navigate`/`setWindowOpenHandler`)+ MCP token 爆破限速
- **P2**(2dc9048)—— Computer Use 授权撤销入口(设置页一键撤销)+ 快照目录 git 本地忽略
- **纵深两笔** —— `settings.json` 0600 落盘、MCP CORS 删 `'null'`/`file://`、web_fetch 响应体 16MB 上限(381e20a);`escapeHtml`/`esc` 全部补单引号转义,堵 onclick 单引号属性逃逸注入(3d32ea2)

### ✨ 功能

- **侧栏运行中实时状态**(98fcb24)—— 频道条目就地下发引擎 statusNote(对齐 Mac 版),当前步骤一目了然,不再只有"运行中"三个字
- **compactMeta 紧凑模式**(6416e1d)—— 设置新增开关:工具输出只留摘要行;工具输出里的路径可点(Shift+单击系统打开);行内代码路径同款交互(0731188)
- **DirectV2 executePlanSteps 抽取**(51459c1)—— run/replan 两条执行循环合一,补丁面收窄
- **旧回合「收起」按钮**(cccee2a)—— 展开后的历史回合可再收起,修此前单向折叠
- **marketing-kit 插件 v1.2/v1.3**(4f067a5/58cf524)—— 6 只读工具(搜索/HN 热度/Reddit 原声/SEO 体检/漏斗计算/关键词拓展)+ panel 贡献点(营销控制台:漏斗计算器+调研工作台+发布清单),postMessage 桥接零宿主改动

### 🐛 修复 & 📖 文档

- 长会话可用性五项(bd449af):侧栏时间桶/日期分隔/流式实时 meta/命令面板扩充/contextTooLong 恢复引导
- README 首屏 30 秒 TL;DR + Star CTA(acaeb0d);hero 截图更新到 v3.8 真实会话(a2c610d);wiki Tools-and-MCP 补全 40+ 工具清单(85300c2);跨平台定位口径修正(11c1002)

---

**English**

### 🔒 Security hardening (five fixes)

- **P0 credential encryption coverage** (d4c7518) — sensitive fields in `settings.json` uniformly sealed with `@enc:` encryption: `modelProfiles[].apiKey` / `balanceApiKey` (previously plaintext on disk), wecomBot.secret, all feishu fields, MCP tokens; `web_fetch` redirect SSRF fix (redirects to internal addresses are refused)
- **P0 unified approval gate for plugin tools** (c61f38a) — `pluginTools()` wraps tools per the manifest `approval` declaration, default `always`: before the fix, office-suite's 18 tools all ran exec with zero confirm, and the whole hw-diag plugin bypassed the approval chain
- **P1 trio** (941f4f6) — CSP tightened (removed leftover unpkg remote-script source) + main-window navigation protection (intercepts `will-navigate` / `setWindowOpenHandler`) + MCP token brute-force rate limiting
- **P2** (2dc9048) — Computer Use authorization revoke entry (one-click revoke on the settings page) + snapshot directory git-ignored locally
- **Defense in depth** — `settings.json` persisted 0600, MCP CORS drops `'null'`/`file://`, web_fetch response body 16MB cap (381e20a); `escapeHtml`/`esc` all gained single-quote escaping, closing onclick single-quoted-attribute injection (3d32ea2)

### ✨ Features

- **Sidebar live running status** (98fcb24) — channel rows get engine statusNote in place (matching the Mac app); the current step is visible at a glance instead of just the words "running"
- **compactMeta compact mode** (6416e1d) — new settings toggle: tool output keeps only summary lines; paths in tool output are clickable (Shift+click opens in the system), same interaction for inline-code paths (0731188)
- **DirectV2 executePlanSteps extraction** (51459c1) — the run/replan execution loops merged into one, shrinking the patch surface
- **Collapse button for old turns** (cccee2a) — expanded history turns can collapse again, fixing the previous one-way fold
- **marketing-kit plugin v1.2/v1.3** (4f067a5/58cf524) — 6 read-only tools (search / HN traction / Reddit voice-of-customer / SEO audit / funnel calc / keyword expansion) + panel contribution (marketing console: funnel calculator + research workbench + launch checklist), postMessage bridge with zero host changes

### 🐛 Fixes & 📖 Docs

- Five long-session usability items (bd449af): sidebar time buckets / date separators / streaming live meta / command palette expansion / contextTooLong recovery guidance
- README first-screen 30-second TL;DR + Star CTA (acaeb0d); hero screenshot updated to a real v3.8 session (a2c610d); wiki Tools-and-MCP completed with the 40+ tool inventory (85300c2); cross-platform positioning corrected (11c1002)

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.8.0...v3.8.1
