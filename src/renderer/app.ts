// Dashboard renderer. Vanilla TS — no framework. Holds a local copy of conversations,
// applies streaming events, re-renders the changed bits. Settings + shell-confirm modal inline.
import { applyEvent } from '../shared/types';
import type { AppSettings, Conversation, EngineKind, KinetAPI } from '../shared/types';
import { renderMarkdown as md } from './markdown';

declare global {
  interface Window {
    kinet: KinetAPI;
  }
}

const api: KinetAPI = window.kinet;
const convs = new Map<string, Conversation>();
let order: string[] = [];
let selectedId: string | null = null;

// ---------- bootstrap ----------
(async function init() {
  const list = await api.getConversations();
  for (const c of list) {
    convs.set(c.id, c);
    order.push(c.id);
  }
  if (order.length) selectedId = order[0];

  api.onConversation((conv) => {
    const isNew = !convs.has(conv.id);
    convs.set(conv.id, conv);
    if (isNew) order.unshift(conv.id);
    renderSidebar();
    if (conv.id === selectedId) renderMain();
  });
  api.onConversationRemoved((id) => {
    convs.delete(id);
    order = order.filter((x) => x !== id);
    if (selectedId === id) selectedId = order[0] ?? null;
    renderSidebar();
    renderMain();
  });
  api.onAgentEvent((convId, ev) => {
    const conv = convs.get(convId);
    if (!conv) return;
    applyEvent(conv, ev);
    if (convId === selectedId) {
      if (ev.type === 'token') streamPatch(conv);
      else renderMain();
    }
    if (ev.type !== 'token') renderSidebar();
  });
  api.onConfirmRequest((req) => showConfirm(req.id, req.cmd));

  wireUi();
  renderSidebar();
  renderMain();
})();

// ---------- sidebar ----------
function renderSidebar() {
  const ul = document.getElementById('conv-list')!;
  ul.innerHTML = '';
  if (!order.length) {
    ul.innerHTML = '<li style="color:var(--text-faint);cursor:default">还没有会话 — 点 ＋ 新建</li>';
    return;
  }
  for (const id of order) {
    const c = convs.get(id);
    if (!c) continue;
    const li = document.createElement('li');
    if (id === selectedId) li.classList.add('active');
    const last = c.turns[c.turns.length - 1];
    const title = c.customTitle || (c.turns[0]?.prompt.slice(0, 40)) || '新会话';
    const cls = c.status === 'running' ? 'running' : last?.error ? 'error' : 'ready';
    li.innerHTML = `<span class="dot ${cls}"></span><span class="title">${esc(title)}</span>`;
    li.onclick = () => {
      selectedId = id;
      renderSidebar();
      renderMain();
    };
    ul.appendChild(li);
  }
}

// ---------- main pane ----------
function renderMain() {
  const conv = selectedId ? convs.get(selectedId) : undefined;
  renderHead(conv);
  const turns = document.getElementById('turns')!;
  turns.innerHTML = '';
  if (!conv) {
    turns.appendChild(empty('选择一个会话,或点 ＋ 新建'));
    return;
  }
  if (!conv.turns.length) {
    turns.appendChild(empty('输入任务开始'));
  }
  for (let i = 0; i < conv.turns.length; i++) {
    turns.appendChild(renderTurn(conv, i));
  }
  scrollDown();
}

function renderHead(conv: Conversation | undefined) {
  const dot = document.getElementById('head-dot')!;
  const title = document.getElementById('head-title')!;
  const cwd = document.getElementById('cwd-input') as HTMLInputElement;
  const eng = document.getElementById('engine-select') as HTMLSelectElement;
  const stat = document.getElementById('head-stat')!;
  if (!conv) {
    dot.className = 'dot ready';
    title.textContent = 'KinetAios';
    cwd.value = '';
    eng.value = 'direct';
    stat.textContent = '';
    return;
  }
  const last = conv.turns[conv.turns.length - 1];
  const cls = conv.status === 'running' ? 'running' : last?.error ? 'error' : 'ready';
  dot.className = `dot ${cls}`;
  title.textContent = conv.customTitle || conv.turns[0]?.prompt.slice(0, 60) || '新会话';
  if (document.activeElement !== cwd) cwd.value = conv.cwd;
  if (document.activeElement !== eng) eng.value = conv.engine;
  const parts: string[] = [];
  if (conv.tokens) parts.push(`${(conv.tokens / 1000).toFixed(1)}k tok`);
  if (conv.cost) parts.push(`$${conv.cost.toFixed(4)}`);
  stat.textContent = parts.join(' · ');
}

function renderTurn(conv: Conversation, i: number): HTMLElement {
  const t = conv.turns[i];
  const isLast = i === conv.turns.length - 1;
  const streaming = isLast && conv.status === 'running' && !t.done;
  const wrap = document.createElement('div');
  wrap.className = 'turn';

  const prompt = document.createElement('div');
  prompt.innerHTML = `<div class="role">你</div><div class="prompt"></div>`;
  prompt.querySelector('.prompt')!.textContent = t.prompt;
  wrap.appendChild(prompt);

  if (t.steps.length || t.answer || streaming || t.error) {
    const ans = document.createElement('div');
    ans.className = 'answer';
    if (streaming) {
      ans.id = 'streaming-answer';
      ans.classList.add('streaming');
      ans.textContent = t.answer;
    } else if (t.answer) {
      ans.innerHTML = md(t.answer);
    }
    if (t.steps.length) {
      const steps = document.createElement('div');
      steps.className = 'steps';
      for (const s of t.steps) steps.appendChild(renderStep(s));
      wrap.appendChild(steps);
    }
    wrap.appendChild(ans);
    if (t.error) {
      const e = document.createElement('div');
      e.className = 'err';
      e.textContent = '⚠️ ' + t.error;
      wrap.appendChild(e);
    }
  }
  return wrap;
}

function renderStep(s: { name: string; args: string; result: string }): HTMLElement {
  const el = document.createElement('div');
  el.className = 'step';
  const det = document.createElement('details');
  det.innerHTML = `<summary><span class="name">🔧 ${esc(s.name)}</span></summary><pre></pre><pre></pre>`;
  const pres = det.querySelectorAll('pre');
  pres[0].textContent = s.args;
  pres[1].textContent = s.result.slice(0, 4000);
  el.appendChild(det);
  return el;
}

// Streaming token — patch the live answer node directly (no full re-render).
function streamPatch(conv: Conversation) {
  let el = document.getElementById('streaming-answer');
  if (!el) {
    renderMain();
    el = document.getElementById('streaming-answer');
  }
  const last = conv.turns[conv.turns.length - 1];
  if (el && last) el.textContent = last.answer;
  scrollDown();
}

function empty(text: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = text;
  return d;
}

function scrollDown() {
  const turns = document.getElementById('turns');
  if (turns) turns.scrollTop = turns.scrollHeight;
}

// ---------- settings ----------
async function showSettings() {
  document.getElementById('chat-view')!.classList.remove('active');
  document.getElementById('settings-view')!.classList.add('active');
  const s = await api.getSettings();
  const root = document.getElementById('settings')!;
  root.innerHTML = `
    <div class="card">
      <button id="s-back" class="ghost" style="margin-bottom:14px">← 返回对话</button>
      <h2>设置</h2>
      <div class="sub">Direct 引擎走 OpenAI 兼容或 Anthropic 协议的端点。</div>
      <div class="field"><label>Provider 预设</label><select id="s-preset">
        ${PRESETS.map((p) => `<option value="${p.id}" ${p.id === s.presetId ? 'selected' : ''}>${p.label}</option>`).join('')}
      </select></div>
      <div class="field"><label>API Key</label><input id="s-key" type="password" value="${esc(s.apiKey)}" /></div>
      <div class="field"><label>Base URL</label><input id="s-base" value="${esc(s.baseURL)}" /></div>
      <div class="field"><label>模型 ID</label><input id="s-model" value="${esc(s.model)}" /></div>
      <div class="field"><label>协议</label><select id="s-proto">
        <option value="openai" ${s.apiProtocol === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
        <option value="anthropic" ${s.apiProtocol === 'anthropic' ? 'selected' : ''}>Anthropic</option>
      </select></div>
      <div class="field"><label>Reasoning effort</label><select id="s-reason">${REASONS.map(
        (r) => `<option value="${r}" ${r === s.reasoning ? 'selected' : ''}>${r}</option>`,
      ).join('')}</select></div>
      <div class="field"><label>shell 执行确认</label><select id="s-approval">
        <option value="always" ${s.approval === 'always' ? 'selected' : ''}>每次确认</option>
        <option value="never" ${s.approval === 'never' ? 'selected' : ''}>从不(自动放行)</option>
      </select></div>
      <div class="field"><label>Claude Code / Codex 沙盒</label><select id="s-sandbox">
        <option value="readOnly" ${s.sandbox === 'readOnly' ? 'selected' : ''}>只读(规划)</option>
        <option value="workspaceWrite" ${s.sandbox === 'workspaceWrite' ? 'selected' : ''}>工作区写入</option>
        <option value="fullAccess" ${s.sandbox === 'fullAccess' ? 'selected' : ''}>完全访问</option>
      </select></div>
      <div class="field"><label><input type="checkbox" id="s-plan" ${s.planMode ? 'checked' : ''} style="width:auto;margin-right:6px" />计划模式(只规划不执行)</label></div>
      <div class="field"><label>价格(USD / 1M tokens)·0=内置默认</label>
        <div class="row"><input id="s-pin" type="number" step="0.01" value="${s.priceInPerMTok}" /><input id="s-pout" type="number" step="0.01" value="${s.priceOutPerMTok}" /></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="primary" id="s-save">保存</button>
        <button id="s-test">测试连接</button>
        <span class="test-msg" id="s-msg"></span>
      </div>
    </div>`;
  const apply = () => {
    const preset = PRESETS.find((p) => p.id === (document.getElementById('s-preset') as HTMLSelectElement).value);
    if (preset && preset.id !== 'custom') {
      (document.getElementById('s-base') as HTMLInputElement).value = preset.baseURL;
      (document.getElementById('s-model') as HTMLInputElement).value = preset.model;
      (document.getElementById('s-proto') as HTMLSelectElement).value = preset.proto;
      (document.getElementById('s-pin') as HTMLInputElement).value = String(preset.pin);
      (document.getElementById('s-pout') as HTMLInputElement).value = String(preset.pout);
    }
  };
  document.getElementById('s-back')!.onclick = () => showChat();
  document.getElementById('s-preset')!.onchange = apply;
  document.getElementById('s-save')!.onclick = async () => {
    const ns: AppSettings = {
      presetId: (document.getElementById('s-preset') as HTMLSelectElement).value,
      apiKey: (document.getElementById('s-key') as HTMLInputElement).value,
      baseURL: (document.getElementById('s-base') as HTMLInputElement).value,
      model: (document.getElementById('s-model') as HTMLInputElement).value,
      apiProtocol: (document.getElementById('s-proto') as HTMLSelectElement).value as AppSettings['apiProtocol'],
      reasoning: (document.getElementById('s-reason') as HTMLSelectElement).value as AppSettings['reasoning'],
      approval: (document.getElementById('s-approval') as HTMLSelectElement).value as AppSettings['approval'],
      sandbox: (document.getElementById('s-sandbox') as HTMLSelectElement).value as AppSettings['sandbox'],
      planMode: (document.getElementById('s-plan') as HTMLInputElement).checked,
      priceInPerMTok: Number((document.getElementById('s-pin') as HTMLInputElement).value) || 0,
      priceOutPerMTok: Number((document.getElementById('s-pout') as HTMLInputElement).value) || 0,
    };
    await api.saveSettings(ns);
    showMsg('已保存', true);
  };
  document.getElementById('s-test')!.onclick = async () => {
    showMsg('测试中…', false);
    const r = await api.testConnection();
    showMsg(r.message, r.ok);
  };
}

function showMsg(text: string, ok: boolean) {
  const el = document.getElementById('s-msg')!;
  el.textContent = text;
  el.className = 'test-msg ' + (ok ? 'ok' : 'bad');
}

// ---------- shell confirm modal ----------
let currentConfirm: string | null = null;
function showConfirm(id: string, cmd: string) {
  if (currentConfirm && currentConfirm !== id) api.confirmResponse(currentConfirm, false); // deny stacked
  currentConfirm = id;
  document.getElementById('modal-cmd')!.textContent = cmd;
  const noAsk = document.getElementById('modal-noask') as HTMLInputElement | null;
  if (noAsk) noAsk.checked = false;
  document.getElementById('modal')!.classList.add('show');
}
async function closeConfirm(approved: boolean) {
  const noAsk = (document.getElementById('modal-noask') as HTMLInputElement | null)?.checked;
  if (currentConfirm) api.confirmResponse(currentConfirm, approved);
  currentConfirm = null;
  document.getElementById('modal')!.classList.remove('show');
  // "don't ask again" → flip the global approval policy to never (persists to settings.json).
  if (approved && noAsk) {
    const s = await api.getSettings();
    s.approval = 'never';
    await api.saveSettings(s);
  }
}

// ---------- wiring ----------
function wireUi() {
  document.getElementById('btn-new')!.onclick = async () => {
    const conv = await api.newConversation();
    selectedId = conv.id;
    showChat();
    renderSidebar();
    renderMain();
    document.getElementById('composer')!.focus();
  };
  document.getElementById('btn-settings')!.onclick = () => {
    if (document.getElementById('settings-view')!.classList.contains('active')) showChat();
    else showSettings();
  };
  document.getElementById('btn-clear')!.onclick = () => selectedId && api.clearConversation(selectedId);
  document.getElementById('btn-del')!.onclick = () => selectedId && api.deleteConversation(selectedId);
  document.getElementById('btn-send')!.onclick = send;
  document.getElementById('modal-ok')!.onclick = () => closeConfirm(true);
  document.getElementById('modal-cancel')!.onclick = () => closeConfirm(false);

  const cwd = document.getElementById('cwd-input') as HTMLInputElement;
  cwd.addEventListener('change', () => {
    if (selectedId) api.setCwd(selectedId, cwd.value.trim());
  });

  const eng = document.getElementById('engine-select') as HTMLSelectElement;
  eng.addEventListener('change', () => {
    if (selectedId) api.setEngine(selectedId, eng.value as EngineKind);
  });

  const composer = document.getElementById('composer') as HTMLTextAreaElement;
  composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  composer.addEventListener('input', () => autosize(composer));
}

async function send() {
  if (!selectedId) return;
  const composer = document.getElementById('composer') as HTMLTextAreaElement;
  const text = composer.value;
  if (!text.trim()) return;
  composer.value = '';
  autosize(composer);
  showChat();
  await api.send(selectedId, text);
  document.getElementById('composer')!.focus();
}

function showChat() {
  document.getElementById('settings-view')!.classList.remove('active');
  document.getElementById('chat-view')!.classList.add('active');
  renderMain();
}

function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PRESETS = [
  { id: 'glm', label: 'GLM 智谱', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.2', proto: 'openai', pin: 0.07, pout: 0.21 },
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', proto: 'openai', pin: 0.27, pout: 1.1 },
  { id: 'qwen', label: '阿里通义 (DashScope)', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max', proto: 'openai', pin: 0.29, pout: 0.86 },
  { id: 'custom', label: '自定义', baseURL: '', model: '', proto: 'openai', pin: 0, pout: 0 },
];
const REASONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
