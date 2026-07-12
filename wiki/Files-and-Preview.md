# Files & Preview

内置的文件浏览器 + 浏览器 + 编辑器。两个入口:

1. **侧边栏 🌐 按钮** —— 独立窗口,全屏分屏
2. **主窗口「文件」tab** —— 内联挂在主窗口右侧,跟着当前会话的 cwd

两个入口共用 `mountFilesPane`(`src/renderer/files-pane.ts`),逻辑一份。

## 布局

```
┌────────────────────────────────────────────────────────────┐
│ .files-head                                                │
│ [📁] <cwd 文本>    [预览|编辑]  [←] [⟳] [<地址栏>]        │
├──────────────┬─────────────────────────────────────────────┤
│              │                                             │
│ .files-tree  │  .files-view                                │
│ (cwd 文件树) │  ├─ <webview> 预览(HTML/图/PDF/CSS)        │
│ 懒加载       │  └─ <textarea> 编辑器(其他文件)           │
│ 点目录展开   │                                             │
│              │                                             │
└──────────────┴─────────────────────────────────────────────┘
```

## 文件树(左)

- **懒加载**:初始只列 cwd 一层;点目录才 `api.listDir(parentPath)` 取子层
- **过滤**:`node_modules` / `.git` / `dist` / `.next` / `.cache` 等被 main 进程忽略
- **图标**:📁 目录 / 📄 文件
- **单击文件**:
  - 后缀 `.html/.htm/.svg/.png/.jpg/.jpeg/.gif/.webp/.bmp/.ico/.pdf/.css` → 切「预览」tab + loadFile
  - 其他 → 切「编辑」tab + loadEditor
- **单击目录**:展开 / 收起
- **右键**(文件或目录):菜单「在浏览器中打开 / 在编辑器中打开 / 复制路径」

## 预览(webview)

右侧 `<webview>` 标签(Electron 原生,不是 iframe)。理由:

- iframe 的 CSP `default-src 'self'` 不允许 `file://`,且 sandbox 严格
- `<webview>` 独立进程,能加载 `file://` 和任意 `http(s)://`,自家沙箱
- webview 自身默认 `nodeIntegration: false, sandbox: true, contextIsolation: true` —— 预览的页面拿不到主进程 IPC

需要在 BrowserWindow 的 `webPreferences` 加 `webviewTag: true`(默认 false)。`createFilesWindow` 里设了。

### CSP

`src/renderer/index.html` / `files.html` 的 CSP:

```
default-src 'self';
frame-src file: http: https:;     ← 给 webview
style-src 'self' 'unsafe-inline';
script-src 'self';
```

`frame-src` 给 webview 用;之前没这条时 webview 加载 file:// 不渲染。

### 地址栏

支持:
- `file:///...` —— 本地文件
- `http://` / `https://` —— 任意 URL
- `localhost:<port>` / `127.0.0.1:<port>` —— agent 起的本地服务直接预览(超有用)
- `192.168.x.x:<port>` —— 局域网地址
- 无协议头的纯路径(`/x` 或 `C:\x`)→ 自动补 `file:///`
- 其他 → 自动补 `https://`

回车 → `webview.loadURL(normalizeURL(input))`。

### loadFile 的细节

```ts
const absenc = abs.replace(/\\/g, '/').replace(/^\/+/, '');
const url = 'file:///' + encodeURI(absenc);
webview.src = url;
webview.loadURL(url);
```

三斜杠:Unix `/x` → `file:///x`;Windows `C:\x` → `file:///C:/x`。

**两个都设**(`src` + `loadURL`)是 belt-and-suspenders:
- `loadURL` 在 `src` 已是同 URL 时不会重载 → 切不同文件时 `src = url` 确保下一次必重载
- 单独 `src = url` 在某些 Electron 版本对 file:// 不触发实际 navigation

详见 commit `9c7e310`。

### webview 事件

- `did-navigate` → 地址栏回填当前 URL
- `did-navigate-in-page` → 同上(单页应用的 pushState)

### 后退 / 刷新

- **←**:webview.goBack()
- **⟳**:webview.reload()

## 编辑器(textarea)

切到「编辑」tab → 右侧 `<textarea>`。

- 加载:`api.fileRead(abs)` → 灌进 textarea
- 编辑:`input` 事件 → 标 dirty
- 保存:**Ctrl/Cmd+S** 或点「保存」按钮 → `api.fileWrite(abs, content)`
- 状态栏:文件路径 / 未保存 / 已保存

textarea 是纯文本编辑器,不带语法高亮、不带 LSP。简单粗暴,够用。要 IDE 体感 → 右键「在浏览器中打开」走系统默认编辑器。

## tab 切换重灌内容

切 tab 时若已有当前文件,**用对应 loader 重新加载内容**(因为 loadFile 只灌 webview / loadEditor 只灌编辑器,切 tab 时对面是空的)。

```ts
ftabPreview.onclick = () => { setTab('preview'); if (currentAbs && isPreviewExt(currentAbs)) loadFile(currentAbs); };
ftabEdit.onclick    = () => { if (currentAbs) void loadEditor(currentAbs); };
```

## 右键菜单(纯 DOM)

不用 Electron `Menu`(那是 native、要 IPC 来回)。`#files-menu` div 绝对定位在鼠标位置。

| 菜单项 | 行为 |
|---|---|
| 在浏览器中打开 | `api.shellOpen('file:///...')` → 调起系统默认浏览器(macOS Preview / Windows Edge / 浏览器) |
| 在编辑器中打开 | loadEditor(path) |
| 复制路径 | `navigator.clipboard.writeText(path)` |

**「在浏览器中打开」走系统浏览器**(不走内置 webview —— 那是左键单击的行为)。v1.0 加的 IPC 链 `shell-open` → `shell.openExternal`。

点文件树外部任意处 → 隐藏菜单。

## 独立窗口 vs 内联

| | 独立窗口(🌐) | 内联(「文件」tab) |
|---|---|---|
| 入口 | 侧边栏 🌐 按钮 | 主窗口「文件」tab |
| 大小 | 1100×700,独立 BrowserWindow | 主窗口右半 |
| cwd 来源 | 打开时主进程推(`files-cwd` IPC) | app.ts 主动调 `setCwd(conv.cwd)` |
| 全屏分屏 | 是 | 受主窗口宽度限制 |

已开独立窗口时再点 🌐 → 聚焦已开窗口 + 推 cwd 过去换目录。

## 关键源文件

- `src/renderer/files-pane.ts` —— `mountFilesPane`(独立 & 内联共用)
- `src/renderer/files.html` —— 独立窗口骨架
- `src/renderer/index.html`(内联)—— `#chat-files-pane`
- `src/main/main.ts` —— `createFilesWindow` + `toggleFilesWindow` + `list-dir` / `shell-open` IPC
- `src/shared/types.ts:118` —— `DirEntry` 类型
