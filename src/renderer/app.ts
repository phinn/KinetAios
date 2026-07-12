// Dashboard renderer. Vanilla TS — no framework. Holds a local copy of conversations,
// applies streaming events, re-renders the changed bits. Settings + shell-confirm modal inline.
import { applyEvent, ENGINE_LABELS } from '../shared/types';
import { t, LANGS, type Lang } from '../shared/i18n';
import type { AppSettings, Conversation, EngineKind, GitSnapshot, KinetAPI, SkillInfo } from '../shared/types';
import { renderMarkdown as md } from './markdown';
import { mountFilesPane, type FilesPaneController } from './files-pane';

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
let currentView: 'chat' | 'settings' | 'workbench' = 'chat';
// 侧栏显示模式:grouped(按 cwd 分项目)或 flat(原始平铺)。localStorage 持久化。
let sidebarMode: 'grouped' | 'flat' = (localStorage.getItem('sb-mode') as 'grouped' | 'flat') || 'grouped';
const collapsedProjects = new Set<string>(); // sidebar 分组折叠状态(内存,不持久化)
const slashMenu = document.getElementById('slash-menu')!;
let skills: SkillInfo[] = []; // lazily fetched on first /
let slashItems: SkillInfo[] = []; // current filtered view
let slashIndex = 0;
let attachments: { name: string; content: string }[] = []; // 📎 选 / 拖入的文件,发送时拼进 prompt
let PRODUCT = 'KinetAios'; // 产品名(启动从 brand.json 读,所有显示处用这个)
let HOME_DIR = ''; // 用户主目录(brand API 同步拿到);cwd === HOME_DIR 时显示「未分类」
let lang: Lang = 'zh-CN'; // UI 语言(启动从 settings 读,切语言后更新 + applyI18nDOM)
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
function tr(key: string, params?: Record<string, string | number>): string {
  return t(lang, key, params);
}
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
  if (brandEl) brandEl.innerHTML = '<span class="spark">✨</span> ' + esc(PRODUCT);
  (document.getElementById('composer') as HTMLTextAreaElement).placeholder = tr('composer.placeholder', { product: PRODUCT });
  applyI18nDOM();

  const list = await api.getConversations();
  for (const c of list) {
    convs.set(c.id, c);
    order.push(c.id);
  }
  if (order.length) selectedId = order[0];

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
      `<span class="sb-chevron">${collapsed ? '▶' : '▼'}</span>` +
      `<span class="sb-pico">📁</span>` +
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
  li.innerHTML = `<span class="dot ${cls}"></span><span class="title-wrap"><span class="title">${esc(title)}</span><span class="sb-task-cwd">${esc(projName(c.cwd))}</span></span><span class="conv-actions"><button class="ca-btn" data-act="rename" title="${esc(tr('conv.rename'))}">✎</button><button class="ca-btn" data-act="delete" title="${esc(tr('conv.delete'))}">🗑</button></span>`;
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

// 加载当前 cwd 的 KINET.md 到 editor。空文件 → 空白 textarea(保存就创建文件)。
async function loadRules(cwd: string): Promise<void> {
  rulesCwd = cwd;
  const editor = document.getElementById('rules-editor') as HTMLTextAreaElement;
  const status = document.getElementById('rules-status')!;
  status.textContent = '';
  if (!cwd) {
    editor.value = '';
    editor.disabled = true;
    return;
  }
  editor.disabled = false;
  editor.value = '…';
  const r = await api.readRules(cwd);
  editor.value = r.ok ? r.content ?? '' : '';
  if (!r.ok) status.textContent = r.error ?? '';
}

async function saveRules(): Promise<void> {
  if (!rulesCwd) return;
  const editor = document.getElementById('rules-editor') as HTMLTextAreaElement;
  const status = document.getElementById('rules-status')!;
  status.textContent = '…';
  const r = await api.writeRules(rulesCwd, editor.value);
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
  branchEl.textContent = `🌿 ${snap.branch ?? ''} · ${snap.changes?.length ?? 0} ${tr('git.changes')}`;
  // changes
  if (!snap.changes?.length) {
    changesEl.innerHTML = `<div class="git-empty">${esc(tr('git.empty'))}</div>`;
  } else {
    changesEl.innerHTML = snap.changes
      .map(
        (c) =>
          `<div class="gc-row" data-path="${esc(c.path)}"><span class="gc-code ${esc(gitCodeSuffix(c.code))}">${esc(c.code)}</span><span class="gc-label">${esc(tr('git.stat' + gitCodeSuffix(c.code)))}</span><span class="gc-path">${esc(c.path)}</span></div>`,
      )
      .join('');
    changesEl.querySelectorAll<HTMLElement>('.gc-row').forEach((row) => {
      row.onclick = () => void showGitDiff({ file: row.dataset.path! });
    });
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
    sideTitleEl.innerHTML = `<button class="ghost git-back" id="git-back">← ${esc(tr('git.history'))}</button><span class="git-diff-title">${esc(gitState.view.title)}</span>`;
    sideListEl.innerHTML = gitState.view.contentHTML;
    document.getElementById('git-back')!.onclick = () => {
      gitState.view = { kind: 'history' };
      renderGit();
    };
  }
}

async function showGitDiff(opts: { file?: string; hash?: string }): Promise<void> {
  const cwd = selectedId ? convs.get(selectedId)?.cwd ?? '' : '';
  if (!cwd) return;
  const title = opts.hash
    ? `${tr('git.history')}: ${opts.hash}`
    : `${tr('git.diff')}: ${opts.file ?? ''}`;
  // 先占位再异步加载,体感更快。
  gitState.view = { kind: 'diff', title, contentHTML: '<pre class="git-diff"><span class="d-hunk">…</span></pre>' };
  renderGit();
  const r = await api.gitDiff(cwd, opts);
  // 文件 diff 走左右对比(看修改点更直观);commit show 涉及多文件,保留统一格式。
  const html = !r.ok
    ? `<pre class="git-diff"><span class="d-del">${esc(r.error ?? '')}</span></pre>`
    : opts.file
      ? renderSideBySide(r.diff || '')
      : colorGitDiff(r.diff || '');
  gitState.view = { kind: 'diff', title, contentHTML: html };
  renderGit();
}

// Diff 按行着色(统一格式,commit show 用)。+/-/@@/+++ --- 不同色;每行独立 esc。
function colorGitDiff(s: string): string {
  if (!s) return '<pre class="git-diff"><span class="d-hunk">(empty)</span></pre>';
  // git show 输出 = commit metadata + message + diff body。必须分离:message 里的 "- list 项"
  // 会被误判为 diff 删除行渲染成红色 → 乱。从首个 "diff --git" 行开始才算 diff body。
  const lines = s.split('\n');
  const diffStart = lines.findIndex((l) => l.startsWith('diff --git'));
  const meta = diffStart >= 0 ? lines.slice(0, diffStart) : [];
  const body = diffStart >= 0 ? lines.slice(diffStart) : lines;
  const metaHtml = meta.length
    ? meta.map((l) => `<span class="d-meta">${esc(l) || '&nbsp;'}</span>`).join('\n')
    : '';
  const bodyHtml = body
    .map((line) => {
      const e = esc(line);
      if (line.startsWith('+++') || line.startsWith('---')) return `<span class="d-hunk">${e}</span>`;
      if (line.startsWith('+')) return `<span class="d-add">${e}</span>`;
      if (line.startsWith('-')) return `<span class="d-del">${e}</span>`;
      if (line.startsWith('@@')) return `<span class="d-hunk">${e}</span>`;
      return e;
    })
    .join('\n');
  return `<pre class="git-diff">${metaHtml}${metaHtml && bodyHtml ? '\n' : ''}${bodyHtml}</pre>`;
}

// 文件 diff 的左右对比:把 unified diff 解析成对齐的「左旧 / 右新」行。
// ponytail: 同一 hunk 内连续的 - 与 + 按行配对(逐对对齐),多出来的用空行垫;不做 token 级 diff,够直观。
type SSRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'ctx'; ln: number; rn: number; text: string }
  | { kind: 'pair'; ln: number | null; lt: string; rn: number | null; rt: string; cls: string };
function renderSideBySide(diff: string): string {
  if (!diff || !diff.includes('@@')) return '<span class="d-hunk">(无差异)</span>';
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
      return `<tr class="${r.cls}"><td class="ss-num">${r.ln ?? ''}</td><td class="ss-txt">${esc(r.lt) || '&nbsp;'}</td><td class="ss-num">${r.rn ?? ''}</td><td class="ss-txt">${esc(r.rt) || '&nbsp;'}</td></tr>`;
    })
    .join('');
  return `<table class="git-ss"><thead><tr><th class="ss-num"></th><th>${esc(tr('git.before'))}</th><th class="ss-num"></th><th>${esc(tr('git.after'))}</th></tr></thead><tbody>${body}</tbody></table>`;
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
  userMsg.appendChild(bubble);
  userMsg.appendChild(avatarEl('🧑'));
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
      e.textContent = '⚠️ ' + t.error;
      body.appendChild(e);
    }
    aiMsg.appendChild(avatarEl('✨'));
    aiMsg.appendChild(body);
    wrap.appendChild(aiMsg);
  }
  return wrap;
}

function avatarEl(emoji: string): HTMLElement {
  const a = document.createElement('div');
  a.className = 'avatar';
  a.textContent = emoji;
  return a;
}

function renderStep(s: { name: string; args: string; result: string }): HTMLElement {
  const el = document.createElement('div');
  el.className = 'step';
  const det = document.createElement('details');
  det.innerHTML = `<summary><span class="name">🔧 ${esc(s.name)}</span></summary><pre></pre><pre></pre>`;
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
function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme;
}

async function showSettings() {
  currentView = 'settings';
  document.getElementById('chat-view')!.classList.remove('active');
  document.getElementById('workbench-view')!.classList.remove('active');
  document.getElementById('settings-view')!.classList.add('active');
  syncViewButtons();
  const s = await api.getSettings();
  const root = document.getElementById('settings')!;
  root.innerHTML = `
    <div class="card">
      <button id="s-back" class="ghost" style="margin-bottom:14px">${tr('settings.back')}</button>
      <h2>${tr('settings.title')}</h2>
      <div class="sub">${tr('settings.sub')}</div>

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
        <h3>${tr('settings.sec.ui')}</h3>
        <div class="field"><label>${tr('settings.lang')}</label><select id="s-lang">
          ${LANGS.map((l) => `<option value="${l.id}" ${l.id === s.lang ? 'selected' : ''}>${l.label}</option>`).join('')}
        </select></div>
        <div class="field"><label>${tr('settings.theme')}</label><select id="s-theme">
          <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>${tr('settings.theme.dark')}</option>
          <option value="light" ${s.theme === 'light' ? 'selected' : ''}>${tr('settings.theme.light')}</option>
        </select></div>
      </div>

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
  document.getElementById('s-back')!.onclick = () => showChat();
  document.getElementById('s-preset')!.onchange = apply;
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
    theme: (document.getElementById('s-theme') as HTMLSelectElement).value as 'dark' | 'light',
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
  document.getElementById('btn-dashboard')!.onclick = () => void api.openDashboard();
  document.getElementById('btn-files')!.onclick = () => {
    // 拿当前选中会话的 cwd 开 files 窗口;无选中会话则让 main 兜底用 os.homedir()。
    const c = selectedId ? convs.get(selectedId)?.cwd : undefined;
    void api.openFiles(c);
  };
  document.getElementById('btn-arena')!.onclick = () => {
    // 拿当前选中会话的 cwd;无则 main 兜底 homedir。Arena 在该 cwd 下三引擎并跑。
    const c = selectedId ? convs.get(selectedId)?.cwd : undefined;
    void api.openArena(c);
  };
  document.getElementById('btn-memory')!.onclick = () => void openMemoryPanel();

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
      ? list.map((s) => `<div class="mcp-srv"><div class="mcp-srv-name">🔌 ${esc(s.name)}<span class="mcp-src">${s.source}</span></div><div class="mcp-tools">${
          s.tools.length ? s.tools.map((tool) => `<span class="mcp-tool">${esc(tool)}</span>`).join('') : '<i>' + esc(tr('mcp.noTools')) + '</i>'
        }</div></div>`).join('')
      : '<div class="mcp-empty">' + tr('mcp.empty') + '</div>';
    menu.hidden = false;
  };
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('mcp-menu')!;
    if (!menu.hidden && !(e.target as HTMLElement)?.closest('#btn-mcp, #mcp-menu')) menu.hidden = true;
  });
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
  if (!typed.trim() && !attachments.length) return;
  // @文件引用 + 📎 附件:内容拼到正文前(代码块包裹,模型可直接读取)。
  const cwd = convs.get(selectedId)?.cwd ?? '';
  const at = cwd ? await resolveAtFiles(typed, cwd) : { files: [], missing: [] };
  const files = [...attachments, ...at.files];
  let text = typed;
  if (files.length) {
    text = files.map((a) => `📎 文件 ${a.name}:\n\`\`\`\n${a.content}\n\`\`\``).join('\n\n') + '\n\n---\n\n' + typed;
    attachments = [];
    renderAttach();
  }
  if (at.missing.length) alert(tr('attach.missingAlert', { list: at.missing.join('\n') }));
  composer.value = '';
  autosize(composer);
  showChat();
  await api.send(selectedId, text);
  document.getElementById('composer')!.focus();
}

function showChat() {
  currentView = 'chat';
  document.getElementById('settings-view')!.classList.remove('active');
  document.getElementById('workbench-view')!.classList.remove('active');
  document.getElementById('chat-view')!.classList.add('active');
  syncViewButtons();
  renderMain();
}

function showWorkbench() {
  currentView = 'workbench';
  document.getElementById('chat-view')!.classList.remove('active');
  document.getElementById('settings-view')!.classList.remove('active');
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
      <span class="wb-picon">${running ? '⚡' : '📁'}</span>
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
  card.querySelector<HTMLElement>('.wb-picon')!.textContent = running ? '⚡' : '📁';
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
// 用 modal:textarea 全屏 + 保存/取消。空 cwd 不允许(workbench 卡片总是带 cwd)。
let contextCwd = '';
async function openContextModal(cwd: string): Promise<void> {
  if (!cwd) return;
  contextCwd = cwd;
  const modal = document.getElementById('context-modal')!;
  const editor = document.getElementById('cm-editor') as HTMLTextAreaElement;
  const cwdLabel = document.getElementById('cm-cwd')!;
  const status = document.getElementById('cm-status')!;
  cwdLabel.textContent = cwd;
  status.textContent = '';
  editor.value = '…';
  modal.classList.add('show');
  const r = await api.readContext(cwd);
  editor.value = r.ok ? r.content ?? '' : '';
  if (!r.ok) status.textContent = r.error ?? '';
  editor.focus();
}

async function saveContext(): Promise<void> {
  if (!contextCwd) return;
  const editor = document.getElementById('cm-editor') as HTMLTextAreaElement;
  const status = document.getElementById('cm-status')!;
  status.textContent = '…';
  const r = await api.writeContext(contextCwd, editor.value);
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
    if (!isTextFile(f.name)) continue; // 二进制跳过
    attachments.push({ name: f.name, content: await readTextTruncated(f, 20000) });
  }
  renderAttach();
}

function renderAttach(): void {
  const row = document.getElementById('attach-row')!;
  row.innerHTML = attachments
    .map((a, i) => `<span class="chip"><span>${esc(a.name)}</span><span class="chip-x" data-i="${i}">×</span></span>`)
    .join('');
  row.querySelectorAll<HTMLElement>('.chip-x').forEach((x) => {
    x.onclick = () => {
      attachments.splice(Number(x.dataset.i), 1);
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
async function openMemoryPanel(): Promise<void> {
  mmScope = selectedId ? 'this' : 'all';
  document.getElementById('memory-modal')!.classList.add('show');
  await renderMemoryList();
}
function closeMemoryPanel(): void {
  document.getElementById('memory-modal')!.classList.remove('show');
}
async function renderMemoryList(): Promise<void> {
  const listEl = document.getElementById('mm-list')!;
  // scope 按钮态
  document.getElementById('mm-scope-this')!.classList.toggle('active', mmScope === 'this');
  document.getElementById('mm-scope-all')!.classList.toggle('active', mmScope === 'all');
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

const PRESETS = [
  { id: 'glm', labelKey: 'preset.glm', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.2', proto: 'openai', pin: 0.07, pout: 0.21 },
  { id: 'deepseek', labelKey: 'preset.deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', proto: 'openai', pin: 0.27, pout: 1.1 },
  { id: 'qwen', labelKey: 'preset.qwen', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max', proto: 'openai', pin: 0.29, pout: 0.86 },
  { id: 'custom', labelKey: 'preset.custom', baseURL: '', model: '', proto: 'openai', pin: 0, pout: 0 },
];
const REASONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
