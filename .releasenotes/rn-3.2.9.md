**发布日期：** 2026-08-24(自 v3.2.8 起 4 commits)

### 🔍 web_search 引擎可选
- **bing/sogou/google/ddg 可选 + 失败自动回退**;搜狗主引擎 + Bing RSS 备用,结果污染修复

### 🩺 诊断
- **卡死自动取证** — renderer 心跳 + main 侧 sample 抓栈
- CI:electron-builder 25 移除 afterSign,改用内置 notarize:true

---

**English**

- **Selectable search engines** (bing/sogou/google/ddg) with automatic fallback; Sogou primary + Bing RSS backup fixes result pollution
- **Auto-forensics on hangs**: renderer heartbeat + main-process sample stacks
- CI: electron-builder 25 removed afterSign in favor of built-in notarize:true

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.2.8...v3.2.9
