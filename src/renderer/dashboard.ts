// Dashboard window: token consumption + per-session agent status + Arena 深度统计。
// Pure frontend aggregation over the live convs map + arenaStats backend data。
// 雷达图 + 趋势线图 + 引擎对比表(SVG, 零依赖)。
import { applyEvent, ENGINE_LABELS } from '../shared/types';
import type { AgentEvent, Conversation, EngineKind, KinetAPI } from '../shared/types';
import { t, type Lang } from '../shared/i18n';

declare global { interface Window { kinet: KinetAPI } }

const api = window.kinet;
const convs = new Map<string, Conversation>();
let lang: Lang = 'zh-CN';
const ns = 'http://www.w3.org/2000/svg';

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

function fmtCost(n: number): string { return '$' + (n || 0).toFixed(4); }
function fmtTok(n: number): string { n = n || 0; return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
function fmtMs(ms: number): string {
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.round(ms / 60000) + 'm';
}
function relTime(ts: number): string {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

const ENGINES: EngineKind[] = ['direct', 'claudeCode', 'codex'];
const ENGINE_COLORS: Record<string, string> = {
  direct: '#e8b339',
  claudeCode: '#d97757',
  codex: '#10a37f',
};

// ── 雷达图:五维引擎对比 ──
type ArenaStat = {
  engine: string; sessions: number; totalCost: number; totalTokens: number;
  totalTools: number; avgCost: number; avgTokens: number; avgTools: number;
  avgTurnDurationMs: number; costByDay: Array<{ date: string; cost: number }>;
};

function renderRadar(stats: ArenaStat[]): void {
  const svg = document.getElementById('dash-radar')!;
  svg.innerHTML = '';
  const dims = [
    { key: 'sessions', label: tr('dash.dim.sessions'), max: Math.max(1, ...stats.map((s) => s.sessions)) },
    { key: 'totalTokens', label: tr('dash.dim.tokens'), max: Math.max(1, ...stats.map((s) => s.totalTokens)) },
    { key: 'totalTools', label: tr('dash.dim.tools'), max: Math.max(1, ...stats.map((s) => s.totalTools)) },
    { key: 'totalCost', label: tr('dash.dim.cost'), max: Math.max(0.0001, ...stats.map((s) => s.totalCost)) },
    { key: 'avgTurnDurationMs', label: tr('dash.dim.speed'), max: Math.max(1, ...stats.map((s) => s.avgTurnDurationMs)) },
  ];
  const R = 120;
  const N = dims.length;

  // 背景网格(5 层)
  for (let layer = 1; layer <= 5; layer++) {
    const r = (R * layer) / 5;
    const pts: string[] = [];
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
      pts.push(`${Math.cos(angle) * r},${Math.sin(angle) * r}`);
    }
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', pts.join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', 'var(--border)');
    poly.setAttribute('stroke-width', '0.5');
    poly.setAttribute('opacity', String(0.3 + layer * 0.05));
    svg.appendChild(poly);
  }

  // 轴线 + 标签
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
    const x2 = Math.cos(angle) * R;
    const y2 = Math.sin(angle) * R;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', '0'); line.setAttribute('y1', '0');
    line.setAttribute('x2', String(x2)); line.setAttribute('y2', String(y2));
    line.setAttribute('stroke', 'var(--border)');
    line.setAttribute('stroke-width', '0.5');
    svg.appendChild(line);

    const tx = Math.cos(angle) * (R + 20);
    const ty = Math.sin(angle) * (R + 20);
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', String(tx));
    text.setAttribute('y', String(ty));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('fill', 'var(--text-dim)');
    text.setAttribute('font-size', '10');
    text.style.userSelect = 'none';
    text.textContent = dims[i].label;
    svg.appendChild(text);
  }

  // 每个引擎的多边形
  for (const stat of stats) {
    if (stat.sessions === 0 && stat.totalCost === 0) continue;
    const pts: string[] = [];
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
      const val = (stat as any)[dims[i].key] as number;
      const norm = Math.min(1, val / dims[i].max);
      const r = R * norm;
      pts.push(`${Math.cos(angle) * r},${Math.sin(angle) * r}`);
    }
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', pts.join(' '));
    poly.setAttribute('fill', ENGINE_COLORS[stat.engine] ?? '#888');
    poly.setAttribute('fill-opacity', '0.12');
    poly.setAttribute('stroke', ENGINE_COLORS[stat.engine] ?? '#888');
    poly.setAttribute('stroke-width', '1.5');
    svg.appendChild(poly);
  }

  // 图例
  const legend = document.getElementById('dash-radar-legend')!;
  legend.innerHTML = stats.filter((s) => s.sessions > 0 || s.totalCost > 0).map((s) => {
    const color = ENGINE_COLORS[s.engine] ?? '#888';
    const label = ENGINE_LABELS[s.engine as EngineKind] ?? s.engine;
    return `<div class="dash-legend-item"><span class="dash-legend-dot" style="background:${color}"></span>${esc(label)}</div>`;
  }).join('');
}

// ── 趋势线图:7 天成本 ──
function renderTrend(stats: ArenaStat[]): void {
  const svg = document.getElementById('dash-trend')!;
  svg.innerHTML = '';
  const W = 700, H = 180;
  const padding = { left: 50, right: 20, top: 20, bottom: 30 };
  const chartW = W - padding.left - padding.right;
  const chartH = H - padding.top - padding.bottom;

  // 取第一个有数据的 engine 的 costByDay 做 X 轴标签(都是最近 7 天,日期对齐)
  const refStats = stats.find((s) => s.costByDay.length > 0);
  if (!refStats) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--text-dim)" font-size="13">${esc(tr('dash.noData'))}</text>`;
    return;
  }
  const days = refStats.costByDay;
  const allCosts = days.map((d) => d.cost);
  const maxCost = Math.max(0.001, ...stats.flatMap((s) => s.costByDay.map((d) => d.cost)));

  // Y 轴标签 + 水平线
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartH * i) / 4;
    const val = maxCost * (1 - i / 4);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(padding.left));
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(W - padding.right));
    line.setAttribute('y2', String(y));
    line.setAttribute('stroke', 'var(--border)');
    line.setAttribute('stroke-width', '0.5');
    line.setAttribute('opacity', '0.3');
    svg.appendChild(line);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', String(padding.left - 5));
    label.setAttribute('y', String(y + 3));
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('fill', 'var(--text-dim)');
    label.setAttribute('font-size', '9');
    label.textContent = '$' + val.toFixed(3);
    svg.appendChild(label);
  }

  // X 轴标签(日期)
  days.forEach((d, i) => {
    const x = padding.left + (chartW * i) / Math.max(1, days.length - 1);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', String(x));
    label.setAttribute('y', String(H - padding.bottom + 15));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', 'var(--text-dim)');
    label.setAttribute('font-size', '9');
    label.textContent = d.date.slice(5); // MM-DD
    svg.appendChild(label);
  });

  // 每个引擎一条折线
  for (const stat of stats) {
    if (stat.costByDay.every((d) => d.cost === 0)) continue;
    const color = ENGINE_COLORS[stat.engine] ?? '#888';
    let pathD = '';
    stat.costByDay.forEach((d, i) => {
      const x = padding.left + (chartW * i) / Math.max(1, days.length - 1);
      const y = padding.top + chartH * (1 - d.cost / maxCost);
      pathD += (i === 0 ? 'M' : 'L') + `${x.toFixed(1)},${y.toFixed(1)} `;
    });
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2');
    svg.appendChild(path);

    // 数据点
    stat.costByDay.forEach((d, i) => {
      const x = padding.left + (chartW * i) / Math.max(1, days.length - 1);
      const y = padding.top + chartH * (1 - d.cost / maxCost);
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', String(x));
      circle.setAttribute('cy', String(y));
      circle.setAttribute('r', '2.5');
      circle.setAttribute('fill', color);
      svg.appendChild(circle);
    });
  }
}

// ── Arena 深度对比表 ──
function renderArenaTable(stats: ArenaStat[]): void {
  const table = document.getElementById('dash-arena-table')!;
  const active = stats.filter((s) => s.sessions > 0 || s.totalCost > 0);
  if (!active.length) {
    table.innerHTML = `<tbody><tr><td class="dash-empty">${esc(tr('dash.empty'))}</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `<thead><tr>
    <th>${esc(tr('dash.col.engine'))}</th>
    <th>${esc(tr('dash.col.sessions'))}</th>
    <th>${esc(tr('dash.col.tokens'))}</th>
    <th>${esc(tr('dash.col.tools'))}</th>
    <th>${esc(tr('dash.col.cost'))}</th>
    <th>${esc(tr('dash.col.avgCost'))}</th>
    <th>${esc(tr('dash.col.avgTools'))}</th>
    <th>${esc(tr('dash.col.avgDuration'))}</th>
  </tr></thead><tbody>` + active.map((s) => {
    return `<tr>
      <td>${esc(ENGINE_LABELS[s.engine as EngineKind] ?? s.engine)}</td>
      <td>${s.sessions}</td>
      <td>${esc(fmtTok(s.totalTokens))}</td>
      <td>${s.totalTools}</td>
      <td>${esc(fmtCost(s.totalCost))}</td>
      <td>${esc(fmtCost(s.avgCost))}</td>
      <td>${s.avgTools.toFixed(1)}</td>
      <td>${esc(fmtMs(s.avgTurnDurationMs))}</td>
    </tr>`;
  }).join('') + '</tbody>';
}

function renderDashboard(): void {
  const list = [...convs.values()];
  const total = list.length;
  const running = list.filter((c) => c.status === 'running').length;
  const tokens = list.reduce((s, c) => s + (c.tokens ?? 0), 0);
  const cost = list.reduce((s, c) => s + (c.cost ?? 0), 0);

  document.getElementById('dash-overview')!.innerHTML = `
    <div class="dash-card"><div class="dc-num">${total}</div><div class="dc-lbl">${esc(tr('dash.sessions'))}</div></div>
    <div class="dash-card"><div class="dc-num run">${running}</div><div class="dc-lbl">${esc(tr('dash.running'))}</div></div>
    <div class="dash-card"><div class="dc-num">${esc(fmtTok(tokens))}</div><div class="dc-lbl">${esc(tr('dash.tokens'))}</div></div>
    <div class="dash-card"><div class="dc-num">${esc(fmtCost(cost))}</div><div class="dc-lbl">${esc(tr('dash.cost'))}</div></div>`;

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
  } else {
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
}

// ── 加载 Arena 统计 ──
async function loadArenaStats(): Promise<void> {
  try {
    const stats = await api.arenaStats();
    renderRadar(stats);
    renderTrend(stats);
    renderArenaTable(stats);
  } catch (e) {
    // 静默失败(首次启动无 cost_log)
  }
}

(async () => {
  const [settings, brand] = await Promise.all([api.getSettings(), api.getBrand()]);
  lang = settings.lang;
  document.documentElement.dataset.theme = settings.theme;
  document.title = `${brand.productName} · ${t(lang, 'dash.title')}`;
  const b = document.getElementById('dash-brand');
  if (b) b.textContent = brand.productName;
  for (const c of await api.getConversations()) convs.set(c.id, c);
  applyI18nDOM();
  renderDashboard();
  loadArenaStats();

  api.onConversation((conv) => { convs.set(conv.id, conv); renderDashboard(); });
  api.onConversationRemoved((id) => { convs.delete(id); renderDashboard(); });
  api.onAgentEvent((convId, ev: AgentEvent) => {
    const c = convs.get(convId);
    if (!c) return;
    applyEvent(c, ev);
    renderDashboard();
  });

  // 刷新按钮
  document.getElementById('dash-refresh')!.onclick = () => {
    loadArenaStats();
    renderDashboard();
  };
})();
