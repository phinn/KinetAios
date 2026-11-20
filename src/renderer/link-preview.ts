// 链接预览:聊天流里的 html/md 链接在应用内渲染预览,不再丢去系统浏览器看源码。
// Link preview: html/md links in the chat feed open an in-app preview instead of
// being handed to the system browser (where you'd just see raw source).
//
// 策略(renderer 事件委托拦截,不动 main.ts 导航层):
// - http(s)/file:// 且扩展名为 html/md 家族 → preventDefault + 应用内 overlay 预览;
//   其余链接走原路(setWindowOpenHandler → shell.openExternal 系统浏览器)。
// - html:复用 files-pane 同款 <webview>(partition=persist:files 持久会话)。
//   预览 guest 不带用户浏览器 cookie,预览态=未登录 —— 换来的是预览与用户身份完全隔离。
// - md:fetch-text IPC 拉原文 → 聊天流同款 renderMarkdown 渲染(先转义后渲染,安全语义一致)。
//   不用 webview 载 md:相对路径基准缺失、guest 内导航难管;同管线渲染更可控。
// - fetch-text 主进程防护:协议白名单、仅 GET、30s 超时、512KB 上限、15 跳重定向、
//   私网/元数据 IP 黑名单且逐跳复检(SSRF 硬闸)。

import { renderMarkdown } from './markdown';

// ── 可预览类型识别:扩展名 → 预览类型(路径后缀判断,query/hash 不参与) ──
const PREVIEWABLE: Record<string, 'html' | 'md'> = {
  html: 'html', htm: 'html', xhtml: 'html',
  md: 'md', markdown: 'md', mdx: 'md', mdown: 'md', mkd: 'md', mdwn: 'md',
  txt: 'md', text: 'md', rst: 'md', org: 'md', adoc: 'md', creole: 'md',
};

// 预览链接分类器(可测试的纯逻辑):http/https/file + html/md 类扩展名 → 预览,其余 null(原路系统浏览器)
// 测试:scripts/test/20-link-preview.test.ts
export function previewableKind(rawUrl: string): 'html' | 'md' | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return null;
    const path = u.pathname.toLowerCase();
    const m = path.match(/\.([a-z0-9]+)$/);
    return m ? (PREVIEWABLE[m[1]] ?? null) : null;
  } catch {
    return null;
  }
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── overlay:全屏遮罩 + 头部(地址栏/外部打开/关闭)+ 内容区。单例,复用。 ──
interface OverlayBits {
  root: HTMLDivElement;
  urlText: HTMLElement;
  body: HTMLElement;
  webview: HTMLElement | null;
}

let bits: OverlayBits | null = null;

function ensureOverlay(): OverlayBits {
  if (bits) return bits;
  const root = document.createElement('div');
  root.className = 'link-preview-overlay';
  root.innerHTML = `
    <div class="lp-chrome">
      <span class="lp-kind"></span>
      <span class="lp-url"></span>
      <span class="lp-flex"></span>
      <button class="lp-btn" data-act="open" title="在浏览器打开 / Open in browser">↗</button>
      <button class="lp-btn" data-act="close" title="关闭 / Close (Esc)">✕</button>
    </div>
    <div class="lp-body"></div>`;
  document.body.appendChild(root);
  const urlText = root.querySelector<HTMLElement>('.lp-url')!;
  const body = root.querySelector<HTMLElement>('.lp-body')!;
  bits = { root, urlText, body, webview: null };

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    // 按钮走 data-act;点遮罩空白(root 本体)关闭;点内容区不冒泡关闭
    const btn = t.closest('[data-act]');
    const url = urlText.textContent || '';
    if (btn) {
      if (btn.getAttribute('data-act') === 'close') closePreview();
      else if (btn.getAttribute('data-act') === 'open' && url) void window.kinet.openExternal(url);
    } else if (t === root) {
      closePreview();
    }
  });
  return bits;
}

function closePreview(): void {
  if (!bits) return;
  // 先摘 webview(src 挂 about:blank)再隐藏,停掉 guest 加载/媒体
  if (bits.webview) {
    const wv = bits.webview as unknown as { loadURL: (u: string) => void };
    try { wv.loadURL('about:blank'); } catch { /* closing anyway */ }
  }
  bits.root.classList.remove('open');
  bits.body.innerHTML = '';
  bits.webview = null;
}

function showChrome(kind: 'html' | 'md', url: string): void {
  const o = ensureOverlay();
  o.root.querySelector<HTMLElement>('.lp-kind')!.textContent = kind.toUpperCase();
  o.urlText.textContent = url;
  o.root.classList.add('open');
}

// ── html 预览:webview 直载(与 files-pane 同 partition,沙箱隔离) ──
function showHtmlPreview(url: string): void {
  showChrome('html', url);
  const o = ensureOverlay();
  const wv = document.createElement('webview') as unknown as HTMLElement & {
    src: string; loadURL: (u: string) => void;
  };
  wv.setAttribute('partition', 'persist:files');
  wv.setAttribute('allowpopups', ''); // guest 内 target=_blank 交主进程 setWindowOpenHandler → 系统浏览器
  wv.style.cssText = 'width:100%;height:100%;border:0;background:#fff;';
  o.body.innerHTML = '';
  o.body.appendChild(wv);
  bits = { ...o, webview: wv };
  wv.src = url;
}

// ── md 预览:fetch 原文 → 聊天流同款渲染管线 ──
async function showMdPreview(url: string): Promise<void> {
  showChrome('md', url);
  const o = ensureOverlay();
  o.body.innerHTML = '<div class="lp-loading">加载中…</div>';
  const r = await window.kinet.fetchText(url);
  // 期间被关闭(Esc)就不再写 DOM
  if (!o.root.classList.contains('open')) return;
  if (!r.ok) {
    o.body.innerHTML = `<div class="lp-error">预览失败:${esc(r.error || 'unknown')}</div>
      <div class="lp-err-hint">可点右上 ↗ 用浏览器打开,或在终端 curl 该地址排查。</div>`;
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'lp-md answer'; // 复用聊天流 .answer 全套 markdown 排版样式
  wrap.innerHTML = renderMarkdown(r.text ?? '');
  o.body.innerHTML = '';
  o.body.appendChild(wrap);
  o.body.scrollTop = 0;
}

// ── 入口:聊天流链接点击委托 ──
export function mountLinkPreview(rootEl: ParentNode): void {
  rootEl.addEventListener('click', (ev) => {
    const e = ev as MouseEvent;
    const a = (e.target as HTMLElement | null)?.closest?.('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href) return;
    const kind = previewableKind(href);
    if (!kind) return; // 非 html/md → 原路(系统浏览器)
    // 修饰键 = 用户显式要走浏览器,尊重
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (kind === 'html') showHtmlPreview(href);
    else void showMdPreview(href);
  });

  // Esc 关闭(捕获阶段,预览开着时优先消费;不影响其他 Esc 消费者)
  rootEl.addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key === 'Escape' && bits?.root.classList.contains('open')) {
      ev.stopPropagation();
      closePreview();
    }
  }, true);
}
