> 🌐 Language: [English](Visualization.md) | **中文**

# 答案内嵌可视化卡片(viz-card)

> v4.0.7 起可用。当答案里出现**自包含 HTML 文档**(```html 围栏、≥80 字符、含 div/table/svg/canvas/body 等布局标签)时,渲染引擎不再把它当普通代码块展示,而是升级为一张**可视化卡片**:

```
┌─ [标题(取内层首个 h1–h3,≤60 字)] [⬇ HTML][⬇ PNG][⍟ 代码][</> 源码] ─┐
│  ┌──────────────────────────────────────────┐  │
│  │   sandbox iframe(allow-scripts 独占)      │  │
│  │   高度按内容自适应;外链经 open-external      │  │
│  └──────────────────────────────────────┘  │
└─ 可折叠「源码」区块(转义原文,可复制) ──────────┘
```

## 工作机制 / How it works

1. **触发判定**(`src/renderer/markdown.ts::isVizCardDoc`):```html 代码块、长度 ≥ 80、含布局标签。命中即由 `renderVizCard` 输出卡片壳(标题条 + 四按钮 + iframe + 源码区),原 HTML 经转义存进 `<details class="viz-src">` 供查看/复制/下载。
2. **沙箱隔离**(唯一执行闸门):iframe 以 blob URL 加载源 HTML,`sandbox="allow-scripts"` **独占属性**。
   - ⚠️ 绝不能追加 `allow-same-origin`:blob: 与宿主同源,叠加后等于**取消沙箱**(内层脚本可经 `parent.document` 逃逸,拿到 `window.kinet` 的 shell 等能力)。源 HTML 原样进入 iframe、不预剥离脚本 —— 安全性全押在 sandbox 属性上,这是刻意的单一闸门设计。
3. **高度自适应**:sandbox 收紧后宿主读不到内层尺寸,改由**内层 boot 脚本量 `document.body` 系高度**(`documentElement.scrollHeight` 在内容不满屏时=视口高,会正反馈失控),`postMessage({type:'viz-height', id, h, w})` 上报;宿主按播种的 `data-viz-id` 精确匹配(跨域下 `ev.source` 与 contentWindow 不可全等比较),回写钳制在 `[80, 720]px`。
4. **窄卡收敛(防振荡)**:内层实报内容宽 < 父容器宽 78% → 卡片缩到内容宽;回宽阈值 92%(迟滞带)。判定基准取**父容器宽(恒定)**,绝不用 `card.clientWidth` —— 它会被上轮判定自我改写,形成宽窄振荡。
5. **图片导出**:SVG foreignObject 路实测**不可行**(整份 HTML 文档嵌 `<img>` 上下文非法,Chromium 直接拒载)。实际实现为 **`viz-capture` IPC**:主进程开离屏 `BrowserWindow` 加载同一份 HTML,`webContents.capturePage()` 截帧 2x 成 PNG,blob URL 触发下载。E2E 实测 9186 字节 PNG 落盘全链路通。
6. **外链**:sandbox 内 `target=_blank` 被吞,boot 脚本拦截锚点点击 → 宿主转 `open-external` IPC(仅放行 `http/https`)→ `shell.openExternal` 系统浏览器打开。

## 相关文件 / Files
- `src/renderer/markdown.ts` — `isVizCardDoc` / `renderVizCard`(卡片壳 + 转义源码)
- `src/renderer/app.ts` — `mountVizFrames`(blob URL 播种、id 回写、窄卡迟滞、按钮逻辑)
- `src/main/ipc/tools.ts` — `viz-capture` handler(离屏窗口拍帧)
- `src/shared/i18n.ts` — `viz.*` 四语键
