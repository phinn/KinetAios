// 通过 --remote-debugging-port 连接到真实运行的 dashboard 检查布局
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// 完整注册所有 app.ts init 需要的 IPC handler
function registerHandlers() {
  // Settings
  ipcMain.handle('get-settings', () => ({
    apiKeys: {},
    theme: 'dark',
    lang: 'zh',
    conversations: [],
    enableCliEngines: false,
    sidebarMode: 'grouped',
  }));
  ipcMain.handle('save-settings', (e, s) => ({}));

  // Conversations
  ipcMain.handle('get-conversations', () => []);
  ipcMain.handle('new-conversation', () => ({ id: 'test', title: 'Test', turns: [], cwd: '/tmp', engine: 'direct', status: 'idle' }));
  ipcMain.handle('send', () => ({}));
  ipcMain.handle('cancel', () => ({}));
  ipcMain.handle('delete-conversation', () => ({}));
  ipcMain.handle('clear-conversation', () => ({}));
  ipcMain.handle('rename', () => ({}));
  ipcMain.handle('set-cwd', () => ({}));
  ipcMain.handle('set-engine', () => ({}));
  ipcMain.handle('set-model', () => ({}));
  ipcMain.handle('set-sub-model', () => ({}));
  ipcMain.handle('set-conv-profile', () => ({}));
  ipcMain.handle('set-context-mode', () => ({}));
  ipcMain.handle('set-persona-enabled', () => ({}));

  // Misc
  ipcMain.handle('get-brand', () => ({ productName: 'KinetAios' }));
  ipcMain.handle('list-memories', () => ({ items: [], total: 0 }));
  ipcMain.handle('get-balance', () => ({}));
  ipcMain.handle('list-skills', () => ({ skills: [] }));
  ipcMain.handle('list-mcp', () => ({ servers: [] }));
  ipcMain.handle('start-mcp-server', () => ({}));
  ipcMain.handle('stop-mcp-server', () => ({}));
  ipcMain.handle('list-local-models', () => []);
  ipcMain.handle('test-connection', () => ({ ok: true }));

  // Tools (shell confirm etc.)
  ipcMain.handle('shell-run', () => ({ stdout: '', stderr: '', exitCode: 0 }));
  ipcMain.handle('read-file', () => '');
  ipcMain.handle('write-file', () => ({}));

  // Events - use mainWindow.on/send pattern
  ipcMain.handle('get-active-profiles', () => []);
  ipcMain.handle('list-snapshots', () => ({ items: [] }));
  ipcMain.handle('list-cron', () => ({ items: [] }));
  ipcMain.handle('get-remote-nodes', () => []);
  ipcMain.handle('get-teams', () => ({ teams: [] }));
  ipcMain.handle('get-plugins', () => ({ plugins: [] }));
  ipcMain.handle('get-pipeline-list', () => []);
  ipcMain.handle('get-templates', () => []);
  ipcMain.handle('get-cost-data', () => ({}));
  ipcMain.handle('get-git-snapshot', () => null);
  ipcMain.handle('get-rules', () => '');
  ipcMain.handle('get-workbench-data', () => ({ projects: [] }));
  ipcMain.handle('get-memory-graph', () => ({ nodes: [], edges: [] }));
  ipcMain.handle('get-timeline', () => ({ items: [], hasMore: false }));
  ipcMain.handle('get-ctx-inspector', () => null);

  // on* handlers - respond with a cleanup function
  ipcMain.handle('on-conversation', () => () => {});
  ipcMain.handle('on-event', () => () => {});
  ipcMain.handle('on-cost', () => () => {});
  ipcMain.handle('on-status', () => () => {});
}

app.whenReady().then(() => {
  registerHandlers();

  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));

  win.webContents.on('console-message', (e, level, message) => {
    console.log('[CONSOLE]', message);
  });

  setTimeout(() => {
    win.webContents.executeJavaScript(`(
      new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          function diag() {
            const ids = ['app', 'main', 'chat-view', 'chat-content', 'turns', 'input'];
            const results = {};
            for (const id of ids) {
              const el = document.getElementById(id);
              if (!el) { results[id] = 'NOT FOUND'; continue; }
              const cs = getComputedStyle(el);
              results[id] = {
                display: cs.display,
                flexDirection: cs.flexDirection,
                flex: cs.flex,
                flexShrink: cs.flexShrink,
                minHeight: cs.minHeight,
                overflow: cs.overflow,
                overflowY: cs.overflowY,
                offsetHeight: el.offsetHeight,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                offsetWidth: el.offsetWidth,
                hidden: el.hidden,
                childCount: el.childElementCount,
              };
            }
            const cv = document.getElementById('chat-view');
            if (cv) {
              results['chat-view-children'] = [...cv.children].map(c => ({
                tag: c.tagName, id: c.id, cls: c.className,
                display: getComputedStyle(c).display,
                offsetH: c.offsetHeight, hidden: c.hidden,
              }));
            }
            const cc = document.getElementById('chat-content');
            if (cc) {
              results['chat-content-children'] = [...cc.children].map(c => ({
                tag: c.tagName, id: c.id, cls: c.className,
                display: getComputedStyle(c).display,
                offsetH: c.offsetHeight,
                position: getComputedStyle(c).position,
              }));
            }
            return JSON.stringify(results, null, 2);
          }
          resolve(diag());
        }));
      })
    );`).then(result => {
      console.log('=== REAL APP DIAGNOSTIC ===');
      console.log(result);
      app.quit();
    }).catch(err => {
      console.error('Error:', err);
      app.quit();
    });
  }, 3000);
});
