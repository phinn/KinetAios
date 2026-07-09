// Electron main: app lifecycle, dashboard + quick windows, global shortcut, IPC, shell-confirm bridge.
// ponytail: no tray icon for MVP (would need an .ico asset) — the taskbar icon + global shortcut cover it.
import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { initStore } from './store';
import { getSettings, saveSettings } from './settings';
import { currentProvider } from './glm';
import { TaskManager, type TaskManagerEmitter } from './TaskManager';
import type { AgentEvent, AppSettings, ConfigSnapshot, Conversation, EngineKind } from '../shared/types';

let dashboardWin: BrowserWindow | null = null;
let quickWin: BrowserWindow | null = null;
let taskManager: TaskManager;

// MARK: shell-confirm bridge (main asks the dashboard window; user answers in a modal)
const pendingConfirms = new Map<string, (approved: boolean) => void>();
let confirmSeq = 0;

function confirm(cmd: string): Promise<boolean> {
  if (getSettings().approval === 'never') return Promise.resolve(true);
  const id = `c${process.pid}_${confirmSeq++}`;
  const win = dashboardWin;
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  win.webContents.send('confirm-request', { id, cmd });
  return new Promise((resolve) => pendingConfirms.set(id, resolve));
}

const emitter: TaskManagerEmitter = {
  emitEvent(convId, ev: AgentEvent) {
    dashboardWin?.webContents.send('agent-event', { convId, ev });
    quickWin?.webContents.send('agent-event', { convId, ev });
  },
  emitConversation(conv: Conversation) {
    dashboardWin?.webContents.send('conversation', conv);
    quickWin?.webContents.send('conversation', conv);
  },
  emitRemoved(convId) {
    dashboardWin?.webContents.send('conversation-removed', convId);
  },
  confirm,
};

function createDashboard(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#1b1b1f',
    title: 'KinetAios',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses require(better-sqlite3)? no — preload only bridges; keep false for contextBridge simplicity
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

function createQuick(): BrowserWindow {
  const win = new BrowserWindow({
    width: 640,
    height: 160,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#1b1b1f',
    title: 'KinetAios · Quick',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'quick.html'));
  return win;
}

function toggleQuick(): void {
  if (quickWin && !quickWin.isDestroyed()) {
    quickWin.close();
    return;
  }
  quickWin = createQuick();
  quickWin.on('closed', () => (quickWin = null));
}

function registerIpc(): void {
  ipcMain.handle('get-conversations', () => taskManager.list());
  ipcMain.handle('new-conversation', (_e, cwd?: string, engine?: EngineKind) =>
    taskManager.newConversation(cwd || os.homedir(), engine),
  );
  ipcMain.handle('send', (_e, id: string, text: string) => {
    taskManager.send(id, text);
    return true;
  });
  ipcMain.handle('cancel', (_e, id: string) => taskManager.cancel(id));
  ipcMain.handle('delete-conversation', (_e, id: string) => taskManager.deleteConversation(id));
  ipcMain.handle('clear-conversation', (_e, id: string) => taskManager.clearConversation(id));
  ipcMain.handle('rename', (_e, id: string, title: string) => taskManager.rename(id, title));
  ipcMain.handle('set-cwd', (_e, id: string, cwd: string) => taskManager.setCwd(id, cwd));
  ipcMain.handle('set-engine', (_e, id: string, engine: EngineKind) => {
    taskManager.setEngine(id, engine);
    return true;
  });

  ipcMain.handle('get-settings', () => getSettings());
  ipcMain.handle('save-settings', (_e, s: AppSettings) => {
    saveSettings(s);
    return true;
  });
  ipcMain.handle('test-connection', async (_e, s?: AppSettings) => {
    const snap: ConfigSnapshot = s
      ? { baseURL: s.baseURL, model: s.model, apiKey: s.apiKey, apiProtocol: s.apiProtocol, reasoning: 'none' }
      : (() => {
          const cur = getSettings();
          return {
            baseURL: cur.baseURL,
            model: cur.model,
            apiKey: cur.apiKey,
            apiProtocol: cur.apiProtocol,
            reasoning: 'none' as const,
          };
        })();
    try {
      await currentProvider(snap).streamComplete(
        [{ role: 'user', content: 'ping' }],
        [],
        snap,
        AbortSignal.timeout(20_000),
        () => {},
      );
      return { ok: true, message: '连接成功' };
    } catch (e) {
      return { ok: false, message: (e as Error)?.message ?? String(e) };
    }
  });

  ipcMain.on('confirm-response', (_e, { id, approved }: { id: string; approved: boolean }) => {
    const resolve = pendingConfirms.get(id);
    if (resolve) {
      resolve(approved);
      pendingConfirms.delete(id);
    }
  });

  ipcMain.handle('quick-submit', async (_e, text: string) => {
    const conv = taskManager.newConversation(os.homedir());
    taskManager.send(conv.id, text);
    return conv.id;
  });
}

// single instance — second launch just focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (dashboardWin) {
      if (dashboardWin.isMinimized()) dashboardWin.restore();
      dashboardWin.focus();
    }
  });

  app.whenReady().then(() => {
    initStore();
    taskManager = new TaskManager(emitter);
    taskManager.load();
    registerIpc();
    dashboardWin = createDashboard();

    // Ctrl+Alt+Space on Windows (Cmd/Ctrl+Alt+Space cross-platform).
    globalShortcut.register('CommandOrControl+Alt+Space', toggleQuick);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) dashboardWin = createDashboard();
    });
  });

  app.on('window-all-closed', () => {
    // ponytail: quit on close everywhere (no mac dock-stays-open behavior on Windows).
    globalShortcut.unregisterAll();
    app.quit();
  });
}
