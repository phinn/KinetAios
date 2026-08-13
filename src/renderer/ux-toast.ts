// ux-toast.ts — 统一 Toast 通知系统 / Unified Toast notification system
// 取代 alert() / gitToast() / showMsg() / ad-hoc inline toasts。
// 支持 4 种语义级别: success / error / info / warning
// 特性: 队列管理、自动消失、手动关闭、stack 堆叠、主题感知、可访问(aria-live)

type ToastKind = 'success' | 'error' | 'info' | 'warning';

interface ToastEntry {
  el: HTMLDivElement;
  timer: ReturnType<typeof setTimeout> | null;
}

const MAX_TOASTS = 5;           // 同时最多显示 5 条
const DEFAULT_DURATIONS: Record<ToastKind, number> = {
  success: 3000,
  info: 3500,
  warning: 5000,
  error: 6000,
};

let container: HTMLDivElement | null = null;
const activeToasts: ToastEntry[] = [];

function ensureContainer(): HTMLDivElement {
  if (container && document.body.contains(container)) return container;
  container = document.createElement('div');
  container.className = 'ux-toast-container';
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', 'Notifications');
  document.body.appendChild(container);
  return container;
}

function kindIcon(kind: ToastKind): string {
  const icons: Record<ToastKind, string> = {
    success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
    info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    warning: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  };
  return icons[kind];
}

function kindLabel(kind: ToastKind): string {
  const labels: Record<ToastKind, string> = {
    success: '✓',
    error: '✗',
    info: 'ℹ',
    warning: '⚠',
  };
  return labels[kind];
}

/**
 * 显示一条 Toast 通知 / Show a toast notification.
 * @param message 消息文本(纯文本,不含 HTML)
 * @param kind 语义级别
 * @param duration 自动关闭时长(ms),0 = 手动关闭。默认按 kind 决定。
 */
export function toast(message: string, kind: ToastKind = 'info', duration?: number): void {
  const cont = ensureContainer();

  // 超出上限:移除最早的 / Enforce max visible count
  while (activeToasts.length >= MAX_TOASTS) {
    const oldest = activeToasts.shift();
    if (oldest) dismissToast(oldest);
  }

  const dur = duration ?? DEFAULT_DURATIONS[kind];

  const el = document.createElement('div');
  el.className = `ux-toast ux-toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');

  el.innerHTML = `
    <span class="ux-toast-icon">${kindIcon(kind)}</span>
    <span class="ux-toast-msg">${escHtml(message)}</span>
    <button class="ux-toast-close" aria-label="Close" tabindex="0">${'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'}</button>
  `;

  const entry: ToastEntry = { el, timer: null };

  // 关闭按钮 / Close button
  el.querySelector('.ux-toast-close')!.addEventListener('click', () => {
    dismissToast(entry);
  });

  // 鼠标悬停暂停自动关闭 / Hover to pause auto-dismiss
  el.addEventListener('mouseenter', () => {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    el.classList.add('ux-toast-paused');
  });
  el.addEventListener('mouseleave', () => {
    el.classList.remove('ux-toast-paused');
    if (entry.timer === null && dur > 0) {
      entry.timer = setTimeout(() => dismissToast(entry), dur);
    }
  });

  cont.appendChild(el);
  activeToasts.push(entry);

  // 触发入场动画 / Trigger enter animation
  requestAnimationFrame(() => {
    el.classList.add('ux-toast-show');
  });

  if (dur > 0) {
    entry.timer = setTimeout(() => dismissToast(entry), dur);
  }
}

function dismissToast(entry: ToastEntry): void {
  const idx = activeToasts.indexOf(entry);
  if (idx === -1) return;  // already dismissed

  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }

  entry.el.classList.remove('ux-toast-show');
  entry.el.classList.add('ux-toast-leaving');

  // 动画结束后移除 DOM / Remove from DOM after exit animation
  const removeTimer = setTimeout(() => {
    entry.el.remove();
    const i = activeToasts.indexOf(entry);
    if (i !== -1) activeToasts.splice(i, 1);
  }, 300);

  // 标记 timer 防止重复 / Mark to prevent re-entry
  entry.timer = removeTimer as any;
}

/** 快捷方法 / Convenience wrappers */
export const uxToast = {
  ok: (msg: string, dur?: number) => toast(msg, 'success', dur),
  err: (msg: string, dur?: number) => toast(msg, 'error', dur),
  info: (msg: string, dur?: number) => toast(msg, 'info', dur),
  warn: (msg: string, dur?: number) => toast(msg, 'warning', dur),
};

// HTML 转义(防注入) / HTML escape (prevent injection)
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
