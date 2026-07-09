// Quick palette (Ctrl/Cmd+Alt+Space). One-shot: submit → stream answer inline.
// The full conversation also lands in the dashboard window.
import { applyEvent } from '../shared/types';
import type { Conversation, KinetAPI } from '../shared/types';

declare global {
  interface Window {
    kinet: KinetAPI;
  }
}

const api = window.kinet;
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
