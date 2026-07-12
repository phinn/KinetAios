// Quick palette (Ctrl/Cmd+Alt+Space). One-shot: submit → stream answer inline.
// The full conversation also lands in the dashboard window.
import { applyEvent } from '../shared/types';
import type { Conversation, KinetAPI } from '../shared/types';
import { t, type Lang } from '../shared/i18n';

declare global {
  interface Window {
    kinet: KinetAPI;
  }
}

const api = window.kinet;
let lang: Lang = 'zh-CN';
// 刷 quick.html 静态文本([data-i18n] / [data-i18n-placeholder])+ <html lang>。
function applyI18nDOM(): void {
  document.documentElement.lang = lang;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = t(lang, el.dataset.i18n!); });
  document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => { (el as HTMLTextAreaElement).placeholder = t(lang, el.dataset.i18nPlaceholder!); });
}
// 读品牌名 + 语言:设 title + 刷静态文本。
Promise.all([api.getBrand(), api.getSettings()]).then(([b, s]) => {
  lang = s.lang;
  document.documentElement.dataset.theme = s.theme; // 与主窗 data-theme 同步
  document.title = `${b.productName} · Quick`;
  applyI18nDOM();
});
let activeId: string | null = null;
let conv: Conversation | null = null;

const out = document.getElementById('q-out')!;
const input = document.getElementById('q-input') as HTMLTextAreaElement;

api.onAgentEvent((id, ev) => {
  if (id !== activeId || !conv) return;
  applyEvent(conv, ev);
  paint();
});
api.onConversation((c) => {
  if (c.id === activeId) {
    conv = c;
    paint();
  }
});

input.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME 组合输入中:交给输入法,不发送
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void submit();
  }
  if (e.key === 'Escape') window.close();
});
input.focus();

async function submit() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  out.textContent = '…';
  conv = null;
  activeId = await api.quickSubmit(text);
}

function paint() {
  if (!conv) return;
  const last = conv.turns[conv.turns.length - 1];
  if (!last) return;
  out.textContent = last.answer || last.error || (conv.status === 'running' ? '…' : '');
}
