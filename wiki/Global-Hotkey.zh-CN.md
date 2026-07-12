> 🌐 Language: [English](Global-Hotkey) | **中文**

# 全局热键 + 快速面板

`Ctrl/Cmd+Alt+Space` —— 任意应用前台时,弹出 KinetAios 快速面板。

## 快速面板

独立的小窗口(`src/renderer/quick.html`):

- 单行输入框
- 输入任务 → Enter
- 后台启一个**临时会话**(默认引擎 + 全局模型)
- 流式 token 显示在面板里
- 完成 → 桌面通知 + 结果可见

不阻塞主窗口、不打断当前会话。临时会话用完会保留在 sidebar 列表里(可以再回去翻)。

## 全局热键

`src/main/main.ts` 用 Electron `globalShortcut`:

```ts
globalShortcut.register('CommandOrControl+Alt+Space', () => toggleQuickPanel());
```

- `CommandOrControl` —— macOS Command / Windows Ctrl
- 注册在 app 启动时;app 退出时自动注销

## 关窗 = 退应用(重要)

KinetAios 默认行为:**关主窗口 = 退出整个 app**(包括托盘 + 热键)。

```
CLAUDE.md:关闭窗口即退出应用(无后台驻留);全局热键只在应用运行时生效。
```

如果想「关窗 + 热键常驻」:

- 改回 hide-on-close(把 `app.on('window-all-closed')` 的 `app.quit()` 换成不退出 + 隐藏窗口)
- 或者保持当前行为(简单,无驻留资源浪费)

`IMPROVEMENTS.md` 里有 roadmap。

## 托盘

启动时建托盘图标(`Tray`):

- 右键菜单:打开主窗口 / 退出
- 单击:聚焦主窗口

托盘的「退出」是唯一可靠的全局退出(关主窗口默认也退,但有些路径下不一定)。

## 快速面板 vs 主窗口

| | 快速面板 | 主窗口 |
|---|---|---|
| 大小 | 小,屏幕中央浮层 | 大,完整 dashboard |
| 持续性 | 一次性临时会话 | 完整会话历史 |
| 工具步骤 | 折叠,只显示文本 | 详细展开,可点开看 |
| 适用 | 「帮我翻译这个」「这段代码有什么问题」 | 复杂多轮任务 |

## 关键源文件

- `src/main/main.ts` —— `globalShortcut.register` + `toggleQuickPanel` + 托盘
- `src/renderer/quick.ts` —— 快速面板逻辑
- `src/renderer/quick.html` —— 骨架
