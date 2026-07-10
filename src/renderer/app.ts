// Dashboard renderer. Vanilla TS — no framework. Holds a local copy of conversations,
// applies streaming events, re-renders the changed bits. Settings + shell-confirm modal inline.
import { applyEvent, ENGINE_LABELS } from '../shared/types';
import type { AppSettings, Conversation, EngineKind, KinetAPI, SkillInfo } from '../shared/types';
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
let cliEnabled = false; // mirrors settings.enableCliEngines — gates the engine dropdown
const slashMenu = document.getElementById('slash-menu')!;
let skills: SkillInfo[] = []; // lazily fetched on first /
let slashItems: SkillInfo[] = []; // current filtered view
let slashIndex = 0;
let attachments: { name: string; content: string }[] = []; // 📎 选 / 拖入的文件,发送时拼进 prompt

// ---------- bootstrap ----------
(async function init() {
  // 阻止 Electron 把拖入的文件当成 URL 打开(默认会让整个窗口跳转/白屏)。
  // 只有 #input 的 drop 真正接收文件(见 wireUi)。
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  const list = await api.getConversations();
  for (const c of list) {
    convs.set(c.id, c);
    order.push(c.id);
  }
  if (order.length) selectedId = order[0];
  cliEnabled = (await api.getSettings()).enableCliEngines;

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
      if (ev.type === 'token') streamAppend(ev.text);
      else renderMain();
    }
    if (ev.type !== 'token') renderSidebar();
  });
  api.onConfirmRequest((req) => showConfirm(req.id, req.cmd));

  fillModelHints();
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
  const model = document.getElementById('model-input') as HTMLInputElement;
  const eng = document.getElementById('engine-select') as HTMLSelectElement;
  const stat = document.getElementById('head-stat')!;
  const status = document.getElementById('head-status')!;
  const sendBtn = document.getElementById('btn-send')!;
  if (!conv) {
    dot.className = 'dot ready';
    title.textContent = 'KinetAios';
    cwd.value = '';
    model.value = '';
    model.style.display = 'none';
    eng.value = 'direct';
    stat.textContent = '';
    status.textContent = '';
    sendBtn.textContent = '发送';
    sendBtn.classList.remove('stop');
    return;
  }
  const last = conv.turns[conv.turns.length - 1];
  const cls = conv.status === 'running' ? 'running' : last?.error ? 'error' : 'ready';
  dot.className = `dot ${cls}`;
  title.textContent = conv.customTitle || conv.turns[0]?.prompt.slice(0, 60) || '新会话';
  if (document.activeElement !== cwd) cwd.value = conv.cwd;
  // Model picker only matters for Direct (claudeCode/codex use their own CLI models) → hide otherwise.
  model.style.display = conv.engine === 'direct' ? '' : 'none';
  if (document.activeElement !== model) model.value = conv.model;
  syncEngineSelect(conv);
  const parts: string[] = [];
  if (conv.tokens) parts.push(`${(conv.tokens / 1000).toFixed(1)}k tok`);
  if (conv.cost) parts.push(`$${conv.cost.toFixed(4)}`);
  stat.textContent = parts.join(' · ');
  status.textContent = conv.status === 'running' && conv.statusNote ? conv.statusNote : '';
  sendBtn.textContent = conv.status === 'running' ? '停止' : '发送';
  sendBtn.classList.toggle('stop', conv.status === 'running');
}

// Rebuild the engine dropdown from the toggle. Direct is always present; Claude/Codex only when
// enabled. If the active conversation is already on a CLI engine while disabled, keep showing it
// (read-only-ish) so the value isn't blanked — switching away is still allowed, back is not.
function syncEngineSelect(conv: Conversation | undefined) {
  const sel = document.getElementById('engine-select') as HTMLSelectElement;
  const current = conv?.engine ?? 'direct';
  const want: EngineKind[] = cliEnabled ? ['direct', 'claudeCode', 'codex'] : ['direct'];
  if (!want.includes(current)) want.push(current);
  const have = [...sel.options].map((o) => o.value);
  const same = have.length === want.length && have.every((v, i) => v === want[i]);
  if (!same) {
    sel.innerHTML = want.map((e) => `<option value="${e}">${esc(ENGINE_LABELS[e])}</option>`).join('');
  }
  if (document.activeElement !== sel) sel.value = current;
}

function renderTurn(conv: Conversation, i: number): HTMLElement {
  const t = conv.turns[i];
  const isLast = i === conv.turns.length - 1;
  const streaming = isLast && conv.status === 'running' && !t.done;
  const wrap = document.createElement('div');
  wrap.className = 'turn';

  // 用户消息:头像在右、气泡在左(行内靠右)
  const userMsg = document.createElement('div');
  userMsg.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = t.prompt;
  userMsg.appendChild(bubble);
  userMsg.appendChild(avatarEl('🧑'));
  wrap.appendChild(userMsg);

  // AI 回复:头像在左、正文在右(无内容且非流式时不渲染)
  if (t.steps.length || t.answer || streaming || t.error) {
    const aiMsg = document.createElement('div');
    aiMsg.className = 'msg ai';
    const body = document.createElement('div');
    body.className = 'ai-body';
    if (t.steps.length) {
      const steps = document.createElement('div');
      steps.className = 'steps';
      for (const s of t.steps) steps.appendChild(renderStep(s));
      body.appendChild(steps);
    }
    const ans = document.createElement('div');
    ans.className = 'answer';
    if (streaming) {
      ans.id = 'streaming-answer';
      ans.classList.add('streaming');
      // 接口还没返回首个 token → 头像旁显示三点"思考中"反馈;token 一到 streamPatch 会用正文覆盖。
      if (t.answer) ans.textContent = t.answer;
      else ans.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    } else if (t.answer) {
      ans.innerHTML = md(t.answer);
    }
    body.appendChild(ans);
    if (t.error) {
      const e = document.createElement('div');
      e.className = 'err';
      e.textContent = '⚠️ ' + t.error;
      body.appendChild(e);
    }
    aiMsg.appendChild(avatarEl('✨'));
    aiMsg.appendChild(body);
    wrap.appendChild(aiMsg);
  }
  return wrap;
}

function avatarEl(emoji: string): HTMLElement {
  const a = document.createElement('div');
  a.className = 'avatar';
  a.textContent = emoji;
  return a;
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

// 流式 token:增量追加(不全量重设 textContent,避免长答案 O(n²) 重渲)。
function streamAppend(text: string) {
  let el = document.getElementById('streaming-answer');
  if (!el) {
    renderMain();
    el = document.getElementById('streaming-answer');
  }
  if (el) {
    el.appendChild(document.createTextNode(text));
    scrollDown();
  }
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
      <div class="field"><label><input type="checkbox" id="s-cli" ${s.enableCliEngines ? 'checked' : ''} style="width:auto;margin-right:6px" />启用 Claude Code / Codex 引擎(需本地装好 CLI,默认关)</label></div>
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
    const ns = readSettingsForm();
    await api.saveSettings(ns);
    cliEnabled = ns.enableCliEngines;
    renderMain(); // refresh the engine dropdown for the new toggle state
    showMsg('已保存', true);
  };
  document.getElementById('s-test')!.onclick = async () => {
    showMsg('测试中…', false);
    // Test the in-form values, not the last-saved ones (kills the "edit key, test, still old key" trap).
    const r = await api.testConnection(readSettingsForm());
    showMsg(r.message, r.ok);
  };
}

// Read the settings form into AppSettings. Shared by Save and Test so Test validates the in-form
// config rather than whatever was last persisted.
function readSettingsForm(): AppSettings {
  return {
    presetId: (document.getElementById('s-preset') as HTMLSelectElement).value,
    apiKey: (document.getElementById('s-key') as HTMLInputElement).value,
    baseURL: (document.getElementById('s-base') as HTMLInputElement).value,
    model: (document.getElementById('s-model') as HTMLInputElement).value,
    apiProtocol: (document.getElementById('s-proto') as HTMLSelectElement).value as AppSettings['apiProtocol'],
    reasoning: (document.getElementById('s-reason') as HTMLSelectElement).value as AppSettings['reasoning'],
    approval: (document.getElementById('s-approval') as HTMLSelectElement).value as AppSettings['approval'],
    sandbox: (document.getElementById('s-sandbox') as HTMLSelectElement).value as AppSettings['sandbox'],
    planMode: (document.getElementById('s-plan') as HTMLInputElement).checked,
    enableCliEngines: (document.getElementById('s-cli') as HTMLInputElement).checked,
    priceInPerMTok: Number((document.getElementById('s-pin') as HTMLInputElement).value) || 0,
    priceOutPerMTok: Number((document.getElementById('s-pout') as HTMLInputElement).value) || 0,
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
  document.getElementById('btn-cwd')!.onclick = async () => {
    if (!selectedId) return;
    const dir = await api.pickDirectory();
    if (dir) {
      api.setCwd(selectedId, dir);
      cwd.value = dir;
    }
  };

  const model = document.getElementById('model-input') as HTMLInputElement;
  model.addEventListener('change', () => {
    if (selectedId) api.setModel(selectedId, model.value.trim());
  });

  const eng = document.getElementById('engine-select') as HTMLSelectElement;
  eng.addEventListener('change', () => {
    if (!selectedId) return;
    closeSlash();
    const conv = convs.get(selectedId);
    const next = eng.value as EngineKind;
    // Switching wipes cross-engine context (Direct history + the CLI session id used for --resume).
    // Only confirm when there's actually something to lose.
    const hasContext = !!(conv && (conv.directHistory.length || conv.engineSessionId || conv.turns.length));
    if (next !== conv?.engine && hasContext && !confirm('切换引擎会清空当前上下文(Direct 对话历史 / Claude·Codex 的会话续接)。继续?')) {
      syncEngineSelect(conv); // revert the dropdown
      return;
    }
    api.setEngine(selectedId, next);
  });

  const composer = document.getElementById('composer') as HTMLTextAreaElement;
  composer.addEventListener('keydown', (e) => {
    // IME 组合输入中(中文/日文等还没确认候选):按键交给输入法,避免 Enter 确认词被误当成发送。
    if (e.isComposing || e.keyCode === 229) return;
    if (!slashMenu.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSlash(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSlash(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  composer.addEventListener('input', () => {
    autosize(composer);
    handleSlash(composer);
  });
  composer.addEventListener('blur', () => setTimeout(closeSlash, 150));

  // 文件附件:📎 选 / 拖入多个
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  document.getElementById('btn-attach')!.onclick = () => fileInput.click();
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    if (files.length) void addFiles(files);
    fileInput.value = ''; // 允许重复选同一文件
  });
  const dropZone = document.getElementById('input')!;
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag');
  });
  dropZone.addEventListener('dragleave', (e) => {
    if (!dropZone.contains(e.relatedTarget as Node | null)) dropZone.classList.remove('drag');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag');
    // 检测文件夹(暂不支持递归读)→ 提示
    const items = e.dataTransfer?.items;
    let hasDir = false;
    if (items) {
      for (const it of Array.from(items)) {
        const ent = it.webkitGetAsEntry?.() as { isDirectory?: boolean } | null | undefined;
        if (ent?.isDirectory) { hasDir = true; break; }
      }
    }
    if (hasDir) alert('暂不支持文件夹,请拖单个文件(可多选),或用 📎 选择。');
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) void addFiles(files);
  });

  // Skill 按钮:打开 skill 菜单(复用 / 的逻辑)。Direct 才有意义。
  document.getElementById('btn-skill')!.onclick = () => {
    if (selectedId && convs.get(selectedId)?.engine !== 'direct') return;
    (document.getElementById('composer') as HTMLTextAreaElement).focus();
    void openSlash('');
  };

  // MCP 按钮:弹已连服务 + 工具列表(可见性)。点外面关闭。
  document.getElementById('btn-mcp')!.onclick = async (e) => {
    e.stopPropagation();
    const menu = document.getElementById('mcp-menu')!;
    if (!menu.hidden) { menu.hidden = true; return; }
    const list = await api.listMcp();
    menu.innerHTML = list.length
      ? list.map((s) => `<div class="mcp-srv"><div class="mcp-srv-name">🔌 ${esc(s.name)}<span class="mcp-src">${s.source}</span></div><div class="mcp-tools">${
          s.tools.length ? s.tools.map((t) => `<span class="mcp-tool">${esc(t)}</span>`).join('') : '<i>(无工具)</i>'
        }</div></div>`).join('')
      : '<div class="mcp-empty">未连接 MCP 服务。<br>在 ~/.claude.json / ~/.codex/config.toml 配置后,启动时自动接入。</div>';
    menu.hidden = false;
  };
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('mcp-menu')!;
    if (!menu.hidden && !(e.target as HTMLElement)?.closest('#btn-mcp, #mcp-menu')) menu.hidden = true;
  });
}

async function send() {
  if (!selectedId) return;
  // Running → the same button acts as Stop (cancel the in-flight task).
  if (convs.get(selectedId)?.status === 'running') {
    await api.cancel(selectedId);
    return;
  }
  closeSlash();
  const composer = document.getElementById('composer') as HTMLTextAreaElement;
  const typed = composer.value;
  if (!typed.trim() && !attachments.length) return;
  // @文件引用 + 📎 附件:内容拼到正文前(代码块包裹,模型可直接读取)。
  const cwd = convs.get(selectedId)?.cwd ?? '';
  const at = cwd ? await resolveAtFiles(typed, cwd) : { files: [], missing: [] };
  const files = [...attachments, ...at.files];
  let text = typed;
  if (files.length) {
    text = files.map((a) => `📎 文件 ${a.name}:\n\`\`\`\n${a.content}\n\`\`\``).join('\n\n') + '\n\n---\n\n' + typed;
    attachments = [];
    renderAttach();
  }
  if (at.missing.length) alert(`这些 @文件 没读到(不存在 / 非文本 / 不在工作目录内):\n${at.missing.join('\n')}`);
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

// ---------- slash skill menu (Direct only) ----------
// Typing /<name> in the composer opens a filterable list of skills from ~/.claude/skills +
// ~/.codex/skills. Pick (Enter/click) inserts "/name " — sending it makes the Direct engine
// inject that skill's body. Non-Direct conversations never show the menu.
async function ensureSkills(): Promise<SkillInfo[]> {
  if (!skills.length) skills = await api.listSkills();
  return skills;
}

function handleSlash(composer: HTMLTextAreaElement): void {
  const conv = selectedId ? convs.get(selectedId) : undefined;
  const v = composer.value;
  // Only while the user is still typing the name token (no space yet) and only for Direct.
  if (conv?.engine !== 'direct' || !v.startsWith('/') || /\s/.test(v.slice(1))) {
    closeSlash();
    return;
  }
  void openSlash(v.slice(1).toLowerCase());
}

async function openSlash(q: string): Promise<void> {
  const all = await ensureSkills();
  slashItems = all
    .filter((s) => s.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ai = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bi = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return ai - bi || a.name.localeCompare(b.name);
    })
    .slice(0, 50);
  slashIndex = 0;
  renderSlash();
}

function renderSlash(): void {
  if (!slashItems.length) {
    slashMenu.innerHTML = '<div class="slash-empty">无匹配 skill</div>';
    slashMenu.hidden = false;
    return;
  }
  slashMenu.innerHTML = slashItems
    .map(
      (s, i) =>
        `<div class="slash-item${i === slashIndex ? ' active' : ''}" data-i="${i}">` +
        `<span class="slash-name">${esc(s.name)}<span class="slash-tag">${s.source}</span></span>` +
        `<span class="slash-desc">${esc(s.description)}</span></div>`,
    )
    .join('');
  slashMenu.hidden = false;
  slashMenu.querySelectorAll<HTMLElement>('.slash-item').forEach((el) => {
    el.onclick = () => {
      const s = slashItems[Number(el.dataset.i)];
      if (s) pickSlash(s.name);
    };
  });
}

function moveSlash(delta: number): void {
  if (!slashItems.length) return;
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  renderSlash();
  slashMenu.querySelector<HTMLElement>('.slash-item.active')?.scrollIntoView({ block: 'nearest' });
}

function pickSlash(name?: string): void {
  const pick = name ?? slashItems[slashIndex]?.name;
  if (!pick) return;
  const composer = document.getElementById('composer') as HTMLTextAreaElement;
  composer.value = `/${pick} `;
  closeSlash();
  composer.focus();
  composer.setSelectionRange(composer.value.length, composer.value.length);
  autosize(composer);
}

function closeSlash(): void {
  slashMenu.hidden = true;
}

// ---------- 文件附件(📎 选 / 拖入多个)----------
// ponytail: 只读文本文件,内容用代码块拼进 prompt。二进制(图片/PDF/压缩包/音视频等)按扩展名跳过 ——
// 非 UTF-8 / 二进制无法纯文本喂模型;要支持图片得走多模态消息,标 TODO。
const BIN_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tar|rar|7z|exe|dll|so|dylib|class|jar|mp[34]|mov|avi|wav|flac|ogg|webm|ttf|otf|woff2?|eot|psd|ai|sketch|app|dmg|iso|db|sqlite?|node)$/i;

function isTextFile(name: string): boolean {
  return !BIN_EXT.test(name);
}

function readTextTruncated(f: File, max: number): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result ?? '');
      resolve(text.length > max ? text.slice(0, max) + '\n…[截断]' : text);
    };
    r.onerror = () => resolve('[读取失败]');
    // 只读开头 max*4 字节(留余量给多字节字符)—— 否则几 MB 的大文件会被整个读进内存,卡住/失败。
    r.readAsText(f.slice(0, max * 4));
  });
}

async function addFiles(files: File[]): Promise<void> {
  for (const f of files) {
    if (!isTextFile(f.name)) continue; // 二进制跳过
    attachments.push({ name: f.name, content: await readTextTruncated(f, 20000) });
  }
  renderAttach();
}

function renderAttach(): void {
  const row = document.getElementById('attach-row')!;
  row.innerHTML = attachments
    .map((a, i) => `<span class="chip"><span>${esc(a.name)}</span><span class="chip-x" data-i="${i}">×</span></span>`)
    .join('');
  row.querySelectorAll<HTMLElement>('.chip-x').forEach((x) => {
    x.onclick = () => {
      attachments.splice(Number(x.dataset.i), 1);
      renderAttach();
    };
  });
}

// @文件引用:解析正文里的 @path,经 main 读 cwd 内文件(@ 前需非单词字符以避开 email)。返回读到的 + 失败的。
async function resolveAtFiles(text: string, cwd: string): Promise<{ files: { name: string; content: string }[]; missing: string[] }> {
  const rels = [...new Set([...text.matchAll(/(?<![\w@])@([\w./\\-]+)/g)].map((m) => m[1]))];
  const files: { name: string; content: string }[] = [];
  const missing: string[] = [];
  for (const rel of rels) {
    if (!isTextFile(rel)) continue;
    const r = await api.readFile(rel, cwd);
    if (r.ok && r.content != null) files.push({ name: rel, content: r.content });
    else missing.push(rel);
  }
  return { files, missing };
}

// Suggestions for the model picker's datalist (Direct only). Free-typing any id still works.
const MODEL_HINTS = [
  'glm-5.2', 'glm-4.6', 'glm-4-plus',
  'deepseek-chat', 'deepseek-reasoner',
  'qwen-max', 'qwen-plus', 'qwen-long',
  'claude-sonnet-5', 'claude-haiku-4-5-20251001',
];

function fillModelHints(): void {
  const dl = document.getElementById('model-list')!;
  dl.innerHTML = MODEL_HINTS.map((m) => `<option value="${esc(m)}"></option>`).join('');
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
