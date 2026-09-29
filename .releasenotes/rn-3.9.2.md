**发布日期:** 2026-09-27(自 v3.9.1 起 11 commits)

### ✨ 功能

- **用量看板全面改版**(4d3a4e3, 4285671)—— 趋势图对齐 Cherry Studio:按日柱状 + Token/费用指标切换 + 模型分色;时间范围扩至 6 档 3D/7D/30D/6M(90)/180D/1Y(365),默认 1M,热力图周数随档位缩放(1Y≈53 周 + 12 月份标记);X 轴长范围 5 刻度带年份
- **项目排行卡**(09432ef)—— 第 4 张排行卡:按 conversations.cwd 末段聚合 token/费用/请求数,与模型/引擎/会话排行组成 2×2;项目名 hash 分色
- **web-auto 网页自动化插件**(392a6f6)—— 浏览器实战工作流模板
- **browser_* 工具组固化推广实战坑**(2f54fc7)—— browserType 三模式注入(value/paste/insertText,React 受控组件/ProseMirror/contenteditable 全覆盖)+ 注入后回读验证(「DOM 有字≠框架收了字」);browserUpload 走 CDP DOM.setFileInputFiles 独木桥;browserCookie 写走 cookieStore.set(CDP Network.setCookie 是假成功)/读走 CDP(可读 HttpOnly)
- **usage-stats IPC + KINET_METRICS 启动开关**(ded6bf6)

### 🐛 修复

- **长档位渲染雷同**(8bf5234)—— cost_log 仅 75 天时 180D/1Y 与 90D 完全一样:根因是 daily 补齐起点=最早数据日,长档时间轴不向左展开;修复为起点=min(最早数据日, 窗口首日)向左补 0,1Y 热力图铺满 53 周
- **上下文接力优先级**(a2fe193, 4c29f98)—— 确认型短指令(「继续/执行」)先消费自身上条提议,不再先查记忆库;手贴摘要优先于 recall_memory;会话限制内检索全空时全局兜底

### 🎨 UI

- 排行卡与概览区间距修正(61a3d1a):u-rank-grid 下边距 22px,dash-overview 补上边距,消除区块拥挤

---

**English**

- **Usage dashboard overhaul** (4d3a4e3, 4285671) — trend chart aligned with Cherry Studio: daily bars + Token/cost metric switch + per-model coloring; time range extended to 6 presets (3D/7D/30D/6M(90)/180D/1Y(365)), default 1M; heatmap weeks scale with range (1Y ≈ 53 weeks + month labels); 5 ticks with year for long X ranges
- **Project ranking card** (09432ef) — 4th ranking card: aggregates token/cost/requests by last segment of conversations.cwd, forming a 2×2 grid with model/engine/conversation rankings; project names color-hashed
- **web-auto web-automation plugin** (392a6f6) — browser workflow templates from real campaigns
- **browser_* tool group hardens field-tested pitfalls** (2f54fc7) — browserType's three injection modes (value/paste/insertText covering React controlled inputs / ProseMirror / contenteditable) + post-injection read-back verification ("text in DOM ≠ framework received it"); browserUpload goes through the CDP DOM.setFileInputFiles single bridge; browserCookie writes via cookieStore.set (CDP Network.setCookie silently fails) and reads via CDP (sees HttpOnly)
- **Goal-driven context continuation (v2)** — goal chain + turn progress injected into the system prompt

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.9.1...v3.9.2
