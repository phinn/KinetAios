// Preload: exposes a narrow, typed API to the renderer via contextBridge.
// Renderer has no Node access — it can only call these and listen to these events.
// 每个 on* 方法先 removeAllListeners 再注册,防止多次调用导致回调叠加(hot-reload / 窗口重建场景)。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { KinetAPI } from '../shared/types';

const api: KinetAPI = {
  getConversations: () => ipcRenderer.invoke('get-conversations'),
  newConversation: (cwd, engine) => ipcRenderer.invoke('new-conversation', cwd, engine),
  send: (id, text) => ipcRenderer.invoke('send', id, text),
  cancel: (id) => ipcRenderer.invoke('cancel', id),
  deleteConversation: (id) => ipcRenderer.invoke('delete-conversation', id),
  clearConversation: (id) => ipcRenderer.invoke('clear-conversation', id),
  rename: (id, title) => ipcRenderer.invoke('rename', id, title),
  setCwd: (id, cwd) => ipcRenderer.invoke('set-cwd', id, cwd),
  setEngine: (id, engine) => ipcRenderer.invoke('set-engine', id, engine),
  setModel: (id, model) => ipcRenderer.invoke('set-model', id, model),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  testConnection: (s) => ipcRenderer.invoke('test-connection', s),
  listSkills: () => ipcRenderer.invoke('list-skills'),
  listMcp: () => ipcRenderer.invoke('list-mcp'),
  startMcpServer: (port, token) => ipcRenderer.invoke('start-mcp-server', port, token),
  stopMcpServer: () => ipcRenderer.invoke('stop-mcp-server'),
  mcpServerStatus: () => ipcRenderer.invoke('mcp-server-status'),
  listRemoteNodes: () => ipcRenderer.invoke('list-remote-nodes'),
  callRemoteAgent: (serverName, prompt) => ipcRenderer.invoke('call-remote-agent', serverName, prompt),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  readFile: (rel, cwd) => ipcRenderer.invoke('read-file', rel, cwd),
  fileRead: (abs) => ipcRenderer.invoke('file-read', abs),
  fileWrite: (abs, content) => ipcRenderer.invoke('file-write', abs, content),
  getBrand: () => ipcRenderer.invoke('get-brand'),
  quickSubmit: (text) => ipcRenderer.invoke('quick-submit', text),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  openFiles: (cwd) => ipcRenderer.invoke('open-files', cwd),
  openArena: (cwd) => ipcRenderer.invoke('open-arena', cwd),
  shellOpen: (url) => ipcRenderer.invoke('shell-open', url),
  listDir: (absPath) => ipcRenderer.invoke('list-dir', absPath),
  gitSnapshot: (cwd) => ipcRenderer.invoke('git-snapshot', cwd),
  gitDiff: (cwd: string, opts: { file?: string; hash?: string; staged?: boolean }) => ipcRenderer.invoke('git-diff', cwd, opts),
  readRules: (cwd) => ipcRenderer.invoke('read-rules', cwd),
  writeRules: (cwd, content) => ipcRenderer.invoke('write-rules', cwd, content),
  readContext: (cwd) => ipcRenderer.invoke('read-context', cwd),
  writeContext: (cwd, content) => ipcRenderer.invoke('write-context', cwd, content),
  memoryExport: () => ipcRenderer.invoke('memory-export'),
  memoryImport: () => ipcRenderer.invoke('memory-import'),
  memoryList: (convId) => ipcRenderer.invoke('memory-list', convId),
  memoryUpdate: (id, content) => ipcRenderer.invoke('memory-update', id, content),
  memoryDelete: (id) => ipcRenderer.invoke('memory-delete', id),
  memoryTriples: (convId) => ipcRenderer.invoke('memory-triples', convId),
  memoryTripleDelete: (id) => ipcRenderer.invoke('memory-triple-delete', id),
  snapshotList: (cwd, convId) => ipcRenderer.invoke('snapshot-list', cwd, convId),
  snapshotRestore: (cwd, id) => ipcRenderer.invoke('snapshot-restore', cwd, id),
  pluginList: () => ipcRenderer.invoke('plugin-list'),
  pluginReload: () => ipcRenderer.invoke('plugin-reload'),
  cronList: () => ipcRenderer.invoke('cron-list'),
  cronAdd: (t) => ipcRenderer.invoke('cron-add', t),
  cronUpdate: (id, patch) => ipcRenderer.invoke('cron-update', id, patch),
  cronDelete: (id) => ipcRenderer.invoke('cron-delete', id),
  cronValidate: (expr) => ipcRenderer.invoke('cron-validate', expr),
  watchList: () => ipcRenderer.invoke('watch-list'),
  watchStart: (cwd) => ipcRenderer.invoke('watch-start', cwd),
  watchStop: (cwd) => ipcRenderer.invoke('watch-stop', cwd),
  // Pipeline
  pipelineRun: (p) => ipcRenderer.invoke('pipeline-run', p),
  pipelineTemplates: () => ipcRenderer.invoke('pipeline-templates'),
  pipelineSave: (p) => ipcRenderer.invoke('pipeline-save', p),
  pipelineDelete: (id) => ipcRenderer.invoke('pipeline-delete', id),
  // 会话分支
  branchFromTurn: (convId, turnIdx) => ipcRenderer.invoke('branch-from-turn', convId, turnIdx),
  // 成本预算
  getBudget: () => ipcRenderer.invoke('get-budget'),
  saveBudget: (b) => ipcRenderer.invoke('save-budget', b),
  getCostStats: () => ipcRenderer.invoke('cost-stats'),
  // Prompt 模板
  templateList: () => ipcRenderer.invoke('template-list'),
  templateSave: (t) => ipcRenderer.invoke('template-save', t),
  templateDelete: (id) => ipcRenderer.invoke('template-delete', id),
  // 可视化规则生成
  rulesGenerate: (cfg) => ipcRenderer.invoke('rules-generate', cfg),
  // 自定义工具
  customToolList: () => ipcRenderer.invoke('custom-tool-list'),
  customToolSave: (t) => ipcRenderer.invoke('custom-tool-save', t),
  customToolDelete: (id) => ipcRenderer.invoke('custom-tool-delete', id),
  // 记忆时间线
  memoryTimeline: () => ipcRenderer.invoke('memory-timeline'),
  memoryDecay: () => ipcRenderer.invoke('memory-decay'),
  // 会话导出
  exportConversation: (convId, format) => ipcRenderer.invoke('export-conversation', convId, format),
  // Arena Diff
  arenaDiff: (leftConvId, rightConvId) => ipcRenderer.invoke('arena-diff', leftConvId, rightConvId),
  // 上下文压缩可视化
  estContextTokens: (convId) => ipcRenderer.invoke('est-context-tokens', convId),
  pinTurn: (convId, turnId, pinned) => ipcRenderer.invoke('pin-turn', convId, turnId, pinned),
  // 跨会话引用 + Agent 任务图
  taskGraph: () => ipcRenderer.invoke('task-graph'),
  searchConversations: (query) => ipcRenderer.invoke('search-conversations', query),
  // 会话交接
  exportSessionState: (convId) => ipcRenderer.invoke('export-session-state', convId),
  importSessionState: (sessionJson) => ipcRenderer.invoke('import-session-state', sessionJson),
  // 记忆同步
  syncMemoriesWithRemote: (serverName) => ipcRenderer.invoke('sync-memories-remote', serverName),
  // 系统级截图
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  // 语音转写
  transcribeAudio: (base64: string, mime: string) => ipcRenderer.invoke('transcribe-audio', base64, mime),
  // 剪贴板写入(主进程 clipboard 模块,绕过 renderer navigator.clipboard 不可用问题)
  clipboardWriteText: (text: string) => ipcRenderer.invoke('clipboard-write-text', text),
  // Visual Inspector:向 webview guest 注入脚本执行,返回结果
  webviewInspect: (guestInstanceId: number, script: string) => ipcRenderer.invoke('webview-inspect', guestInstanceId, script),

  onAgentEvent: (cb) => {
    ipcRenderer.removeAllListeners('agent-event');
    ipcRenderer.on('agent-event', (_e: IpcRendererEvent, { convId, ev }) => cb(convId, ev));
  },
  onConversation: (cb) => {
    ipcRenderer.removeAllListeners('conversation');
    ipcRenderer.on('conversation', (_e: IpcRendererEvent, conv) => cb(conv));
  },
  onConversationRemoved: (cb) => {
    ipcRenderer.removeAllListeners('conversation-removed');
    ipcRenderer.on('conversation-removed', (_e: IpcRendererEvent, id) => cb(id));
  },
  onFilesCwd: (cb) => {
    ipcRenderer.removeAllListeners('files-cwd');
    ipcRenderer.on('files-cwd', (_e: IpcRendererEvent, cwd: string) => cb(cwd));
  },
  onArenaCwd: (cb) => {
    ipcRenderer.removeAllListeners('arena-cwd');
    ipcRenderer.on('arena-cwd', (_e: IpcRendererEvent, cwd: string) => cb(cwd));
  },
  onConfirmRequest: (cb) => {
    ipcRenderer.removeAllListeners('confirm-request');
    ipcRenderer.on('confirm-request', (_e: IpcRendererEvent, req) => cb(req));
  },
  onRemoteAgentEvent: (cb) => {
    ipcRenderer.removeAllListeners('remote-agent-event');
    ipcRenderer.on('remote-agent-event', (_e: IpcRendererEvent, ev) => cb(ev));
  },
  confirmResponse: (id, approved) => ipcRenderer.send('confirm-response', { id, approved }),
};

contextBridge.exposeInMainWorld('kinet', api);
