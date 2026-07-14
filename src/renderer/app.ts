// Dashboard renderer. Vanilla TS — no framework. Holds a local copy of conversations,
// applies streaming events, re-renders the changed bits. Settings + shell-confirm modal inline.
import { applyEvent, ENGINE_LABELS } from '../shared/types';
import { t, LANGS, type Lang } from '../shared/i18n';
import type { AppSettings, Conversation, EngineKind, GitSnapshot, KinetAPI, SkillInfo } from '../shared/types';
import { renderMarkdown as md } from './markdown';
import { mountFilesPane, type FilesPaneController } from './files-pane';
import { CodeEditor } from './code-editor';

declare global {
  interface Window {
    kinet: KinetAPI;
  }
}

const api: KinetAPI = window.kinet;
const convs = new Map<string, Conversation>();
let order: string[] = [];
let selectedId: string | null = null;
let cliEnabled = false; // mirrors settings.enableCliEngines — gates the engine dropdown
let currentView: 'chat' | 'settings' | 'workbench' | 'pipeline' | 'templates' | 'cost' | 'ctools' | 'timeline' = 'chat';
// 侧栏显示模式:grouped(按 cwd 分项目)或 flat(原始平铺)。localStorage 持久化。
let sidebarMode: 'grouped' | 'flat' = (localStorage.getItem('sb-mode') as 'grouped' | 'flat') || 'grouped';
const collapsedProjects = new Set<string>(); // sidebar 分组折叠状态(内存,不持久化)
const slashMenu = document.getElementById('slash-menu')!;
let skills: SkillInfo[] = []; // lazily fetched on first /
let slashItems: SkillInfo[] = []; // current filtered view
let slashIndex = 0;
let attachments: { name: string; content: string }[] = []; // 📎 选 / 拖入的文件,发送时拼进 prompt
let imageAttachments: { name: string; dataUrl: string }[] = []; // 🖼️ 图片附件(base64 data URL)
let PRODUCT = 'KinetAios'; // 产品名(启动从 brand.json 读,所有显示处用这个)
let HOME_DIR = ''; // 用户主目录(brand API 同步拿到);cwd === HOME_DIR 时显示「未分类」
let lang: Lang = 'zh-CN'; // UI 语言(启动从 settings 读,切语言后更新 + applyI18nDOM)
// 成本预算缓存(设置页 load 时从 main 读,save 时原样回写,避免 async readSettingsForm)
let budgetCache: AppSettings['budget'] = { enabled: false, perSessionLimit: 0, dailyLimit: 0 };
// 多机协作:MCP Server + 远程节点配置缓存(同 budget 模式)
let localMcpServerCache: AppSettings['localMcpServer'] = { enabled: false, port: 18109, token: '' };
let remoteMcpServersCache: AppSettings['remoteMcpServers'] = [];
let filesController: FilesPaneController | null = null; // 「文件」tab 懒挂载
let activeTab: 'chat' | 'files' | 'git' | 'rules' = 'chat';
// git tab 状态:最近一次 snapshot + 当前右侧视图(history 默认 / 点文件或提交切到 diff)。
// view.contentHTML 是已转义 + 按行包好 .d-add/.d-del/.d-hunk 的安全 HTML。
let gitState: { snapshot?: GitSnapshot; view: { kind: 'history' } | { kind: 'diff'; title: string; contentHTML: string }; lastCwd: string } = {
  view: { kind: 'history' },
  lastCwd: '',
};
// rules tab:工作目录下的 KINET.md。rulesCwd 跟踪当前加载的 cwd,切会话且 cwd 变了就重载。
let rulesCwd = '';
let rulesEditor: CodeEditor | null = null;
function tr(key: string, params?: Record<string, string | number>): string {
  return t(lang, key, params);
}

// SVG 图标库 / SVG icon set (统一替代 emoji / unified emoji replacement)
const ICON = {
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
  speak: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 010 7M19 5a9 9 0 010 14"/></svg>',
  branch: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="3" r="2"/><circle cx="6" cy="21" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 5v14M18 8v2a4 4 0 01-4 4H6"/></svg>',
  replay: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 109-9 9 9 0 00-7.5 4"/><path d="M3 4v4h4"/><path d="M10 9l5 3-5 3z"/></svg>',
  export: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
  wrench: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 005.4-5.4l-2.1 2.1-2.4-.6-.6-2.4z"/></svg>',
  plug: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>',
  link: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/></svg>',
  bolt: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.5 12.5a1 1 0 00.8 1.5H10l-1 8 8.5-10.5a1 1 0 00-.8-1.5H12z"/></svg>',
  folder: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
  doc: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  globe: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>',
  graph: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v4M12 11L6.5 17M12 11l5.5 6"/></svg>',
  list: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  branch2: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="3" r="2"/><circle cx="6" cy="21" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 5v14M18 8v2a4 4 0 01-4 4H6"/></svg>',
  edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4z"/></svg>',
  del: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M10 11v6M14 11v6"/></svg>',
} as const;
// 刷 index.html 里的静态文本([data-i18n] 元素)+ <html lang>。init 和切语言后调。
// 运行时注入的字符串(app.ts 各 render 函数)直接调 tr(),它们每次重建 innerHTML 自动跟随。
function applyI18nDOM(): void {
  document.documentElement.lang = lang;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = t(lang, el.dataset.i18n!); });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => { el.title = t(lang, el.dataset.i18nTitle!); });
  document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => { (el as HTMLInputElement).placeholder = t(lang, el.dataset.i18nPlaceholder!); });
  // 模式按钮的 title 跟随当前模式(不是静态 key),applyI18nDOM 会重写 title,这里补回去。
  syncSidebarModeBtn();
}

// ---------- bootstrap ----------
(async function init() {
  // 阻止 Electron 把拖入的文件当成 URL 打开(默认会让整个窗口跳转/白屏)。
  // 只有 #input 的 drop 真正接收文件(见 wireUi)。
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  try {
    // 配置(语言 + 主题 + CLI 引擎开关)和产品名都启动时读一次。语言/主题切走后同步更新。
    const settings = await api.getSettings();
    lang = settings.lang;
    cliEnabled = settings.enableCliEngines;
    applyTheme(settings.theme);
    const brand = await api.getBrand();
    PRODUCT = brand.productName;
    HOME_DIR = brand.homeDir;
    document.title = PRODUCT;
    const brandEl = document.getElementById('brand');
    if (brandEl) brandEl.innerHTML = '<span class="spark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg></span> ' + esc(PRODUCT);
    (document.getElementById('composer') as HTMLTextAreaElement).placeholder = tr('composer.placeholder', { product: PRODUCT });
    applyI18nDOM();

    const list = await api.getConversations();
    for (const c of list) {
      convs.set(c.id, c);
      order.push(c.id);
    }
    if (order.length) selectedId = order[0];
  } catch (e) {
    console.error('init failed', e);
    document.body.innerHTML = `<div style="padding:48px;text-align:center;color:#f44336;font-family:system-ui">
      <h2><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-4px;margin-right:6px"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg> 初始化失败</h2>
      <p>${esc(String(e))}</p>
      <p>请重启应用。如问题持续,检查 userData/history.db 是否损坏。</p>
    </div>`;
    return;
  }

  api.onConversation((conv) => {
    const isNew = !convs.has(conv.id);
    convs.set(conv.id, conv);
    if (isNew) order.unshift(conv.id);
    renderSidebar();
    if (conv.id === selectedId) renderMain();
    if (currentView === 'workbench') renderWorkbench();
  });
  api.onConversationRemoved((id) => {
    convs.delete(id);
    order = order.filter((x) => x !== id);
    if (selectedId === id) selectedId = order[0] ?? null;
    renderSidebar();
    renderMain();
    if (currentView === 'workbench') renderWorkbench();
  });
  api.onAgentEvent((convId, ev) => {
    const conv = convs.get(convId);
    if (!conv) return;
    applyEvent(conv, ev);
    if (convId === selectedId) {
      if (ev.type === 'token') streamAppend(ev.text);
      else renderMain();
    }
    if (ev.type !== 'token') {
      renderSidebar();
      if (currentView === 'workbench' && (ev.type === 'cost' || ev.type === 'done' || ev.type === 'error')) {
        // ponytail: 增量刷新单卡;新任务/删除走 onConversation → 全量 renderWorkbench,这里只更新统计/时间/图标。
        refreshWbCard(conv.cwd || '');
      }
    }
  });
  api.onConfirmRequest((req) => showConfirm(req.id, req.cmd));

  // 远程 Agent 事件:别的机器正在调本机 Agent 干活 → 显示浮动状态条。
  api.onRemoteAgentEvent((ev) => {
    showRemoteAgentBanner(ev);
  });

  fillModelHints();
  wireUi();
  syncSidebarModeBtn();
  syncViewButtons();
  renderSidebar();
  renderMain();
})();

// ---------- sidebar ----------
// 两种模式:grouped(按 cwd 分项目)和 flat(原始平铺)。底部按钮切换。
function renderSidebar() {
  const ul = document.getElementById('conv-list')!;
  ul.innerHTML = '';
  if (!order.length) {
    ul.innerHTML = '<li style="color:var(--text-faint);cursor:default">' + esc(tr('sidebar.empty')) + '</li>';
    return;
  }
  // flat 模式 = 原始平铺;grouped = 按 cwd 分项目(默认)。
  if (sidebarMode === 'flat') {
    for (const id of order) {
      const c = convs.get(id);
      if (!c) continue;
      ul.appendChild(taskLi(id));
    }
    return;
  }
  // 按 cwd 聚合,保留首次出现顺序(order 已经最新在前,所以分组顺序也是最新项目在前)。
  const groups = new Map<string, string[]>();
  for (const id of order) {
    const c = convs.get(id);
    if (!c) continue;
    const key = c.cwd || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(id);
  }
  for (const [cwd, ids] of groups) {
    const projLi = document.createElement('li');
    projLi.className = 'sb-proj';
    const head = document.createElement('div');
    head.className = 'sb-proj-head';
    const collapsed = collapsedProjects.has(cwd);
    const name = projName(cwd);
    head.innerHTML =
      `<span class="sb-chevron">${collapsed ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>' : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'}</span>` +
      `<span class="sb-pico">${ICON.folder}</span>` +
      `<span class="sb-pname">${esc(name)}</span>` +
      `<span class="sb-pcount">${ids.length}</span>` +
      `<span class="sb-pacts"><button class="ca-btn" data-act="new" title="${esc(tr('wb.newTask'))}">＋</button></span>`;
    head.onclick = (e) => {
      if ((e.target as HTMLElement)?.closest('[data-act]')) return;
      if (collapsedProjects.has(cwd)) collapsedProjects.delete(cwd);
      else collapsedProjects.add(cwd);
      renderSidebar();
    };
    head.querySelector<HTMLElement>('[data-act="new"]')!.onclick = (e) => {
      e.stopPropagation();
      void newTaskInProject(cwd);
    };
    head.title = cwd || tr('wb.ungrouped');
    projLi.appendChild(head);
    if (!collapsed) {
      const tasksUl = document.createElement('ul');
      tasksUl.className = 'sb-proj-tasks';
      for (const id of ids) tasksUl.appendChild(taskLi(id));
      projLi.appendChild(tasksUl);
    }
    ul.appendChild(projLi);
  }
}

// 单条任务条目(grouped 模式作 .sb-proj-tasks 子项;flat 模式作 #conv-list 顶层 li)。
// flat 模式下额外渲染一行 cwd basename(因为没了项目头),CSS 控制只在 flat 显示。
function taskLi(id: string): HTMLElement {
  const c = convs.get(id)!;
  const li = document.createElement('li');
  if (id === selectedId) li.classList.add('active');
  const last = c.turns[c.turns.length - 1];
  const title = c.customTitle || (c.turns[0]?.prompt.slice(0, 40)) || tr('head.newConv');
  const cls = c.status === 'running' ? 'running' : last?.error ? 'error' : 'ready';
  li.innerHTML = `<span class="dot ${cls}"></span><span class="title-wrap"><span class="title">${esc(title)}</span><span class="sb-task-cwd">${esc(projName(c.cwd))}</span></span><span class="conv-actions"><button class="ca-btn" data-act="rename" title="${esc(tr('conv.rename'))}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4z"/></svg></button><button class="ca-btn" data-act="delete" title="${esc(tr('conv.delete'))}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M10 11v6M14 11v6"/></svg></button></span>`;
  li.onclick = () => {
    selectedId = id;
    showChat();
    renderSidebar();
  };
  li.querySelectorAll<HTMLElement>('.ca-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (btn.dataset.act === 'rename') void renameConv(id);
      else if (btn.dataset.act === 'delete') void deleteConv(id);
    };
  });
  return li;
}

// 项目名 = cwd basename;无 cwd 或 cwd === homedir(默认新建会话的兜底)走「未分类」。
function projName(cwd: string): string {
  if (!cwd || cwd === HOME_DIR) return tr('wb.ungrouped');
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return base || cwd;
}

// Electron renderer 不支持 window.prompt(),用自定义输入 modal 替代。
// 全局 Escape / backdrop 关闭时通过 activePromptDone 触发同一个 resolver。
let activePromptDone: ((v: string | null) => void) | null = null;
function showPrompt(title: string, def: string): Promise<string | null> {
  const modal = document.getElementById('prompt-modal')!;
  document.getElementById('prompt-title')!.textContent = title;
  const input = document.getElementById('prompt-input') as HTMLInputElement;
  input.value = def;
  modal.classList.add('show');
  input.focus();
  input.select();
  return new Promise((resolve) => {
    const ok = document.getElementById('prompt-ok')!;
    const cancel = document.getElementById('prompt-cancel')!;
    // 如果有上一个未完成的 prompt,先 resolve null(避免 Promise 永挂)
    if (activePromptDone) activePromptDone(null);
    const done = (v: string | null) => {
      ok.onclick = null;
      cancel.onclick = null;
      input.onkeydown = null;
      activePromptDone = null;
      modal.classList.remove('show');
      resolve(v);
    };
    activePromptDone = done;
    ok.onclick = () => done(input.value);
    cancel.onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value);
      else if (e.key === 'Escape') done(null);
    };
  });
}
function dismissPrompt(): void { activePromptDone?.(null); }

// 侧栏会话改名 / 删除(✎/🗑 按钮)。
async function renameConv(id: string) {
  const c = convs.get(id);
  if (!c) return;
  const cur = c.customTitle || c.turns[0]?.prompt.slice(0, 40) || '';
  const name = await showPrompt(tr('prompt.nameTitle'), cur);
  if (name != null) await api.rename(id, name);
}
async function deleteConv(id: string) {
  const c = convs.get(id);
  if (!c) return;
  const name = c.customTitle || c.turns[0]?.prompt.slice(0, 40) || tr('prompt.deleteFallback');
  if (confirm(tr('prompt.deleteConfirm', { name }))) await api.deleteConversation(id);
}

// ---------- main pane ----------
// 聊天 tab 切换(对话 / 文件 / Git / 规则)。文件 tab 首次点才挂 mountFilesPane;切会话后切回任一 tab 都同步 cwd。
function showTab(tab: 'chat' | 'files' | 'git' | 'rules'): void {
  if (activeTab === tab) return;
  activeTab = tab;
  document.getElementById('tab-chat')!.classList.toggle('active', tab === 'chat');
  document.getElementById('tab-files')!.classList.toggle('active', tab === 'files');
  document.getElementById('tab-git')!.classList.toggle('active', tab === 'git');
  document.getElementById('tab-rules')!.classList.toggle('active', tab === 'rules');
  document.getElementById('chat-content')!.hidden = tab !== 'chat';
  document.getElementById('chat-files-pane')!.hidden = tab !== 'files';
  document.getElementById('chat-git-pane')!.hidden = tab !== 'git';
  document.getElementById('chat-rules-pane')!.hidden = tab !== 'rules';
  if (tab === 'files') {
    if (!filesController) {
      const pane = document.getElementById('chat-files-pane')!;
      // files-pane.ts 的 querySelector 都基于 root(pane),不会越界。
      // ponytail: 用当前 lang 挂载;切语言后需要重挂(简化:暂不处理,首次挂载语言固定)。
      filesController = mountFilesPane(pane, lang);
    }
    const cwd = selectedId ? convs.get(selectedId)?.cwd ?? '' : '';
    filesController.setCwd(cwd);
  }
  if (tab === 'git') {
    const cwd = selectedId ? convs.get(selectedId)?.cwd ?? '' : '';
    if (cwd && cwd !== gitState.lastCwd) void refreshGit(cwd);
    else renderGit();
  }
  if (tab === 'rules') {
    const cwd = selectedId ? convs.get(selectedId)?.cwd ?? '' : '';
    if (cwd && cwd !== rulesCwd) void loadRules(cwd);
  }
}

// 加载当前 cwd 的 KINET.md 到 CodeEditor。空文件 → 空白编辑器(保存就创建文件)。
function ensureRulesEditor(): CodeEditor {
  if (!rulesEditor) {
    const host = document.getElementById('rules-editor-host')!;
    rulesEditor = new CodeEditor(host, { lang: 'markdown', autoHeight: false });
  }
  return rulesEditor;
}

async function loadRules(cwd: string): Promise<void> {
  rulesCwd = cwd;
  const ed = ensureRulesEditor();
  const status = document.getElementById('rules-status')!;
  status.textContent = '';
  if (!cwd) {
    ed.value = '';
    return;
  }
  ed.value = '…';
  const r = await api.readRules(cwd);
  ed.value = r.ok ? r.content ?? '' : '';
  if (!r.ok) status.textContent = r.error ?? '';
}

async function saveRules(): Promise<void> {
  if (!rulesCwd || !rulesEditor) return;
  const status = document.getElementById('rules-status')!;
  status.textContent = '…';
  const r = await api.writeRules(rulesCwd, rulesEditor.value);
  status.textContent = r.ok ? tr('rules.saved') : tr('rules.saveErr', { msg: r.error ?? '' });
}

// Git tab:抓 snapshot + 渲染。cwd 切换 / 手动刷新时调;切回 history 视图。
async function refreshGit(cwd: string): Promise<void> {
  gitState.lastCwd = cwd;
  gitState.view = { kind: 'history' };
  gitState.snapshot = undefined;
  renderGit();
  const r = await api.gitSnapshot(cwd);
  gitState.snapshot = r;
  renderGit();
}

// 单字符状态码 → i18n 标签 key 后缀(M/A/D/R → 自身,其它 ??/! → U)。
function gitCodeSuffix(code: string): string {
  return ['M', 'A', 'D', 'R'].includes(code) ? code : 'U';
}

// ── word-level diff:对一对修改行(旧/新)做字符级 LCS,标记变化部分 ──
// 返回 [leftHtml, rightHtml],变化部分用 <mark> 包裹。
function wordDiff(oldText: string, newText: string): [string, string] {
  if (!oldText || !newText) return [esc(oldText), esc(newText)];
  // 简单字符级 LCS(短行够用,长行走 token 粗粒度)
  const a = [...oldText], b = [...newText];
  const n = a.length, m = b.length;
  // 超长行降级:直接返回不做 word-diff(避免 O(n*m) 爆炸)
  if (n * m > 50000) return [esc(oldText), esc(newText)];
  // LCS DP
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // 回溯:收集相等/不等段
  let leftHtml = '', rightHtml = '';
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      leftHtml += esc(a[i]); rightHtml += esc(b[j]);
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      leftHtml += `<mark>${esc(a[i])}</mark>`;
      i++;
    } else {
      rightHtml += `<mark>${esc(b[j])}</mark>`;
      j++;
    }
  }
  while (i < n) { leftHtml += `<mark>${esc(a[i])}</mark>`; i++; }
  while (j < m) { rightHtml += `<mark>${esc(b[j])}</mark>`; j++; }
  return [leftHtml, rightHtml];
}

function renderGit(): void {
  const branchEl = document.getElementById('git-branch')!;
  const changesEl = document.getElementById('git-changes-list')!;
  const sideTitleEl = document.getElementById('git-side-title')!;
  const sideListEl = document.getElementById('git-side-list')!;
  const snap = gitState.snapshot;
  if (!snap) {
    branchEl.textContent = '…';
    changesEl.innerHTML = '';
    sideTitleEl.textContent = tr('git.history');
    sideListEl.innerHTML = '';
    return;
  }
  if (!snap.ok) {
    branchEl.textContent = snap.error ?? '';
    changesEl.innerHTML = '';
    sideListEl.innerHTML = '';
    return;
  }
  const staged = snap.changes?.filter((c) => c.staged) ?? [];
  const unstaged = snap.changes?.filter((c) => !c.staged) ?? [];
  branchEl.innerHTML = `${ICON.branch2} <strong>${esc(snap.branch ?? '')}</strong> · ${snap.changes?.length ?? 0} ${tr('git.changes')}`;
  // changes — 分 staged / unstaged 两组
  const renderGroup = (label: string, items: typeof snap.changes) => {
    if (!items?.length) return '';
    const rows = items.map((c) => {
      const suf = gitCodeSuffix(c.code);
      return `<div class="gc-row" data-path="${esc(c.path)}" data-staged="${c.staged ? '1' : '0'}"><span class="gc-code ${esc(suf)}">${esc(c.code)}</span><span class="gc-label">${esc(tr('git.stat' + suf))}</span><span class="gc-path">${esc(c.path)}</span></div>`;
    }).join('');
    return `<div class="gc-group-label">${esc(label)} <span class="gc-group-count">${items.length}</span></div>${rows}`;
  };
  if (!snap.changes?.length) {
    changesEl.innerHTML = `<div class="git-empty">${esc(tr('git.empty'))}</div>`;
  } else {
    changesEl.innerHTML =
      `<button class="gc-all-diff" id="gc-all-diff">${tr('git.allDiff')} (${snap.changes.length})</button>` +
      renderGroup(tr('git.staged'), staged) +
      renderGroup(tr('git.unstaged'), unstaged);
    changesEl.querySelectorAll<HTMLElement>('.gc-row').forEach((row) => {
      row.onclick = () => void showGitDiff({ file: row.dataset.path!, staged: row.dataset.staged === '1' });
    });
    const allBtn = document.getElementById('gc-all-diff');
    if (allBtn) allBtn.onclick = () => void showGitDiff({});
  }
  // side:history 或 diff
  if (gitState.view.kind === 'history') {
    sideTitleEl.textContent = tr('git.history');
    if (!snap.log?.length) {
      sideListEl.innerHTML = `<div class="git-empty">${esc(tr('git.empty'))}</div>`;
    } else {
      sideListEl.innerHTML = snap.log
        .map(
          (c) =>
            `<div class="gl-row" data-hash="${esc(c.hash)}"><span class="gl-hash">${esc(c.hash)}</span><span class="gl-date">${esc(c.date)}</span><span class="gl-subject">${esc(c.subject)}</span><span class="gl-author">${esc(c.author)}</span></div>`,
        )
        .join('');
      sideListEl.querySelectorAll<HTMLElement>('.gl-row').forEach((row) => {
        row.onclick = () => void showGitDiff({ hash: row.dataset.hash! });
      });
    }
  } else {
    sideTitleEl.innerHTML = `<button class="ghost git-back" id="git-back"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M15 18l-6-6 6-6"/></svg> ${esc(tr('git.history'))}</button><span class="git-diff-title">${esc(gitState.view.title)}</span>`;
    sideListEl.innerHTML = gitState.view.contentHTML;
    document.getElementById('git-back')!.onclick = () => {
      gitState.view = { kind: 'history' };
      renderGit();
    };
  }
}

async function showGitDiff(opts: { file?: string; hash?: string; staged?: boolean }): Promise<void> {
  const cwd = selectedId ? convs.get(selectedId)?.cwd ?? '' : '';
  if (!cwd) return;
  const title = opts.hash
    ? `${tr('git.history')}: ${opts.hash}`
    : opts.file
      ? `${tr('git.diff')}: ${opts.file}${opts.staged ? ` (${tr('git.staged')})` : ''}`
      : tr('git.allDiff');
  // 先占位再异步加载,体感更快。
  gitState.view = { kind: 'diff', title, contentHTML: '<pre class="git-diff"><span class="d-hunk">…</span></pre>' };
  renderGit();
  const r = await api.gitDiff(cwd, opts);
  // 单文件 → 左右对比;commit show / 全量 → 按文件分段的统一格式
  const html = !r.ok
    ? `<pre class="git-diff"><span class="d-del">${esc(r.error ?? '')}</span></pre>`
    : opts.file
      ? renderSideBySide(r.diff || '')
      : colorGitDiff(r.diff || '');
  gitState.view = { kind: 'diff', title, contentHTML: html };
  renderGit();
}

// Diff 按行着色(统一格式,commit show / 全量 diff 用)。
// 按文件分段:每个 "diff --git" 块提取文件名做标题栏 + stat(+xx -yy)。
function colorGitDiff(s: string): string {
  if (!s) return '<pre class="git-diff"><span class="d-hunk">(empty)</span></pre>';
  const lines = s.split('\n');
  // commit show:metadata(message)在 diff --git 之前
  const diffStart = lines.findIndex((l) => l.startsWith('diff --git'));
  const meta = diffStart >= 0 ? lines.slice(0, diffStart) : [];
  const body = diffStart >= 0 ? lines.slice(diffStart) : lines;
  const metaHtml = meta.length
    ? `<div class="d-commit-meta">${meta.map((l) => `<span>${esc(l) || '&nbsp;'}</span>`).join('')}</div>`
    : '';
  // 按文件分段
  const segments: { header: string; stat: string; lines: string[] }[] = [];
  let cur: { header: string; stat: string; lines: string[] } | null = null;
  let addCount = 0, delCount = 0;
  for (const line of body) {
    if (line.startsWith('diff --git')) {
      if (cur) { cur.stat = `+${addCount} -${delCount}`; segments.push(cur); }
      // 提取文件名:diff --git a/foo.ts b/foo.ts
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const fname = m ? m[2] : line;
      cur = { header: fname, stat: '', lines: [] };
      addCount = 0; delCount = 0;
    } else if (cur) {
      cur.lines.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) addCount++;
      if (line.startsWith('-') && !line.startsWith('---')) delCount++;
    }
  }
  if (cur) { cur.stat = `+${addCount} -${delCount}`; segments.push(cur); }
  if (!segments.length) {
    // 没有文件分段(纯 diff),整体着色
    const html = body.map((line) => {
      const e = esc(line);
      if (line.startsWith('+++') || line.startsWith('---')) return `<span class="d-hunk">${e}</span>`;
      if (line.startsWith('+')) return `<span class="d-add">${e}</span>`;
      if (line.startsWith('-')) return `<span class="d-del">${e}</span>`;
      if (line.startsWith('@@')) return `<span class="d-hunk">${e}</span>`;
      return e;
    }).join('\n');
    return `${metaHtml}<pre class="git-diff">${html}</pre>`;
  }
  // 每个文件段:文件名标题栏 + stat + diff body
  const segHtml = segments.map((seg) => {
    const bodyHtml = seg.lines
      .filter((l) => !l.startsWith('diff --git') && !l.startsWith('index '))
      .map((line) => {
        const e = esc(line);
        if (line.startsWith('+++') || line.startsWith('---')) return `<span class="d-hunk">${e}</span>`;
        if (line.startsWith('+')) return `<span class="d-add">${e}</span>`;
        if (line.startsWith('-')) return `<span class="d-del">${e}</span>`;
        if (line.startsWith('@@')) return `<span class="d-hunk">${e}</span>`;
        return e;
      })
      .join('\n');
    const addN = seg.stat.match(/\+(\d+)/)?.[1] ?? '0';
    const delN = seg.stat.match(/-(\d+)/)?.[1] ?? '0';
    return `<div class="d-file-header"><span class="d-file-name">${esc(seg.header)}</span><span class="d-file-stat"><span class="d-add-count">+${addN}</span> <span class="d-del-count">-${delN}</span></span></div><pre class="git-diff">${bodyHtml}</pre>`;
  }).join('');
  return `${metaHtml}${segHtml}`;
}

// 文件 diff 的左右对比:把 unified diff 解析成对齐的「左旧 / 右新」行。
// 修改行做 word-level diff(字符级 LCS),变化部分用 <mark> 高亮。
type SSRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'ctx'; ln: number; rn: number; text: string }
  | { kind: 'pair'; ln: number | null; lt: string; rn: number | null; rt: string; cls: string };
function renderSideBySide(diff: string): string {
  if (!diff || !diff.includes('@@')) return '<div class="git-empty">(无差异)</div>';
  const rows: SSRow[] = [];
  let ln = 0;
  let rn = 0;
  let delRun: string[] = [];
  let addRun: string[] = [];
  const flushRuns = () => {
    const len = Math.max(delRun.length, addRun.length);
    for (let i = 0; i < len; i++) {
      const lTxt = i < delRun.length ? delRun[i] : '';
      const rTxt = i < addRun.length ? addRun[i] : '';
      const cls = lTxt && rTxt ? 'ss-mod' : lTxt ? 'ss-del' : 'ss-add';
      rows.push({ kind: 'pair', ln: lTxt ? ln++ : null, lt: lTxt, rn: rTxt ? rn++ : null, rt: rTxt, cls });
    }
    delRun = [];
    addRun = [];
  };
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      flushRuns();
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        ln = parseInt(m[1], 10);
        rn = parseInt(m[2], 10);
      }
      rows.push({ kind: 'hunk', text: line });
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // skip "diff --git" / "index" / "---" / "+++" 文件头
    if (line.startsWith('-')) delRun.push(line.slice(1));
    else if (line.startsWith('+')) addRun.push(line.slice(1));
    else {
      flushRuns();
      const txt = line.startsWith(' ') ? line.slice(1) : '';
      rows.push({ kind: 'ctx', ln: ln++, rn: rn++, text: txt });
    }
  }
  flushRuns();
  const body = rows
    .map((r) => {
      if (r.kind === 'hunk') return `<tr class="ss-hunk"><td colspan="4">${esc(r.text)}</td></tr>`;
      if (r.kind === 'ctx')
        return `<tr><td class="ss-num">${r.ln}</td><td class="ss-txt">${esc(r.text) || '&nbsp;'}</td><td class="ss-num">${r.rn}</td><td class="ss-txt">${esc(r.text) || '&nbsp;'}</td></tr>`;
      // 修改行:做 word-level diff
      const [lh, rh] = r.cls === 'ss-mod' ? wordDiff(r.lt, r.rt) : [esc(r.lt), esc(r.rt)];
      return `<tr class="${r.cls}"><td class="ss-num">${r.ln ?? ''}</td><td class="ss-txt">${lh || '&nbsp;'}</td><td class="ss-num">${r.rn ?? ''}</td><td class="ss-txt">${rh || '&nbsp;'}</td></tr>`;
    })
    .join('');
  return `<div class="git-ss-wrap"><table class="git-ss"><thead><tr><th class="ss-num"></th><th>${esc(tr('git.before'))}</th><th class="ss-num"></th><th>${esc(tr('git.after'))}</th></tr></thead><tbody>${body}</tbody></table></div>`;
}


function renderMain() {
  const conv = selectedId ? convs.get(selectedId) : undefined;
  renderHead(conv);
  const turns = document.getElementById('turns')!;
  turns.innerHTML = '';
  if (!conv) {
    turns.appendChild(empty(tr('empty.noConv')));
    return;
  }
  if (!conv.turns.length) {
    turns.appendChild(empty(tr('empty.noTurns')));
  }
  for (let i = 0; i < conv.turns.length; i++) {
    turns.appendChild(renderTurn(conv, i));
  }
  scrollDown();
  // 切会话后,文件 tab 若已挂,跟着换 cwd(切到当前会话的 cwd)。
  if (activeTab === 'files' && filesController) filesController.setCwd(conv.cwd);
  // git tab:cwd 变了就重抓 snapshot(切会话是最常见的触发)。
  if (activeTab === 'git' && conv.cwd !== gitState.lastCwd) void refreshGit(conv.cwd);
  // rules tab:cwd 变了就重载 KINET.md。
  if (activeTab === 'rules' && conv.cwd !== rulesCwd) void loadRules(conv.cwd);
}

function renderHead(conv: Conversation | undefined) {
  const dot = document.getElementById('head-dot')!;
  const title = document.getElementById('head-title')!;
  const cwd = document.getElementById('cwd-input') as HTMLInputElement;
  const model = document.getElementById('model-input') as HTMLInputElement;
  const eng = document.getElementById('engine-select') as HTMLSelectElement;
  const stat = document.getElementById('head-stat')!;
  const status = document.getElementById('head-status')!;
  const sendBtn = document.getElementById('btn-send')!;
  if (!conv) {
    dot.className = 'dot ready';
    title.textContent = PRODUCT;
    cwd.value = '';
    model.value = '';
    model.style.display = 'none';
    eng.value = 'direct';
    stat.textContent = '';
    status.textContent = '';
    sendBtn.textContent = tr('common.send');
    sendBtn.classList.remove('stop');
    return;
  }
  const last = conv.turns[conv.turns.length - 1];
  const cls = conv.status === 'running' ? 'running' : last?.error ? 'error' : 'ready';
  dot.className = `dot ${cls}`;
  title.textContent = conv.customTitle || conv.turns[0]?.prompt.slice(0, 60) || tr('head.newConv');
  if (document.activeElement !== cwd) cwd.value = conv.cwd;
  // Model picker only matters for Direct (claudeCode/codex use their own CLI models) → hide otherwise.
  model.style.display = conv.engine === 'direct' ? '' : 'none';
  if (document.activeElement !== model) model.value = conv.model;
  syncEngineSelect(conv);
  const parts: string[] = [];
  if (conv.tokens) parts.push(`${(conv.tokens / 1000).toFixed(1)}k tok`);
  if (conv.cost) parts.push(`$${conv.cost.toFixed(4)}`);
  stat.textContent = parts.join(' · ');
  status.textContent = conv.status === 'running' && conv.statusNote ? conv.statusNote : '';
  sendBtn.textContent = conv.status === 'running' ? tr('common.stop') : tr('common.send');
  sendBtn.classList.toggle('stop', conv.status === 'running');
}

// Rebuild the engine dropdown from the toggle. Direct is always present; Claude/Codex only when
// enabled. If the active conversation is already on a CLI engine while disabled, keep showing it
// (read-only-ish) so the value isn't blanked — switching away is still allowed, back is not.
function syncEngineSelect(conv: Conversation | undefined) {
  const sel = document.getElementById('engine-select') as HTMLSelectElement;
  const current = conv?.engine ?? 'direct';
  const want: EngineKind[] = cliEnabled ? ['direct', 'claudeCode', 'codex'] : ['direct'];
  if (!want.includes(current)) want.push(current);
  const have = [...sel.options].map((o) => o.value);
  const same = have.length === want.length && have.every((v, i) => v === want[i]);
  if (!same) {
    sel.innerHTML = want.map((e) => `<option value="${e}">${esc(ENGINE_LABELS[e])}</option>`).join('');
  }
  if (document.activeElement !== sel) sel.value = current;
}

function renderTurn(conv: Conversation, i: number): HTMLElement {
  const t = conv.turns[i];
  const isLast = i === conv.turns.length - 1;
  const streaming = isLast && conv.status === 'running' && !t.done;
  const wrap = document.createElement('div');
  wrap.className = 'turn';

  // 用户消息:头像在右、气泡在左(行内靠右)
  const userMsg = document.createElement('div');
  userMsg.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = t.prompt;
  // 用户气泡悬浮复制按钮
  const uCopy = document.createElement('button');
  uCopy.className = 'ghost bubble-copy';
  uCopy.title = tr('copy.text');
  uCopy.innerHTML = ICON.copy;
  uCopy.onclick = (e) => { e.stopPropagation(); copyText(t.prompt, uCopy); };
  bubble.appendChild(uCopy);
  userMsg.appendChild(bubble);
  userMsg.appendChild(avatarEl('user'));
  wrap.appendChild(userMsg);

  // AI 回复:头像在左、正文在右(无内容且非流式时不渲染)
  if (t.steps.length || t.answer || streaming || t.error) {
    const aiMsg = document.createElement('div');
    aiMsg.className = 'msg ai';
    const body = document.createElement('div');
    body.className = 'ai-body';
    if (t.steps.length) {
      const steps = document.createElement('div');
      steps.className = 'steps';
      for (const s of t.steps) steps.appendChild(renderStep(s));
      body.appendChild(steps);
    }
    const ans = document.createElement('div');
    ans.className = 'answer';
    if (streaming) {
      ans.id = 'streaming-answer';
      ans.classList.add('streaming');
      // streaming 区只放 answer 文本(streamAppend 直接 appendChild text node,不能混入别的元素)。
      if (t.answer) ans.textContent = t.answer;
      else if (!conv.statusNote) ans.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    } else if (t.answer) {
      ans.innerHTML = md(t.answer);
    }
    body.appendChild(ans);
    // 工具执行中:在 answer 下面单独显示「●●● 执行 X…」(statusNote)。作为兄弟元素,
    // 不污染 #streaming-answer 的文本追加路径。token 来时 applyEvent 清 statusNote,本块自动消失。
    if (streaming && conv.statusNote) {
      const ns = document.createElement('div');
      ns.className = 'streaming-status';
      ns.innerHTML = '<span class="typing"><i></i><i></i><i></i></span><span class="typing-text">' + esc(conv.statusNote) + '</span>';
      body.appendChild(ns);
    }
    if (t.error) {
      const e = document.createElement('div');
      e.className = 'err';
      e.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>' + esc(t.error);
      body.appendChild(e);
    }
    aiMsg.appendChild(avatarEl('ai'));
    aiMsg.appendChild(body);
    // 非流式时给 AI 回复挂一个 🔊 朗读按钮(speechSynthesis 系统级 TTS,零依赖)。
    if (!streaming && t.answer) {
      const bar = document.createElement('div');
      bar.className = 'ai-actions';
      const speak = document.createElement('button');
      speak.className = 'ghost ai-speak';
      speak.title = tr('voice.speak');
      speak.innerHTML = ICON.speak;
      speak.onclick = () => speakText(t.answer ?? '');
      bar.appendChild(speak);
      // 复制按钮:复制 AI 回复纯文本
      const copy = document.createElement('button');
      copy.className = 'ghost ai-copy';
      copy.title = tr('copy.text');
      copy.innerHTML = ICON.copy;
      copy.onclick = () => copyText(t.answer ?? '', copy);
      bar.appendChild(copy);
      // 分支按钮:从此 turn 分叉出新会话(类似 git branch)
      const branch = document.createElement('button');
      branch.className = 'ghost ai-branch';
      branch.title = tr('branch.from');
      branch.innerHTML = ICON.branch;
      branch.onclick = () => void branchFromTurn(conv.id, i);
      bar.appendChild(branch);
      // 回放按钮:逐步回放工具调用
      if (t.steps.length > 0) {
        const replay = document.createElement('button');
        replay.className = 'ghost ai-replay';
        replay.title = tr('replay.title');
        replay.innerHTML = ICON.replay;
        replay.onclick = () => openReplay(i);
        bar.appendChild(replay);
      }
      // 导出按钮:导出整个会话
      const exportBtn = document.createElement('button');
      exportBtn.className = 'ghost ai-export';
      exportBtn.title = tr('export.title');
      exportBtn.innerHTML = ICON.export;
      exportBtn.onclick = () => openExportMenu(conv.id);
      bar.appendChild(exportBtn);
      body.appendChild(bar);
    }
    wrap.appendChild(aiMsg);
  }
  return wrap;
}

function avatarEl(kind: 'user' | 'ai'): HTMLElement {
  const a = document.createElement('div');
  a.className = 'avatar';
  if (kind === 'user') {
    a.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/></svg>';
  } else {
    a.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
  }
  return a;
}

function renderStep(s: { name: string; args: string; result: string }): HTMLElement {
  const el = document.createElement('div');
  el.className = 'step';
  const det = document.createElement('details');
  det.innerHTML = `<summary><span class="name">${ICON.wrench} ${esc(s.name)}</span></summary><pre></pre><pre></pre>`;
  const pres = det.querySelectorAll('pre');
  pres[0].textContent = s.args;
  pres[1].textContent = s.result.slice(0, 4000);
  el.appendChild(det);
  return el;
}

// 流式 token:增量追加(不全量重设 textContent,避免长答案 O(n²) 重渲)。
function streamAppend(text: string) {
  let el = document.getElementById('streaming-answer');
  if (!el) {
    renderMain();
    el = document.getElementById('streaming-answer');
  }
  if (el) {
    if (el.querySelector('.typing')) el.textContent = ''; // 首个 token:清掉思考三点
    el.appendChild(document.createTextNode(text));
    scrollDown();
  }
}

function empty(text: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = text;
  return d;
}

function scrollDown() {
  const turns = document.getElementById('turns');
  if (turns) turns.scrollTop = turns.scrollHeight;
}

// ---------- settings ----------
// 主题切换:改 <html data-theme>,变量级切换,所有窗口共享(主/dashboard/files/quick 都用 styles.css)。
function applyTheme(theme: 'dark' | 'light' | 'aurora' | 'serene'): void {
  document.documentElement.dataset.theme = theme;
}

async function showSettings() {
  currentView = 'settings';
  hideAllViews();
  document.getElementById('settings-view')!.classList.add('active');
  syncViewButtons();
  const s = await api.getSettings();
  budgetCache = s.budget ?? { enabled: false, perSessionLimit: 0, dailyLimit: 0 };
  localMcpServerCache = s.localMcpServer ?? { enabled: false, port: 18109, token: '' };
  remoteMcpServersCache = s.remoteMcpServers ?? [];
  const root = document.getElementById('settings')!;
  root.innerHTML = `
    <div class="card">
      <button id="s-back" class="ghost" style="margin-bottom:14px">${tr('settings.back')}</button>
      <h2>${tr('settings.title')}</h2>
      <div class="sub">${tr('settings.sub')}</div>

      <div class="s-tabs">
        <button class="s-tab active" data-stab="model">模型</button>
        <button class="s-tab" data-stab="behavior">行为</button>
        <button class="s-tab" data-stab="advanced">高级</button>
        <button class="s-tab" data-stab="mesh">多机协作</button>
      </div>

      <div class="s-tab-panel" data-panel="model">
      <div class="s-section">
        <h3>${tr('settings.sec.api')}</h3>
        <div class="field"><label>${tr('settings.preset')}</label><select id="s-preset">
          ${PRESETS.map((p) => `<option value="${p.id}" ${p.id === s.presetId ? 'selected' : ''}>${tr(p.labelKey)}</option>`).join('')}
        </select></div>
        <div class="field"><label>API Key</label><input id="s-key" type="password" value="${esc(s.apiKey)}" /></div>
        <div class="field"><label>Base URL</label><input id="s-base" value="${esc(s.baseURL)}" /></div>
        <div class="field"><label>${tr('settings.modelId')}</label><input id="s-model" value="${esc(s.model)}" /></div>
        <div class="field"><label>${tr('settings.protocol')}</label><select id="s-proto">
          <option value="openai" ${s.apiProtocol === 'openai' ? 'selected' : ''}>${tr('settings.proto.openai')}</option>
          <option value="anthropic" ${s.apiProtocol === 'anthropic' ? 'selected' : ''}>Anthropic</option>
        </select></div>
        <div class="field"><label>Reasoning effort</label><select id="s-reason">${REASONS.map(
          (r) => `<option value="${r}" ${r === s.reasoning ? 'selected' : ''}>${r}</option>`,
        ).join('')}</select></div>
      </div>

      <div class="s-section">
        <h3>${tr('settings.sec.behavior')}</h3>
        <div class="field"><label>${tr('settings.approval')}</label><select id="s-approval">
          <option value="always" ${s.approval === 'always' ? 'selected' : ''}>${tr('settings.approval.always')}</option>
          <option value="never" ${s.approval === 'never' ? 'selected' : ''}>${tr('settings.approval.never')}</option>
        </select></div>
        <div class="field"><label>${tr('settings.sandbox')}</label><select id="s-sandbox">
          <option value="readOnly" ${s.sandbox === 'readOnly' ? 'selected' : ''}>${tr('settings.sandbox.readOnly')}</option>
          <option value="workspaceWrite" ${s.sandbox === 'workspaceWrite' ? 'selected' : ''}>${tr('settings.sandbox.workspaceWrite')}</option>
          <option value="fullAccess" ${s.sandbox === 'fullAccess' ? 'selected' : ''}>${tr('settings.sandbox.fullAccess')}</option>
        </select></div>
        <div class="field"><label><input type="checkbox" id="s-plan" ${s.planMode ? 'checked' : ''} style="width:auto;margin-right:6px" />${tr('settings.plan')}</label></div>
        <div class="field"><label><input type="checkbox" id="s-cli" ${s.enableCliEngines ? 'checked' : ''} style="width:auto;margin-right:6px" />${tr('settings.cli')}</label></div>
      </div>

      <div class="s-section">
        <h3>${tr('settings.sec.price')}</h3>
        <div class="field"><label>${tr('settings.price')}</label>
          <div class="row"><input id="s-pin" type="number" step="0.01" value="${s.priceInPerMTok}" /><input id="s-pout" type="number" step="0.01" value="${s.priceOutPerMTok}" /></div>
        </div>
      </div>

      <div class="s-section">
        <h3>${tr('settings.sec.embed')}</h3>
        <div class="field-desc" style="color:var(--muted);font-size:12px;margin-bottom:8px">${tr('settings.embed.desc')}</div>
        <div class="field"><label>${tr('settings.embed.model')}</label><input id="s-embed-model" value="${esc(s.embedModel || 'embedding-3')}" /></div>
        <div class="field"><label>${tr('settings.embed.baseURL')}</label><input id="s-embed-base" value="${esc(s.embedBaseURL || '')}" placeholder="${esc(tr('settings.embed.baseURLPh'))}" /></div>
        <div class="field"><label>${tr('settings.embed.apiKey')}</label><input id="s-embed-key" type="password" value="${esc(s.embedApiKey || '')}" placeholder="${esc(tr('settings.embed.apiKeyPh'))}" /></div>
      </div>
      </div><!-- /model panel -->

      <div class="s-tab-panel" data-panel="behavior" style="display:none">
      <div class="s-section">
        <h3>${tr('settings.sec.ui')}</h3>
        <div class="field"><label>${tr('settings.lang')}</label><select id="s-lang">
          ${LANGS.map((l) => `<option value="${l.id}" ${l.id === s.lang ? 'selected' : ''}>${l.label}</option>`).join('')}
        </select></div>
        <div class="field"><label>${tr('settings.theme')}</label><select id="s-theme">
          <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>${tr('settings.theme.dark')}</option>
          <option value="light" ${s.theme === 'light' ? 'selected' : ''}>${tr('settings.theme.light')}</option>
          <option value="aurora" ${s.theme === 'aurora' ? 'selected' : ''}>${tr('settings.theme.aurora')}</option>
          <option value="serene" ${s.theme === 'serene' ? 'selected' : ''}>${tr('settings.theme.serene')}</option>
        </select></div>
      </div>
      <div class="s-section">
        <h3>${tr('settings.sec.agent')}</h3>
        <div class="field"><label>${tr('settings.maxTurns')}</label><input id="s-maxturns" type="number" min="0" max="500" value="${s.maxTurns ?? 50}" style="width:80px" /></div>
        <div class="field-desc" style="color:var(--muted);font-size:11px;margin:-4px 0 0 0">${tr('settings.maxTurns.desc')}</div>
      </div>
      </div><!-- /behavior panel -->

      <div class="s-tab-panel" data-panel="advanced" style="display:none">
      <div class="s-section">
        <h3>${tr('settings.sec.memory')}</h3>
        <div class="field" style="flex-direction:column;align-items:flex-start;gap:8px">
          <span class="field-desc" style="color:var(--muted);font-size:12px">${tr('settings.mem.desc')}</span>
          <div style="display:flex;gap:8px">
            <button id="s-mem-exp">${tr('settings.mem.export')}</button>
            <button id="s-mem-imp">${tr('settings.mem.import')}</button>
            <span class="test-msg" id="s-mem-msg"></span>
          </div>
        </div>
      </div>

      <div class="s-section">
        <h3>${tr('settings.sec.plugins')}</h3>
        <div class="field" style="flex-direction:column;align-items:flex-start;gap:8px">
          <span class="field-desc" style="color:var(--muted);font-size:12px">${tr('settings.plugins.desc')}</span>
          <div id="s-plugins" class="s-plugin-list"></div>
          <div style="display:flex;gap:8px;align-items:center">
            <button id="s-plugins-reload">${tr('settings.plugins.reload')}</button>
            <span class="test-msg" id="s-plugins-msg"></span>
          </div>
        </div>
      </div>
      </div><!-- /advanced panel -->

      <div class="s-tab-panel" data-panel="mesh" style="display:none">
      <div class="s-section">
        <h3>${ICON.link} 多机协作 (MCP Bridge)</h3>
        <div class="field-desc" style="color:var(--muted);font-size:12px;margin-bottom:12px">把本机工具暴露给局域网内其它 KinetAios 节点,或连接远程节点作为工具使用。</div>

        <!-- 本机 MCP Server -->
        <div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">
          <label class="switch-label" style="margin-bottom:8px">
            <span class="switch"><input type="checkbox" id="s-mcp-enabled" ${s.localMcpServer?.enabled ? 'checked' : ''} /><span class="track"><span class="thumb"></span></span></span>
            <span style="font-weight:600">本机 MCP Server</span>
          </label>
          <div style="color:var(--muted);font-size:11px;margin:-4px 0 10px 46px">开启后允许其它机器通过 HTTP 调用你的工具(shell / 文件 / 网页等)</div>

          <div style="display:grid;grid-template-columns:auto 1fr auto;gap:8px 10px;align-items:center;margin-left:46px">
            <label style="font-size:12px;color:var(--muted)">端口</label>
            <input id="s-mcp-port" type="number" value="${s.localMcpServer?.port ?? 18109}" style="width:100px" />
            <button id="s-mcp-gentoken" title="生成随机 Token" style="padding:4px 10px;font-size:12px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.2"/><circle cx="16" cy="8" r="1.2"/><circle cx="8" cy="16" r="1.2"/><circle cx="16" cy="16" r="1.2"/><circle cx="12" cy="12" r="1.2"/></svg></button>

            <label style="font-size:12px;color:var(--muted)">Token</label>
            <input id="s-mcp-token" type="password" value="${esc(s.localMcpServer?.token ?? '')}" placeholder="留空=不鉴权" style="grid-column:2/4" />
          </div>

          <div style="display:flex;gap:8px;align-items:center;margin:10px 0 0 46px">
            <button id="s-mcp-start" class="primary" style="padding:4px 14px;font-size:12px">立即启动</button>
            <button id="s-mcp-stop" style="padding:4px 14px;font-size:12px">停止</button>
            <span class="test-msg" id="s-mcp-msg"></span>
          </div>
        </div>

        <!-- 远程节点 -->
        <div style="border:1px solid var(--border);border-radius:8px;padding:12px">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px">远程节点</div>
          <div style="color:var(--muted);font-size:11px;margin-bottom:8px">把别的 KinetAios 当工具用</div>
          <div id="s-remote-list" style="width:100%;display:flex;flex-direction:column;gap:4px;margin-bottom:8px"></div>
          <div style="display:grid;grid-template-columns:130px 1fr 100px auto;gap:8px;align-items:center">
            <input id="s-remote-name" placeholder="名称(如 macbook-pro)" />
            <input id="s-remote-url" placeholder="http://192.168.1.100:18109/mcp" />
            <input id="s-remote-token" type="password" placeholder="token" />
            <button id="s-remote-add" style="padding:4px 12px;font-size:12px">添加</button>
          </div>
        </div>
      </div>
      </div><!-- /mesh panel -->

      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <button class="primary" id="s-save">${tr('settings.save')}</button>
        <button id="s-test">${tr('settings.test')}</button>
        <span class="test-msg" id="s-msg"></span>
      </div>
    </div>`;
  // 主题切换实时预览(不必等保存):select 改了立即改 html data-theme,保存时再固化。
  document.getElementById('s-theme')!.onchange = () => applyTheme(readSettingsForm().theme);
  const apply = () => {
    const preset = PRESETS.find((p) => p.id === (document.getElementById('s-preset') as HTMLSelectElement).value);
    if (preset && preset.id !== 'custom') {
      (document.getElementById('s-base') as HTMLInputElement).value = preset.baseURL;
      (document.getElementById('s-model') as HTMLInputElement).value = preset.model;
      (document.getElementById('s-proto') as HTMLSelectElement).value = preset.proto;
      (document.getElementById('s-pin') as HTMLInputElement).value = String(preset.pin);
      (document.getElementById('s-pout') as HTMLInputElement).value = String(preset.pout);
    }
  };
  // ── 设置页 tab 切换 ──
  root.querySelectorAll('.s-tab').forEach((btn) => {
    (btn as HTMLElement).onclick = () => {
      const target = (btn as HTMLElement).dataset.stab!;
      root.querySelectorAll('.s-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      root.querySelectorAll('.s-tab-panel').forEach((p) => {
        (p as HTMLElement).style.display = (p as HTMLElement).dataset.panel === target ? '' : 'none';
      });
    };
  });

  // ── Token 随机生成 ──
  document.getElementById('s-mcp-gentoken')!.onclick = () => {
    const buf = new Uint8Array(24);
    crypto.getRandomValues(buf);
    const token = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    (document.getElementById('s-mcp-token') as HTMLInputElement).value = token;
  };

  document.getElementById('s-back')!.onclick = () => showChat();
  document.getElementById('s-preset')!.onchange = apply;

  // ── 多机协作:MCP Server 控制按钮 ──
  function renderRemoteList() {
    const list = document.getElementById('s-remote-list')!;
    list.innerHTML = remoteMcpServersCache.length
      ? remoteMcpServersCache.map((r, i) => `
        <div style="display:flex;gap:8px;align-items:center;padding:4px 0">
          <span style="min-width:100px">${esc(r.name)}</span>
          <span style="flex:1;color:var(--muted);font-size:12px">${esc(r.url)}</span>
          <button class="danger" data-remote-del="${i}" style="padding:2px 8px">删除</button>
        </div>`).join('')
      : '<span style="color:var(--muted);font-size:12px">暂无远程节点</span>';
    list.querySelectorAll('[data-remote-del]').forEach((btn) => {
      (btn as HTMLElement).onclick = () => {
        const idx = Number((btn as HTMLElement).dataset.remoteDel);
        remoteMcpServersCache.splice(idx, 1);
        renderRemoteList();
      };
    });
  }
  renderRemoteList();
  document.getElementById('s-remote-add')!.onclick = () => {
    const name = (document.getElementById('s-remote-name') as HTMLInputElement).value.trim();
    const url = (document.getElementById('s-remote-url') as HTMLInputElement).value.trim();
    const token = (document.getElementById('s-remote-token') as HTMLInputElement).value.trim();
    if (!name || !url) return;
    remoteMcpServersCache.push({ name, url, ...(token ? { token } : {}) });
    (document.getElementById('s-remote-name') as HTMLInputElement).value = '';
    (document.getElementById('s-remote-url') as HTMLInputElement).value = '';
    (document.getElementById('s-remote-token') as HTMLInputElement).value = '';
    renderRemoteList();
  };
  document.getElementById('s-mcp-start')!.onclick = async () => {
    const port = Number((document.getElementById('s-mcp-port') as HTMLInputElement).value) || 18109;
    const token = (document.getElementById('s-mcp-token') as HTMLInputElement).value;
    const r = await api.startMcpServer(port, token);
    const msg = document.getElementById('s-mcp-msg')!;
    msg.textContent = r.ok ? `✓ 已启动 :${port}` : `✗ ${r.error}`;
    msg.style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
  };
  document.getElementById('s-mcp-stop')!.onclick = async () => {
    await api.stopMcpServer();
    const msg = document.getElementById('s-mcp-msg')!;
    msg.textContent = '已停止';
    msg.style.color = 'var(--muted)';
  };

  document.getElementById('s-save')!.onclick = async () => {
    const ns = readSettingsForm();
    await api.saveSettings(ns);
    cliEnabled = ns.enableCliEngines;
    lang = ns.lang; // 语言切了 → 刷静态文本 + 重渲(侧栏/主区/设置面板自身)
    applyTheme(ns.theme);
    applyI18nDOM();
    renderSidebar();
    renderMain();
    showSettings(); // 重开设置面板,让所有 label/option 跟随新语言
    showMsg(tr('settings.saved'), true);
  };
  document.getElementById('s-test')!.onclick = async () => {
    showMsg(tr('settings.testing'), false);
    // Test the in-form values, not the last-saved ones (kills the "edit key, test, still old key" trap).
    const r = await api.testConnection(readSettingsForm());
    showMsg(r.message, r.ok);
  };
  // 长期记忆导出/导入。结果写入 s-mem-msg(用与 showMsg 同款样式,但不抢 s-msg 通道)。
  const showMemMsg = (text: string, ok: boolean): void => {
    const el = document.getElementById('s-mem-msg')!;
    el.textContent = text;
    el.style.color = ok ? 'var(--ok)' : 'var(--danger)';
  };
  document.getElementById('s-mem-exp')!.onclick = async () => {
    const r = await api.memoryExport();
    if (r.ok && r.path) showMemMsg(tr('settings.mem.expOk', { count: r.count ?? 0, path: r.path }), true);
    else if (r.error === 'canceled') showMemMsg(tr('settings.mem.canceled'), false);
    else showMemMsg(r.error ?? 'error', false);
  };
  document.getElementById('s-mem-imp')!.onclick = async () => {
    const r = await api.memoryImport();
    if (r.ok) showMemMsg(tr('settings.mem.impOk', { imported: r.imported ?? 0, skipped: r.skipped ?? 0 }), true);
    else if (r.error === 'canceled') showMemMsg(tr('settings.mem.canceled'), false);
    else showMemMsg(r.error ?? 'error', false);
  };
  // Plugin SDK:列出已加载插件 + 重载按钮。点重载 → invalidate cache → 再拉一遍。
  const renderPlugins = async (): Promise<void> => {
    const el = document.getElementById('s-plugins')!;
    const msg = document.getElementById('s-plugins-msg')!;
    const r = await api.pluginList();
    if (!r.ok || !r.items) {
      el.innerHTML = `<div class="s-plugin-empty">${esc(r.error ?? 'error')}</div>`;
      return;
    }
    if (!r.items.length) {
      el.innerHTML = `<div class="s-plugin-empty">${tr('settings.plugins.empty')}</div>`;
      return;
    }
    el.innerHTML = r.items
      .map((p) => {
        const errBadge = p.error ? `<span class="s-plugin-err" title="${esc(p.error)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:2px"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg> ${esc(tr('settings.plugins.loadFailed'))}</span>` : '';
        return `<div class="s-plugin-row">
          <div class="s-plugin-name">${esc(p.name)} <span class="s-plugin-ver">v${esc(p.version)}</span></div>
          <div class="s-plugin-meta">${p.description ? esc(p.description) + ' · ' : ''}${p.toolCount} ${esc(tr('settings.plugins.tools'))}${p.author ? ' · ' + esc(p.author) : ''}</div>
          ${errBadge}
        </div>`;
      })
      .join('');
    msg.textContent = '';
  };
  document.getElementById('s-plugins-reload')!.onclick = async () => {
    const msg = document.getElementById('s-plugins-msg')!;
    const r = await api.pluginReload();
    if (r.ok) msg.style.color = 'var(--ok)';
    else msg.style.color = 'var(--danger)';
    msg.textContent = r.ok ? tr('settings.plugins.reloaded', { count: r.count ?? 0 }) : (r.error ?? 'error');
    renderPlugins();
  };
  renderPlugins();
}

// Read the settings form into AppSettings. Shared by Save and Test so Test validates the in-form
// config rather than whatever was last persisted.
function readSettingsForm(): AppSettings {
  return {
    presetId: (document.getElementById('s-preset') as HTMLSelectElement).value,
    apiKey: (document.getElementById('s-key') as HTMLInputElement).value,
    baseURL: (document.getElementById('s-base') as HTMLInputElement).value,
    model: (document.getElementById('s-model') as HTMLInputElement).value,
    apiProtocol: (document.getElementById('s-proto') as HTMLSelectElement).value as AppSettings['apiProtocol'],
    reasoning: (document.getElementById('s-reason') as HTMLSelectElement).value as AppSettings['reasoning'],
    approval: (document.getElementById('s-approval') as HTMLSelectElement).value as AppSettings['approval'],
    sandbox: (document.getElementById('s-sandbox') as HTMLSelectElement).value as AppSettings['sandbox'],
    planMode: (document.getElementById('s-plan') as HTMLInputElement).checked,
    enableCliEngines: (document.getElementById('s-cli') as HTMLInputElement).checked,
    priceInPerMTok: Number((document.getElementById('s-pin') as HTMLInputElement).value) || 0,
    priceOutPerMTok: Number((document.getElementById('s-pout') as HTMLInputElement).value) || 0,
    lang: (document.getElementById('s-lang') as HTMLSelectElement).value as Lang,
    theme: (document.getElementById('s-theme') as HTMLSelectElement).value as 'dark' | 'light' | 'aurora' | 'serene',
    maxTurns: Number((document.getElementById('s-maxturns') as HTMLInputElement).value) || 0,
    embedBaseURL: (document.getElementById('s-embed-base') as HTMLInputElement).value.trim(),
    embedApiKey: (document.getElementById('s-embed-key') as HTMLInputElement).value.trim(),
    embedModel: (document.getElementById('s-embed-model') as HTMLInputElement).value.trim() || 'embedding-3',
    budget: budgetCache,
    localMcpServer: {
      enabled: (document.getElementById('s-mcp-enabled') as HTMLInputElement).checked,
      port: Number((document.getElementById('s-mcp-port') as HTMLInputElement).value) || 18109,
      token: (document.getElementById('s-mcp-token') as HTMLInputElement).value,
    },
    remoteMcpServers: remoteMcpServersCache,
  };
}

function showMsg(text: string, ok: boolean) {
  const el = document.getElementById('s-msg')!;
  el.textContent = text;
  el.className = 'test-msg ' + (ok ? 'ok' : 'bad');
}

// ---------- shell confirm modal ----------
let currentConfirm: string | null = null;
function showConfirm(id: string, cmd: string) {
  if (currentConfirm && currentConfirm !== id) api.confirmResponse(currentConfirm, false); // deny stacked
  currentConfirm = id;
  document.getElementById('modal-cmd')!.textContent = cmd;
  const noAsk = document.getElementById('modal-noask') as HTMLInputElement | null;
  if (noAsk) noAsk.checked = false;
  document.getElementById('modal')!.classList.add('show');
}
async function closeConfirm(approved: boolean) {
  const noAsk = (document.getElementById('modal-noask') as HTMLInputElement | null)?.checked;
  if (currentConfirm) api.confirmResponse(currentConfirm, approved);
  currentConfirm = null;
  document.getElementById('modal')!.classList.remove('show');
  // "don't ask again" → flip the global approval policy to never (persists to settings.json).
  if (approved && noAsk) {
    const s = await api.getSettings();
    s.approval = 'never';
    await api.saveSettings(s);
  }
}

// ---------- 远程 Agent 状态条 ----------
// 当远程机器通过 MCP 调用本机 run_agent 时,在底部显示浮动状态条。
let remoteBannerEl: HTMLDivElement | null = null;
let remoteBannerTimer: ReturnType<typeof setTimeout> | null = null;

function showRemoteAgentBanner(ev: import('../shared/types').RemoteAgentEvent): void {
  // 确保 banner 元素存在
  if (!remoteBannerEl) {
    remoteBannerEl = document.createElement('div');
    remoteBannerEl.id = 'remote-agent-banner';
    remoteBannerEl.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 9999;
      max-width: 420px; padding: 12px 16px; border-radius: 12px;
      background: var(--bg-card, #1e1e2e); color: var(--text-primary, #cdd6f4);
      border: 1px solid var(--accent, #e8b339); box-shadow: 0 4px 24px rgba(0,0,0,0.3);
      font-size: 13px; line-height: 1.5; display: flex; align-items: center; gap: 10px;
      transition: opacity 0.3s; backdrop-filter: blur(12px);
    `;
    document.body.appendChild(remoteBannerEl);
  }

  let icon = '⚡';
  let text = '';
  let autoHide = false;

  switch (ev.type) {
    case 'start':
      icon = '🔌';
      text = `远程 Agent 已启动: ${ev.prompt.slice(0, 80)}${ev.prompt.length > 80 ? '…' : ''}`;
      break;
    case 'tool':
      icon = '🔧';
      text = `远程 Agent 正在调用工具: ${ev.name}`;
      break;
    case 'token':
      // token 事件太频繁,只在 banner 里追加少量文本
      return;
    case 'status':
      icon = '📋';
      text = ev.text;
      break;
    case 'cost':
      icon = '💰';
      text = `远程 Agent 消耗: $${ev.usd.toFixed(4)} / ${ev.tokens} tokens`;
      break;
    case 'done':
      icon = '✅';
      text = `远程 Agent 完成: ${ev.summary.slice(0, 100)}${ev.summary.length > 100 ? '…' : ''}`;
      autoHide = true;
      break;
    case 'error':
      icon = '❌';
      text = `远程 Agent 出错: ${ev.message}`;
      autoHide = true;
      break;
  }

  remoteBannerEl.innerHTML = `<span style="font-size:16px">${icon}</span><span>${text}</span>`;
  remoteBannerEl.style.opacity = '1';

  if (remoteBannerTimer) {
    clearTimeout(remoteBannerTimer);
    remoteBannerTimer = null;
  }
  if (autoHide) {
    remoteBannerTimer = setTimeout(() => {
      if (remoteBannerEl) remoteBannerEl.style.opacity = '0';
    }, 6000);
  }
}

// ---------- wiring ----------
function wireUi() {
  document.getElementById('btn-new')!.onclick = async () => {
    const conv = await api.newConversation();
    selectedId = conv.id;
    showChat();
    renderSidebar();
    renderMain();
    document.getElementById('composer')!.focus();
  };
  document.getElementById('btn-settings')!.onclick = () => {
    if (document.getElementById('settings-view')!.classList.contains('active')) showChat();
    else showSettings();
  };

// 收起 ⋯ 更多菜单
function closeMoreMenu() { document.getElementById('sb-more-menu')?.classList.remove('open'); }
  document.getElementById('btn-wb')!.onclick = () => {
    if (document.getElementById('workbench-view')!.classList.contains('active')) showChat();
    else showWorkbench();
  };
  // 侧栏底部按钮:grouped ↔ flat 切换。图标和 title 跟随当前模式(显示「下一个会变成的」)。
  document.getElementById('sb-mode-toggle')!.onclick = () => {
    sidebarMode = sidebarMode === 'grouped' ? 'flat' : 'grouped';
    localStorage.setItem('sb-mode', sidebarMode);
    syncSidebarModeBtn();
    renderSidebar();
  };
  // 低频按钮收纳进 ⋯ 下拉菜单(图表/文件/Arena/记忆/快照)
  document.getElementById('m-dashboard')!.onclick = () => { closeMoreMenu(); void api.openDashboard(); };
  document.getElementById('m-files')!.onclick = () => { closeMoreMenu();
    const c = selectedId ? convs.get(selectedId)?.cwd : undefined;
    void api.openFiles(c);
  };
  document.getElementById('m-arena')!.onclick = () => { closeMoreMenu();
    const c = selectedId ? convs.get(selectedId)?.cwd : undefined;
    void api.openArena(c);
  };
  document.getElementById('m-memory')!.onclick = () => { closeMoreMenu(); void openMemoryPanel(); };
  document.getElementById('m-cron')!.onclick = () => { closeMoreMenu(); void openCronPanel(); };
  document.getElementById('m-snap')!.onclick = () => { closeMoreMenu(); void openSnapshotPanel(); };
  document.getElementById('m-pipeline')!.onclick = () => { closeMoreMenu(); showPipeline(); };
  document.getElementById('m-templates')!.onclick = () => { closeMoreMenu(); showTemplates(); };
  document.getElementById('m-cost')!.onclick = () => { closeMoreMenu(); showCost(); };
  document.getElementById('m-ctools')!.onclick = () => { closeMoreMenu(); showCTools(); };
  document.getElementById('m-timeline')!.onclick = () => { closeMoreMenu(); showTimeline(); };

  // ⋯ 更多菜单:点击切换 open,点外部收起
  const moreMenu = document.getElementById('sb-more-menu')!;
  const moreBtn = document.getElementById('btn-more')!;
  moreBtn.onclick = (e) => { e.stopPropagation(); moreMenu.classList.toggle('open'); };
  document.addEventListener('click', (e) => {
    if (!moreMenu.contains(e.target as Node) && e.target !== moreBtn) moreMenu.classList.remove('open');
  });

  // 聊天 tab:对话 / 文件 / Git。「文件」首次点才懒挂载;切换会话时若已在文件 tab,同步 cwd。
  document.getElementById('tab-chat')!.onclick = () => showTab('chat');
  document.getElementById('tab-files')!.onclick = () => showTab('files');
  document.getElementById('tab-git')!.onclick = () => showTab('git');
  document.getElementById('btn-git-refresh')!.onclick = () => {
    const cwd = selectedId ? convs.get(selectedId)?.cwd ?? '' : '';
    if (cwd) void refreshGit(cwd);
  };
  document.getElementById('tab-rules')!.onclick = () => showTab('rules');
  document.getElementById('btn-rules-save')!.onclick = () => void saveRules();
  document.getElementById('btn-rules-reload')!.onclick = () => {
    if (rulesCwd) void loadRules(rulesCwd);
  };
  document.getElementById('btn-rules-gen')!.onclick = () => openRuleGenerator();
  document.getElementById('btn-clear')!.onclick = () => selectedId && api.clearConversation(selectedId);
  document.getElementById('btn-del')!.onclick = () => selectedId && api.deleteConversation(selectedId);
  document.getElementById('btn-send')!.onclick = send;
  document.getElementById('modal-ok')!.onclick = () => closeConfirm(true);
  document.getElementById('modal-cancel')!.onclick = () => closeConfirm(false);
  // 项目背景编辑器(workbench 卡片「背景」按钮触发)。
  document.getElementById('cm-cancel')!.onclick = () => closeContextModal();
  document.getElementById('cm-save')!.onclick = () => void saveContext();

  // 长期记忆面板(🧠)。
  document.getElementById('mm-close')!.onclick = () => closeMemoryPanel();
  document.getElementById('mm-scope-this')!.onclick = async () => {
    mmScope = 'this';
    await renderMemoryList();
  };
  document.getElementById('mm-scope-all')!.onclick = async () => {
    mmScope = 'all';
    await renderMemoryList();
  };
  document.getElementById('mm-view-facts')!.onclick = async () => {
    mmView = 'facts';
    await renderMemoryList();
  };
  document.getElementById('mm-view-graph')!.onclick = async () => {
    mmView = 'graph';
    await renderMemoryList();
  };

  // 快照面板(⏪)。
  document.getElementById('snap-close')!.onclick = () => closeSnapshotPanel();
  document.getElementById('snap-scope-this')!.onclick = async () => {
    snapScope = 'this';
    await renderSnapshotList();
  };
  document.getElementById('snap-scope-all')!.onclick = async () => {
    snapScope = 'all';
    await renderSnapshotList();
  };

  // 全局:Escape 关 modal + 点 backdrop 关 modal(三个 modal 都安全,等同 cancel)。
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('modal')!.classList.contains('show')) closeConfirm(false);
    else if (document.getElementById('prompt-modal')!.classList.contains('show')) dismissPrompt();
    else if (document.getElementById('context-modal')!.classList.contains('show')) closeContextModal();
  });
  for (const id of ['modal', 'prompt-modal', 'context-modal']) {
    document.getElementById(id)!.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        if (id === 'modal') closeConfirm(false);
        else if (id === 'prompt-modal') dismissPrompt();
        else closeContextModal();
      }
    });
  }

  const cwd = document.getElementById('cwd-input') as HTMLInputElement;
  cwd.addEventListener('change', () => {
    if (selectedId) api.setCwd(selectedId, cwd.value.trim());
  });
  document.getElementById('btn-cwd')!.onclick = async () => {
    if (!selectedId) return;
    const dir = await api.pickDirectory();
    if (dir) {
      api.setCwd(selectedId, dir);
      cwd.value = dir;
    }
  };

  const model = document.getElementById('model-input') as HTMLInputElement;
  model.addEventListener('change', () => {
    if (selectedId) api.setModel(selectedId, model.value.trim());
  });

  const eng = document.getElementById('engine-select') as HTMLSelectElement;
  eng.addEventListener('change', () => {
    if (!selectedId) return;
    closeSlash();
    const conv = convs.get(selectedId);
    const next = eng.value as EngineKind;
    // Switching wipes cross-engine context (Direct history + the CLI session id used for --resume).
    // Only confirm when there's actually something to lose.
    const hasContext = !!(conv && (conv.directHistory.length || conv.engineSessionId || conv.turns.length));
    if (next !== conv?.engine && hasContext && !confirm(tr('engine.switchConfirm'))) {
      syncEngineSelect(conv); // revert the dropdown
      return;
    }
    api.setEngine(selectedId, next);
  });

  const composer = document.getElementById('composer') as HTMLTextAreaElement;
  composer.addEventListener('keydown', (e) => {
    // IME 组合输入中(中文/日文等还没确认候选):按键交给输入法,避免 Enter 确认词被误当成发送。
    if (e.isComposing || e.keyCode === 229) return;
    if (!slashMenu.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSlash(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSlash(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  composer.addEventListener('input', () => {
    autosize(composer);
    handleSlash(composer);
  });
  composer.addEventListener('blur', () => setTimeout(closeSlash, 150));

  // 文件附件:📎 选 / 拖入多个
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  document.getElementById('btn-attach')!.onclick = () => fileInput.click();
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    if (files.length) void addFiles(files);
    fileInput.value = ''; // 允许重复选同一文件
  });
  const dropZone = document.getElementById('input')!;
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag');
  });
  dropZone.addEventListener('dragleave', (e) => {
    if (!dropZone.contains(e.relatedTarget as Node | null)) dropZone.classList.remove('drag');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag');
    // 检测文件夹(暂不支持递归读)→ 提示
    const items = e.dataTransfer?.items;
    let hasDir = false;
    if (items) {
      for (const it of Array.from(items)) {
        const ent = it.webkitGetAsEntry?.() as { isDirectory?: boolean } | null | undefined;
        if (ent?.isDirectory) { hasDir = true; break; }
      }
    }
    if (hasDir) alert(tr('attach.dirAlert'));
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) void addFiles(files);
  });

  // 🖼️ 粘贴图片(Ctrl+V):直接从剪贴板读图片 → base64 附件。
  composer.addEventListener('paste', (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          void addFiles([f]);
        }
      }
    }
  });

  // 📷 截图按钮:renderer 端 getDisplayMedia → canvas 截帧 → base64 附件。
  // 比 desktopCapturer 更可靠:macOS 弹屏幕共享权限,截到真实画面。
  const captureBtn = document.getElementById('btn-capture');
  if (captureBtn) {
    captureBtn.onclick = async () => {
      captureBtn.classList.add('loading');
      try {
        // 优先 main 进程 desktopCapturer —— 比 renderer getDisplayMedia 更可靠:
        // macOS 上 getDisplayMedia 经常拿到 0×0 的空 track(canvas 画出空白 PNG)。
        let dataUrl: string | null = null;

        // 路径 1:desktopCapturer(main 进程)
        try {
          const r = await api.captureScreen();
          if (r.ok && r.dataUrl && r.dataUrl.length > 1000) dataUrl = r.dataUrl;
        } catch { /* 忽略,走回退 */ }

        // 路径 2:getDisplayMedia(renderer 端,某些场景更清晰)
        if (!dataUrl) {
          try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 } as MediaTrackConstraints, audio: false });
            const track = stream.getVideoTracks()[0];
            const video = document.createElement('video');
            video.srcObject = stream;
            video.muted = true;
            await new Promise<void>((resolve, reject) => {
              video.onloadedmetadata = () => { video.play().then(() => resolve()).catch(reject); };
              setTimeout(() => reject(new Error('video timeout')), 3000);
            });
            // 等一帧渲染
            await new Promise((r) => requestAnimationFrame(r));
            await new Promise((r) => setTimeout(r, 100));
            const w = video.videoWidth;
            const h = video.videoHeight;
            if (w > 0 && h > 0) {
              const canvas = document.createElement('canvas');
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext('2d')!;
              ctx.drawImage(video, 0, 0);
              const url = canvas.toDataURL('image/png');
              // 校验:空 canvas 也会产生 ~100 字节的 PNG,真正截图至少几万字节
              if (url.length > 1000) dataUrl = url;
            }
            // 清理
            track.stop();
            stream.getTracks().forEach((t) => t.stop());
            video.srcObject = null;
          } catch {
            // getDisplayMedia 失败(用户取消/不支持)→ dataUrl 保持 null
          }
        }

        captureBtn.classList.remove('loading');
        if (!dataUrl) return; // 用户取消或两条路径都失败
        imageAttachments.push({ name: `screenshot-${Date.now()}.png`, dataUrl });
        renderAttach();
      } catch (e) {
        captureBtn.classList.remove('loading');
        alert(tr('vision.captureErr', { msg: (e as Error)?.message ?? String(e) }));
      }
    };
  }

  // Skill 按钮:打开 skill 菜单(复用 / 的逻辑)。Direct 才有意义。
  document.getElementById('btn-skill')!.onclick = () => {
    if (selectedId && convs.get(selectedId)?.engine !== 'direct') return;
    (document.getElementById('composer') as HTMLTextAreaElement).focus();
    void openSlash('');
  };

  // MCP 按钮:弹已连服务 + 工具列表(可见性)。点外面关闭。
  document.getElementById('btn-mcp')!.onclick = async (e) => {
    e.stopPropagation();
    const menu = document.getElementById('mcp-menu')!;
    if (!menu.hidden) { menu.hidden = true; return; }
    const list = await api.listMcp();
    menu.innerHTML = list.length
      ? list.map((s) => `<div class="mcp-srv"><div class="mcp-srv-name">${ICON.plug} ${esc(s.name)}<span class="mcp-src">${s.source}</span></div><div class="mcp-tools">${
          s.tools.length ? s.tools.map((tool) => `<span class="mcp-tool">${esc(tool)}</span>`).join('') : '<i>' + esc(tr('mcp.noTools')) + '</i>'
        }</div></div>`).join('')
      : '<div class="mcp-empty">' + tr('mcp.empty') + '</div>';
    menu.hidden = false;
  };
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('mcp-menu')!;
    if (!menu.hidden && !(e.target as HTMLElement)?.closest('#btn-mcp, #mcp-menu')) menu.hidden = true;
  });
  // Voice in/out —— MediaRecorder 录音 → main 进程 /audio/transcriptions → 文字填入 composer。
  // TTS 走 speechSynthesis(系统级,零依赖),每条 AI 回复自带 🔊 按钮(见 renderTurn)。
  // ponytail: STT 需要联网调 API,后续可换 whisper.cpp 离线。
  wireVoice();
}

// 录音状态:MediaRecorder → chunks → base64 → main 转写
let mediaRec: MediaRecorder | null = null;
let recActive = false;
let recChunks: Blob[] = [];
function wireVoice(): void {
  const btn = document.getElementById('btn-voice')!;
  btn.onclick = async () => {
    // 正在录音 → 停止 + 转写
    if (recActive && mediaRec) {
      mediaRec.stop();
      return;
    }
    // 开始录音
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recChunks = [];
      // 优先 audio/webm;Safari 给 audio/mp4
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg'
        : 'audio/mp4';
      mediaRec = new MediaRecorder(stream, { mimeType: mime });
      mediaRec.ondataavailable = (e) => { if (e.data.size > 0) recChunks.push(e.data); };
      mediaRec.onstop = async () => {
        // 清理轨道
        stream.getTracks().forEach((t) => t.stop());
        recActive = false;
        btn.classList.remove('listening');
        btn.title = tr('voice.mic');
        if (!recChunks.length) return;
        const blob = new Blob(recChunks, { type: mime });
        // 太短(<0.3s)忽略
        if (blob.size < 1000) return;
        btn.classList.add('loading');
        // base64 编码
        const buf = await blob.arrayBuffer();
        // 分块编码,避免展开运算符在 >64KB 时栈溢出(V8 参数上限)。
        const bytes = new Uint8Array(buf);
        let b64 = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
        }
        b64 = btoa(b64);
        const r = await api.transcribeAudio(b64, mime);
        btn.classList.remove('loading');
        if (!r.ok || !r.text) {
          if (r.error) alert(tr('voice.transcribeErr', { msg: r.error }));
          return;
        }
        const text = r.text.trim();
        if (!text) return;
        const composer = document.getElementById('composer') as HTMLTextAreaElement;
        const cur = composer.value;
        composer.value = cur + (cur && !cur.endsWith(' ') ? ' ' : '') + text + ' ';
        composer.dispatchEvent(new Event('input'));
        autosize(composer);
        composer.focus();
      };
      mediaRec.start();
      recActive = true;
      btn.classList.add('listening');
      btn.title = tr('voice.listening');
      const composer = document.getElementById('composer') as HTMLTextAreaElement;
      composer.focus();
    } catch (e) {
      recActive = false;
      btn.classList.remove('listening');
      const err = (e as Error)?.message ?? String(e);
      if (err.includes('Permission') || err.includes('NotAllowed') || err.includes('denied')) {
        alert(tr('voice.micDenied'));
      } else {
        alert(tr('voice.transcribeErr', { msg: err }));
      }
    }
  };
}

// TTS:speechSynthesis 系统级,零依赖。再次点同一个正在读的消息 → 取消。
let lastUtterance: SpeechSynthesisUtterance | null = null;
// 复制文本到剪贴板,带短暂"已复制"反馈
function copyText(text: string, btn?: HTMLElement): void {
  navigator.clipboard.writeText(text).then(() => {
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = orig; }, 1200);
    }
  }).catch(() => {});
}

function speakText(text: string): void {
  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    if (lastUtterance && lastUtterance.text === text) {
      lastUtterance = null;
      return;
    }
  }
  // strip markdown 噪声(代码块/链接),让朗读顺一点。ponytail:粗暴 replace,够用。
  const clean = text
    .replace(/```[\s\S]*?```/g, '(code)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_>]/g, '')
    .slice(0, 2000);
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = lang === 'en' ? 'en-US' : lang === 'ja' ? 'ja-JP' : lang === 'zh-TW' ? 'zh-TW' : 'zh-CN';
  lastUtterance = u;
  window.speechSynthesis.speak(u);
}

async function send() {
  if (!selectedId) return;
  // Running → the same button acts as Stop (cancel the in-flight task).
  if (convs.get(selectedId)?.status === 'running') {
    await api.cancel(selectedId);
    return;
  }
  closeSlash();
  const composer = document.getElementById('composer') as HTMLTextAreaElement;
  const typed = composer.value;
  if (!typed.trim() && !attachments.length && !imageAttachments.length) return;
  // @文件引用 + 📎 附件:内容拼到正文前(代码块包裹,模型可直接读取)。
  const cwd = convs.get(selectedId)?.cwd ?? '';
  const at = cwd ? await resolveAtFiles(typed, cwd) : { files: [], missing: [] };
  const files = [...attachments, ...at.files];
  let text = typed;
  if (files.length) {
    text = files.map((a) => `📎 文件 ${a.name}:\n\`\`\`\n${a.content}\n\`\`\``).join('\n\n') + '\n\n---\n\n' + typed;
  }
  // 🖼️ 图片附件:发给 Direct 引擎时,标记 prompt 含图片(主进程 send 把 imageAttachments 拼进 ChatMsg content parts)。
  if (imageAttachments.length) {
    const imgNote = imageAttachments.length === 1 ? `\n\n[📷 1 张图片已附加]` : `\n\n[📷 ${imageAttachments.length} 张图片已附加]`;
    text += imgNote;
    // 将图片 base64 作为特殊 JSON 块附加到 text 末尾,Direct 引擎的 send 拆解。
    const imgs = imageAttachments.map((a) => JSON.stringify(a));
    text += `\n\x00IMAGES${JSON.stringify(imgs)}\x00`;
  }
  if (at.missing.length) alert(tr('attach.missingAlert', { list: at.missing.join('\n') }));
  showChat();
  // 先发送,成功后再清空(IPC 失败时用户数据不丢失)
  try {
    await api.send(selectedId, text);
  } catch (e) {
    alert(tr('send.failed', { msg: (e as Error)?.message ?? String(e) }));
    return; // 不清空,用户可重试
  }
  // 发送成功 → 清空 composer + 附件
  if (files.length) {
    attachments = [];
  }
  if (imageAttachments.length) {
    imageAttachments = [];
  }
  renderAttach();
  composer.value = '';
  autosize(composer);
  document.getElementById('composer')!.focus();
}

function showChat() {
  currentView = 'chat';
  hideAllViews();
  document.getElementById('chat-view')!.classList.add('active');
  syncViewButtons();
  renderMain();
}

function showPipeline() {
  currentView = 'pipeline';
  hideAllViews();
  document.getElementById('pipeline-view')!.classList.add('active');
  syncViewButtons();
  renderPipeline();
}

function showTemplates() {
  currentView = 'templates';
  hideAllViews();
  document.getElementById('templates-view')!.classList.add('active');
  syncViewButtons();
  renderTemplates();
}

function showCost() {
  currentView = 'cost';
  hideAllViews();
  document.getElementById('cost-view')!.classList.add('active');
  syncViewButtons();
  renderCost();
}

function showCTools() {
  currentView = 'ctools';
  hideAllViews();
  document.getElementById('ctools-view')!.classList.add('active');
  syncViewButtons();
  renderCTools();
}

function showTimeline() {
  currentView = 'timeline';
  hideAllViews();
  document.getElementById('timeline-view')!.classList.add('active');
  syncViewButtons();
  renderTimeline();
}

function hideAllViews(): void {
  for (const id of ['chat-view', 'settings-view', 'workbench-view', 'pipeline-view', 'templates-view', 'cost-view', 'ctools-view', 'timeline-view']) {
    const el = document.getElementById(id)!;
    el.classList.remove('active');
    // 切走时重置滚动位置,避免回来时停在底部 / 布局错乱
    el.scrollTop = 0;
  }
}

function showWorkbench() {
  currentView = 'workbench';
  hideAllViews();
  document.getElementById('workbench-view')!.classList.add('active');
  syncViewButtons();
  renderWorkbench();
}

// 顶栏按钮的 active 态(📂 / ⚙):高亮当前所在视图,让用户知道点回去会切走。
function syncViewButtons(): void {
  document.getElementById('btn-wb')!.classList.toggle('active', currentView === 'workbench');
  document.getElementById('btn-settings')!.classList.toggle('active', currentView === 'settings');
}

// 侧栏底部模式按钮:grouped 时显示 ▤(下一步变 flat);flat 时显示 ▦(下一步变 grouped)。
// 图标始终代表「点一下会变成什么」,与播放/暂停按钮同理。
function syncSidebarModeBtn(): void {
  const btn = document.getElementById('sb-mode-toggle')!;
  if (sidebarMode === 'grouped') {
    btn.textContent = '▤';
    btn.title = tr('sidebar.modeFlat');
    btn.dataset.i18nTitle = 'sidebar.modeFlat';
  } else {
    btn.textContent = '▦';
    btn.title = tr('sidebar.modeGrouped');
    btn.dataset.i18nTitle = 'sidebar.modeGrouped';
  }
}

// ---------- workbench(项目卡片总览)----------
// 项目 = cwd,卡片显示项目下所有任务聚合的 token / 费用 / 最近活动。
function renderWorkbench() {
  const root = document.getElementById('workbench')!;
  const groups = new Map<string, string[]>();
  for (const id of order) {
    const c = convs.get(id);
    if (!c) continue;
    const key = c.cwd || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(id);
  }
  const items = [...groups.entries()];
  // 项目排序:最近有活动的在前(用项目内最新 conv 的 createdAt)。
  items.sort((a, b) => {
    const la = a[1][0] ? convs.get(a[1][0])?.createdAt ?? 0 : 0;
    const lb = b[1][0] ? convs.get(b[1][0])?.createdAt ?? 0 : 0;
    return lb - la;
  });
  root.innerHTML =
    `<div class="wb-head">
      <div class="wb-title">${esc(tr('wb.title'))}</div>
      <div class="wb-sub">${esc(tr('wb.sub'))}</div>
      <span class="wb-spacer"></span>
      <button class="primary" id="wb-new-proj">${esc(tr('wb.newProject'))}</button>
    </div>` +
    (items.length === 0
      ? `<div class="empty">${esc(tr('wb.empty'))}</div>`
      : `<div class="wb-grid">${items.map(([cwd, ids]) => projCard(cwd, ids)).join('')}</div>`);
  document.getElementById('wb-new-proj')!.onclick = () => void newProject();
  root.querySelectorAll<HTMLElement>('.wb-card').forEach((card) => {
    const cwd = card.dataset.cwd!;
    card.querySelector<HTMLElement>('.wb-newtask')!.onclick = (e) => { e.stopPropagation(); void newTaskInProject(cwd); };
    card.querySelector<HTMLElement>('.wb-ctx')!.onclick = (e) => { e.stopPropagation(); void openContextModal(cwd); };
    card.onclick = () => void openProject(cwd);
  });
}

function projCard(cwd: string, ids: string[]): string {
  let tokens = 0;
  let cost = 0;
  let lastTs = 0;
  let running = false;
  for (const id of ids) {
    const c = convs.get(id);
    if (!c) continue;
    tokens += c.tokens;
    cost += c.cost;
    const t = c.turns[c.turns.length - 1]?.ts ?? c.createdAt;
    if (t > lastTs) lastTs = t;
    if (c.status === 'running') running = true;
  }
  const stats: string[] = [tr('wb.tasks', { n: ids.length })];
  if (tokens) stats.push(`${(tokens / 1000).toFixed(1)}k tok`);
  if (cost) stats.push(`$${cost.toFixed(4)}`);
  const when = lastTs ? timeAgo(lastTs) : tr('wb.noActivity');
  return `<div class="wb-card" data-cwd="${esc(cwd)}">
    <div class="wb-card-head">
      <span class="wb-picon">${running ? ICON.bolt : ICON.folder}</span>
      <span class="wb-pname">${esc(projName(cwd))}</span>
      <span class="wb-spacer"></span>
      <button class="ghost wb-newtask" title="${esc(tr('wb.newTask'))}">＋</button>
    </div>
    <div class="wb-cwd">${esc(cwd || tr('wb.ungrouped'))}</div>
    <div class="wb-stats">${esc(stats.join(' · '))}</div>
    <div class="wb-last">${esc(tr('wb.last', { when }))}</div>
    <div class="wb-card-actions">
      <span class="wb-spacer"></span>
      <button class="ghost wb-ctx">${esc(tr('wb.context'))}</button>
    </div>
  </div>`;
}

// 单卡增量:cost/done/error 事件时只改这一张卡的统计/时间/图标,不重建网格,保留滚动位置。
// 找不到卡(新 cwd 的首条事件先到 onConversation 之前)就 noop,下次 renderWorkbench 兜底。
function refreshWbCard(cwd: string): void {
  const card = document.querySelector<HTMLElement>(`.wb-card[data-cwd="${cssEsc(cwd)}"]`);
  if (!card) return;
  const ids = order.filter((id) => convs.get(id)?.cwd === cwd);
  let tokens = 0, cost = 0, lastTs = 0, running = false;
  for (const id of ids) {
    const c = convs.get(id);
    if (!c) continue;
    tokens += c.tokens; cost += c.cost;
    const t = c.turns[c.turns.length - 1]?.ts ?? c.createdAt;
    if (t > lastTs) lastTs = t;
    if (c.status === 'running') running = true;
  }
  const stats: string[] = [tr('wb.tasks', { n: ids.length })];
  if (tokens) stats.push(`${(tokens / 1000).toFixed(1)}k tok`);
  if (cost) stats.push(`$${cost.toFixed(4)}`);
  card.querySelector<HTMLElement>('.wb-stats')!.textContent = stats.join(' · ');
  card.querySelector<HTMLElement>('.wb-last')!.textContent =
    tr('wb.last', { when: lastTs ? timeAgo(lastTs) : tr('wb.noActivity') });
  card.querySelector<HTMLElement>('.wb-picon')!.innerHTML = running ? ICON.bolt : ICON.folder;
}

// attribute selector escaping: cwd may contain quotes / ] / backslash — escape for querySelector.
function cssEsc(s: string): string {
  return s.replace(/["\\\]]/g, '\\$&');
}

async function openProject(cwd: string): Promise<void> {
  const ids = order.filter((id) => convs.get(id)?.cwd === cwd);
  if (!ids.length) {
    void newTaskInProject(cwd);
    return;
  }
  selectedId = ids[0];
  showChat();
  renderSidebar();
}

// 新建项目:挑目录 → 在该目录建首个任务。
async function newProject(): Promise<void> {
  const dir = await api.pickDirectory();
  if (!dir) return;
  const conv = await api.newConversation(dir);
  selectedId = conv.id;
  showChat();
  renderSidebar();
  document.getElementById('composer')!.focus();
}

// 在已有项目下加任务(沿用 cwd,不重新挑目录)。
async function newTaskInProject(cwd: string): Promise<void> {
  const conv = await api.newConversation(cwd || undefined);
  selectedId = conv.id;
  showChat();
  renderSidebar();
  document.getElementById('composer')!.focus();
}

// 相对时间(本地化):刚刚 / N 分钟前 / N 小时前 / N 天前。
function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return tr('time.justNow');
  if (s < 3600) return tr('time.minutesAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return tr('time.hoursAgo', { n: Math.floor(s / 3600) });
  return tr('time.daysAgo', { n: Math.floor(s / 86400) });
}

// ---------- 项目背景编辑器(KINET-CONTEXT.md)----------
// 用 modal + CodeEditor 全屏 + 保存/取消。空 cwd 不允许(workbench 卡片总是带 cwd)。
let contextCwd = '';
let contextEditor: CodeEditor | null = null;

async function openContextModal(cwd: string): Promise<void> {
  if (!cwd) return;
  contextCwd = cwd;
  const modal = document.getElementById('context-modal')!;
  const host = document.getElementById('cm-editor-host')!;
  const cwdLabel = document.getElementById('cm-cwd')!;
  const status = document.getElementById('cm-status')!;
  cwdLabel.textContent = cwd;
  status.textContent = '';

  // 每次打开重建编辑器（确保干净状态）
  if (contextEditor) { contextEditor.destroy(); contextEditor = null; }
  contextEditor = new CodeEditor(host, { lang: 'markdown', autoHeight: false });
  contextEditor.value = '…';
  modal.classList.add('show');
  const r = await api.readContext(cwd);
  contextEditor.value = r.ok ? r.content ?? '' : '';
  if (!r.ok) status.textContent = r.error ?? '';
  contextEditor.focus();
}

async function saveContext(): Promise<void> {
  if (!contextCwd || !contextEditor) return;
  const status = document.getElementById('cm-status')!;
  status.textContent = '…';
  const r = await api.writeContext(contextCwd, contextEditor.value);
  status.textContent = r.ok ? tr('wb.saved') : tr('wb.saveErr', { msg: r.error ?? '' });
}

function closeContextModal(): void {
  contextCwd = '';
  document.getElementById('context-modal')!.classList.remove('show');
}

function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

// ---------- slash skill menu (Direct only) ----------
// Typing /<name> in the composer opens a filterable list of skills from ~/.claude/skills +
// ~/.codex/skills. Pick (Enter/click) inserts "/name " — sending it makes the Direct engine
// inject that skill's body. Non-Direct conversations never show the menu.
async function ensureSkills(): Promise<SkillInfo[]> {
  if (!skills.length) skills = await api.listSkills();
  return skills;
}

function handleSlash(composer: HTMLTextAreaElement): void {
  const conv = selectedId ? convs.get(selectedId) : undefined;
  const v = composer.value;
  // Only while the user is still typing the name token (no space yet) and only for Direct.
  if (conv?.engine !== 'direct' || !v.startsWith('/') || /\s/.test(v.slice(1))) {
    closeSlash();
    return;
  }
  void openSlash(v.slice(1).toLowerCase());
}

async function openSlash(q: string): Promise<void> {
  const all = await ensureSkills();
  slashItems = all
    .filter((s) => s.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ai = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bi = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return ai - bi || a.name.localeCompare(b.name);
    })
    .slice(0, 50);
  slashIndex = 0;
  renderSlash();
}

function renderSlash(): void {
  if (!slashItems.length) {
    slashMenu.innerHTML = '<div class="slash-empty">' + esc(tr('skill.noMatch')) + '</div>';
    slashMenu.hidden = false;
    return;
  }
  slashMenu.innerHTML = slashItems
    .map(
      (s, i) =>
        `<div class="slash-item${i === slashIndex ? ' active' : ''}" data-i="${i}">` +
        `<span class="slash-name">${esc(s.name)}<span class="slash-tag">${s.source}·${s.type}</span></span>` +
        `<span class="slash-desc">${esc(s.description)}</span></div>`,
    )
    .join('');
  slashMenu.hidden = false;
  slashMenu.querySelectorAll<HTMLElement>('.slash-item').forEach((el) => {
    el.onclick = () => {
      const s = slashItems[Number(el.dataset.i)];
      if (s) pickSlash(s.name);
    };
  });
}

function moveSlash(delta: number): void {
  if (!slashItems.length) return;
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  renderSlash();
  slashMenu.querySelector<HTMLElement>('.slash-item.active')?.scrollIntoView({ block: 'nearest' });
}

function pickSlash(name?: string): void {
  const pick = name ?? slashItems[slashIndex]?.name;
  if (!pick) return;
  const composer = document.getElementById('composer') as HTMLTextAreaElement;
  composer.value = `/${pick} `;
  closeSlash();
  composer.focus();
  composer.setSelectionRange(composer.value.length, composer.value.length);
  autosize(composer);
}

function closeSlash(): void {
  slashMenu.hidden = true;
}

// ---------- 文件附件(📎 选 / 拖入多个)----------
// ponytail: 只读文本文件,内容用代码块拼进 prompt。二进制(图片/PDF/压缩包/音视频等)按扩展名跳过 ——
// 非 UTF-8 / 二进制无法纯文本喂模型;要支持图片得走多模态消息,标 TODO。
const BIN_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tar|rar|7z|exe|dll|so|dylib|class|jar|mp[34]|mov|avi|wav|flac|ogg|webm|ttf|otf|woff2?|eot|psd|ai|sketch|app|dmg|iso|db|sqlite?|node)$/i;

function isTextFile(name: string): boolean {
  return !BIN_EXT.test(name);
}

function readTextTruncated(f: File, max: number): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result ?? '');
      resolve(text.length > max ? text.slice(0, max) + '\n…[截断]' : text);
    };
    r.onerror = () => resolve('[读取失败]');
    // 只读开头 max*4 字节(留余量给多字节字符)—— 否则几 MB 的大文件会被整个读进内存,卡住/失败。
    r.readAsText(f.slice(0, max * 4));
  });
}

async function addFiles(files: File[]): Promise<void> {
  for (const f of files) {
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) {
      // 图片附件 → base64 data URL(多模态)
      if (f.size > 10 * 1024 * 1024) { alert(tr('vision.tooLarge', { mb: 10 })); continue; }
      const dataUrl = await fileToDataUrl(f);
      imageAttachments.push({ name: f.name, dataUrl });
    } else if (isTextFile(f.name)) {
      attachments.push({ name: f.name, content: await readTextTruncated(f, 20000) });
    }
  }
  renderAttach();
}

// File → base64 data URL(用于图片附件)
function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => resolve('');
    r.readAsDataURL(f);
  });
}

function renderAttach(): void {
  const row = document.getElementById('attach-row')!;
  const fileChips = attachments
    .map((a, i) => `<span class="chip"><span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg> ${esc(a.name)}</span><span class="chip-x" data-kind="file" data-i="${i}">×</span></span>`)
    .join('');
  const imgChips = imageAttachments
    .map((a, i) => `<span class="chip img-chip"><img src="${a.dataUrl}" alt="${esc(a.name)}" /><span class="chip-x" data-kind="img" data-i="${i}">×</span></span>`)
    .join('');
  row.innerHTML = fileChips + imgChips;
  row.querySelectorAll<HTMLElement>('.chip-x').forEach((x) => {
    x.onclick = () => {
      const idx = Number(x.dataset.i);
      if (x.dataset.kind === 'img') imageAttachments.splice(idx, 1);
      else attachments.splice(idx, 1);
      renderAttach();
    };
  });
}

// @文件引用:解析正文里的 @path,经 main 读 cwd 内文件(@ 前需非单词字符以避开 email)。返回读到的 + 失败的。
async function resolveAtFiles(text: string, cwd: string): Promise<{ files: { name: string; content: string }[]; missing: string[] }> {
  const rels = [...new Set([...text.matchAll(/(?<![\w@])@([\w./\\-]+)/g)].map((m) => m[1]))];
  const files: { name: string; content: string }[] = [];
  const missing: string[] = [];
  for (const rel of rels) {
    if (!isTextFile(rel)) continue;
    const r = await api.readFile(rel, cwd);
    if (r.ok && r.content != null) files.push({ name: rel, content: r.content });
    else missing.push(rel);
  }
  return { files, missing };
}

// Suggestions for the model picker's datalist (Direct only). Free-typing any id still works.
const MODEL_HINTS = [
  'glm-5.2', 'glm-4.6', 'glm-4-plus',
  'deepseek-chat', 'deepseek-reasoner',
  'qwen-max', 'qwen-plus', 'qwen-long',
  'claude-sonnet-5', 'claude-haiku-4-5-20251001',
];

function fillModelHints(): void {
  const dl = document.getElementById('model-list')!;
  dl.innerHTML = MODEL_HINTS.map((m) => `<option value="${esc(m)}"></option>`).join('');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 长期记忆面板:modal 形态(不开新 BrowserWindow —— 列表轻量,modal 够用)。
// scope:this = 当前选中频道产生的记忆;all = 全部(包括 conversation_id 为 NULL 的历史/导入行)。
// 每行:文本 + 编辑(行内 textarea)+ 删除。来源频道显示 conv 的 customTitle 或 cwd 末段。
let mmScope: 'this' | 'all' = 'this';
let mmView: 'facts' | 'graph' = 'facts';
async function openMemoryPanel(): Promise<void> {
  mmScope = selectedId ? 'this' : 'all';
  document.getElementById('memory-modal')!.classList.add('show');
  await renderMemoryList();
}
function closeMemoryPanel(): void {
  document.getElementById('memory-modal')!.classList.remove('show');
  // 停止力导向图动画,释放 CPU(之前漏了 → 关面板后 rAF 继续跑)
  stopGraphAnim();
}
async function renderMemoryList(): Promise<void> {
  const listEl = document.getElementById('mm-list')!;
  // scope / view 按钮态(两条渲染路径都要刷,提到分流前)
  document.getElementById('mm-scope-this')!.classList.toggle('active', mmScope === 'this');
  document.getElementById('mm-scope-all')!.classList.toggle('active', mmScope === 'all');
  document.getElementById('mm-view-facts')!.classList.toggle('active', mmView === 'facts');
  document.getElementById('mm-view-graph')!.classList.toggle('active', mmView === 'graph');
  // view 分流:graph → 三元组列表;facts → 原有文本列表
  if (mmView === 'graph') return renderMemoryGraph();
  // this 模式必须有选中会话;否则强制 all
  const convId = mmScope === 'this' && selectedId ? selectedId : undefined;
  const r = await api.memoryList(convId);
  if (!r.ok || !r.items) {
    listEl.innerHTML = `<div class="mm-empty">${esc(r.error ?? 'error')}</div>`;
    return;
  }
  if (!r.items.length) {
    listEl.innerHTML = `<div class="mm-empty">${tr('mem.empty')}</div>`;
    return;
  }
  listEl.innerHTML = r.items
    .map((m) => {
      const fromLabel = m.conversation_id
        ? convLabel(m.conversation_id)
        : '';
      return `<div class="mm-row" data-id="${esc(m.id)}">
        <div class="mm-text">${esc(m.content)}</div>
        ${fromLabel ? `<div class="mm-from">${esc(tr('mem.from'))}: ${esc(fromLabel)}</div>` : ''}
        <div class="mm-actions">
          <button class="ghost mm-edit" data-i18n="mem.edit">${esc(tr('mem.edit'))}</button>
          <button class="ghost mm-del" data-i18n="mem.del">${esc(tr('mem.del'))}</button>
        </div>
      </div>`;
    })
    .join('');
  listEl.querySelectorAll<HTMLElement>('.mm-row').forEach((row) => {
    const id = row.dataset.id!;
    row.querySelector<HTMLElement>('.mm-edit')!.onclick = () => memEdit(row, id);
    row.querySelector<HTMLElement>('.mm-del')!.onclick = async () => {
      if (!confirm(tr('mem.delConfirm'))) return;
      await api.memoryDelete(id);
      await renderMemoryList();
    };
  });
}
// Memory Graph 视图:力导向图(默认) / 三元组列表(可切换)。按当前 scope 过滤。
let mmGraphMode: 'viz' | 'list' = 'viz';
let mmGraphAnim = 0; // requestAnimationFrame id(0 = 未运行)
async function renderMemoryGraph(): Promise<void> {
  const listEl = document.getElementById('mm-list')!;
  document.getElementById('mm-scope-this')!.classList.toggle('active', mmScope === 'this');
  document.getElementById('mm-scope-all')!.classList.toggle('active', mmScope === 'all');
  document.getElementById('mm-view-facts')!.classList.toggle('active', mmView === 'facts');
  document.getElementById('mm-view-graph')!.classList.toggle('active', mmView === 'graph');
  // 图谱视图下显示「图/列表」切换按钮
  const vizBtn = document.getElementById('mm-graph-viz')!;
  vizBtn.style.display = mmView === 'graph' ? '' : 'none';
  vizBtn.innerHTML = mmGraphMode === 'viz' ? ICON.list : ICON.graph;
  vizBtn.title = mmGraphMode === 'viz' ? '切换列表' : '切换力导向图';
  vizBtn.onclick = async () => {
    mmGraphMode = mmGraphMode === 'viz' ? 'list' : 'viz';
    stopGraphAnim();
    await renderMemoryGraph();
  };
  const convId = mmScope === 'this' && selectedId ? selectedId : undefined;
  const r = await api.memoryTriples(convId);
  if (!r.ok || !r.items) {
    stopGraphAnim();
    listEl.innerHTML = `<div class="mm-empty">${esc(r.error ?? 'error')}</div>`;
    return;
  }
  if (!r.items.length) {
    stopGraphAnim();
    listEl.innerHTML = `<div class="mm-empty">${esc(tr('graph.empty'))}</div>`;
    return;
  }
  if (mmGraphMode === 'viz') return renderGraphViz(listEl, r.items);
  return renderGraphList(listEl, r.items);
}

// 列表模式:[s] → predicate → [o](原有格式)
async function renderGraphList(
  listEl: HTMLElement,
  items: Array<{ id: string; subject: string; predicate: string; object: string; conversation_id: string | null }>,
): Promise<void> {
  stopGraphAnim();
  listEl.innerHTML = items
    .map((t) => {
      const from = t.conversation_id ? convLabel(t.conversation_id) : '';
      return `<div class="mm-row mm-triple" data-id="${esc(t.id)}">
        <div class="mm-triple-line">
          <span class="mm-triple-node">${esc(t.subject)}</span>
          <span class="mm-triple-arrow">${esc(t.predicate)} →</span>
          <span class="mm-triple-node">${esc(t.object)}</span>
        </div>
        ${from ? `<div class="mm-from">${esc(from)}</div>` : ''}
        <div class="mm-actions">
          <button class="ghost mm-del" data-i18n="mem.del">${esc(tr('mem.del'))}</button>
        </div>
      </div>`;
    })
    .join('');
  listEl.querySelectorAll<HTMLElement>('.mm-triple').forEach((row) => {
    const id = row.dataset.id!;
    row.querySelector<HTMLElement>('.mm-del')!.onclick = async () => {
      if (!confirm(tr('graph.delConfirm'))) return;
      await api.memoryTripleDelete(id);
      await renderMemoryGraph();
    };
  });
}

// ── 力导向图可视化(纯 Canvas,零依赖) ──
// 节点 = 去重实体(subject + object 合并),边 = predicate 关系。
// 力模型:库仑排斥 + 弹簧吸引 + 中心引力 + 阻尼。
interface GNode { label: string; x: number; y: number; vx: number; vy: number; r: number; degree: number; fixed: boolean; }
interface GEdge { from: string; to: string; label: string; tripleId: string; }
function stopGraphAnim(): void {
  if (mmGraphAnim) { cancelAnimationFrame(mmGraphAnim); mmGraphAnim = 0; }
}

async function renderGraphViz(
  listEl: HTMLElement,
  items: Array<{ id: string; subject: string; predicate: string; object: string; conversation_id: string | null }>,
): Promise<void> {
  // 构建去重节点和边
  const nodeMap = new Map<string, GNode>();
  const edges: GEdge[] = [];
  for (const t of items) {
    const sKey = t.subject, oKey = t.object;
    if (!nodeMap.has(sKey)) nodeMap.set(sKey, makeNode(sKey));
    if (!nodeMap.has(oKey)) nodeMap.set(oKey, makeNode(oKey));
    nodeMap.get(sKey)!.degree++;
    nodeMap.get(oKey)!.degree++;
    edges.push({ from: sKey, to: oKey, label: t.predicate, tripleId: t.id });
  }
  const nodes = [...nodeMap.values()];
  // 半径根据 degree 分级
  for (const n of nodes) n.r = 14 + Math.min(n.degree, 6) * 3;

  // 构建 DOM:canvas + 浮层 toolbar
  listEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'mm-graph-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'mm-graph-canvas';
  const tipBar = document.createElement('div');
  tipBar.className = 'mm-graph-tip';
  tipBar.innerHTML = `<span>拖拽节点 · 滚轮缩放 · ${esc(tr('graph.tip'))}</span>`;
  wrap.appendChild(canvas);
  wrap.appendChild(tipBar);
  listEl.appendChild(wrap);

  // 等一帧让 layout 生效,拿容器尺寸
  requestAnimationFrame(() => runForceGraph(canvas, nodes, edges, tipBar));
}

function makeNode(label: string): GNode {
  const angle = Math.random() * Math.PI * 2;
  const dist = 80 + Math.random() * 80;
  return {
    label,
    x: Math.cos(angle) * dist,
    y: Math.sin(angle) * dist,
    vx: 0, vy: 0,
    r: 18, degree: 0, fixed: false,
  };
}

function runForceGraph(canvas: HTMLCanvasElement, nodes: GNode[], edges: GEdge[], tipBar: HTMLElement): void {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;

  // 视口状态:平移 + 缩放
  let panX = 0, panY = 0, zoom = 1;
  let dragging: GNode | null = null;
  let hoverNode: GNode | null = null;
  let mouseDown = false;
  let lastMX = 0, lastMY = 0;

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 初始居中
    panX = rect.width / 2;
    panY = rect.height / 2;
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // 屏幕坐标 → 世界坐标
  function s2w(sx: number, sy: number): [number, number] {
    return [(sx - panX) / zoom, (sy - panY) / zoom];
  }
  // 命中测试
  function hitTest(sx: number, sy: number): GNode | null {
    const [wx, wy] = s2w(sx, sy);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = wx - n.x, dy = wy - n.y;
      if (dx * dx + dy * dy <= n.r * n.r) return n;
    }
    return null;
  }

  // ── 力模拟一步 ──
  function simulate(): void {
    const REPULSION = 6000;    // 库仑排斥常数
    const SPRING_K = 0.04;     // 弹簧弹力系数
    const SPRING_LEN = 120;    // 弹簧自然长度
    const CENTER_K = 0.005;    // 中心引力
    const DAMPING = 0.85;      // 阻尼

    // 排斥力(节点对)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 1) { dist2 = 1; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
        const dist = Math.sqrt(dist2);
        const force = REPULSION / dist2;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        if (!a.fixed) { a.vx -= fx; a.vy -= fy; }
        if (!b.fixed) { b.vx += fx; b.vy += fy; }
      }
    }
    // 弹簧力(边)
    const nodeMap = new Map(nodes.map((n) => [n.label, n]));
    for (const e of edges) {
      const a = nodeMap.get(e.from)!, b = nodeMap.get(e.to)!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = SPRING_K * (dist - SPRING_LEN);
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      if (!a.fixed) { a.vx += fx; a.vy += fy; }
      if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
    }
    // 中心引力 + 阻尼 + 位置更新
    for (const n of nodes) {
      if (n.fixed || n === dragging) { n.vx = 0; n.vy = 0; continue; }
      n.vx += -n.x * CENTER_K;
      n.vy += -n.y * CENTER_K;
      n.vx *= DAMPING; n.vy *= DAMPING;
      n.x += n.vx; n.y += n.vy;
    }
  }

  // ── 渲染 ──
  function render(): void {
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    // 边
    const nodeMap = new Map(nodes.map((n) => [n.label, n]));
    for (const e of edges) {
      const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
      if (!a || !b) continue;
      const isHL = hoverNode && (hoverNode === a || hoverNode === b);
      // 线
      ctx.strokeStyle = isHL ? 'rgba(232,179,57,0.6)' : 'rgba(120,120,130,0.3)';
      ctx.lineWidth = isHL ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      // 箭头
      drawArrow(ctx, a.x, a.y, b.x, b.y, b.r);
      // 边标签(predicate)
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ctx.font = '10px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(e.label).width;
      ctx.fillStyle = isHL ? 'rgba(232,179,57,0.9)' : 'rgba(160,160,170,0.7)';
      ctx.fillText(e.label, mx, my - 7);
    }

    // 节点
    for (const n of nodes) {
      const isHL = n === hoverNode;
      const isConnected = hoverNode && edges.some((e) =>
        (nodeMap.get(e.from) === hoverNode && nodeMap.get(e.to) === n) ||
        (nodeMap.get(e.to) === hoverNode && nodeMap.get(e.from) === n));
      const dim = hoverNode && !isHL && !isConnected;

      // 外圈光晕(hover 时)
      if (isHL) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(232,179,57,0.15)';
        ctx.fill();
      }
      // 节点圆
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      const grad = ctx.createRadialGradient(n.x - n.r * 0.3, n.y - n.r * 0.3, 0, n.x, n.y, n.r);
      if (dim) {
        grad.addColorStop(0, '#4a4a52');
        grad.addColorStop(1, '#333338');
      } else {
        grad.addColorStop(0, '#f0c860');
        grad.addColorStop(1, '#b88200');
      }
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = dim ? 'rgba(60,60,65,0.5)' : 'rgba(232,179,57,0.8)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 标签文字
      ctx.font = `${Math.max(10, Math.min(14, n.r * 0.6))}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 文字描边(可读性)
      ctx.strokeStyle = 'rgba(20,20,23,0.9)';
      ctx.lineWidth = 3;
      ctx.strokeText(n.label, n.x, n.y);
      ctx.fillStyle = dim ? '#777' : '#fff';
      ctx.fillText(n.label, n.x, n.y);
    }
    ctx.restore();
  }

  function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, targetR: number): void {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const tipX = x2 - Math.cos(angle) * (targetR + 2);
    const tipY = y2 - Math.sin(angle) * (targetR + 2);
    const aSize = 6;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - aSize * Math.cos(angle - 0.4), tipY - aSize * Math.sin(angle - 0.4));
    ctx.lineTo(tipX - aSize * Math.cos(angle + 0.4), tipY - aSize * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,120,130,0.5)';
    ctx.fill();
  }

  // ── 动画循环 ──
  let frame = 0;
  function tick(): void {
    simulate();
    render();
    frame++;
    // 收敛后降帧(省 CPU):速度都很小了 → 每 3 帧才模拟一次
    const totalV = nodes.reduce((s, n) => s + Math.abs(n.vx) + Math.abs(n.vy), 0);
    if (totalV < 0.5 && frame > 300) {
      // 基本稳定了,降到 ~10fps
      mmGraphAnim = requestAnimationFrame(() => { mmGraphAnim = requestAnimationFrame(tick) as unknown as number; }) as unknown as number;
      return;
    }
    mmGraphAnim = requestAnimationFrame(tick);
  }

  // ── 交互事件 ──
  canvas.addEventListener('mousedown', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    mouseDown = true;
    lastMX = sx; lastMY = sy;
    const hit = hitTest(sx, sy);
    if (hit) {
      dragging = hit;
      canvas.style.cursor = 'grabbing';
    }
  });
  canvas.addEventListener('mousemove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    if (dragging) {
      const [wx, wy] = s2w(sx, sy);
      dragging.x = wx; dragging.y = wy;
      // 拖拽时重新激活模拟
      frame = 0;
    } else if (mouseDown) {
      // 拖拽画布 → 平移
      panX += sx - lastMX;
      panY += sy - lastMY;
      lastMX = sx; lastMY = sy;
    } else {
      // hover 检测
      const hit = hitTest(sx, sy);
      if (hit !== hoverNode) {
        hoverNode = hit;
        canvas.style.cursor = hit ? 'pointer' : 'default';
        // tip 栏显示关联信息
        if (hit) {
          const rels = edges.filter((e) => e.from === hit.label || e.to === hit.label);
          tipBar.querySelector('span')!.textContent = `${hit.label} · ${rels.length} 条关系`;
        } else {
          tipBar.querySelector('span')!.textContent = `拖拽节点 · 滚轮缩放 · ${tr('graph.tip')}`;
        }
      }
    }
  });
  canvas.addEventListener('mouseup', () => {
    dragging = null;
    mouseDown = false;
    canvas.style.cursor = hoverNode ? 'pointer' : 'default';
  });
  canvas.addEventListener('mouseleave', () => {
    dragging = null;
    mouseDown = false;
    hoverNode = null;
  });
  // 滚轮缩放
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    const delta = ev.deltaY > 0 ? 0.9 : 1.1;
    // 以鼠标位置为中心缩放
    const [wx, wy] = s2w(sx, sy);
    zoom = Math.max(0.3, Math.min(3, zoom * delta));
    panX = sx - wx * zoom;
    panY = sy - wy * zoom;
  }, { passive: false });
  // 双击节点 → 删除关联三元组
  canvas.addEventListener('dblclick', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
    if (hit && confirm(tr('graph.delNode').replace('{n}', hit.label))) {
      // 删除该节点相关的所有三元组
      const rels = edges.filter((e) => e.from === hit.label || e.to === hit.label);
      Promise.all(rels.map((r) => api.memoryTripleDelete(r.tripleId))).then(() => renderMemoryGraph());
    }
  });

  // 启动动画
  stopGraphAnim();
  mmGraphAnim = requestAnimationFrame(tick);
}
// 把某行变成 textarea + 保存/取消。
function memEdit(row: HTMLElement, id: string): void {
  const original = row.querySelector<HTMLElement>('.mm-text')!.textContent ?? '';
  row.innerHTML = `<textarea class="mm-input"></textarea>
    <div class="mm-actions">
      <button class="primary mm-save">${esc(tr('mem.save'))}</button>
      <button class="ghost mm-cancel">${esc(tr('mem.cancel'))}</button>
    </div>`;
  const ta = row.querySelector<HTMLTextAreaElement>('.mm-input')!;
  ta.value = original;
  ta.focus();
  ta.select();
  row.querySelector<HTMLElement>('.mm-save')!.onclick = async () => {
    const v = ta.value.trim();
    if (!v) return;
    await api.memoryUpdate(id, v);
    await renderMemoryList();
  };
  row.querySelector<HTMLElement>('.mm-cancel')!.onclick = () => void renderMemoryList();
}
// 来源频道显示:customTitle > cwd 末段 > 兜底文案
function convLabel(convId: string): string {
  const c = convs.get(convId);
  if (!c) return tr('mem.unknownConv');
  if (c.customTitle) return c.customTitle;
  if (c.cwd) return c.cwd.split(/[\\/]/).pop() ?? c.cwd;
  return tr('mem.unknownConv');
}

// 快照面板(⏪):write_file/edit_file 写前自动存原文到 <cwd>/.kinet-snapshots/,这里列出 + 一键 restore。
// scope:this = 当前选中频道的快照;all = 当前 cwd 下全部频道的快照。
let snapScope: 'this' | 'all' = 'this';
async function openSnapshotPanel(): Promise<void> {
  snapScope = selectedId ? 'this' : 'all';
  document.getElementById('snapshot-modal')!.classList.add('show');
  await renderSnapshotList();
}
function closeSnapshotPanel(): void {
  document.getElementById('snapshot-modal')!.classList.remove('show');
}
async function renderSnapshotList(): Promise<void> {
  const listEl = document.getElementById('snap-list')!;
  document.getElementById('snap-scope-this')!.classList.toggle('active', snapScope === 'this');
  document.getElementById('snap-scope-all')!.classList.toggle('active', snapScope === 'all');
  const sel = selectedId ? convs.get(selectedId) : undefined;
  const cwd = sel?.cwd ?? '';
  if (!cwd) {
    listEl.innerHTML = `<div class="mm-empty">${esc(tr('snap.noCwd'))}</div>`;
    return;
  }
  const convId = snapScope === 'this' && selectedId ? selectedId : undefined;
  const r = await api.snapshotList(cwd, convId);
  if (!r.ok || !r.items) {
    listEl.innerHTML = `<div class="mm-empty">${esc(r.error ?? 'error')}</div>`;
    return;
  }
  if (!r.items.length) {
    listEl.innerHTML = `<div class="mm-empty">${esc(tr('snap.empty'))}</div>`;
    return;
  }
  listEl.innerHTML = r.items
    .map((s) => {
      const rel = relativize(s.absPath, cwd);
      const when = new Date(s.ts).toLocaleString();
      const from = convLabel(s.convId);
      return `<div class="mm-row" data-id="${esc(s.id)}">
        <div class="mm-text snap-path">${esc(rel)}</div>
        <div class="mm-from">${esc(s.tool)} · ${esc(when)} · ${esc(from)}</div>
        <div class="mm-actions">
          <button class="ghost snap-restore" data-i18n="snap.restore">${esc(tr('snap.restore'))}</button>
        </div>
      </div>`;
    })
    .join('');
  listEl.querySelectorAll<HTMLElement>('.mm-row').forEach((row) => {
    const id = row.dataset.id!;
    row.querySelector<HTMLElement>('.snap-restore')!.onclick = async () => {
      if (!confirm(tr('snap.restoreConfirm'))) return;
      const res = await api.snapshotRestore(cwd, id);
      if (!res.ok) {
        alert(res.error ?? 'restore failed');
        return;
      }
      await renderSnapshotList();
    };
  });
}
// abs 路径相对化(只显示项目内相对路径,项目外保留绝对)。 Ponytail: 简单前缀匹配。
function relativize(abs: string, cwd: string): string {
  if (abs.startsWith(cwd)) {
    const rel = abs.slice(cwd.length).replace(/^[\\/]+/, '');
    return rel || abs;
  }
  return abs;
}

const PRESETS = [
  { id: 'glm', labelKey: 'preset.glm', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.2', proto: 'openai', pin: 0.07, pout: 0.21 },
  { id: 'deepseek', labelKey: 'preset.deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', proto: 'openai', pin: 0.27, pout: 1.1 },
  { id: 'qwen', labelKey: 'preset.qwen', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max', proto: 'openai', pin: 0.29, pout: 0.86 },
  { id: 'ollama', labelKey: 'preset.ollama', baseURL: 'http://localhost:11434/v1', model: 'llama3.2', proto: 'openai', pin: 0, pout: 0 },
  { id: 'custom', labelKey: 'preset.custom', baseURL: '', model: '', proto: 'openai', pin: 0, pout: 0 },
];
const REASONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// MARK: 定时任务面板(cron)—— 「⋯ → 📅」入口
type CronItem = { id: string; cron: string; prompt: string; cwd: string | null; enabled: boolean; lastRun: number | null; createdAt: number };
async function openCronPanel(): Promise<void> {
  document.getElementById('cron-modal')!.classList.add('show');
  document.getElementById('cron-close')!.onclick = () => document.getElementById('cron-modal')!.classList.remove('show');
  document.getElementById('cron-new')!.onclick = () => editCronItem(null);
  await renderCronList();
}
async function renderCronList(): Promise<void> {
  const listEl = document.getElementById('cron-list')!;
  const r = await api.cronList();
  if (!r.ok || !r.items) {
    listEl.innerHTML = `<div class="mm-empty">${esc(r.error ?? 'error')}</div>`;
    return;
  }
  if (!r.items.length) {
    listEl.innerHTML = `<div class="mm-empty">${esc(tr('cron.empty'))}</div>`;
    return;
  }
  listEl.innerHTML = r.items
    .map((t) => {
      const last = t.lastRun ? new Date(t.lastRun).toLocaleString() : '—';
      return `<div class="mm-row cron-row" data-id="${esc(t.id)}">
        <div class="cron-row-head">
          <span class="cron-expr ${t.enabled ? '' : 'disabled'}">${esc(t.cron)}</span>
          <span class="cron-toggle">${t.enabled ? '✓' : '✗'}</span>
        </div>
        <div class="cron-prompt">${esc(t.prompt.slice(0, 200))}${t.prompt.length > 200 ? '…' : ''}</div>
        <div class="cron-meta">${esc(t.cwd ?? tr('cron.noCwd'))} · ${esc(tr('cron.lastRun'))}: ${esc(last)}</div>
        <div class="mm-actions">
          <button class="ghost cron-edit">${esc(tr('cron.edit'))}</button>
          <button class="ghost cron-toggle-btn">${t.enabled ? esc(tr('cron.pause')) : esc(tr('cron.enable'))}</button>
          <button class="ghost cron-del">${esc(tr('cron.delete'))}</button>
        </div>
      </div>`;
    })
    .join('');
  listEl.querySelectorAll<HTMLElement>('.cron-row').forEach((row) => {
    const id = row.dataset.id!;
    row.querySelector('.cron-edit')!.addEventListener('click', () => editCronItem(id));
    row.querySelector('.cron-del')!.addEventListener('click', async () => {
      if (!confirm(tr('cron.delConfirm'))) return;
      await api.cronDelete(id);
      renderCronList();
    });
    row.querySelector('.cron-toggle-btn')!.addEventListener('click', async () => {
      const item = (r.items ?? []).find((x) => x.id === id);
      if (!item) return;
      await api.cronUpdate(id, { enabled: !item.enabled });
      renderCronList();
    });
  });
}
function editCronItem(id: string | null): void {
  // 用 prompt-modal 改 cron / prompt / cwd,简单粗暴(没有自定义弹窗的工程量)。
  // ponytail: 用 prompt() 三连问,后续可换专门的编辑表单。
  const overlay = document.getElementById('cron-modal')!;
  // 直接在 cron-modal 上叠一个内联编辑卡。复用现有 DOM 不开新 modal。
  let existing = document.getElementById('cron-edit-card');
  if (existing) existing.remove();
  const card = document.createElement('div');
  card.id = 'cron-edit-card';
  card.className = 'cron-edit-card';
  // 先 load 现有值(编辑模式)。新建模式默认 cron=每分钟、cwd=当前会话 cwd。
  const cur = id ? null : { cron: '0 * * * *', prompt: '', cwd: selectedId ? convs.get(selectedId)?.cwd ?? '' : '' };
  card.innerHTML = `
    <h4>${id ? esc(tr('cron.editTitle')) : esc(tr('cron.newTitle'))}</h4>
    <label>${esc(tr('cron.cronLabel'))} <input id="ce-cron" value="${id ? '' : esc(cur!.cron)}" placeholder="分 时 日 月 周 (如 0 9 * * 1 = 每周一 9 点)"/></label>
    <label>${esc(tr('cron.promptLabel'))} <textarea id="ce-prompt" rows="3" placeholder="要自动执行的任务描述…"></textarea></label>
    <label>${esc(tr('cron.cwdLabel'))} <input id="ce-cwd" value="${id ? '' : esc(cur!.cwd)}" placeholder="(可选)工作目录"/></label>
    <div class="cron-edit-actions">
      <button class="ghost" id="ce-cancel">${esc(tr('common.cancel'))}</button>
      <button class="primary" id="ce-save">${esc(tr('common.ok'))}</button>
    </div>
  `;
  overlay.querySelector('.modal-card')!.appendChild(card);
  // 编辑模式:异步拉详情回填
  if (id) {
    api.cronList().then((r) => {
      const item = (r.items ?? []).find((x) => x.id === id);
      if (!item) return;
      (document.getElementById('ce-cron') as HTMLInputElement).value = item.cron;
      (document.getElementById('ce-prompt') as HTMLTextAreaElement).value = item.prompt;
      (document.getElementById('ce-cwd') as HTMLInputElement).value = item.cwd ?? '';
    });
  }
  document.getElementById('ce-cancel')!.onclick = () => card.remove();
  document.getElementById('ce-save')!.onclick = async () => {
    const cron = (document.getElementById('ce-cron') as HTMLInputElement).value.trim();
    const prompt = (document.getElementById('ce-prompt') as HTMLTextAreaElement).value.trim();
    const cwd = (document.getElementById('ce-cwd') as HTMLInputElement).value.trim();
    if (!cron || !prompt) return;
    const v = await api.cronValidate(cron);
    if (!v.ok) { alert(v.error); return; }
    if (id) {
      await api.cronUpdate(id, { cron, prompt, cwd: cwd || undefined });
    } else {
      await api.cronAdd({ id: crypto.randomUUID(), cron, prompt, cwd: cwd || undefined });
    }
    card.remove();
    renderCronList();
  };
}

// ──────────────────────────────────────────────────────────────────────
// MARK: Pipeline 跨引擎编排 UI
// ──────────────────────────────────────────────────────────────────────

// pipeline 编辑器状态
let pipelineStages: Array<{ engine: EngineKind; prompt: string; label: string }> = [];
let pipelineName = '';

function renderPipeline(): void {
  const root = document.getElementById('pipeline-root')!;
  const cwd = selectedId ? convs.get(selectedId)?.cwd ?? '' : '';
  root.innerHTML = `
    <div class="pl-head">
      <div class="pl-title">${esc(tr('pipeline.title'))}</div>
      <div class="pl-sub">${esc(tr('pipeline.sub'))}</div>
    </div>
    <div class="pl-editor">
      <div class="pl-field">
        <label>${esc(tr('pipeline.name'))}</label>
        <input id="pl-name" value="${esc(pipelineName)}" placeholder="${esc(tr('pipeline.namePh'))}" />
      </div>
      <div class="pl-field">
        <label>${esc(tr('pipeline.cwd'))}</label>
        <div class="row">
          <input id="pl-cwd" value="${esc(cwd)}" placeholder="${esc(tr('head.cwdPh'))}" />
          <button class="ghost" id="pl-pick">${esc(tr('head.pickDir'))}</button>
        </div>
      </div>
      <div class="pl-stages-label">${esc(tr('pipeline.stages'))}</div>
      <div id="pl-stages"></div>
      <div class="pl-add-stage">
        <button class="ghost" id="pl-add">${esc(tr('pipeline.addStage'))}</button>
      </div>
      <div class="pl-actions">
        <button class="primary" id="pl-run">${esc(tr('pipeline.run'))}</button>
        <button class="ghost" id="pl-save">${esc(tr('pipeline.save'))}</button>
        <span class="test-msg" id="pl-msg"></span>
      </div>
    </div>
    <div class="pl-templates">
      <h3>${esc(tr('pipeline.saved'))}</h3>
      <div id="pl-saved-list"></div>
    </div>
  `;

  // 初始 stage 列表
  if (!pipelineStages.length) {
    pipelineStages = [
      { engine: 'direct', prompt: '', label: 'Step 1' },
    ];
  }
  renderPipelineStages();
  renderPipelineSaved();

  document.getElementById('pl-add')!.onclick = () => {
    pipelineStages.push({ engine: 'direct', prompt: '', label: `Step ${pipelineStages.length + 1}` });
    renderPipelineStages();
  };
  document.getElementById('pl-pick')!.onclick = async () => {
    const dir = await api.pickDirectory();
    if (dir) (document.getElementById('pl-cwd') as HTMLInputElement).value = dir;
  };
  document.getElementById('pl-run')!.onclick = async () => {
    const name = (document.getElementById('pl-name') as HTMLInputElement).value.trim() || 'Pipeline';
    const cwdVal = (document.getElementById('pl-cwd') as HTMLInputElement).value.trim();
    if (!cwdVal) { showPlMsg(tr('pipeline.noCwd'), false); return; }
    // 从 DOM 读回所有 stage 数据
    collectPipelineStages();
    const valid = pipelineStages.filter((s) => s.prompt.trim());
    if (!valid.length) { showPlMsg(tr('pipeline.empty'), false); return; }
    showPlMsg(tr('pipeline.running'), true);
    const r = await api.pipelineRun({ name, stages: valid, cwd: cwdVal });
    if (r.ok && r.convId) {
      showPlMsg(tr('pipeline.done'), true);
      selectedId = r.convId;
      showChat();
      renderSidebar();
    } else {
      showPlMsg(r.error ?? 'error', false);
    }
  };
  document.getElementById('pl-save')!.onclick = async () => {
    const name = (document.getElementById('pl-name') as HTMLInputElement).value.trim();
    if (!name) { showPlMsg(tr('pipeline.nameRequired'), false); return; }
    const cwdVal = (document.getElementById('pl-cwd') as HTMLInputElement).value.trim();
    collectPipelineStages();
    await api.pipelineSave({ id: crypto.randomUUID(), name, stages: pipelineStages, cwd: cwdVal, createdAt: Date.now() });
    showPlMsg(tr('pipeline.savedOk'), true);
    renderPipelineSaved();
  };
}

function showPlMsg(text: string, ok: boolean): void {
  const el = document.getElementById('pl-msg')!;
  el.textContent = text;
  el.className = 'test-msg ' + (ok ? 'ok' : 'bad');
}

function renderPipelineStages(): void {
  const container = document.getElementById('pl-stages')!;
  container.innerHTML = pipelineStages.map((s, i) => `
    <div class="pl-stage" data-idx="${i}">
      <div class="pl-stage-head">
        <input class="pl-stage-label" value="${esc(s.label)}" placeholder="Step ${i + 1}" />
        <select class="pl-stage-engine">
          <option value="direct" ${s.engine === 'direct' ? 'selected' : ''}>Kaios (Direct)</option>
          ${cliEnabled ? `<option value="claudeCode" ${s.engine === 'claudeCode' ? 'selected' : ''}>Claude Code</option>` : ''}
          ${cliEnabled ? `<option value="codex" ${s.engine === 'codex' ? 'selected' : ''}>Codex</option>` : ''}
        </select>
        ${pipelineStages.length > 1 ? `<button class="ghost pl-stage-del" data-idx="${i}">✕</button>` : ''}
      </div>
      <textarea class="pl-stage-prompt" placeholder="${esc(tr('pipeline.stagePrompt'))}">${esc(s.prompt)}</textarea>
    </div>
  `).join('');
  // 绑定删除
  container.querySelectorAll<HTMLElement>('.pl-stage-del').forEach((btn) => {
    btn.onclick = () => {
      const idx = Number(btn.dataset.idx);
      pipelineStages.splice(idx, 1);
      renderPipelineStages();
    };
  });
}

function collectPipelineStages(): void {
  const stages = document.querySelectorAll<HTMLElement>('.pl-stage');
  pipelineStages = Array.from(stages).map((el, i) => ({
    engine: (el.querySelector('.pl-stage-engine') as HTMLSelectElement).value as EngineKind,
    prompt: (el.querySelector('.pl-stage-prompt') as HTMLTextAreaElement).value,
    label: (el.querySelector('.pl-stage-label') as HTMLInputElement).value || `Step ${i + 1}`,
  }));
}

async function renderPipelineSaved(): Promise<void> {
  const list = document.getElementById('pl-saved-list');
  if (!list) return;
  const templates = await api.pipelineTemplates();
  if (!templates.length) {
    list.innerHTML = `<div class="pl-empty">${esc(tr('pipeline.noSaved'))}</div>`;
    return;
  }
  list.innerHTML = templates.map((t) => `
    <div class="pl-saved-item" data-id="${esc(t.id)}">
      <div class="pl-saved-name">${esc(t.name)}</div>
      <div class="pl-saved-meta">${t.stages.length} steps · ${esc(t.stages.map((s: any) => s.label || s.engine).join(' → '))}</div>
      <div class="pl-saved-actions">
        <button class="ghost pl-load" data-id="${esc(t.id)}">${esc(tr('pipeline.load'))}</button>
        <button class="ghost pl-del-saved" data-id="${esc(t.id)}">${esc(tr('pipeline.delete'))}</button>
      </div>
    </div>
  `).join('');
  list.querySelectorAll<HTMLElement>('.pl-load').forEach((btn) => {
    btn.onclick = () => {
      const tpl = templates.find((t) => t.id === btn.dataset.id);
      if (!tpl) return;
      pipelineName = tpl.name;
      pipelineStages = tpl.stages.map((s: any) => ({ ...s }));
      (document.getElementById('pl-name') as HTMLInputElement).value = tpl.name;
      if (tpl.cwd) (document.getElementById('pl-cwd') as HTMLInputElement).value = tpl.cwd;
      renderPipelineStages();
    };
  });
  list.querySelectorAll<HTMLElement>('.pl-del-saved').forEach((btn) => {
    btn.onclick = async () => {
      await api.pipelineDelete(btn.dataset.id!);
      renderPipelineSaved();
    };
  });
}

// ──────────────────────────────────────────────────────────────────────
// MARK: 模板库 UI
// ──────────────────────────────────────────────────────────────────────

function renderTemplates(): void {
  const root = document.getElementById('templates-root')!;
  root.innerHTML = `<div class="tpl-loading">${esc(tr('common.loading'))}</div>`;
  api.templateList().then((templates) => {
    // 按 category 分组
    const groups = new Map<string, typeof templates>();
    for (const tpl of templates) {
      const cat = tpl.category || '其他';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(tpl);
    }
    root.innerHTML = `
      <div class="tpl-head">
        <div class="tpl-title">${esc(tr('templates.title'))}</div>
        <div class="tpl-sub">${esc(tr('templates.sub'))}</div>
      </div>
      <div class="tpl-body">
        ${[...groups.entries()].map(([cat, items]) => `
          <div class="tpl-cat">
            <h3>${esc(cat)}</h3>
            <div class="tpl-grid">
              ${items.map((tpl) => `
                <div class="tpl-card" data-id="${esc(tpl.id)}">
                  <div class="tpl-card-icon">${esc(tpl.icon || '📋')}</div>
                  <div class="tpl-card-name">${esc(tpl.name)}</div>
                  <div class="tpl-card-desc">${esc(tpl.description)}</div>
                  <div class="tpl-card-engine">${esc(ENGINE_LABELS[tpl.engine])}</div>
                  <div class="tpl-card-actions">
                    <button class="primary tpl-use" data-id="${esc(tpl.id)}">${esc(tr('templates.use'))}</button>
                    ${tpl.builtin ? '' : `<button class="ghost tpl-del" data-id="${esc(tpl.id)}">✕</button>`}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `;
    // 绑定使用按钮
    root.querySelectorAll<HTMLElement>('.tpl-use').forEach((btn) => {
      btn.onclick = async () => {
        const tpl = templates.find((t) => t.id === btn.dataset.id);
        if (!tpl) return;
        const cwd = selectedId ? convs.get(selectedId)?.cwd ?? '' : '';
        const conv = await api.newConversation(cwd || undefined, tpl.engine);
        selectedId = conv.id;
        showChat();
        renderSidebar();
        // 填入 prompt
        const composer = document.getElementById('composer') as HTMLTextAreaElement;
        composer.value = tpl.prompt;
        autosize(composer);
        composer.focus();
      };
    });
    root.querySelectorAll<HTMLElement>('.tpl-del').forEach((btn) => {
      btn.onclick = async () => {
        await api.templateDelete(btn.dataset.id!);
        renderTemplates();
      };
    });
  });
}

// ──────────────────────────────────────────────────────────────────────
// MARK: 成本看板 UI — Canvas 趋势图 + 预算熔断
// ──────────────────────────────────────────────────────────────────────

function renderCost(): void {
  const root = document.getElementById('cost-root')!;
  root.innerHTML = `<div class="cost-loading">${esc(tr('common.loading'))}</div>`;
  Promise.all([api.getCostStats(), api.getBudget()]).then(([stats, budget]) => {
    budgetCache = budget;
    const hasData = stats.today > 0 || stats.week > 0 || stats.month > 0 || Object.keys(stats.byEngine).length > 0;
    root.innerHTML = `
      <div class="cost-head">
        <div class="cost-title">${esc(tr('cost.title'))}</div>
        <div class="cost-sub">${esc(tr('cost.sub'))}</div>
      </div>
      ${!hasData ? `<div class="cost-empty">${esc(tr('cost.noData'))}</div>` : `
      <div class="cost-overview">
        <div class="cost-card"><div class="cc-num">$${stats.today.toFixed(4)}</div><div class="cc-lbl">${esc(tr('cost.today'))}</div></div>
        <div class="cost-card"><div class="cc-num">$${stats.week.toFixed(4)}</div><div class="cc-lbl">${esc(tr('cost.week'))}</div></div>
        <div class="cost-card"><div class="cc-num">$${stats.month.toFixed(4)}</div><div class="cc-lbl">${esc(tr('cost.month'))}</div></div>
      </div>
      <div class="cost-chart-section">
        <h3>${esc(tr('cost.trend'))}</h3>
        <canvas id="cost-canvas" width="800" height="200"></canvas>
      </div>
      <div class="cost-engine-section">
        <h3>${esc(tr('cost.byEngine'))}</h3>
        <div class="cost-engines">
          ${Object.entries(stats.byEngine).map(([eng, cost]) => {
            const maxC = Math.max(0.0001, ...Object.values(stats.byEngine));
            const pct = Math.round((cost / maxC) * 100);
            return `<div class="cost-eng">
              <span class="ce-name">${esc(ENGINE_LABELS[eng as EngineKind] || eng)}</span>
              <div class="ce-bar"><div class="ce-fill" style="width:${pct}%"></div></div>
              <span class="ce-val">$${cost.toFixed(4)}</span>
            </div>`;
          }).join('') || `<div class="cost-empty">${esc(tr('cost.noData'))}</div>`}
        </div>
      </div>`}
      <div class="cost-budget-section">
        <h3>${esc(tr('cost.budget'))}</h3>
        <div class="cost-budget-form">
          <div class="field">
            <label><input type="checkbox" id="cb-enabled" ${budget.enabled ? 'checked' : ''} style="width:auto;margin-right:6px" />${esc(tr('cost.budgetEnable'))}</label>
          </div>
          <div class="field">
            <label>${esc(tr('cost.perSession'))}</label>
            <input id="cb-session" type="number" step="0.01" value="${budget.perSessionLimit}" placeholder="0 = 不限" />
          </div>
          <div class="field">
            <label>${esc(tr('cost.dailyLimit'))}</label>
            <input id="cb-daily" type="number" step="0.01" value="${budget.dailyLimit}" placeholder="0 = 不限" />
          </div>
          <div class="field">
            <button class="primary" id="cb-save">${esc(tr('cost.saveBudget'))}</button>
            <span class="test-msg" id="cb-msg"></span>
          </div>
        </div>
      </div>
    `;
    // 画趋势图(仅在有数据时)
    if (hasData) drawCostChart(stats.byDay);
    // 保存预算
    document.getElementById('cb-save')!.onclick = async () => {
      const b = {
        enabled: (document.getElementById('cb-enabled') as HTMLInputElement).checked,
        perSessionLimit: Number((document.getElementById('cb-session') as HTMLInputElement).value) || 0,
        dailyLimit: Number((document.getElementById('cb-daily') as HTMLInputElement).value) || 0,
      };
      const r = await api.saveBudget(b);
      const msg = document.getElementById('cb-msg')!;
      msg.textContent = r.ok ? tr('cost.budgetSaved') : 'error';
      msg.className = 'test-msg ' + (r.ok ? 'ok' : 'bad');
      if (r.ok) budgetCache = b;
    };
  });
}

// Canvas 画 14 天成本趋势柱状图(零依赖)
function drawCostChart(data: Array<{ date: string; cost: number }>): void {
  const canvas = document.getElementById('cost-canvas') as HTMLCanvasElement;
  if (!canvas) return;
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth || 800;
  const ch = 200;
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;
  ctx.scale(dpr, dpr);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-elev').trim() || '#242429';
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e8b339';
  const border = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#34343c';
  const textDim = getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim() || '#9a9aa4';
  // 背景
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cw, ch);
  const maxCost = Math.max(0.001, ...data.map((d) => d.cost));
  const barW = (cw - 40) / data.length;
  const chartH = ch - 50;
  // 轴线
  ctx.strokeStyle = border;
  ctx.beginPath();
  ctx.moveTo(30, 10);
  ctx.lineTo(30, chartH + 10);
  ctx.lineTo(cw - 10, chartH + 10);
  ctx.stroke();
  // 柱状
  data.forEach((d, i) => {
    const h = maxCost > 0 ? (d.cost / maxCost) * chartH : 0;
    const x = 32 + i * barW;
    const y = chartH + 10 - h;
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, barW - 3, h);
    // x 轴日期(只显示 月/日)
    if (i % 2 === 0) {
      ctx.fillStyle = textDim;
      ctx.font = '10px sans-serif';
      const label = d.date.slice(5); // MM-DD
      ctx.fillText(label, x, chartH + 22);
    }
  });
  // y 轴最大值标注
  ctx.fillStyle = textDim;
  ctx.font = '10px sans-serif';
  ctx.fillText(`$${maxCost.toFixed(4)}`, 2, 15);
}

// ──────────────────────────────────────────────────────────────────────
// MARK: 会话分支 — 在 turn 菜单中添加"从此处分叉"
// ──────────────────────────────────────────────────────────────────────

async function branchFromTurn(convId: string, turnIdx: number): Promise<void> {
  const r = await api.branchFromTurn(convId, turnIdx);
  if (r.ok && r.convId) {
    selectedId = r.convId;
    showChat();
    renderSidebar();
  }
}

// ──────────────────────────────────────────────────────────────────────
// MARK: 可视化规则生成器 — 在 rules tab 中添加
// ──────────────────────────────────────────────────────────────────────

function openRuleGenerator(): void {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'rule-gen-modal';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:560px">
      <h3>${esc(tr('rules.gen.title'))}</h3>
      <div class="rg-body">
        <div class="field"><label>${esc(tr('rules.gen.lang'))}</label><select id="rg-lang">
          <option value="typescript">TypeScript</option>
          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
          <option value="rust">Rust</option>
          <option value="go">Go</option>
          <option value="swift">Swift</option>
        </select></div>
        <div class="field"><label>${esc(tr('rules.gen.naming'))}</label><select id="rg-naming">
          <option value="camelCase">camelCase</option>
          <option value="PascalCase">PascalCase</option>
          <option value="snake_case">snake_case</option>
          <option value="SCREAMING_SNAKE">SCREAMING_SNAKE (常量)</option>
        </select></div>
        <div class="field"><label>${esc(tr('rules.gen.indent'))}</label><select id="rg-indent">
          <option value="2spaces">2 空格</option>
          <option value="4spaces">4 空格</option>
          <option value="tabs">Tab</option>
        </select></div>
        <div class="field"><label>${esc(tr('rules.gen.comment'))}</label><select id="rg-comment">
          <option value="bilingual">中英双语</option>
          <option value="chinese">仅中文</option>
          <option value="english">仅英文</option>
          <option value="none">不加注释</option>
        </select></div>
        <div class="field"><label>${esc(tr('rules.gen.banned'))}</label><input id="rg-banned" placeholder="eval, exec, ..." /></div>
        <div class="field"><label>${esc(tr('rules.gen.extra'))}</label><textarea id="rg-extra" rows="3" placeholder="${esc(tr('rules.gen.extraPh'))}"></textarea></div>
      </div>
      <div class="actions">
        <button id="rg-cancel">${esc(tr('common.cancel'))}</button>
        <button class="primary" id="rg-gen">${esc(tr('rules.gen.generate'))}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('rg-cancel')!.onclick = () => modal.remove();
  document.getElementById('rg-gen')!.onclick = async () => {
    const cfg = {
      codeStyle: (document.getElementById('rg-lang') as HTMLSelectElement).value,
      namingConvention: (document.getElementById('rg-naming') as HTMLSelectElement).value,
      indent: (document.getElementById('rg-indent') as HTMLSelectElement).value as 'tabs' | '2spaces' | '4spaces',
      commentStyle: (document.getElementById('rg-comment') as HTMLSelectElement).value as 'bilingual' | 'chinese' | 'english' | 'none',
      bannedApis: (document.getElementById('rg-banned') as HTMLInputElement).value,
      extraRules: (document.getElementById('rg-extra') as HTMLTextAreaElement).value,
    };
    const r = await api.rulesGenerate(cfg);
    if (r.ok && r.content) {
      // 写入 rules editor
      if (rulesEditor) rulesEditor.value = r.content;
      modal.remove();
    }
  };
}

// ── Custom Tools 视图 ──
// 用户通过 UI 注册自定义工具(name + JSON Schema + shell 命令模板),Direct 引擎自动加载。
async function renderCTools(): Promise<void> {
  const root = document.getElementById('ctools-view')!;
  const r = await api.customToolList();
  const items = r.ok ? r.items ?? [] : [];
  root.innerHTML = `
    <div class="card">
      <h2>${tr('ctool.title')}</h2>
      <div class="sub">${tr('ctool.sub')}</div>
      <button id="ct-add" class="primary" style="margin:12px 0">${tr('ctool.add')}</button>
      <div id="ct-list"></div>
    </div>
  `;
  const listEl = document.getElementById('ct-list')!;
  if (!items.length) {
    listEl.innerHTML = `<div class="empty-hint">${tr('ctool.empty')}</div>`;
  } else {
    listEl.innerHTML = items.map((it) => `
      <div class="ctool-card" data-id="${it.id}">
        <div class="ctool-head">
          <div class="ctool-title-row">
            <strong>${esc(it.name)}</strong>
          </div>
          <span class="ctool-actions">
            <button class="ghost sm ct-edit" data-id="${it.id}">${tr('common.edit')}</button>
            <button class="ghost sm ct-del">${tr('ctool.delete')}</button>
          </span>
        </div>
        ${it.description ? `<div class="ctool-desc">${esc(it.description)}</div>` : ''}
        <div class="ctool-cmd"><code>${esc(it.commandTpl)}</code></div>
      </div>
    `).join('');
    listEl.querySelectorAll<HTMLElement>('.ct-del').forEach((btn) => {
      btn.onclick = async () => {
        const card = btn.closest('.ctool-card') as HTMLElement;
        await api.customToolDelete(card.dataset.id!);
        showMsg(tr('ctool.deleted'), true);
        renderCTools();
      };
    });
    listEl.querySelectorAll<HTMLElement>('.ct-edit').forEach((btn) => {
      btn.onclick = () => {
        const item = items.find((i) => i.id === btn.dataset.id);
        if (item) openCToolEditor(item);
      };
    });
  }
  document.getElementById('ct-add')!.onclick = () => openCToolEditor(null);
}

function openCToolEditor(existing: { id: string; name: string; description: string; parameters: Record<string, unknown>; commandTpl: string; timeoutMs: number } | null): void {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:560px">
      <h3>${tr('ctool.title')}</h3>
      <div class="settings-grid">
        <div class="field"><label>${tr('ctool.name')}</label><input id="ct-name" placeholder="${esc(tr('ctool.namePh'))}" value="${existing?.name ?? ''}" /></div>
        <div class="field"><label>${tr('ctool.desc')}</label><input id="ct-desc" placeholder="${esc(tr('ctool.descPh'))}" value="${existing?.description ?? ''}" /></div>
        <div class="field"><label>${tr('ctool.cmd')}</label><input id="ct-cmd" placeholder="${esc(tr('ctool.cmdPh'))}" value="${existing?.commandTpl ?? ''}" /></div>
        <div class="field"><label>${tr('ctool.timeout')}</label><input id="ct-timeout" type="number" value="${existing?.timeoutMs ?? 120}" /></div>
        <div class="field" style="grid-column:1/-1"><label>${tr('ctool.params')}</label><textarea id="ct-params" rows="4" placeholder="${esc(tr('ctool.paramsPh'))}">${existing ? esc(JSON.stringify(existing.parameters, null, 2)) : ''}</textarea></div>
      </div>
      <div class="actions">
        <button id="ct-cancel">${tr('common.cancel')}</button>
        <button class="primary" id="ct-save">${tr('ctool.save')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('ct-cancel')!.onclick = () => modal.remove();
  document.getElementById('ct-save')!.onclick = async () => {
    const name = (document.getElementById('ct-name') as HTMLInputElement).value.trim();
    if (!name) { alert(tr('ctool.nameRequired')); return; }
    await api.customToolSave({
      id: existing?.id ?? '',
      name,
      description: (document.getElementById('ct-desc') as HTMLInputElement).value,
      parameters: JSON.parse((document.getElementById('ct-params') as HTMLTextAreaElement).value || '{}'),
      commandTpl: (document.getElementById('ct-cmd') as HTMLInputElement).value,
      timeoutMs: Number((document.getElementById('ct-timeout') as HTMLInputElement).value) || 120,
    });
    modal.remove();
    showMsg(tr('ctool.saved'), true);
    renderCTools();
  };
}

// ── 记忆时间线视图 ──
async function renderTimeline(): Promise<void> {
  const root = document.getElementById('timeline-view')!;
  const r = await api.memoryTimeline();
  const items = r.ok ? r.items ?? [] : [];
  const sorted = [...items].sort((a, b) => b.created_at - a.created_at);
  root.innerHTML = `
    <div class="card">
      <h2>${tr('mem.timeline')}</h2>
      <div class="sub">${tr('mem.timelineSub')}</div>
      <div style="margin:10px 0">
        <button id="mem-decay-btn" class="ghost">${tr('mem.decay')}</button>
        <span class="sub" style="margin-left:8px">${tr('mem.pruneThreshold')}</span>
      </div>
      <div id="mem-tl-list"></div>
    </div>
  `;
  const listEl = document.getElementById('mem-tl-list')!;
  if (!sorted.length) {
    listEl.innerHTML = `<div class="empty-hint">${esc(tr('mem.empty'))}</div>`;
  } else {
    listEl.innerHTML = sorted.map((m) => {
      const date = new Date(m.created_at).toLocaleString();
      const w = Math.round(m.weight * 100);
      const wColor = w > 60 ? '#4caf50' : w > 30 ? '#e8b339' : '#f44336';
      const wLabel = w > 60 ? '高' : w > 30 ? '中' : '低';
      return `<div class="mem-tl-item" style="border-left-color:${wColor}">
        <div class="mem-tl-row">
          <span class="mem-tl-badge" style="background:${wColor}1a;color:${wColor}">${wLabel} ${w}%</span>
          <span class="mem-tl-date">${date}</span>
          <span class="mem-tl-used">使用 ${m.useCount} 次</span>
        </div>
        <div class="mem-tl-text">${esc(m.content)}</div>
      </div>`;
    }).join('');
  }
  document.getElementById('mem-decay-btn')!.onclick = async () => {
    const dr = await api.memoryDecay();
    if (dr.ok) showMsg(tr('mem.decayDone', { n: dr.pruned ?? 0 }), true);
    renderTimeline();
  };
}

// ── 会话导出 ──
function openExportMenu(convId: string): void {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:360px;text-align:center">
      <h3>${tr('export.title')}</h3>
      <div style="display:flex;gap:8px;justify-content:center;margin:16px 0">
        <button class="primary" id="ex-md">${ICON.doc} ${tr('export.md')}</button>
        <button class="primary" id="ex-html">${ICON.globe} ${tr('export.html')}</button>
        <button class="primary" id="ex-json">{ } ${tr('export.json')}</button>
      </div>
      <button class="ghost" id="ex-cancel">${tr('common.cancel')}</button>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  document.getElementById('ex-cancel')!.onclick = close;
  document.getElementById('ex-md')!.onclick = async () => { close(); await doExport(convId, 'markdown'); };
  document.getElementById('ex-html')!.onclick = async () => { close(); await doExport(convId, 'html'); };
  document.getElementById('ex-json')!.onclick = async () => { close(); await doExport(convId, 'json'); };
}

async function doExport(convId: string, format: 'markdown' | 'html' | 'json'): Promise<void> {
  const r = await api.exportConversation(convId, format);
  if (r.ok && r.path) showMsg(tr('export.saved', { path: r.path }), true);
  else if (!r.ok && r.error !== 'cancelled') showMsg(tr('export.failed', { msg: r.error ?? '' }), false);
}

// ── Agent 行为回放模态框 ──
// 逐步展示某 turn 的工具调用(steps),高亮当前步骤,显示 args 和 result。
function openReplay(turnIdx: number): void {
  if (!selectedId) return;
  const conv = convs.get(selectedId);
  if (!conv) return;
  const turn = conv.turns[turnIdx];
  if (!turn || !turn.steps.length) { alert(tr('replay.noSteps')); return; }
  let stepIdx = 0;
  let playing = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  document.body.appendChild(modal);

  function render(): void {
    const step = turn.steps[stepIdx];
    const progress = `${stepIdx + 1} / ${turn.steps.length}`;
    modal.innerHTML = `
      <div class="modal-box" style="max-width:680px">
        <div class="replay-header">
          <h3>${tr('replay.title')} — ${tr('replay.step', { n: stepIdx + 1 })} (${progress})</h3>
        </div>
        <div class="replay-progress">
          ${turn.steps.map((_, i) => `<div class="replay-dot ${i < stepIdx ? 'done' : i === stepIdx ? 'active' : ''}"></div>`).join('')}
        </div>
        <div class="replay-body">
          <div class="replay-step">
            <div class="replay-tool">${ICON.wrench} ${esc(step.name)}</div>
            ${step.durationMs != null ? `<span class="replay-dur">${tr('replay.duration', { ms: step.durationMs })}</span>` : ''}
            <div class="replay-section">
              <div class="replay-label">${tr('replay.toolCall')}</div>
              <pre class="replay-args">${esc(step.args)}</pre>
            </div>
            <div class="replay-section">
              <div class="replay-label">${tr('replay.result')}</div>
              <pre class="replay-result">${esc(step.result.slice(0, 3000))}</pre>
            </div>
          </div>
        </div>
        <div class="replay-controls">
          <button id="rp-prev" class="ghost" ${stepIdx === 0 ? 'disabled' : ''}>${tr('replay.prev')}</button>
          <button id="rp-play" class="primary">${playing ? tr('replay.pause') : tr('replay.play')}</button>
          <button id="rp-next" class="ghost" ${stepIdx === turn.steps.length - 1 ? 'disabled' : ''}>${tr('replay.next')}</button>
          <button id="rp-close" class="ghost">${tr('common.cancel')}</button>
        </div>
      </div>
    `;
    document.getElementById('rp-close')!.onclick = () => { stop(); modal.remove(); };
    document.getElementById('rp-prev')!.onclick = () => { stop(); if (stepIdx > 0) { stepIdx--; render(); } };
    document.getElementById('rp-next')!.onclick = () => { stop(); if (stepIdx < turn.steps.length - 1) { stepIdx++; render(); } };
    document.getElementById('rp-play')!.onclick = () => {
      if (playing) { stop(); render(); return; }
      playing = true;
      timer = setInterval(() => {
        if (stepIdx < turn.steps.length - 1) { stepIdx++; render(); }
        else { stop(); showMsg(tr('replay.done'), true); }
      }, 1500);
      render();
    };
  }

  function stop(): void {
    playing = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  render();
}
