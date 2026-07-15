// Files & Preview:cwd 文件树 + <webview> 浏览器,左右分屏。
// 既给独立 files 窗口用(files.html 调 mountFilesPane(document.body)),
// 也给主窗口的「文件」tab 用(app.ts 调 mountFilesPane(inlinePane))。
//
// 文件树懒加载(点目录才 listDir 子层);右键「在浏览器中打开」→ webview.loadURL(file://)。
// 主进程切 cwd 时通过 onFilesCwd 推送(独立窗口场景);内联场景由 app.ts 主动调 setCwd。
//
// 多面板(Multi-Pane):顶部标签栏可「+」新建面板,每个面板独立 cwd / 文件树 / 预览。
// 面板状态(打开的文件、编辑器内容)在切换标签时保留。上限 MAX_PANELS 个。
import type { DirEntry, KinetAPI, ElementInfo } from '../shared/types';
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
  getGuestInstanceId(): number | undefined;
  executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;  // 直接在 renderer 层调用
}

export interface FilesPaneController {
  setCwd(cwd: string): void;
  // Visual Inspector:当用户完成圈选+输入意图后触发,app.ts 负责发给当前活跃会话
  onInspect?: (prompt: string) => void;
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

  // Visual Inspector 回调 —— 由外部 FilesPaneController.onInspect 设置
  let inspectHandler: ((prompt: string) => void) | null = null;

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
    const ctrl = mountSinglePanel(el, lang, menu, setMenuTarget, (prompt: string) => {
      // 优先用外部注册的 handler,否则回退到剪贴板
      if (inspectHandler) inspectHandler(prompt);
      else void window.kinet.clipboardWriteText(prompt);
    });
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
    set onInspect(fn: ((prompt: string) => void) | undefined) {
      inspectHandler = fn ?? null;
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
    <div class="seg" role="tablist">
      <button class="seg-btn active" data-btn="tab-preview" role="tab" data-i18n-title="files.tabPreview" title="预览">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
        <span data-i18n="files.tabPreview">预览</span>
      </button>
      <button class="seg-btn" data-btn="tab-edit" role="tab" data-i18n-title="files.tabEdit" title="编辑">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        <span data-i18n="files.tabEdit">编辑</span>
      </button>
    </div>
    <button class="ghost" data-btn="back" data-i18n-title="files.back" title="后退"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button>
    <button class="ghost" data-btn="inspect" data-i18n-title="files.inspect" title="圈选标注"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4 2"><path d="M3 3h6M3 3v6M21 3h-6M21 3v6M3 21h6M3 21v-6M21 21h-6M21 21v-6"/></svg></button>
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

function mountSinglePanel(root: HTMLElement, lang: Lang, menu: HTMLElement, setMenuTarget: (e: DirEntry | null) => void, onInspectPrompt?: (prompt: string) => void): SinglePanelController {
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

  // ── Visual Inspector:圈选标注 → AI 改代码 ──
  // 点击「圈选」按钮 → 向 webview 注入选择脚本 → 用户拖拽框选页面元素
  // → 收集被选元素的 DOM 信息(outerHTML/computedStyle/domPath/rect)
  // → 弹出输入框让用户描述修改意图 → 组装 [文件路径 + 源码片段 + 元素信息 + 意图] 发给当前会话
  const inspectBtn = root.querySelector<HTMLElement>('[data-btn="inspect"]')!;
  let inspecting = false;
  inspectBtn.onclick = () => void toggleInspect();

  async function toggleInspect(): Promise<void> {
    if (inspecting) return;
    if (!currentAbs) { feStatus.textContent = tr('files.inspectNoFile'); return; }
    inspecting = true;
    inspectBtn.classList.add('active');
    feStatus.textContent = tr('files.inspectDragging');

    // ★ overlay 在 renderer 主页面(而非 webview 内部),避免 CSP/事件隔离问题
    const elements = await doInspectOverlay(webview as unknown as HTMLElement);

    inspecting = false;
    inspectBtn.classList.remove('active');
    if (!elements || elements.length === 0) {
      feStatus.textContent = tr('files.inspectCancelled');
      return;
    }
    // 弹出输入框 / Show intent input modal
    const intent = await showInspectModal(elements);
    if (!intent) { feStatus.textContent = tr('files.inspectCancelled'); return; }
    // 组装 prompt 发送 / Assemble prompt and send to conversation
    const prompt = buildInspectPrompt(currentAbs, elements, intent);
    feStatus.textContent = tr('files.inspectSent');
    // 通过回调把 prompt 发给当前活跃会话(由 app.ts 的 onInspect 处理)
    if (onInspectPrompt) onInspectPrompt(prompt);
    else { void api.clipboardWriteText(prompt); feStatus.textContent = tr('files.inspectCopied'); }
  }

  // 标注意图输入模态框 / Inspect intent input modal
  function showInspectModal(elements: ElementInfo[]): Promise<string | null> {
    return new Promise((resolve) => {
      // 创建模态遮罩 / Create modal overlay
      const overlay = document.createElement('div');
      overlay.className = 'inspect-modal-overlay';
      overlay.innerHTML = `
        <div class="inspect-modal">
          <div class="inspect-modal-head">
            <span class="inspect-modal-title">${tr('files.inspectTitle')}</span>
            <button class="inspect-modal-close" data-act="cancel">&times;</button>
          </div>
          <div class="inspect-modal-body">
            <div class="inspect-selected-info">
              <span class="inspect-badge">${elements.length} ${tr('files.inspectElements')}</span>
              ${elements.slice(0, 3).map((el) => `<code class="inspect-el-tag">&lt;${el.tag}${el.id ? ' id="' + el.id + '"' : ''}${el.className ? ' class="' + el.className + '"' : ''}&gt;</code>`).join('')}
              ${elements.length > 3 ? `<span class="inspect-more">+${elements.length - 3}</span>` : ''}
            </div>
            <div class="inspect-preview">${escapeHtml(elements[0]?.textPreview || '').slice(0, 100)}</div>
            <textarea class="inspect-input" data-el="intent" placeholder="${tr('files.inspectPlaceholder')}" rows="4"></textarea>
            <div class="inspect-hint">${tr('files.inspectHint')}</div>
          </div>
          <div class="inspect-modal-foot">
            <button class="ghost" data-act="cancel">${tr('common.cancel')}</button>
            <button class="primary" data-act="send">${tr('files.inspectSend')}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const textarea = overlay.querySelector<HTMLTextAreaElement>('[data-el="intent"]')!;
      const close = () => { overlay.remove(); resolve(null); };
      const send = () => {
        const v = textarea.value.trim();
        if (!v) { textarea.focus(); return; }
        overlay.remove();
        resolve(v);
      };

      overlay.querySelector<HTMLElement>('[data-act="cancel"]')!.onclick = close;
      overlay.querySelector<HTMLElement>('[data-act="send"]')!.onclick = send;
      textarea.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); send(); }
        if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      });

      // 遮罩点击关闭(点模态框本身不关)
      overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

      setTimeout(() => textarea.focus(), 50);
    });
  }

  // ── doInspectOverlay:在 renderer 层(render 页面)创建 overlay 处理框选 ──
  // 不把 overlay 注入到 webview 内部(容易受 CSP/事件隔离影响),
  // 而是直接覆盖在 webview DOM 元素上,鼠标松开后用 executeJavaScript 采集元素。
  function doInspectOverlay(webviewEl: HTMLElement): Promise<ElementInfo[] | null> {
    return new Promise((resolve) => {
      // 获取 webview 的位置和大小(相对于 dashboard 窗口)
      const wvRect = webviewEl.getBoundingClientRect();

      // 创建全屏 overlay(覆盖整个 dashboard 窗口,但不影响顶部工具栏)
      const overlay = document.createElement('div');
      overlay.style.cssText = `position:fixed;left:${wvRect.left}px;top:${wvRect.top}px;width:${wvRect.width}px;height:${wvRect.height}px;z-index:99999;cursor:crosshair;background:rgba(0,0,0,0.15);`;

      const selBox = document.createElement('div');
      selBox.style.cssText = 'position:fixed;border:2px dashed #e8b339;background:rgba(232,179,57,0.12);z-index:100000;pointer-events:none;display:none;box-shadow:0 0 0 9999px rgba(0,0,0,0.3);';

      const hint = document.createElement('div');
      hint.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:100001;background:#1b1b1f;color:#e8b339;padding:8px 16px;border-radius:8px;font:13px system-ui,sans-serif;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,0.4);';
      hint.textContent = '拖拽框选要修改的区域 · 按 ESC 取消';

      document.body.appendChild(overlay);
      document.body.appendChild(selBox);
      document.body.appendChild(hint);

      let startX = 0, startY = 0, isDown = false;
      let done = false;

      function finish(result: ElementInfo[] | null) {
        if (done) return;
        done = true;
        overlay.remove(); selBox.remove(); hint.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(result);
      }

      function onKey(e: KeyboardEvent) { if (e.key === 'Escape') finish(null); }
      document.addEventListener('keydown', onKey, true);

      overlay.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isDown = true;
        startX = e.clientX; startY = e.clientY;
        selBox.style.display = 'block';
        selBox.style.left = startX + 'px';
        selBox.style.top = startY + 'px';
        selBox.style.width = '0px';
        selBox.style.height = '0px';
        hint.style.display = 'none';
      });

      overlay.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        const x = Math.min(e.clientX, startX);
        const y = Math.min(e.clientY, startY);
        const w = Math.abs(e.clientX - startX);
        const h = Math.abs(e.clientY - startY);
        selBox.style.left = x + 'px';
        selBox.style.top = y + 'px';
        selBox.style.width = w + 'px';
        selBox.style.height = h + 'px';
      });

      overlay.addEventListener('mouseup', async (e) => {
        if (!isDown) return;
        isDown = false;
        const x1 = Math.min(e.clientX, startX);
        const y1 = Math.min(e.clientY, startY);
        const x2 = Math.max(e.clientX, startX);
        const y2 = Math.max(e.clientY, startY);
        const w = x2 - x1, h = y2 - y1;

        // 先移除 overlay,否则 executeJavaScript 的 elementsFromPoint 不会采到它
        overlay.remove(); selBox.remove(); hint.remove();
        document.removeEventListener('keydown', onKey, true);

        if (w < 5 || h < 5) { finish(null); return; }

        // 把 renderer 坐标转换为 webview 内部坐标(减去 webview 的偏移)
        const inWvX1 = x1 - wvRect.left, inWvY1 = y1 - wvRect.top;
        const inWvX2 = x2 - wvRect.left, inWvY2 = y2 - wvRect.top;

        // ★ 直接在 renderer 层调用 webview.executeJavaScript,不走主进程 IPC
        // 避免 getGuestInstanceId + webContents.fromId 的 "guest view manager call error"
        const collectScript = buildCollectScript(inWvX1, inWvY1, inWvX2, inWvY2);
        try {
          const wv = webviewEl as unknown as WebviewLike;
          const result = await wv.executeJavaScript(collectScript, false);
          done = true;
          if (!result || !Array.isArray(result)) { resolve(null); return; }
          resolve(result as ElementInfo[]);
        } catch (err) {
          console.error('[inspect] executeJavaScript failed:', err);
          done = true;
          resolve(null);
        }
      });
    });
  }

  // buildCollectScript:生成一次性采集脚本,传入选择框坐标(webview 内部坐标)
  function buildCollectScript(x1: number, y1: number, x2: number, y2: number): string {
    return `(function() {
      var x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2};
      var w = x2 - x1, h = y2 - y1;
      if (w < 5 || h < 5) return null;
      var collected = [];
      var seen = new Set();
      var step = Math.min(20, Math.min(w, h) / 3);
      for (var px = x1 + step/2; px < x2; px += step) {
        for (var py = y1 + step/2; py < y2; py += step) {
          var els = document.elementsFromPoint(px, py);
          for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (seen.has(el)) continue;
            seen.add(el);
            var r = el.getBoundingClientRect();
            if (r.left + r.width/2 < x1 || r.left + r.width/2 > x2) continue;
            if (r.top + r.height/2 < y1 || r.top + r.height/2 > y2) continue;
            collected.push(extractInfo(el, r));
          }
        }
      }
      var deduped = {};
      var result = [];
      for (var j = 0; j < collected.length; j++) {
        var c = collected[j];
        var key = c.tag + '|' + c.className + '|' + c.textPreview.slice(0, 50);
        if (deduped[key]) {
          if (c.outerHTML.length > deduped[key].outerHTML.length) {
            var idx = result.indexOf(deduped[key]);
            result[idx] = c; deduped[key] = c;
          }
        } else { deduped[key] = c; result.push(c); }
      }
      function extractInfo(el, r) {
        var cs = window.getComputedStyle(el);
        var styles = {};
        var keys = ['color','background-color','font-size','font-weight','font-family','width','height','padding','margin','border','border-radius','display','position','text-align','line-height','letter-spacing','opacity','flex-direction','justify-content','align-items','gap'];
        for (var k = 0; k < keys.length; k++) { styles[keys[k]] = cs.getPropertyValue(keys[k]); }
        var path = [];
        var cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.body) {
          var sel = cur.tagName.toLowerCase();
          if (cur.id) sel += '#' + cur.id;
          else if (cur.className && typeof cur.className === 'string') {
            var cls = cur.className.trim().split(/\\s+/).slice(0, 2).join('.');
            if (cls) sel += '.' + cls;
          }
          var sib = cur, nth = 1;
          while ((sib = sib.previousElementSibling)) nth++;
          if (nth > 1) sel += ':nth-child(' + nth + ')';
          path.unshift(sel);
          cur = cur.parentElement;
        }
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          className: (typeof el.className === 'string' ? el.className : ''),
          textPreview: (el.textContent || '').trim().slice(0, 300),
          outerHTML: el.outerHTML.slice(0, 2000),
          computedStyle: styles,
          domPath: path.join(' > '),
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
        };
      }
      return result.length ? result : null;
    })();`;
  }

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

  // ── buildInspectPrompt:把文件路径 + 元素信息 + 用户意图组装成 AI prompt ──
  // AI 拿到后可以调 read_file 读源码 → 理解结构 → edit_file 精确修改。
  function buildInspectPrompt(abs: string, elements: ElementInfo[], intent: string): string {
    const parts: string[] = [];
    parts.push(`## 视觉标注修改请求`);
    parts.push('');
    parts.push(`**文件路径**: \`${abs}\``);
    parts.push(`**修改意图**: ${intent}`);
    parts.push('');
    parts.push(`### 用户在预览中框选了以下元素(共 ${elements.length} 个):`);
    parts.push('');
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      parts.push(`#### 元素 ${i + 1}: \`<${el.tag}${el.id ? '#' + el.id : ''}${el.className ? '.' + el.className.split(/\s+/).join('.') : ''}>\``);
      parts.push(`- **DOM 路径**: \`${el.domPath}\``);
      parts.push(`- **位置**: x=${el.rect.x}, y=${el.rect.y}, ${el.rect.w}×${el.rect.h}px`);
      parts.push(`- **可见文本**: ${el.textPreview.slice(0, 150) || '(无文本)'}`);
      // 精选关键 computed style(只保留非默认值的)
      const cs = el.computedStyle;
      const styleParts: string[] = [];
      for (const [k, v] of Object.entries(cs)) {
        if (v && v !== 'normal' && v !== 'none' && v !== 'auto' && v !== '0' && v !== '0px') {
          styleParts.push(`${k}: ${v}`);
        }
      }
      if (styleParts.length) parts.push(`- **关键样式**: ${styleParts.slice(0, 8).join(' | ')}`);
      parts.push(`- **outerHTML**:`);
      parts.push('```html');
      parts.push(el.outerHTML.slice(0, 1000));
      parts.push('```');
      parts.push('');
    }
    parts.push(`### 请按以下步骤操作:`);
    parts.push(`1. 先用 read_file 读取 \`${abs}\` 的完整内容`);
    parts.push(`2. 根据 DOM 路径和 outerHTML 定位到对应源码片段`);
    parts.push(`3. 按照用户的修改意图,用 edit_file 精确修改`);
    parts.push(`4. 如果意图不明确或需要确认,先说明你的理解再修改`);
    return parts.join('\n');
  }

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

// ── HTML 转义(展示用户内容时防 XSS) / Escape HTML for safe display ──
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
