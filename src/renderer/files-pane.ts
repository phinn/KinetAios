// Files & Preview:cwd 文件树 + <webview> 浏览器,左右分屏。
// 既给独立 files 窗口用(files.html 调 mountFilesPane(document.body)),
// 也给主窗口的「文件」tab 用(app.ts 调 mountFilesPane(inlinePane))。
//
// 文件树懒加载(点目录才 listDir 子层);右键「在浏览器中打开」→ webview.loadURL(file://)。
// 主进程切 cwd 时通过 onFilesCwd 推送(独立窗口场景);内联场景由 app.ts 主动调 setCwd。
import type { DirEntry, KinetAPI } from '../shared/types';
import { t, type Lang } from '../shared/i18n';

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

// root 必须含(files.html 同款)结构:.files-head / .files-tree / .files-view>webview / #files-menu。
// 返回 controller,调用方用它来主动切 cwd(内联场景)。
export function mountFilesPane(root: HTMLElement, lang: Lang): FilesPaneController {
  const api = window.kinet;
  let cwd = '';
  let menuTarget: DirEntry | null = null;
  // 当前编辑器/预览加载的文件绝对路径(空 = 未加载)。两视图共用一份"当前文件"。
  let currentAbs = '';
  let editorDirty = false;

  const webview = root.querySelector<HTMLElement>('#files-webview') as unknown as WebviewLike;
  const addr = root.querySelector<HTMLInputElement>('#files-addr')!;
  const treeEl = root.querySelector<HTMLElement>('#files-tree')!;
  const cwdLabel = root.querySelector<HTMLElement>('#files-cwd')!;
  const menu = root.querySelector<HTMLElement>('#files-menu')!;
  const editorPane = root.querySelector<HTMLElement>('#files-editor-pane')!;
  const editor = root.querySelector<HTMLTextAreaElement>('#files-editor')!;
  const feStatus = root.querySelector<HTMLElement>('#fe-status')!;
  const ftabPreview = root.querySelector<HTMLElement>('#ftab-preview')!;
  const ftabEdit = root.querySelector<HTMLElement>('#ftab-edit')!;

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
    if (!r.ok || !r.entries) {
      treeEl.innerHTML = `<div class="files-empty">${tr('files.errRead', { msg: r.error ?? '' })}</div>`;
      return;
    }
    treeEl.innerHTML = '';
    if (!r.entries.length) {
      treeEl.innerHTML = `<div class="files-empty">${tr('files.empty')}</div>`;
      return;
    }
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
    ico.textContent = e.isDir ? '📁' : '📄';
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
      // 双击:HTML/图/PDF 预览,其他开编辑器。
      row.ondblclick = () => {
        if (isPreviewExt(e.path)) { setTab('preview'); loadFile(e.path); }
        else void loadEditor(e.path);
      };
    }
    return div;
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
    menuTarget = e;
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

  // 按后缀决定默认视图:HTML/图片/PDF 走预览,其他走编辑器。
  function isPreviewExt(p: string): boolean {
    return /\.(html?|svg|png|jpe?g|gif|webp|bmp|ico|pdf|css)$/i.test(p);
  }

  function loadFile(abs: string): void {
    currentAbs = abs;
    const url = 'file://' + abs;
    webview.loadURL(url);
    addr.value = url;
  }

  async function loadEditor(abs: string): Promise<void> {
    currentAbs = abs;
    const r = await api.fileRead(abs);
    if (!r.ok || r.content == null) {
      editor.value = '';
      editor.placeholder = tr('files.errRead', { msg: r.error ?? '' });
      feStatus.textContent = r.error ?? '';
      return;
    }
    editor.value = r.content;
    editorDirty = false;
    feStatus.textContent = abs;
    setTab('edit');
    addr.value = 'file://' + abs;
  }

  // 切右侧视图:preview = 显示 webview,隐藏 editor;反之亦然。
  function setTab(mode: 'preview' | 'edit'): void {
    const isEdit = mode === 'edit';
    editorPane.hidden = !isEdit;
    (webview as unknown as HTMLElement).style.display = isEdit ? 'none' : '';
    ftabPreview.classList.toggle('active', !isEdit);
    ftabEdit.classList.toggle('active', isEdit);
  }

  async function save(): Promise<void> {
    if (!currentAbs || !editorDirty) return;
    const r = await api.fileWrite(currentAbs, editor.value);
    if (r.ok) {
      editorDirty = false;
      feStatus.textContent = tr('files.saved', { path: currentAbs });
    } else {
      feStatus.textContent = tr('files.errSave', { msg: r.error ?? '' });
    }
  }

  // 头部按钮 + 地址栏 + webview 事件
  root.querySelector<HTMLElement>('#btn-pick')!.onclick = async () => {
    const dir = await api.pickDirectory();
    if (dir) setCwd(dir);
  };
  root.querySelector<HTMLElement>('#btn-back')!.onclick = () => webview.goBack();
  root.querySelector<HTMLElement>('#btn-reload')!.onclick = () => webview.reload();
  addr.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') webview.loadURL(normalizeURL(addr.value));
  });
  webview.addEventListener('did-navigate', (e) => (addr.value = e.url));
  webview.addEventListener('did-navigate-in-page', (e) => (addr.value = e.url));

  // tab 切换 + 编辑器保存 + dirty 标志
  ftabPreview.onclick = () => setTab('preview');
  ftabEdit.onclick = () => setTab('edit');
  editor.addEventListener('input', () => { editorDirty = true; feStatus.textContent = (currentAbs || '') + ' · 未保存'; });
  root.querySelector<HTMLElement>('#btn-save')!.onclick = () => void save();
  editor.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); void save(); }
  });

  // 右键菜单(只作用在 root 范围内)
  root.querySelector<HTMLElement>('#fm-open')!.onclick = () => {
    if (menuTarget) { setTab('preview'); loadFile(menuTarget.path); }
    hideMenu();
  };
  root.querySelector<HTMLElement>('#fm-edit')!.onclick = () => {
    if (menuTarget) void loadEditor(menuTarget.path);
    hideMenu();
  };
  root.querySelector<HTMLElement>('#fm-copy')!.onclick = () => {
    if (menuTarget) void navigator.clipboard.writeText(menuTarget.path);
    hideMenu();
  };
  root.addEventListener('click', (ev) => {
    if (!(ev.target as HTMLElement)?.closest('.files-menu')) hideMenu();
  });
  root.addEventListener('contextmenu', (ev) => {
    if (!(ev.target as HTMLElement)?.closest('.fe-row')) hideMenu();
  });

  applyI18nDOM();

  // 独立窗口场景:主进程会推 cwd(开窗时 did-finish-load → send 'files-cwd');内联场景 app.ts 主动调 setCwd。
  api.onFilesCwd((c) => setCwd(c));

  return { setCwd };
}
