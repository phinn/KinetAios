// Preload: exposes a narrow, typed API to the renderer via contextBridge.
// Renderer has no Node access — it can only call these and listen to these events.
// 每个 on* 方法先 removeAllListeners 再注册,防止多次调用导致回调叠加(hot-reload / 窗口重建场景)。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { KinetAPI, ChatMsg } from '../shared/types';

const api: KinetAPI = {
  getConversations: () => ipcRenderer.invoke('get-conversations'),
  getTurns: (convId) => ipcRenderer.invoke('get-turns', convId),
  newConversation: (cwd, engine) => ipcRenderer.invoke('new-conversation', cwd, engine),
  send: (id, text) => ipcRenderer.invoke('send', id, text),
  cancel: (id) => ipcRenderer.invoke('cancel', id),
  deleteConversation: (id) => ipcRenderer.invoke('delete-conversation', id),
  clearConversation: (id) => ipcRenderer.invoke('clear-conversation', id),
  rename: (id, title) => ipcRenderer.invoke('rename', id, title),
  setCwd: (id, cwd) => ipcRenderer.invoke('set-cwd', id, cwd),
  setEngine: (id, engine) => ipcRenderer.invoke('set-engine', id, engine),
  setModel: (id, model) => ipcRenderer.invoke('set-model', id, model),
  setSubModel: (id, model) => ipcRenderer.invoke('set-sub-model', id, model),
  setConvProfile: (id, profileId) => ipcRenderer.invoke('set-conv-profile', id, profileId),
  setContextMode: (id, mode) => ipcRenderer.invoke('set-context-mode', id, mode),
  setPersonaEnabled: (id, enabled) => ipcRenderer.invoke('set-persona-enabled', id, enabled),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  setAppIcon: (iconKey) => ipcRenderer.invoke('set-app-icon', iconKey),
  resolveIconUrl: (file) => ipcRenderer.invoke('resolve-icon-url', file),
  testConnection: (s?) => ipcRenderer.invoke('test-connection', s),
  listLocalModels: (baseURL?) => ipcRenderer.invoke('list-local-models', baseURL),
  getBalance: (profileId?: string | null) => ipcRenderer.invoke('get-balance', profileId),
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
  gitAction: (cwd: string, action: import('../shared/types').GitActionKind, opts?: { message?: string; file?: string; branch?: string }) => ipcRenderer.invoke('git-action', cwd, action, opts),
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
  // P0-2:会话级 KV 锚点(renderer debug 面板用)
  factList: (convId: string) => ipcRenderer.invoke('fact-list', convId),
  factDelete: (convId: string, key: string) => ipcRenderer.invoke('fact-delete', convId, key),
  snapshotList: (cwd, convId) => ipcRenderer.invoke('snapshot-list', cwd, convId),
  snapshotRestore: (cwd, id) => ipcRenderer.invoke('snapshot-restore', cwd, id),
  pluginList: () => ipcRenderer.invoke('plugin-list'),
  pluginReload: () => ipcRenderer.invoke('plugin-reload'),
  pluginInstall: (sourcePath: string) => ipcRenderer.invoke('plugin-install', sourcePath),
  pluginUninstall: (name: string) => ipcRenderer.invoke('plugin-uninstall', name),
  pluginToggle: (name: string, enabled: boolean) => ipcRenderer.invoke('plugin-toggle', name, enabled),
  pluginEngineSettingsSave: (name: string, values: Record<string, string>) => ipcRenderer.invoke('plugin-engine-settings-save', name, values),
  pluginPanels: () => ipcRenderer.invoke('plugin-panels'),
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
  memoryDedup: () => ipcRenderer.invoke('memory-dedup'),
  // P0: Memory Blocks
  memoryBlocksList: () => ipcRenderer.invoke('memory-blocks-list'),
  memoryBlockUpdate: (label: string, value: string) => ipcRenderer.invoke('memory-block-update', label, value),
  // P2: Episodic Memories
  episodicMemories: (limit?: number) => ipcRenderer.invoke('episodic-memories', limit),
  // P3: Idle Reflection
  memoryReflection: () => ipcRenderer.invoke('memory-reflection'),
  // 会话导出
  exportConversation: (convId, format) => ipcRenderer.invoke('export-conversation', convId, format),
  // Arena Diff
  arenaDiff: (leftConvId, rightConvId) => ipcRenderer.invoke('arena-diff', leftConvId, rightConvId),
  // 上下文压缩可视化
  estContextTokens: (convId) => ipcRenderer.invoke('est-context-tokens', convId),
  pinTurn: (convId, turnId, pinned) => ipcRenderer.invoke('pin-turn', convId, turnId, pinned),
  // 上下文检查器
  getDirectHistory: (convId: string) => ipcRenderer.invoke('get-direct-history', convId),
  saveDirectHistory: (convId: string, history: ChatMsg[]) => ipcRenderer.invoke('save-direct-history', convId, history),
  // 跨会话引用 + Agent 任务图
  taskGraph: () => ipcRenderer.invoke('task-graph'),
  searchConversations: (query) => ipcRenderer.invoke('search-conversations', query),
  // 全局对话搜索
  searchHistory: (query: string) => ipcRenderer.invoke('search-history', query),
  // 记忆图谱数据
  memoryGraphData: () => ipcRenderer.invoke('memory-graph-data'),
  // 删除记忆三元组
  deleteMemoryTriple: (tripleId: string) => ipcRenderer.invoke('delete-memory-triple', tripleId),
  // Arena 深度统计
  arenaStats: () => ipcRenderer.invoke('arena-stats'),
  // 记忆图谱窗口
  openMemoryGraph: () => ipcRenderer.invoke('open-memory-graph'),
  // 远程 Agent 直播状态
  remoteAgentStatus: () => ipcRenderer.invoke('remote-agent-status'),
  // 会话交接
  exportSessionState: (convId) => ipcRenderer.invoke('export-session-state', convId),
  importSessionState: (sessionJson) => ipcRenderer.invoke('import-session-state', sessionJson),
  // 记忆同步
  syncMemoriesWithRemote: (serverName) => ipcRenderer.invoke('sync-memories-remote', serverName),
  // 系统级截图
  captureScreen: (hideSelf?: boolean) => ipcRenderer.invoke('capture-screen', hideSelf),
  // 语音转写
  transcribeAudio: (base64: string, mime: string) => ipcRenderer.invoke('transcribe-audio', base64, mime),
  // 剪贴板写入(主进程 clipboard 模块,绕过 renderer navigator.clipboard 不可用问题)
  clipboardWriteText: (text: string) => ipcRenderer.invoke('clipboard-write-text', text),
  // Visual Inspector:向 webview guest 注入采集脚本(白名单 action,不接受任意脚本)
  webviewInspect: (guestInstanceId: number, action: string, params?: Record<string, unknown>) => ipcRenderer.invoke('webview-inspect', guestInstanceId, action, params),
  // ── 替身画像(Persona)──
  generatePersona: () => ipcRenderer.invoke('generate-persona'),
  getPersona: () => ipcRenderer.invoke('get-persona'),
  savePersona: (persona: string) => ipcRenderer.invoke('save-persona', persona),

  // ── 实时语音助手(豆包实时语音大模型)──
  voiceChatStart: (convId: string) => ipcRenderer.invoke('voice-chat-start', convId),
  voiceChatStop: () => ipcRenderer.invoke('voice-chat-stop'),
  voiceChatSendAudio: (pcm: ArrayBuffer) => ipcRenderer.invoke('voice-chat-send-audio', arrayBufferToBase64(pcm)),
  voiceChatState: () => ipcRenderer.invoke('voice-chat-state'),

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
  onVoiceChatEvent: (cb) => {
    ipcRenderer.removeAllListeners('voice-chat-event');
    ipcRenderer.on('voice-chat-event', (_e: IpcRendererEvent, ev) => cb(ev));
  },
  confirmResponse: (id, approved) => ipcRenderer.send('confirm-response', { id, approved }),

  // ── AgentTeams ──
  listTeams: (convId: string) => ipcRenderer.invoke('team-list', convId),
  createTeam: (convId: string, members: Array<{ name: string; role: string }>) =>
    ipcRenderer.invoke('team-create', convId, members),
  deleteTeamById: (teamId: string) => ipcRenderer.invoke('team-delete', teamId),
  listTeamMembers: (teamId: string) => ipcRenderer.invoke('team-list-members', teamId),
  sendToTeamMember: (teamId: string, memberName: string, message: string) =>
    ipcRenderer.invoke('team-send-member', teamId, memberName, message),
  broadcastToTeam: (teamId: string, message: string) =>
    ipcRenderer.invoke('team-broadcast', teamId, message),
  onTeamEvent: (cb) => {
    ipcRenderer.removeAllListeners('team-event');
    ipcRenderer.on('team-event', (_e: IpcRendererEvent, payload: { teamId: string; ev: import('../shared/types').TeamEvent }) => cb(payload.teamId, payload.ev));
  },

  // ── 企业微信机器人 ──
  wecomBotStatus: () => ipcRenderer.invoke('wecom-bot-status'),
  wecomBotConnect: () => ipcRenderer.invoke('wecom-bot-connect'),
  wecomBotDisconnect: () => ipcRenderer.invoke('wecom-bot-disconnect'),
  onWeComBotEvent: (cb: (ev: { type: string; data?: unknown }) => void) => {
    ipcRenderer.removeAllListeners('wecom-event');
    ipcRenderer.on('wecom-event', (_e: IpcRendererEvent, ev: { type: string; data?: unknown }) => cb(ev));
  },

  // ── 飞书机器人 ──
  feishuBotStatus: () => ipcRenderer.invoke('feishu-bot-status'),
  feishuBotConnect: () => ipcRenderer.invoke('feishu-bot-connect'),
  feishuBotDisconnect: () => ipcRenderer.invoke('feishu-bot-disconnect'),
  onFeishuBotEvent: (cb: (ev: { type: string; data?: unknown }) => void) => {
    ipcRenderer.removeAllListeners('feishu-event');
    ipcRenderer.on('feishu-event', (_e: IpcRendererEvent, ev: { type: string; data?: unknown }) => cb(ev));
  },

  // ── 卡死取证心跳 / Freeze-watchdog heartbeat ──
  // renderer 主线程每秒发一次;main 侧停摆 >5s 即抓调用栈(见 main.ts freeze watchdog)。
  startHeartbeat: () => {
    setInterval(() => ipcRenderer.send('renderer-heartbeat'), 1000);
  },
};

// ArrayBuffer → base64(语音音频传输用)
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

contextBridge.exposeInMainWorld('kinet', api);
