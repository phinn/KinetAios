// focus-manager.ts — 模态框焦点陷阱 + 焦点恢复 / Modal focus trap + focus restore
//
// 用法:
//   const restore = trapFocus(modalEl);   // 打开模态框时调用
//   ... 模态框打开后自动 focus 第一个可交互元素
//   restore();                             // 关闭模态框时调用,恢复焦点到触发元素

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

/**
 * 在指定容器内创建焦点陷阱 / Create a focus trap within the given container.
 * - 打开时自动 focus 第一个可交互元素(或容器本身)
 * - Tab / Shift+Tab 在容器内循环
 * - 返回 restore 函数,调用后恢复焦点到打开前的元素
 */
export function trapFocus(container: HTMLElement): () => void {
  const previouslyFocused = document.activeElement as HTMLElement | null;

  // 设置容器为可聚焦 / Make container focusable
  if (!container.hasAttribute('tabindex')) {
    container.setAttribute('tabindex', '-1');
  }

  // 聚焦容器或第一个可交互元素 / Focus container or first focusable
  requestAnimationFrame(() => {
    const focusables = getFocusables(container);
    if (focusables.length > 0) {
      // 优先聚焦 input/textarea,其次 button
      const firstInput = focusables.find(el => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
      (firstInput || focusables[0]).focus();
    } else {
      container.focus();
    }
  });

  function getFocusables(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter(el => isVisible(el));
  }

  function isVisible(el: HTMLElement): boolean {
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;

    const focusables = getFocusables(container);
    if (focusables.length === 0) {
      e.preventDefault();
      container.focus();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement;

    if (e.shiftKey) {
      // Shift+Tab: 如果在第一个元素上,跳到最后一个 / If on first, wrap to last
      if (active === first || active === container || !container.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      // Tab: 如果在最后一个元素上,跳到第一个 / If on last, wrap to first
      if (active === last || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  document.addEventListener('keydown', onKeydown, true);

  // 返回恢复函数 / Return restore function
  return () => {
    document.removeEventListener('keydown', onKeydown, true);
    // 恢复焦点 / Restore focus
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      // 延迟一帧,确保 DOM 已更新 / Delay one frame to ensure DOM is settled
      requestAnimationFrame(() => {
        try { previouslyFocused.focus(); } catch { /* element may be gone */ }
      });
    }
  };
}

/**
 * 简单的焦点恢复(不做 Tab 循环) / Simple focus restore without Tab cycling.
 * 用于非模态场景(如 toast 关闭后恢复)。
 */
export function saveFocus(): () => void {
  const el = document.activeElement as HTMLElement | null;
  return () => {
    if (el && typeof el.focus === 'function') {
      requestAnimationFrame(() => {
        try { el.focus(); } catch { /* */ }
      });
    }
  };
}
