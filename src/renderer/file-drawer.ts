// 右侧文件抽屉(File Drawer)—— Codex 式浮层:从右滑入,悬浮在对话之上,
// 不挤压聊天区(布局见 styles.css .fd-root)。无 tab:点 chip 换文件,
// 头部只显示文件名 + 收起按钮,Esc / ✕ 关闭。
//
// 纯 renderer 模块:只走已有 ipc(fileRead),不碰 preload/main。
// i18n 通过注入的 tr 回调(app.ts 的当前语言 helper),本模块不持有语言状态。
// Right-side file drawer: click a file chip in a tool step → the drawer shows
// that one file read-only. Resizable, Esc/✕ closes.
import { CodeEditor, detectLang } from './code-editor';
import type { KinetAPI } from '../shared/types';

declare global {
  interface Window {
    kinet: KinetAPI;
  }
}

type TrFn = (key: string, params?: Record<string, string | number>) => string;

export interface FileDrawer {
  /** 打开文件(替换当前内容)。抽屉自动展开;相对路径经 pathResolver 转绝对。 */
  open(path: string): Promise<void>;
  /** 收起抽屉。 */
  close(): void;
  readonly isOpen: boolean;
  /** 相对路径 → 绝对路径解析器(app.ts 注入,基于当前会话 cwd)。 */
  setPathResolver(fn: ((p: string) => string) | null): void;
}

const WIDTH_KEY = 'fd-width';
const MIN_W = 320;

/**
 * 在 host(#file-drawer-host)内挂载抽屉。DOM 结构:
 *   .fd-root
 *     .fd-resizer      ← 左缘拖拽条
 *     .fd-main
 *       .fd-head       ← 文件名 + 收起按钮
 *       .fd-body       ← CodeEditor 宿主(只读)
 */
export function mountFileDrawer(host: HTMLElement, tr: TrFn): FileDrawer {
  const root = document.createElement('div');
  root.className = 'fd-root';
  root.hidden = true;
  root.innerHTML = `
    <div class="fd-resizer" title="拖拽调整宽度"></div>
    <div class="fd-main">
      <div class="fd-head">
        <span class="fd-name"></span>
        <button class="fd-close" title=""></button>
      </div>
      <div class="fd-body"><div class="fd-editor-host"></div></div>
    </div>`;
  host.appendChild(root);

  const nameEl = root.querySelector<HTMLElement>('.fd-name')!;
  const closeBtn = root.querySelector<HTMLElement>('.fd-close')!;
  const editorHost = root.querySelector<HTMLElement>('.fd-editor-host')!;
  const resizer = root.querySelector<HTMLElement>('.fd-resizer')!;

  closeBtn.title = tr('fd.close');
  closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  closeBtn.onclick = () => close();

  const editor = new CodeEditor(editorHost, { readOnly: true, autoHeight: false });
  let resolver: ((p: string) => string) | null = null;
  let loadSeq = 0; // 防乱序:快速点多个 chip 时只认最后一次

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

  async function open(path: string): Promise<void> {
    const abs = resolver ? resolver(path) : path;
    root.hidden = false;
    applyWidth();
    // 先占位再异步读 —— 点击即有反馈,不闪空。
    const name = abs.split(/[\\/]/).pop() || abs;
    nameEl.textContent = name;
    nameEl.title = abs;
    editor.value = '';
    editor.lang = detectLang(abs);
    const seq = ++loadSeq;
    const r = await window.kinet.fileRead(abs);
    if (seq !== loadSeq) return; // 已点了别的文件,丢弃旧响应
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
