> 🌐 Language: **English** | [中文](Files-and-Preview.zh-CN.md)

# Files & Preview

Built-in file browser + browser + editor. Two entry points:

1. **Sidebar 🌐 button** — standalone window, full-screen split
2. **Main window "Files" tab** — inline on the right side of the main window, follows the current session's cwd

Both entry points share `mountFilesPane` (`src/renderer/files-pane.ts`) — one logic source.

## Layout

```
┌────────────────────────────────────────────────────────────┐
│ .files-head                                                │
│ [📁] <cwd text>     [Preview|Edit]  [←] [⟳] [<addr bar>]   │
├──────────────┬─────────────────────────────────────────────┤
│              │                                             │
│ .files-tree  │  .files-view                                │
│ (cwd tree)   │  ├─ <webview> preview (HTML/img/PDF/CSS)     │
│ Lazy-loaded  │  └─ <textarea> editor (everything else)      │
│ Click to     │                                             │
│ expand dirs  │                                             │
│              │                                             │
└──────────────┴─────────────────────────────────────────────┘
```

## File tree (left)

- **Lazy-loaded**: initially lists only the cwd's top level; clicking a directory calls `api.listDir(parentPath)` to fetch children
- **Filtered**: `node_modules` / `.git` / `dist` / `.next` / `.cache` etc. are ignored by the main process
- **Icons**: 📁 directory / 📄 file
- **Single-click on a file**:
  - Extensions `.html/.htm/.svg/.png/.jpg/.jpeg/.gif/.webp/.bmp/.ico/.pdf/.css` → switch to "Preview" tab + loadFile
  - Others → switch to "Edit" tab + loadEditor
- **Single-click on a directory**: expand / collapse
- **Right-click** (file or directory): menu "Open in browser / Open in editor / Copy path"

## Preview (webview)

The right side `<webview>` tag (Electron native, not iframe). Reasons:

- iframe's CSP `default-src 'self'` blocks `file://`, and sandboxing is strict
- `<webview>` is a separate process, can load `file://` and any `http(s)://`, with its own sandbox
- webview itself defaults to `nodeIntegration: false, sandbox: true, contextIsolation: true` — the previewed page can't reach the main process IPC

Requires `webviewTag: true` in the BrowserWindow's `webPreferences` (default false). Set in `createFilesWindow`.

### CSP

`src/renderer/index.html` / `files.html` CSP:

```
default-src 'self';
frame-src file: http: https:;     ← for webview
style-src 'self' 'unsafe-inline';
script-src 'self';
```

`frame-src` is for the webview; without it, webview couldn't render file:// URLs.

### Address bar

Accepts:
- `file:///...` — local files
- `http://` / `https://` — any URL
- `localhost:<port>` / `127.0.0.1:<port>` — preview the agent's local dev server (very useful)
- `192.168.x.x:<port>` — LAN addresses
- Bare path (`/x` or `C:\x`) → auto-prefixed with `file:///`
- Otherwise → auto-prefixed with `https://`

Enter → `webview.loadURL(normalizeURL(input))`.

### loadFile details

```ts
const absenc = abs.replace(/\\/g, '/').replace(/^\/+/, '');
const url = 'file:///' + encodeURI(absenc);
webview.src = url;
webview.loadURL(url);
```

Three slashes: Unix `/x` → `file:///x`; Windows `C:\x` → `file:///C:/x`.

**Setting both** (`src` + `loadURL`) is belt-and-suspenders:
- `loadURL` doesn't reload when `src` is already the same URL → `src = url` ensures the next different URL always reloads
- Just `src = url` doesn't reliably trigger navigation for `file://` on some Electron versions

See commit `9c7e310`.

### webview events

- `did-navigate` → address bar updates to current URL
- `did-navigate-in-page` → same (for SPA pushState)

### Back / reload

- **←**: webview.goBack()
- **⟳**: webview.reload()

## Editor (textarea)

Switch to "Edit" tab → right side `<textarea>`.

- Load: `api.fileRead(abs)` → fill textarea
- Edit: `input` event → mark dirty
- Save: **Ctrl/Cmd+S** or click "Save" button → `api.fileWrite(abs, content)`
- Status bar: file path / unsaved / saved

The textarea is a plain-text editor — no syntax highlighting, no LSP. Simple and sufficient. For an IDE feel → right-click "Open in browser" to launch your system editor.

## Tab switching reloads content

When switching tabs and a current file exists, **the corresponding loader re-loads content** (because loadFile only fills webview / loadEditor only fills the editor — the other side is empty when you switch).

```ts
ftabPreview.onclick = () => { setTab('preview'); if (currentAbs && isPreviewExt(currentAbs)) loadFile(currentAbs); };
ftabEdit.onclick    = () => { if (currentAbs) void loadEditor(currentAbs); };
```

## Right-click menu (pure DOM)

Doesn't use Electron `Menu` (that's native, requires IPC round-trip). The `#files-menu` div is absolutely positioned at the cursor.

| Menu item | Behavior |
|---|---|
| Open in browser | `api.shellOpen('file:///...')` → invokes system default browser (macOS Preview / Windows Edge / browser) |
| Open in editor | loadEditor(path) |
| Copy path | `navigator.clipboard.writeText(path)` |

**"Open in browser" goes through the system browser** (not the built-in webview — that's what left-click does). Added in v1.0 via the `shell-open` IPC → `shell.openExternal`.

Clicking anywhere outside the file tree → hides the menu.

## Standalone window vs inline

| | Standalone (🌐) | Inline ("Files" tab) |
|---|---|---|
| Entry | Sidebar 🌐 button | Main window "Files" tab |
| Size | 1100×700, standalone BrowserWindow | Right half of main window |
| cwd source | Pushed by main process on open (`files-cwd` IPC) | app.ts actively calls `setCwd(conv.cwd)` |
| Full-screen split | Yes | Limited by main window width |

If the standalone window is already open and you click 🌐 again → focus the existing window + push cwd to switch directories.

## Key source files

- `src/renderer/files-pane.ts` — `mountFilesPane` (shared by standalone & inline)
- `src/renderer/files.html` — standalone window skeleton
- `src/renderer/index.html` (inline) — `#chat-files-pane`
- `src/main/main.ts` — `createFilesWindow` + `toggleFilesWindow` + `list-dir` / `shell-open` IPC
- `src/shared/types.ts:118` — `DirEntry` type
