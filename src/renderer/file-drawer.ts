// 右侧文件抽屉(File Drawer)—— Codex 式浮层:从右滑入,悬浮在对话之上,
// 不挤压聊天区(布局见 styles.css .fd-root)。Esc / 收起按钮关闭。
// 聊天流里工具 step(read_file/write_file/edit_file)渲染文件 chip,点击 →
// 抽屉展开该文件(CodeEditor 只读)。多文件多 tab,收起抽屉不丢 tab。
//
// 纯 renderer 模块:只走已有 ipc(fileRead),不碰 preload/main。
// i18n 通过注入的 tr 回调(app.ts 的当前语言 helper),本模块不持有语言状态。
// Right-side file drawer: click a file chip in a tool step → split view opens
// that file read-only. Multi-tab, resizable, state survives drawer close.
import { CodeEditor, detectLang } from './code-editor';
import type { KinetAPI } from '../shared/types';

declare global {
  interface Window {
    kinet: KinetAPI;
  }
}

type TrFn = (key: string, params?: Record<string, string | number>) => string;

interface DrawerTab {
  abs: string;        // 解析后的绝对路径(resolved)
  name: string;       // tab 标题(basename)
  pane: HTMLElement;  // 内容宿主(含 CodeEditor)
  editor: CodeEditor;
}

export interface FileDrawer {
  /** 打开/聚焦文件。抽屉自动展开;相对路径经 pathResolver 转绝对。 */
  open(path: string): Promise<void>;
  /** 收起抽屉(保留已开 tab)。 */
  close(): void;
  readonly isOpen: boolean;
  /** 相对路径 → 绝对路径解析器(app.ts 注入,基于当前会话 cwd)。 */
  setPathResolver(fn: ((p: string) => string) | null): void;
}

const MAX_TABS = 12;      // tab 上限,超出关最旧(防止长任务塞爆)
const WIDTH_KEY = 'fd-width';
const MIN_W = 320;

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/**
 * 在 host(#file-drawer-host)内挂载抽屉。DOM 结构:
 *   .fd-root
 *     .fd-resizer      ← 左缘拖拽条
 *     .fd-main
 *       .fd-tabs       ← 文件 tab 条(右端常驻收起按钮)
 *       .fd-body       ← CodeEditor 宿主们(只显示 active)
 *       .fd-empty      ← 无 tab 占位
 */
export function mountFileDrawer(host: HTMLElement, tr: TrFn): FileDrawer {
  const root = document.createElement('div');
  root.className = 'fd-root';
  root.hidden = true;
  root.innerHTML = `
    <div class="fd-resizer" title="拖拽调整宽度"></div>
    <div class="fd-main">
      <div class="fd-tabs"></div>
      <div class="fd-body"></div>
      <div class="fd-empty"></div>
    </div>`;
  host.appendChild(root);

  const tabsEl = root.querySelector<HTMLElement>('.fd-tabs')!;
  const bodyEl = root.querySelector<HTMLElement>('.fd-body')!;
  const emptyEl = root.querySelector<HTMLElement>('.fd-empty')!;
  const resizer = root.querySelector<HTMLElement>('.fd-resizer')!;
  emptyEl.textContent = tr('fd.empty');

  const tabs: DrawerTab[] = [];
  let activeIdx = -1;
  let resolver: ((p: string) => string) | null = null;

  // 收起按钮:tabs 条右端常驻
  const closeBtn = document.createElement('button');
  closeBtn.className = 'fd-close';
  closeBtn.setAttribute('title', tr('fd.close'));
  closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  closeBtn.onclick = () => close();
  tabsEl.appendChild(closeBtn);

  function showEmpty(v: boolean): void { emptyEl.style.display = v ? '' : 'none'; }

  function clampWidth(w: number): number {
    return Math.min(Math.max(w, MIN_W), Math.max(MIN_W + 80, window.innerWidth - 420));
  }
  function applyWidth(): void {
    const saved = Number(localStorage.getItem(WIDTH_KEY) ?? 480);
    root.style.width = clampWidth(Number.isFinite(saved) ? saved : 480) + 'px';
  }

  // 左缘拖拽:向左拖 = 变宽。松手持久化到 localStorage。
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = root.getBoundingClientRect().width;
    const move = (ev: MouseEvent): void => {
      root.style.width = clampWidth(startW + (startX - ev.clientX)) + 'px';
    };
    const up = (): void => {
      localStorage.setItem(WIDTH_KEY, String(Math.round(root.getBoundingClientRect().width)));
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // 高亮 active tab/pane。不重建 tab 条,避免与 renderTabs 互相递归。
  function activate(i: number): void {
    activeIdx = i;
    tabs.forEach((t, idx) => t.pane.classList.toggle('active', idx === i));
    const btns = tabsEl.querySelectorAll('.fd-tab');
    btns.forEach((b, idx) => b.classList.toggle('active', idx === i));
    showEmpty(tabs.length === 0);
  }

  function renderTabs(): void {
    for (const b of [...tabsEl.querySelectorAll('.fd-tab')]) b.remove();
    tabs.forEach((t, i) => {
      const b = document.createElement('button');
      b.className = 'fd-tab' + (i === activeIdx ? ' active' : '');
      b.title = t.abs;
      b.innerHTML = `<span class="fd-tab-name">${escHtml(t.name)}</span><span class="fd-tab-x" title="✕">✕</span>`;
      b.onclick = () => activate(i);
      (b.querySelector('.fd-tab-x') as HTMLElement).onclick = (e) => { e.stopPropagation(); closeTab(i); };
      tabsEl.insertBefore(b, closeBtn);
    });
    showEmpty(tabs.length === 0);
  }

  function closeTab(i: number): void {
    tabs[i].pane.remove();
    tabs.splice(i, 1);
    if (!tabs.length) { close(); activeIdx = -1; renderTabs(); return; }
    activate(Math.min(Math.max(activeIdx >= i ? activeIdx - 1 : activeIdx, 0), tabs.length - 1));
    renderTabs();
  }

  async function open(path: string): Promise<void> {
    const abs = resolver ? resolver(path) : path;
    root.hidden = false;
    applyWidth();
    const norm = abs.replace(/\\/g, '/');
    const found = tabs.findIndex((t) => t.abs.replace(/\\/g, '/') === norm);
    if (found >= 0) { activate(found); return; }
    if (tabs.length >= MAX_TABS) closeTab(0);

    // 先占位挂载再异步读 —— 点击即有反馈,不闪空。
    const pane = document.createElement('div');
    pane.className = 'fd-pane';
    const editorHost = document.createElement('div');
    editorHost.className = 'fd-editor-host';
    pane.appendChild(editorHost);
    bodyEl.appendChild(pane);
    const editor = new CodeEditor(editorHost, { lang: detectLang(abs), readOnly: true, autoHeight: false });
    tabs.push({ abs, name: abs.split(/[\\/]/).pop() || abs, pane, editor });
    activate(tabs.length - 1);
    renderTabs();

    const r = await window.kinet.fileRead(abs);
    editor.value = r.ok && r.content != null ? r.content : `⚠ ${tr('fd.readErr', { msg: r.error ?? '' })}`;
  }

  function close(): void { root.hidden = true; }

  // Esc 收起抽屉(Codex 式)。capture 阶段吃掉事件,避免同时触发
  // app.ts 的「Esc 清空输入框」等其他全局 Esc 行为。
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) { e.stopPropagation(); close(); }
  }, true);

  return {
    open,
    close,
    get isOpen() { return !root.hidden; },
    setPathResolver(fn) { resolver = fn; },
  };
}
