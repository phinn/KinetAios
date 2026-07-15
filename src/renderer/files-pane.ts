// Files & Preview:cwd 文件树 + <webview> 浏览器,左右分屏。
// 既给独立 files 窗口用(files.html 调 mountFilesPane(document.body)),
// 也给主窗口的「文件」tab 用(app.ts 调 mountFilesPane(inlinePane))。
//
// 文件树懒加载(点目录才 listDir 子层);右键「在浏览器中打开」→ webview.loadURL(file://)。
// 主进程切 cwd 时通过 onFilesCwd 推送(独立窗口场景);内联场景由 app.ts 主动调 setCwd。
//
// 多面板(Multi-Pane):顶部标签栏可「+」新建面板,每个面板独立 cwd / 文件树 / 预览。
// 面板状态(打开的文件、编辑器内容)在切换标签时保留。上限 MAX_PANELS 个。
import type { DirEntry, KinetAPI } from '../shared/types';
import { t, type Lang } from '../shared/i18n';
import { CodeEditor, detectLang } from './code-editor';

declare global {
  interface Window {
    kinet: KinetAPI;
  }
}

// ponytail: webview 的 TS 类型在 renderer tsconfig 里没引(electron types:[])。
// 用最小手写接口挡住编译错 —— 实际由 Electron 在运行时注入。
interface WebviewLike {
  src: string;
  loadURL(url: string): void;
  goBack(): void;
  reload(): void;
  addEventListener(ev: string, cb: (e: { url: string }) => void): void;
}

export interface FilesPaneController {
  setCwd(cwd: string): void;
}

// ─── 多面板管理层 ────────────────────────────────────────────
// 容器结构(container 必须 #chat-files-pane 或 files.html body):
//   .files-panel-bar       ← 面板标签栏(+按钮)
//   .files-panel-host      ← 面板内容宿主(每次只显示一个)
//   #files-menu            ← 右键菜单(所有面板共享)

const MAX_PANELS = 5; // 面板上限 / Panel limit

interface PanelState {
  id: number;
  el: HTMLElement;        // 面板内容 DOM(.files-panel)
  controller: SinglePanelController;
  cwd: string;            // 最后一次设置的 cwd / Last cwd set
}

let panelIdCounter = 0;

/**
 * 多面板入口:在 container 内挂载面板标签栏 + 面板宿主。
 * container 需要含 .files-panel-bar / .files-panel-host / #files-menu。
 */
export function mountFilesPane(container: HTMLElement, lang: Lang): FilesPaneController {
  const menu = container.querySelector<HTMLElement>('#files-menu')!;
  const panelBar = container.querySelector<HTMLElement>('.files-panel-bar')!;
  const panelHost = container.querySelector<HTMLElement>('.files-panel-host')!;

  const panels: PanelState[] = [];
  let activeIndex = 0;

  // 全局右键菜单 target(所有面板共享一个 #files-menu)。
  // 各面板的 showMenu 会把 target 写到这里,menu 按钮的 handler 也从这里读。
  let globalMenuTarget: DirEntry | null = null;
  const setMenuTarget = (e: DirEntry | null) => { globalMenuTarget = e; };

  // 绑定右键菜单按钮(只绑一次,所有面板共享)。
  // fm-edit 需要在当前活跃面板打开编辑器,所以在这里绑(闭包能访问 panels)。
  bindMenuHandlers(menu, () => globalMenuTarget);
  menu.querySelector<HTMLElement>('#fm-edit')!.onclick = () => {
    const target = globalMenuTarget;
    if (target && panels[activeIndex]) panels[activeIndex].controller.openEditor(target.path);
    menu.hidden = true;
  };

  // 「+」按钮:新建面板 / Add button: create new panel
  const addBtn = document.createElement('button');
  addBtn.className = 'fp-add';
  addBtn.title = t(lang, 'files.newPanel');
  addBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  addBtn.onclick = () => addPanel('');

  function renderBar(): void {
    panelBar.innerHTML = '';

    panels.forEach((p, i) => {
      const tab = document.createElement('div');
      tab.className = 'fp-tab' + (i === activeIndex ? ' active' : '');
      const label = document.createElement('span');
      label.className = 'fp-label';
      const dirname = p.cwd ? p.cwd.replace(/\\/g, '/').split('/').pop() || p.cwd : t(lang, 'files.panelDefault');
      label.textContent = dirname;
      label.title = p.cwd || t(lang, 'files.panelDefault');
      tab.appendChild(label);

      // 关闭按钮(只有 >1 个面板时才显示)/ Close button (only when >1 panel)
      if (panels.length > 1) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'fp-close';
        closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
        closeBtn.onclick = (ev) => { ev.stopPropagation(); closePanel(i); };
        tab.appendChild(closeBtn);
      }

      tab.onclick = () => switchPanel(i);
      panelBar.appendChild(tab);
    });

    // 「+」按钮(达到上限时隐藏)/ Add button (hidden at cap)
    if (panels.length < MAX_PANELS) panelBar.appendChild(addBtn);
  }

  function switchPanel(i: number): void {
    if (i < 0 || i >= panels.length) return;
    activeIndex = i;
    panels.forEach((p, idx) => { p.el.style.display = idx === i ? '' : 'none'; });
    renderBar();
  }

  function addPanel(cwd: string): void {
    if (panels.length >= MAX_PANELS) return;
    const el = document.createElement('div');
    el.className = 'files-panel';
    el.setAttribute('data-panel', '');
    el.innerHTML = PANEL_HTML;
    panelHost.appendChild(el);
    const ctrl = mountSinglePanel(el, lang, menu, setMenuTarget);
    const state: PanelState = { id: ++panelIdCounter, el, controller: ctrl, cwd: cwd || '' };
    panels.push(state);
    if (cwd) ctrl.setCwd(cwd);
    switchPanel(panels.length - 1);
  }

  function closePanel(i: number): void {
    if (panels.length <= 1) return;
    const p = panels[i];
    p.controller.destroy?.();
    p.el.remove();
    panels.splice(i, 1);
    if (activeIndex >= panels.length) activeIndex = panels.length - 1;
    switchPanel(activeIndex);
  }

  // 初始化:创建第一个面板 / Init: create first panel
  addPanel('');

  // 独立窗口场景:主进程会推 cwd;内联场景 app.ts 主动调 setCwd。
  window.kinet.onFilesCwd((c: string) => {
    if (panels[activeIndex]) {
      panels[activeIndex].cwd = c;
      panels[activeIndex].controller.setCwd(c);
      renderBar();
    }
  });

  return {
    setCwd(cwd: string) {
      if (panels[activeIndex]) {
        panels[activeIndex].cwd = cwd;
        panels[activeIndex].controller.setCwd(cwd);
        renderBar();
      }
    },
  };
}

// ─── 单面板逻辑 ──────────────────────────────────────────────

interface SinglePanelController {
  setCwd(cwd: string): void;
  openEditor(abs: string): void;
  destroy?(): void;
}

// 单面板 HTML 模板 / Single panel HTML template
const PANEL_HTML = `
  <div class="files-head">
    <button class="ghost" data-btn="pick" data-i18n-title="files.pickDir" title="切换目录"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg></button>
    <span class="files-cwd" data-el="cwd"></span>
    <span class="files-spacer"></span>
    <div class="files-tabs">
      <button class="ftab active" data-btn="tab-preview" data-i18n="files.tabPreview">预览</button>
      <button class="ftab" data-btn="tab-edit" data-i18n="files.tabEdit">编辑</button>
    </div>
    <button class="ghost" data-btn="back" data-i18n-title="files.back" title="后退"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button>
    <button class="ghost" data-btn="reload" data-i18n-title="files.reload" title="刷新"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M20.5 9A9 9 0 005.6 5.6L1 10M3.5 15a9 9 0 0014.9 3.4L23 14"/></svg></button>
    <input class="files-addr" data-el="addr" data-i18n-placeholder="files.addrPh" placeholder="file:// 或 https:// 或 localhost:8000" />
  </div>
  <div class="files-body">
    <div class="files-tree" data-el="tree"></div>
    <div class="files-view">
      <webview data-el="webview" src="about:blank" partition="persist:files"></webview>
      <div class="files-editor" data-el="editor-pane" hidden>
        <div class="files-editor-bar">
          <span class="fe-status" data-el="fe-status"></span>
          <span class="files-spacer"></span>
          <button class="primary" data-btn="save" data-i18n="files.save">保存</button>
        </div>
      </div>
    </div>
  </div>
`;

function mountSinglePanel(root: HTMLElement, lang: Lang, menu: HTMLElement, setMenuTarget: (e: DirEntry | null) => void): SinglePanelController {
  const api = window.kinet;
  let cwd = '';
  let currentAbs = '';
  let editorDirty = false;

  const webview = root.querySelector<HTMLElement>('[data-el="webview"]') as unknown as WebviewLike;
  const addr = root.querySelector<HTMLInputElement>('[data-el="addr"]')!;
  const treeEl = root.querySelector<HTMLElement>('[data-el="tree"]')!;
  const cwdLabel = root.querySelector<HTMLElement>('[data-el="cwd"]')!;
  const editorPane = root.querySelector<HTMLElement>('[data-el="editor-pane"]')!;
  // CodeEditor 宿主 div:动态创建,放在 editorPane 内部(bar 之前),撑满上方空间。
  const editorHost = document.createElement('div');
  editorHost.style.cssText = 'flex:1;min-height:0;overflow:hidden';
  editorPane.insertBefore(editorHost, editorPane.firstChild);
  let codeEditor: CodeEditor | null = null;
  const feStatus = root.querySelector<HTMLElement>('[data-el="fe-status"]')!;
  const ftabPreview = root.querySelector<HTMLElement>('[data-btn="tab-preview"]')!;
  const ftabEdit = root.querySelector<HTMLElement>('[data-btn="tab-edit"]')!;

  const tr = (key: string, params?: Record<string, string | number>) => t(lang, key, params);

  function applyI18nDOM(): void {
    root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
      el.textContent = t(lang, el.dataset.i18n!);
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(lang, el.dataset.i18nPlaceholder!));
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', t(lang, el.dataset.i18nTitle!));
    });
  }

  function setCwd(c: string): void {
    cwd = c;
    cwdLabel.textContent = c;
    void renderTree();
  }

  async function renderTree(): Promise<void> {
    if (!cwd) {
      treeEl.innerHTML = `<div class="files-empty">${tr('files.noCwd')}</div>`;
      return;
    }
    const r = await api.listDir(cwd);
    if (!r.ok) {
      treeEl.innerHTML = `<div class="files-empty">${tr('files.errRead', { msg: r.error ?? '' })}</div>`;
      return;
    }
    if (!r.entries?.length) {
      treeEl.innerHTML = `<div class="files-empty">${tr('files.empty')}</div>`;
      return;
    }
    treeEl.innerHTML = '';
    for (const e of r.entries) treeEl.appendChild(entryEl(e));
  }

  function entryEl(e: DirEntry): HTMLElement {
    const div = document.createElement('div');
    div.className = 'fe ' + (e.isDir ? 'dir' : 'file');
    div.dataset.path = e.path;
    const row = document.createElement('div');
    row.className = 'fe-row';
    const ico = document.createElement('span');
    ico.className = 'fe-ico';
    ico.innerHTML = e.isDir
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>';
    const name = document.createElement('span');
    name.className = 'fe-name';
    name.textContent = e.name;
    row.append(ico, name);
    div.appendChild(row);
    if (e.isDir) {
      const kids = document.createElement('div');
      kids.className = 'fe-children';
      kids.hidden = true;
      div.appendChild(kids);
      row.onclick = () => void toggleDir(kids);
      row.oncontextmenu = (ev) => { ev.preventDefault(); showMenu(ev, e); };
    } else {
      row.oncontextmenu = (ev) => { ev.preventDefault(); showMenu(ev, e); };
      // 单击 = 选中 + 立即打开(按后缀选预览或编辑器)。
      row.onclick = () => {
        selectRow(row);
        if (isPreviewExt(e.path)) { setTab('preview'); loadFile(e.path); }
        else void loadEditor(e.path);
      };
    }
    return div;
  }

  let selectedRow: HTMLElement | null = null;
  function selectRow(row: HTMLElement): void {
    if (selectedRow) selectedRow.classList.remove('selected');
    row.classList.add('selected');
    selectedRow = row;
  }

  async function toggleDir(kids: HTMLElement): Promise<void> {
    if (kids.childNodes.length === 0) {
      const parentPath = kids.parentElement!.dataset.path!;
      const r = await api.listDir(parentPath);
      if (r.ok && r.entries) {
        if (!r.entries.length) {
          kids.innerHTML = `<div class="files-empty">${tr('files.empty')}</div>`;
        } else {
          for (const c of r.entries) kids.appendChild(entryEl(c));
        }
      }
    }
    kids.hidden = !kids.hidden;
  }

  function showMenu(ev: MouseEvent, e: DirEntry): void {
    setMenuTarget(e);
    menu.style.left = Math.min(ev.clientX, window.innerWidth - 180) + 'px';
    menu.style.top = Math.min(ev.clientY, window.innerHeight - 80) + 'px';
    menu.hidden = false;
  }
  function hideMenu(): void { menu.hidden = true; }

  function normalizeURL(s: string): string {
    s = s.trim();
    if (!s) return 'about:blank';
    if (/^(https?|file|about):/i.test(s)) return s;
    if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^\d+\.\d+\.\d+\.\d+(:\d+)?(\/|$)/.test(s)) return 'http://' + s;
    if (s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s)) return 'file://' + s;
    return 'https://' + s;
  }

  function isPreviewExt(p: string): boolean {
    return /\.(html?|svg|png|jpe?g|gif|webp|bmp|ico|pdf|css)$/i.test(p);
  }

  function loadFile(abs: string): void {
    currentAbs = abs;
    const absenc = abs.replace(/\\/g, '/').replace(/^\/+/, '');
    const url = 'file:///' + encodeURI(absenc);
    webview.src = url;
    webview.loadURL(url);
    addr.value = url;
  }

  async function loadEditor(abs: string): Promise<void> {
    currentAbs = abs;
    setTab('edit');
    addr.value = 'file://' + abs;
    feStatus.textContent = abs + ' · …';

    if (codeEditor) { codeEditor.destroy(); codeEditor = null; }
    const detectedLang = detectLang(abs);
    codeEditor = new CodeEditor(editorHost, { lang: detectedLang, autoHeight: false });
    codeEditor.value = '';
    codeEditor.onChange = (v) => { editorDirty = true; feStatus.textContent = (currentAbs || '') + ' · 未保存'; };

    const r = await api.fileRead(abs);
    if (!r.ok || r.content == null) {
      codeEditor.value = '';
      feStatus.textContent = `${abs} · ${r.error ?? 'read error'}`;
      return;
    }
    codeEditor.value = r.content;
    editorDirty = false;
    feStatus.textContent = abs;
  }

  function setTab(mode: 'preview' | 'edit'): void {
    const isEdit = mode === 'edit';
    editorPane.hidden = !isEdit;
    (webview as unknown as HTMLElement).style.display = isEdit ? 'none' : '';
    ftabPreview.classList.toggle('active', !isEdit);
    ftabEdit.classList.toggle('active', isEdit);
  }

  async function save(): Promise<void> {
    if (!currentAbs || !editorDirty || !codeEditor) return;
    const r = await api.fileWrite(currentAbs, codeEditor.value);
    if (r.ok) {
      editorDirty = false;
      feStatus.textContent = tr('files.saved', { path: currentAbs });
    } else {
      feStatus.textContent = tr('files.errSave', { msg: r.error ?? '' });
    }
  }

  // 头部按钮 + 地址栏 + webview 事件
  root.querySelector<HTMLElement>('[data-btn="pick"]')!.onclick = async () => {
    const dir = await api.pickDirectory();
    if (dir) setCwd(dir);
  };
  root.querySelector<HTMLElement>('[data-btn="back"]')!.onclick = () => webview.goBack();
  root.querySelector<HTMLElement>('[data-btn="reload"]')!.onclick = () => webview.reload();
  addr.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') webview.loadURL(normalizeURL(addr.value));
  });
  webview.addEventListener('did-navigate', (e) => (addr.value = e.url));
  webview.addEventListener('did-navigate-in-page', (e) => (addr.value = e.url));

  // tab 切换:切到目标 tab 时,若已有当前文件,用对应 loader 重新加载内容。
  ftabPreview.onclick = () => { setTab('preview'); if (currentAbs && isPreviewExt(currentAbs)) loadFile(currentAbs); };
  ftabEdit.onclick = () => { if (currentAbs) void loadEditor(currentAbs); };
  root.querySelector<HTMLElement>('[data-btn="save"]')!.onclick = () => void save();
  editorPane.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); void save(); }
  });

  // 右键菜单的菜单按钮由多面板层统一绑定(bindMenuHandlers),
  // 单面板只负责在 showMenu 中设置 target。这里只处理"点外面关闭菜单"。
  root.addEventListener('click', (ev) => {
    if (!(ev.target as HTMLElement)?.closest('.files-menu')) hideMenu();
  });
  root.addEventListener('contextmenu', (ev) => {
    if (!(ev.target as HTMLElement)?.closest('.fe-row')) hideMenu();
  });

  applyI18nDOM();

  return {
    setCwd,
    openEditor: (abs: string) => void loadEditor(abs),
    destroy() {
      if (codeEditor) { codeEditor.destroy(); codeEditor = null; }
    },
  };
}

// ─── 右键菜单(多面板共享,只绑一次) ──────────────────────────

/**
 * 绑定 #files-menu 的 fm-open / fm-copy(无面板依赖的操作)。
 * fm-edit 需要在 mountFilesPane 闭包中单独绑(访问活跃面板的 controller)。
 */
function bindMenuHandlers(menu: HTMLElement, getTarget: () => DirEntry | null): void {
  const api = window.kinet;

  menu.querySelector<HTMLElement>('#fm-open')!.onclick = () => {
    const target = getTarget();
    if (target) {
      const absenc = target.path.replace(/\\/g, '/').replace(/^\/+/, '');
      void api.shellOpen('file:///' + encodeURI(absenc));
    }
    menu.hidden = true;
  };

  menu.querySelector<HTMLElement>('#fm-copy')!.onclick = () => {
    const target = getTarget();
    if (target) void api.clipboardWriteText(target.path);
    menu.hidden = true;
  };
}
