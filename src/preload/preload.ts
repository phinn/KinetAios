// Preload: exposes a narrow, typed API to the renderer via contextBridge.
// Renderer has no Node access — it can only call these and listen to these events.
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
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  readFile: (rel, cwd) => ipcRenderer.invoke('read-file', rel, cwd),
  fileRead: (abs) => ipcRenderer.invoke('file-read', abs),
  fileWrite: (abs, content) => ipcRenderer.invoke('file-write', abs, content),
  getBrand: () => ipcRenderer.invoke('get-brand'),
  quickSubmit: (text) => ipcRenderer.invoke('quick-submit', text),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  openFiles: (cwd) => ipcRenderer.invoke('open-files', cwd),
  shellOpen: (url) => ipcRenderer.invoke('shell-open', url),
  listDir: (absPath) => ipcRenderer.invoke('list-dir', absPath),
  gitSnapshot: (cwd) => ipcRenderer.invoke('git-snapshot', cwd),
  gitDiff: (cwd, opts) => ipcRenderer.invoke('git-diff', cwd, opts),
  readRules: (cwd) => ipcRenderer.invoke('read-rules', cwd),
  writeRules: (cwd, content) => ipcRenderer.invoke('write-rules', cwd, content),
  readContext: (cwd) => ipcRenderer.invoke('read-context', cwd),
  writeContext: (cwd, content) => ipcRenderer.invoke('write-context', cwd, content),
  memoryExport: () => ipcRenderer.invoke('memory-export'),
  memoryImport: () => ipcRenderer.invoke('memory-import'),
  memoryList: (convId) => ipcRenderer.invoke('memory-list', convId),
  memoryUpdate: (id, content) => ipcRenderer.invoke('memory-update', id, content),
  memoryDelete: (id) => ipcRenderer.invoke('memory-delete', id),

  onAgentEvent: (cb) => {
    ipcRenderer.on('agent-event', (_e: IpcRendererEvent, { convId, ev }) => cb(convId, ev));
  },
  onConversation: (cb) => {
    ipcRenderer.on('conversation', (_e: IpcRendererEvent, conv) => cb(conv));
  },
  onConversationRemoved: (cb) => {
    ipcRenderer.on('conversation-removed', (_e: IpcRendererEvent, id) => cb(id));
  },
  onFilesCwd: (cb) => {
    ipcRenderer.on('files-cwd', (_e: IpcRendererEvent, cwd: string) => cb(cwd));
  },
  onConfirmRequest: (cb) => {
    ipcRenderer.on('confirm-request', (_e: IpcRendererEvent, req) => cb(req));
  },
  confirmResponse: (id, approved) => ipcRenderer.send('confirm-response', { id, approved }),
};

contextBridge.exposeInMainWorld('kinet', api);
