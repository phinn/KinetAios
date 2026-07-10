// Dashboard window: token consumption + per-session agent status.
// Pure frontend aggregation over the live convs map (getConversations + onConversation/onAgentEvent).
import { applyEvent, ENGINE_LABELS } from '../shared/types';
import type { AgentEvent, Conversation, EngineKind, KinetAPI } from '../shared/types';
import { t, type Lang } from '../shared/i18n';

declare global {
  interface Window {
    kinet: KinetAPI;
  }
}

const api = window.kinet;
const convs = new Map<string, Conversation>();
let lang: Lang = 'zh-CN';

function tr(key: string, params?: Record<string, string | number>): string {
  return t(lang, key, params);
}
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function applyI18nDOM(): void {
  document.documentElement.lang = lang;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = t(lang, el.dataset.i18n!); });
}

function fmtCost(n: number): string {
  return '$' + (n || 0).toFixed(4);
}
function fmtTok(n: number): string {
  n = n || 0;
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}
// 相对时间(几秒/分/时/天前)。无 ts 返回 —。
function relTime(ts: number): string {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

const ENGINES: EngineKind[] = ['direct', 'claudeCode', 'codex'];

function renderDashboard(): void {
  const list = [...convs.values()];
  const total = list.length;
  const running = list.filter((c) => c.status === 'running').length;
  const tokens = list.reduce((s, c) => s + (c.tokens ?? 0), 0);
  const cost = list.reduce((s, c) => s + (c.cost ?? 0), 0);

  // overview cards
  document.getElementById('dash-overview')!.innerHTML = `
    <div class="dash-card"><div class="dc-num">${total}</div><div class="dc-lbl">${esc(tr('dash.sessions'))}</div></div>
    <div class="dash-card"><div class="dc-num run">${running}</div><div class="dc-lbl">${esc(tr('dash.running'))}</div></div>
    <div class="dash-card"><div class="dc-num">${esc(fmtTok(tokens))}</div><div class="dc-lbl">${esc(tr('dash.tokens'))}</div></div>
    <div class="dash-card"><div class="dc-num">${esc(fmtCost(cost))}</div><div class="dc-lbl">${esc(tr('dash.cost'))}</div></div>`;

  // by engine — cost 占比条(以最高 cost 的引擎为满)
  const maxCost = Math.max(1, ...ENGINES.map((e) => list.filter((c) => c.engine === e).reduce((s, c) => s + (c.cost ?? 0), 0)));
  document.getElementById('dash-engines')!.innerHTML = ENGINES.map((e) => {
    const cs = list.filter((c) => c.engine === e);
    const tk = cs.reduce((s, c) => s + (c.tokens ?? 0), 0);
    const co = cs.reduce((s, c) => s + (c.cost ?? 0), 0);
    const pct = Math.round((co / maxCost) * 100);
    return `<div class="dash-eng">
      <div class="de-name">${esc(ENGINE_LABELS[e])}<span class="de-count">${cs.length}</span></div>
      <div class="de-bar"><div class="de-fill" style="width:${pct}%"></div></div>
      <div class="de-stats"><span>${esc(fmtTok(tk))} · ${esc(tr('dash.tokens'))}</span><span>${esc(fmtCost(co))}</span></div>
    </div>`;
  }).join('');

  // per-session table — running 在前,再按最后活动倒序
  const sorted = [...list].sort((a, b) => {
    const ar = a.status === 'running' ? 1 : 0;
    const br = b.status === 'running' ? 1 : 0;
    if (ar !== br) return br - ar;
    const at = a.turns[a.turns.length - 1]?.ts ?? 0;
    const bt = b.turns[b.turns.length - 1]?.ts ?? 0;
    return bt - at;
  });
  const table = document.getElementById('dash-table')!;
  if (!sorted.length) {
    table.innerHTML = `<tbody><tr><td class="dash-empty">${esc(tr('dash.empty'))}</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `<thead><tr>
    <th>${esc(tr('dash.col.name'))}</th><th>${esc(tr('dash.col.engine'))}</th><th>${esc(tr('dash.col.model'))}</th>
    <th>${esc(tr('dash.col.status'))}</th><th>${esc(tr('dash.col.tokens'))}</th><th>${esc(tr('dash.col.cost'))}</th><th>${esc(tr('dash.col.last'))}</th>
  </tr></thead><tbody>` + sorted.map((c) => {
    const name = c.customTitle || c.turns[0]?.prompt.slice(0, 40) || '—';
    const last = c.turns[c.turns.length - 1];
    const isRun = c.status === 'running';
    const status = isRun ? (c.statusNote ? esc(c.statusNote) : esc(tr('dash.status.running'))) : esc(tr('dash.status.ready'));
    return `<tr class="${isRun ? 'run' : ''}">
      <td class="dt-name">${esc(name)}</td>
      <td>${esc(ENGINE_LABELS[c.engine])}</td>
      <td class="mono">${esc(c.model || '—')}</td>
      <td class="dt-status">${isRun ? '<span class="dt-run"></span>' : ''}${status}</td>
      <td>${esc(fmtTok(c.tokens ?? 0))}</td>
      <td>${esc(fmtCost(c.cost ?? 0))}</td>
      <td class="dt-last">${esc(relTime(last?.ts ?? 0))}</td>
    </tr>`;
  }).join('') + '</tbody>';
}

// init: read lang + brand, load convs, wire live updates.
(async () => {
  const [settings, brand] = await Promise.all([api.getSettings(), api.getBrand()]);
  lang = settings.lang;
  document.title = `${brand.productName} · ${t(lang, 'dash.title')}`;
  const b = document.getElementById('dash-brand');
  if (b) b.textContent = brand.productName;
  for (const c of await api.getConversations()) convs.set(c.id, c);
  applyI18nDOM();
  renderDashboard();

  api.onConversation((conv) => { convs.set(conv.id, conv); renderDashboard(); });
  api.onConversationRemoved((id) => { convs.delete(id); renderDashboard(); });
  api.onAgentEvent((convId, ev: AgentEvent) => {
    const c = convs.get(convId);
    if (!c) return;
    applyEvent(c, ev);
    renderDashboard();
  });
})();
