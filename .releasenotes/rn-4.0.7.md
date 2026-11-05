**发布日期:** 2026-11-05(自 v4.0.6 起 33 commits)

> 4.0.7 是「答案内可视化 + 插件引擎扩张」版本。核心:**viz-card** —— AI 回答里的自包含 HTML 文档(```html 代码块 ≥80 字符且含 div/table/svg/canvas 等)不再只是一段灰色代码,而是直接渲染成带标题、操作条、自动高度的**活卡片**;新增 `jsonl-gemini` 第四协议预设 + **gemini-cli 插件引擎**(在 KinetAios 里多频道并行托管 Gemini CLI 会话);内置 **claude-code-router(ccr)插件引擎**(ccr 路由 DeepSeek/Kimi/GLM,resume 感知);推广追踪 dashboard(promo 面板,隐私:零种子数据)。

### 🖼️ viz-card:答案内可视化卡片

- **渲染契约**:markdown 渲染层识别自包含 HTML 文档(≥80 字符 + 结构标签白名单),输出卡片壳(标题条 + 操作条 + iframe + 可折叠源码 details);宿主 `mountVizFrames` 原地挂载 blob URL,幂等(data-viz-mounted)。
- **沙箱安全**:iframe `sandbox="allow-scripts"`(**不带** allow-same-origin —— blob: 与宿主同源,同时开启等于取消沙箱,内层可逃逸 parent.document;实测收窄后高度/宽度上报不受影响)。内层脚本量自身 body 尺寸,不需要同源授权。
- **高度自适应**:内层 boot 脚本 postMessage({type:'viz-height', id, h}) 上报,宿主按唯一 `data-viz-id` 精确回写(跨域下 ev.source 与 contentWindow 不全等,按 id 匹配),高度钳制 80–720px。E2E 实测单卡 h=262 稳定、双卡 [84,332] 各归各位,无正反馈循环。
- **窄卡防振荡**:窄卡判定基准用**父容器宽**(自身 clientWidth 会被上轮缩放污染 → 振荡),加 0.78 进 / 0.92 出迟滞带 + wasNarrow 锁存。E2E 500px 容器 2s×20 采样零翻转。
- **图片导出(v4.0.7 内重做)**:点「下载为图片」→ 离屏 BrowserWindow 渲染同一份 HTML → `capturePage` → PNG 下载。(SVG foreignObject 方案实测不可行:整份 HTML 文档进 `<img>` 上下文非法,且 Chromium 对 img 内 foreignObject 支持不可靠。)E2E 实证:点击 → IPC `viz-capture` → PNG 落盘。
- **外链**:卡片内 `<a>` 经 open-external IPC 走系统浏览器,仅放行 http/https。
- **标题提取**:内层首个 h1–h3 提为卡片标题(60 字截断),无则 i18n 默认「可视化卡片」(四语)。

### 🔌 引擎/插件

- **gemini-cli 插件引擎**:plugin.json 声明式注册(bin=gemini,protocol=jsonl-gemini),在 KinetAios 里以多频道并行托管 gemini 会话。**坑:gemini 放 `-p` 会与 stdin 冲突** —— 正解 = 不放 -p,spawn stdin pipe 自动触发 headless,恒 end stdin 不挂死。
- **jsonl-gemini 第四协议预设**:解析 gemini --output-format stream-json 的 init(session_id)/message 事件,schema 核对官方 output/types.ts v0.67。
- **claude-code-router(ccr)插件引擎**:ccr → DeepSeek/Kimi/GLM 路由,jsonl-claude 协议,resume 感知(--resume + session_id),纯 plugin.json 零代码。
- wiki 同步:Plugins.md / Plugins.zh-CN.md / Engines.md / Engines.zh-CN.md 协议表 + 新引擎章节;新建 Visualization.md / Visualization.zh-CN.md。

### 📊 promo dashboard(推广追踪)

- promo IPC + 设置面板「推广」tab:追踪上游 PR / issue / 目录站状态,可刷新;**隐私:零种子数据**,数据走 JSON 导入/导出(个人数据与产品功能严格分离)。

### 🐛 修复

- **截图 base64 三处驻留泄漏**:directHistory 剥旧图、applyEvent 只保最新 1 张,内存不再被历史截图撑爆。
- **abort 监听器泄漏全链清零**:fetchUntil200 桥接监听唯一正确摘除时机 = 流消费完(headers 到手就摘断传导),正常完成不摘则每 ReAct 步堆死监听破 MaxListeners 上限;记忆抽取超时自我熔断。
- **流式期「停止」真停**:abort 传导到 body 流,终态清过时 statusNote。
- **插件/预览 iframe sandbox 补 allow-modals + allow-downloads**:修 panel confirm() 被 Chrome 静默吞掉(返回 false 不报错)致导入无反应。
- **插件内点外链白屏**:iframe 裸 `<a href>` 导航 iframe 自身,srcdoc 无内容落 about:blank;改走 open-external。
- **KINET_USERDATA 多实例逃生门**:demo/录制隔离 userData profile,单实例锁按 userData 判定。
- viz.collapse i18n 键补齐(四语)。

### 🧹 其它

- 阅读列 1120→1360(--read-col 变量收敛 4 处),Windows 宽屏留白收敛。
- README:7 引擎口径(Direct V1–V5 + Claude Code + Codex + 插件引擎)。

---

**English**

**Release date:** 2026-11-05 (33 commits since v4.0.6)

> 4.0.7 is the "in-answer visualization + plugin engine expansion" release. The centerpiece: **viz-card** — self-contained HTML documents in AI answers (```html code blocks ≥80 chars with structural tags) are no longer gray code walls; they render live as **cards** with a title, action bar, and auto height. Added the `jsonl-gemini` fourth protocol preset + a **gemini-cli plugin engine** (host parallel Gemini CLI sessions as KinetAios channels), a built-in **claude-code-router (ccr) plugin engine** (routes to DeepSeek/Kimi/GLM, resume-aware), and a promo tracking dashboard (zero seed data — privacy by design).

### 🖼️ viz-card: in-answer visualization cards

- **Rendering contract**: the markdown layer detects self-contained HTML documents (≥80 chars + structural-tag whitelist) and emits a card shell (title bar + action bar + iframe + collapsible source details); the host `mountVizFrames` mounts blob URLs in place, idempotently (data-viz-mounted).
- **Sandbox**: iframe `sandbox="allow-scripts"` — **no** allow-same-origin (blob: shares the host origin; enabling both cancels the sandbox and lets inner scripts escape to parent.document; height/width reporting was verified unaffected after tightening). Inner scripts measure their own body — no same-origin grant needed.
- **Auto height**: inner boot script reports postMessage({type:'viz-height', id, h}); the host writes back by unique `data-viz-id` (cross-origin ev.source ≠ contentWindow, so match by id), clamped 80–720px. E2E: single card h=262 stable, two cards [84,332] each routed correctly, no feedback loop.
- **Narrow-card anti-oscillation**: the narrow test uses the **parent** width (self clientWidth gets polluted by the previous scale round → oscillation), plus a 0.78-in / 0.92-out hysteresis band and a wasNarrow latch. E2E: 500px container, 2s×20 samples, zero flapping.
- **Image export (rebuilt within 4.0.7)**: "Download as image" → offscreen BrowserWindow renders the same HTML → `capturePage` → PNG download. (The SVG foreignObject route was tested and rejected: a full HTML document is invalid inside an `<img>` context, and Chromium's foreignObject-in-img support is unreliable.) E2E-verified: click → IPC `viz-capture` → PNG lands on disk.
- **External links**: in-card `<a>` goes through the open-external IPC to the system browser; only http/https allowed.
- **Title extraction**: the first inner h1–h3 becomes the card title (60-char cap), else the i18n default (4 languages).

### 🔌 Engines / plugins

- **gemini-cli plugin engine**: declarative plugin.json registration (bin=gemini, protocol=jsonl-gemini); host parallel gemini sessions as channels. **Trap: passing `-p` to gemini conflicts with stdin** — the fix is to omit -p; a piped stdin triggers headless mode, and stdin is always ended so it never hangs.
- **jsonl-gemini fourth protocol preset**: parses gemini --output-format stream-json init(session_id)/message events; schema checked against official output/types.ts v0.67.
- **claude-code-router (ccr) plugin engine**: ccr → DeepSeek/Kimi/GLM routing over the jsonl-claude protocol, resume-aware (--resume + session_id), pure plugin.json, zero code.
- Wiki sync: protocol tables + new-engine sections in Plugins.md / Plugins.zh-CN.md / Engines.md / Engines.zh-CN.md; new Visualization.md / Visualization.zh-CN.md.

### 📊 Promo dashboard

- Promo IPC + a settings "promo" tab tracking upstream PR / issue / directory-site status, refreshable; **zero seed data** — data flows via JSON import/export (strict separation of personal data from product features).

### 🐛 Fixes

- **Screenshot base64 residency leak (3 sites)**: directHistory strips old images; applyEvent keeps only the latest 1 — memory no longer bloats with historical screenshots.
- **Abort-listener leak chain zeroed**: the only correct detach point for the fetchUntil200 bridge listener is when the stream is consumed (detach as soon as headers arrive to stop propagation); leaving it attached stacks dead listeners past the MaxListeners limit per ReAct step. Memory extraction now self-fuses on timeout.
- **"Stop" actually stops during streaming**: abort propagates to the body stream; stale statusNote cleared on terminal states.
- **Plugin/preview iframe sandbox gains allow-modals + allow-downloads**: fixes panel confirm() being silently swallowed by Chrome (returns false with no error), which made imports look dead.
- **In-plugin external links no longer blank**: a bare `<a href>` navigates the iframe itself; srcdoc has nothing to persist → about:blank. Now routed via open-external.
- **KINET_USERDATA multi-instance escape hatch**: isolated userData profiles for demo/recording; the single-instance lock now keys on userData.
- viz.collapse i18n key added (4 languages).

### 🧹 Misc

- Reading column 1120→1360 (--read-col variable, 4 usages consolidated); wide-screen margins tightened on Windows.
- README: 7-engine story (Direct V1–V5 + Claude Code + Codex + plugin engines).

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.0.6...v4.0.7
