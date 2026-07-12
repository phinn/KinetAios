> 🌐 Language: **English** | [中文](Global-Hotkey.zh-CN.md)

# Global Hotkey + Quick Panel

`Ctrl/Cmd+Alt+Space` — from any app, pops up the KinetAios quick panel.

## Quick panel

A small standalone window (`src/renderer/quick.html`):

- Single-line input
- Type a task → Enter
- A **temporary session** spins up in the background (default engine + global model)
- Streaming tokens render in the panel
- On completion → desktop notification + result visible

Doesn't block the main window or interrupt the current session. The temporary session persists in the sidebar list (you can revisit it later).

## Global hotkey

`src/main/main.ts` uses Electron `globalShortcut`:

```ts
globalShortcut.register('CommandOrControl+Alt+Space', () => toggleQuickPanel());
```

- `CommandOrControl` — macOS Command / Windows Ctrl
- Registered at app startup; auto-unregistered on app quit

## Closing the window quits the app (important)

KinetAios's default behavior: **closing the main window quits the whole app** (including tray + hotkey).

```
CLAUDE.md: Closing the window quits (no background persistence);
           the global hotkey only works while the app runs.
```

If you want "close window + always-on hotkey":

- Switch back to hide-on-close (replace `app.quit()` in `app.on('window-all-closed')` with not-quitting + hiding the window)
- Or keep the current behavior (simpler, no wasted resources when not in use)

Roadmap in `IMPROVEMENTS.md`.

## Tray

A tray icon is created on startup (`Tray`):

- Right-click menu: open main window / quit
- Single-click: focus the main window

Tray's "Quit" is the only reliable global exit (closing the main window defaults to quit too, but some paths may not).

## Quick panel vs main window

| | Quick panel | Main window |
|---|---|---|
| Size | Small, screen-center overlay | Large, full dashboard |
| Persistence | One-shot temporary session | Full session history |
| Tool steps | Folded, only text shown | Detailed, expandable |
| Use case | "Translate this" / "what's wrong with this code" | Complex multi-turn tasks |

## Key source files

- `src/main/main.ts` — `globalShortcut.register` + `toggleQuickPanel` + tray
- `src/renderer/quick.ts` — quick panel logic
- `src/renderer/quick.html` — skeleton
