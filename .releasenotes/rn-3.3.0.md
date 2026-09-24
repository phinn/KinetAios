**发布日期：** 2026-08-25(自 v3.2.9 起 28 commits)

### 🏷️ 品牌与目录彻底解耦
- **userData 目录写死 KinetAios** — 改任何品牌配置数据目录永不变;菜单栏/窗口标题从 brand.json 读;支持 userData/brand.json 外置覆盖 + 外置 icons;icon 留空回落 settings.appIcon
- 修复 CJS TDZ 初始化崩溃、侧栏品牌名不刷新、打包 icon.ico 缺失

### 🧊 卡死/性能根治(8-24 事故同族)
- **SSE/Ollama 流读取静默看门狗** — 5 分钟静默超时走错误路径,不再永久死等
- **dedupMemories O(n²) 卡死** — 预计算+预过滤+让出;IPC 瘦身(广播/get-conversations 剥 directHistory);turns LRU 逐出 + per-conv 状态释放;两条全表扫描消灭;cron 重入门闩 + 退出 cancelAll;FTS 入库截断 + WAL 退出截断 + 日志轮转
- **unresponsive 黑匣子** — 卡死自动 sample renderer 栈

### 🔍 web_search 链路
- Bing 中文锁 zh-CN 市场 + 全引擎相关性护栏;googleSearch 加 SOCS consent cookie;回退显式标注原因

---

**English**

- **Brand/directory decoupling**: userData pinned to KinetAios; menu-bar/window titles read brand.json; external userData/brand.json + icons override; empty icon falls back to settings.appIcon. CJS TDZ crash, sidebar brand refresh, and packaged icon.ico fixes included
- **Hang/performance root-cause fixes** (same family as the 8-24 incident): silent watchdog on SSE/Ollama streams (5-min timeout), O(n²) dedupMemories tamed, IPC payloads slimmed (directHistory stripped), turns LRU eviction + per-conv state release, two full-table scans eliminated, cron re-entry latch + exit cancelAll, FTS truncation + WAL checkpoint on quit + log rotation, unresponsive black-box stack sampling
- **web_search pipeline**: Bing Chinese locked to zh-CN market with relevance guardrails, Google SOCS consent cookie, explicit fallback reasons

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.2.9...v3.3.0
