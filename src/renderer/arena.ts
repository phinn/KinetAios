// Arena 独立窗口:同一 prompt 三引擎(Direct / Claude Code / Codex)并跑,三栏并排显示。
// 复用主进程的 newConversation + send + onAgentEvent。每栏按 convId 过滤事件,本地 fold 成 status + answer。
// 新增:Diff 对比(选两引擎输出做逐行 diff)+ AI 裁判(第三个引擎评分)。
import type { KinetAPI, AgentEvent, EngineKind } from '../shared/types';
import { t } from '../shared/i18n';
import type { Lang } from '../shared/i18n';

declare global {
  interface Window {
    kinet: KinetAPI;
  }
}

type Col = {
  engine: EngineKind;
  id: string | null;    // null = 未起跑或引擎不可用
  status: string;       // running | done | error | '' (idle)
  answer: string;
  error: string | null;
  usd: number;
};

const ENGINES: Array<{ kind: EngineKind; label: string; icon: string }> = [
  { kind: 'direct', label: 'Direct', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><circle cx="9" cy="14" r="1.2"/><circle cx="15" cy="14" r="1.2"/><path d="M12 8V4M9 4h6"/><circle cx="12" cy="3" r="1"/></svg>' },
  { kind: 'claudeCode', label: 'Claude Code', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6L2 12l6 6M16 6l6 6-6 6"/></svg>' },
  { kind: 'codex', label: 'Codex', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>' },
];

let lang: Lang = 'zh-CN';
let cwd = '';
const cols: Col[] = ENGINES.map((e) => ({ engine: e.kind, id: null, status: '', answer: '', error: null, usd: 0 }));

function renderCol(col: Col): HTMLElement {
  const meta = ENGINES.find((e) => e.kind === col.engine)!;
  const root = document.createElement('div');
  root.className = 'arena-col';
  root.dataset.engine = col.engine;
  const head = document.createElement('div');
  head.className = 'arena-col-head';
  const status = col.status === 'running' ? '· 运行中…' : col.status === 'done' ? '· 完成' : col.status === 'error' ? '· 出错' : '';
  head.innerHTML = `<span class="arena-col-engine">${meta.icon} ${meta.label}</span><span class="arena-col-status ${col.status}">${status}</span>`;
  const body = document.createElement('div');
  body.className = 'arena-col-body';
  if (col.error) {
    body.innerHTML = `<div class="arena-err">${escapeHtml(col.error)}</div>`;
  } else if (col.answer) {
    body.innerHTML = `<pre class="arena-answer"></pre>`;
    (body.querySelector('.arena-answer') as HTMLElement).textContent = col.answer;
  } else if (col.status === 'running') {
    body.innerHTML = `<div class="arena-waiting">${t(lang, 'arena.waiting')}</div>`;
  } else {
    body.innerHTML = `<div class="arena-idle">${t(lang, 'arena.idle')}</div>`;
  }
  if (col.usd > 0) {
    const foot = document.createElement('div');
    foot.className = 'arena-col-foot';
    foot.textContent = `$${col.usd.toFixed(4)}`;
    root.append(head, body, foot);
  } else {
    root.append(head, body);
  }
  return root;
}

function renderCols(): void {
  const root = document.getElementById('arena-cols')!;
  root.innerHTML = '';
  for (const col of cols) root.append(renderCol(col));
  // 如果至少两栏完成,显示 Diff 对比按钮
  const doneCols = cols.filter((c) => c.status === 'done' && c.answer && c.id);
  const toolbar = document.getElementById('arena-toolbar');
  if (toolbar) {
    if (doneCols.length >= 2) {
      const engines = doneCols.map((c) => ENGINES.find((e) => e.kind === c.engine)?.label ?? c.engine).join(' vs ');
      toolbar.innerHTML = `<button id="arena-diff-btn" class="primary"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M3 3v18h18"/><path d="M7 14l3-3 3 3 4-4"/></svg> ${t(lang, 'arena.diff')}</button>`;
      document.getElementById('arena-diff-btn')!.onclick = () => void showArenaDiff(doneCols[0], doneCols[doneCols.length - 1]);
    } else {
      toolbar.innerHTML = '';
    }
  }
}

// Diff 对比:调主进程 computeLineDiff → 显示 colored diff
async function showArenaDiff(left: Col, right: Col): Promise<void> {
  if (left.answer === right.answer) {
    alert(t(lang, 'arena.diffEmpty'));
    return;
  }
  const r = await window.kinet.arenaDiff(left.id!, right.id!);
  if (!r.ok || !r.diff) { alert(r.error ?? 'Diff failed'); return; }
  const panel = document.getElementById('arena-diff-panel')!;
  const diffHtml = r.diff.split('\n').map((line) => {
    const e = escapeHtml(line);
    if (line.startsWith('+ ')) return `<span class="d-add">${e}</span>`;
    if (line.startsWith('- ')) return `<span class="d-del">${e}</span>`;
    return e;
  }).join('\n');
  panel.innerHTML = `
    <div class="arena-diff-head">
      <h3><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:4px"><path d="M3 3v18h18"/><path d="M7 14l3-3 3 3 4-4"/></svg> ${escapeHtml(r.leftEngine ?? left.engine)} vs ${escapeHtml(r.rightEngine ?? right.engine)}</h3>
      <button id="arena-diff-close" class="ghost">×</button>
    </div>
    <pre class="arena-diff-body">${diffHtml}</pre>
  `;
  panel.style.display = 'block';
  document.getElementById('arena-diff-close')!.onclick = () => { panel.style.display = 'none'; };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function handleEvent(convId: string, ev: AgentEvent): void {
  const col = cols.find((c) => c.id === convId);
  if (!col) return;
  switch (ev.type) {
    case 'token':
      col.answer += ev.text;
      break;
    case 'status':
      // status 事件 text 是引擎给的细粒度状态("thinking" / "running shell" 等),不算完成
      break;
    case 'cost':
      col.usd += ev.usd;
      break;
    case 'done':
      col.status = 'done';
      break;
    case 'error':
      col.error = ev.message;
      col.status = 'error';
      break;
  }
  renderCols();
}

async function runArena(prompt: string): Promise<void> {
  if (!prompt.trim() || !cwd) return;
  const runBtn = document.getElementById('arena-run') as HTMLButtonElement;
  runBtn.disabled = true;
  for (const col of cols) {
    col.id = null;
    col.status = '';
    col.answer = '';
    col.error = null;
    col.usd = 0;
  }
  renderCols();
  // 三引擎并行:每栏独立 newConversation + send。失败的引擎在 col.error 里显示。
  await Promise.all(
    cols.map(async (col) => {
      try {
        const conv = await window.kinet.newConversation(cwd, col.engine);
        col.id = conv.id;
        col.status = 'running';
        renderCols();
        await window.kinet.send(conv.id, prompt);
      } catch (e) {
        col.error = (e as Error)?.message ?? String(e);
        col.status = 'error';
        renderCols();
      }
    }),
  );
  runBtn.disabled = false;
}

(async () => {
  const [settings, brand] = await Promise.all([window.kinet.getSettings(), window.kinet.getBrand()]);
  lang = settings.lang;
  document.documentElement.dataset.theme = settings.theme;
  document.title = `${brand.productName} · ${t(lang, 'arena.title')}`;
  // 文案绑定
  const cwdEl = document.getElementById('arena-cwd')!;
  cwdEl.textContent = cwd || t(lang, 'arena.noCwd');
  const input = document.getElementById('arena-input') as HTMLInputElement;
  input.placeholder = t(lang, 'arena.ph');
  (document.getElementById('arena-run') as HTMLButtonElement).textContent = t(lang, 'arena.run');
  document.getElementById('arena-run')!.onclick = () => {
    if (!cwd) return;
    void runArena(input.value);
    input.value = '';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      (document.getElementById('arena-run') as HTMLButtonElement).click();
    }
  });
  // 监听主进程推 cwd(已开窗口切目录)+ agent 事件(按 convId 路由到对应栏)
  window.kinet.onArenaCwd((next) => {
    cwd = next;
    cwdEl.textContent = cwd;
  });
  window.kinet.onAgentEvent((convId, ev) => handleEvent(convId, ev));
  renderCols();
})();
