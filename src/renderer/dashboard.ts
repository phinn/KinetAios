// Dashboard window: usage dashboard (aligned with Juejin Usage) + per-session agent status + Arena stats.
// 仪表盘窗口:用量看板(对齐 Juejin Usage:4 KPI 卡 + 26 周热力图 + 环比 + 趋势分解/模型/会话排行)
// + 每会话 agent 状态 + Arena 深度统计。纯前端聚合 live convs + usageStats/arenaStats 后端数据。
// SVG 手绘,零依赖(沿用本项目约定,不引图表库)。
import { applyEvent } from '../shared/types';
import type { AgentEvent, Conversation, EngineKind, KinetAPI } from '../shared/types';
import { t, engineLabel, type Lang } from '../shared/i18n';
import { ENGINE_COLORS } from './engine-colors';

declare global { interface Window { kinet: KinetAPI } }

const api = window.kinet;
// 卡死取证心跳:主线程被长任务占住时 setInterval 回调停发,main 侧据此抓栈。
// Freeze watchdog heartbeat: silence >5s in main triggers a stack sample.
try { api.startHeartbeat?.(); } catch { /* 旧 preload 无此方法 */ }
const convs = new Map<string, Conversation>();
let lang: Lang = 'zh-CN';
const ns = 'http://www.w3.org/2000/svg';

function tr(key: string, params?: Record<string, string | number>): string {
  return t(lang, key, params);
}
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function applyI18nDOM(): void {
  document.documentElement.lang = lang;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = t(lang, el.dataset.i18n!); });
}

// ── 格式化(对齐 Juejin Usage 口径)──
// formatUsd 两位小数(Juejin: $x.xx);Token 紧凑 3 位有效 + hover 精确值。
function fmtCost(n: number): string { return '$' + (n || 0).toFixed(2); }
function fmtCostFull(n: number): string { return '$' + (n || 0).toFixed(4); }
function fmtTok(n: number): string {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function fmtNum(n: number): string { return Math.round(n || 0).toLocaleString(); }
function fmtMs(ms: number): string {
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's';
}
function relTime(ts: number): string {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return tr('dash.rel.now');
  if (s < 3600) return tr('dash.rel.min', { n: Math.floor(s / 60) });
  if (s < 86400) return tr('dash.rel.hour', { n: Math.floor(s / 3600) });
  return tr('dash.rel.day', { n: Math.floor(s / 86400) });
}
function fmtPct(n: number): string { return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
function pctChange(cur: number, prev: number): number | null {
  if (!prev) return cur > 0 ? 100 : null; // 前窗口为 0:有量即 +100%,无量不算
  return ((cur - prev) / prev) * 100;
}

// ── 用量聚合数据(usage-stats IPC)──
type UsageStat = Awaited<ReturnType<KinetAPI['usageStats']>>;

// 范围选择状态(localStorage 记忆,档位对齐 Cherry/Juejin:3D/7D/1M/6M/1Y)。
// cost_log 全表载入后按日聚合,DB 侧无时间过滤 → 扩档零查询成本。
const RANGE_KEY = 'dash.usageRange';
type Range = 3 | 7 | 30 | 90 | 180 | 365;
const RANGES: Range[] = [3, 7, 30, 90, 180, 365];
let usageRange: Range = 30;
try {
  const saved = Number(localStorage.getItem(RANGE_KEY));
  if (RANGES.includes(saved as Range)) usageRange = saved as Range;
} catch { /* localStorage 不可用无所谓 */ }

// ── KPI 卡:预估费用/总 Token/输入/输出,右侧环比 chip(↑绿↓红)+ 迷你趋势 ──
function kpiCard(id: string, label: string, value: string, exact: string, chip: { text: string; up: boolean } | null, spark: number[], color: string): string {
  // spark:归一化到 0-1 的迷你柱状(近 N 日)
  const max = Math.max(1e-9, ...spark);
  const bars = spark.map((v) => {
    const h = Math.max(2, Math.round((v / max) * 28));
    return `<div class="u-spark-bar" style="height:${h}px;background:${color};opacity:${v > 0 ? 0.85 : 0.18}"></div>`;
  }).join('');
  const chipHtml = chip ? `<span class="u-chip ${chip.up ? 'up' : 'down'}">${chip.up ? '↑' : '↓'}${esc(chip.text)}</span>` : '';
  return `
  <div class="u-card" id="${id}">
    <div class="u-card-top"><span class="u-card-label">${esc(label)}</span>${chipHtml}</div>
    <div class="u-card-main">
      <span class="u-card-value" title="${esc(exact)}">${esc(value)}</span>
      <div class="u-spark">${bars}</div>
    </div>
  </div>`;
}

function renderKpis(u: UsageStat): void {
  const daily = u.daily.slice(-14);
  const sparkT = daily.map((d) => d.tokens);
  const sparkC = daily.map((d) => d.cost);
  const sparkI = daily.map((d) => d.inputTokens);
  const sparkO = daily.map((d) => d.outputTokens);
  const chip = (cur: number, prev: number): { text: string; up: boolean } | null => {
    const p = pctChange(cur, prev);
    if (p === null) return null;
    return { text: fmtPct(p), up: p >= 0 };
  };
  const cacheHit = u.range.inputTokens > 0 ? ((u.range.inputTokens * 0 + cacheFromTokens(u)) * 100).toFixed(1) + '%' : null;
  document.getElementById('u-kpis')!.innerHTML =
    kpiCard('u-kpi-cost', tr('u.kpi.cost'), fmtCost(u.range.cost), fmtCostFull(u.range.cost), chip(u.range.cost, u.prev.cost), sparkC, '#e8b339') +
    kpiCard('u-kpi-total', tr('u.kpi.total'), fmtTok(u.range.totalTokens), fmtNum(u.range.totalTokens) + ' tok' + (u.range.requests ? ` · ${fmtNum(u.range.requests)} ${tr('u.kpi.requests')}` : ''), chip(u.range.totalTokens, u.prev.totalTokens), sparkT, '#4c8dff') +
    kpiCard('u-kpi-in', tr('u.kpi.input'), fmtTok(u.range.inputTokens), fmtNum(u.range.inputTokens) + ' tok' + (cacheHit ? ` · ${tr('u.kpi.cacheHit')} ${cacheHit}` : ''), chip(u.range.inputTokens, u.prev.inputTokens), sparkI, '#4ec27a') +
    kpiCard('u-kpi-out', tr('u.kpi.output'), fmtTok(u.range.outputTokens), fmtNum(u.range.outputTokens) + ' tok', chip(u.range.outputTokens, u.prev.outputTokens), sparkO, '#e2614c');
}
// 缓存命中率:输入 token 相对总 token 的占比近似(本地无 prompt_cache 计费拆分,标口径)。
// 注意:这是近似口径 —— 精确值需 provider 返回 cached_tokens,cost_log 暂未存。
function cacheFromTokens(u: UsageStat): number {
  const total = u.range.inputTokens + u.range.outputTokens;
  return total > 0 ? u.range.inputTokens / total : 0;
}

// ── 26 周热力图(GitHub 风格):5 档 = 分位数 50/75/90,tooltip 显示当日明细 ──
// levelFor 与 Juejin Usage buildActivityHeatmap 一致:0=无,1<=p50,2<=p75,3<=p90,4>p90。
type HeatCell = { date: string; tokens: number; level: number };
function buildHeatmap(daily: UsageStat['daily'], weeks = 26): { cells: HeatCell[][]; max: number } {
  // 只取最近 weeks*7 天
  const days = daily.slice(-weeks * 7);
  const active = days.map((d) => d.tokens).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number): number => {
    if (!active.length) return 0;
    const pos = (active.length - 1) * p;
    const base = Math.floor(pos);
    const rest = pos - base;
    return Math.round((active[base] ?? 0) + ((active[base + 1] ?? active[active.length - 1] ?? 0) - (active[base] ?? 0)) * rest);
  };
  const t1 = q(0.5), t2 = q(0.75), t3 = q(0.9);
  const levelFor = (v: number): number => (v <= 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4);
  // 按周(周日开头)切格:前面补齐第一周空位
  const cells: HeatCell[][] = [];
  let week: HeatCell[] = [];
  for (const d of days) {
    const dow = new Date(d.date + 'T00:00:00').getDay();
    if (dow === 0 && week.length) { cells.push(week); week = []; }
    week.push({ date: d.date, tokens: d.tokens, level: levelFor(d.tokens) });
  }
  if (week.length) cells.push(week);
  return { cells, max: Math.max(1, ...active) };
}

function renderHeatmap(u: UsageStat): void {
  const wrap = document.getElementById('u-heatmap')!;
  // 热力图周数随所选范围缩放:1 年 ≈ 53 周;短范围(3/7D)仍保底 8 周网格不至于太空。
  // Heatmap weeks scale with the selected range (1y ≈ 53 weeks); short ranges keep an 8-week floor.
  const heatWeeks = Math.min(54, Math.max(8, Math.ceil((usageRange || 30) / 7) + 1));
  const { cells } = buildHeatmap(u.daily, heatWeeks);
  // 月份标记:每月第一格上方标月份
  let monthMarks = '';
  const seen = new Set<string>();
  cells.forEach((week, wi) => {
    const first = week[0];
    if (!first) return;
    const mon = first.date.slice(0, 7);
    if (!seen.has(mon)) {
      seen.add(mon);
      monthMarks += `<span class="u-heat-month" style="left:${wi * 17}px">${esc(mon.slice(5))}/${esc(mon.slice(2, 4))}</span>`;
    }
  });
  const grid = cells.map((week) => `
    <div class="u-heat-col">${week.map((c) => {
      const tip = `${c.date} · ${fmtNum(c.tokens)} tok`;
      return `<div class="u-heat-cell lv${c.level}" title="${esc(tip)}"></div>`;
    }).join('')}</div>`).join('');
  wrap.innerHTML = `
    <div class="u-heat-scroll">
      <div class="u-heat-months">${monthMarks}</div>
      <div class="u-heat-grid">${grid}</div>
    </div>
    <div class="u-heat-legend">
      <span>${esc(tr('u.heat.less'))}</span>
      ${[0, 1, 2, 3, 4].map((i) => `<div class="u-heat-cell lv${i}"></div>`).join('')}
      <span>${esc(tr('u.heat.more'))}</span>
    </div>`;
}

// ── 每日趋势(按日柱状图,对齐 Cherry Studio 数据看板)──
// 指标切换 tab:Token(输入/输出堆叠柱)/ 费用(按日柱)+ hover 精确值。
// 旧版固定堆叠面积图无法看单日量级,柱状 + 指标切换是 Cherry 实测更可读的形态。
type TrendMetric = 'tokens' | 'cost';
let trendMetric: TrendMetric = 'tokens';
try { const m = localStorage.getItem('dash.trendMetric'); if (m === 'cost' || m === 'tokens') trendMetric = m; } catch { /* ignore */ }

function renderTrendMetricTabs(): void {
  const tabs: Array<{ m: TrendMetric; key: string }> = [
    { m: 'tokens', key: 'u.trend.tokens' }, { m: 'cost', key: 'u.trend.cost' },
  ];
  document.getElementById('u-metric-tabs')!.innerHTML = tabs.map((tb) =>
    `<button class="u-range-btn${tb.m === trendMetric ? ' active' : ''}" data-metric="${tb.m}">${esc(tr(tb.key))}</button>`).join('');
  document.querySelectorAll<HTMLButtonElement>('#u-metric-tabs .u-range-btn').forEach((btn) => {
    btn.onclick = () => {
      trendMetric = btn.dataset.metric as TrendMetric;
      try { localStorage.setItem('dash.trendMetric', trendMetric); } catch { /* ignore */ }
      // 重拉是多余的 —— daily 数据还在,直接重渲染即可(避免闪一下空图)。
      // Re-render from cached data instead of refetching (no blank flash).
      renderTrendMetricTabs();
      if (lastUsage) renderTrendChart(lastUsage);
    };
  });
}

function renderTrendChart(u: UsageStat): void {
  const svg = document.getElementById('u-trend')!;
  svg.innerHTML = '';
  const legend = document.getElementById('u-trend-legend')!;
  const W = 700, H = 200;
  const pad = { l: 46, r: 10, t: 12, b: 22 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
  const daily = u.daily.slice(-Math.max(7, usageRange)); // 全量数据已在内存,前端切片;3D 至少显 1 周柱基线
  const isTok = trendMetric === 'tokens';
  legend.innerHTML = isTok
    ? `<span class="u-legend-item"><span class="u-legend-dot" style="background:#4ec27a"></span>${esc(tr('u.kpi.input'))}</span>
       <span class="u-legend-item"><span class="u-legend-dot" style="background:#e2614c"></span>${esc(tr('u.kpi.output'))}</span>`
    : `<span class="u-legend-item"><span class="u-legend-dot" style="background:#e8b339"></span>${esc(tr('u.kpi.cost'))}</span>
       <span class="u-legend-item"><span class="u-legend-dot" style="background:#b48be8"></span>${esc(tr('u.trend.requests'))}</span>`;
  if (daily.length < 2) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--text-faint)" font-size="12">${esc(tr('u.noData'))}</text>`;
    return;
  }
  const bw = Math.max(2, (cw / daily.length) * 0.62); // 柱宽 62% 间距
  const x = (i: number) => pad.l + (cw * (i + 0.5)) / daily.length;
  if (isTok) {
    // Token 模式:输入/输出堆叠柱(输入在下,与 KPI 配色一致)
    const maxTok = Math.max(1, ...daily.map((d) => d.tokens));
    const yT = (v: number) => pad.t + ch * (1 - v / maxTok);
    // Y 轴刻度(3 条)
    for (const f of [0, 0.5, 1]) {
      const yy = pad.t + ch * (1 - f);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', String(pad.l)); line.setAttribute('x2', String(W - pad.r));
      line.setAttribute('y1', String(yy)); line.setAttribute('y2', String(yy));
      line.setAttribute('stroke', 'var(--border-soft)'); line.setAttribute('stroke-width', '1');
      svg.appendChild(line);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(pad.l - 6)); label.setAttribute('y', String(yy + 3));
      label.setAttribute('text-anchor', 'end'); label.setAttribute('fill', 'var(--text-faint)'); label.setAttribute('font-size', '9');
      label.textContent = fmtTok(maxTok * f);
      svg.appendChild(label);
    }
    daily.forEach((d, i) => {
      const hi = d.inputTokens, ho = d.outputTokens;
      // 输入柱(下段)
      const inH = ch * (hi / maxTok);
      const rin = document.createElementNS(ns, 'rect');
      rin.setAttribute('x', (x(i) - bw / 2).toFixed(1)); rin.setAttribute('y', yT(hi).toFixed(1));
      rin.setAttribute('width', bw.toFixed(1)); rin.setAttribute('height', Math.max(0, inH).toFixed(1));
      rin.setAttribute('fill', '#4ec27a'); rin.setAttribute('rx', '1.5');
      rin.appendChild(Object.assign(document.createElementNS(ns, 'title'), { textContent: `${d.date}\n${tr('u.kpi.input')}: ${fmtNum(hi)} tok\n${tr('u.kpi.output')}: ${fmtNum(ho)} tok\n${tr('u.kpi.total')}: ${fmtNum(d.tokens)} tok` }));
      svg.appendChild(rin);
      // 输出柱(上段,从输入顶叠起)
      const outH = ch * (ho / maxTok);
      const rout = document.createElementNS(ns, 'rect');
      rout.setAttribute('x', (x(i) - bw / 2).toFixed(1)); rout.setAttribute('y', yT(hi + ho).toFixed(1));
      rout.setAttribute('width', bw.toFixed(1)); rout.setAttribute('height', Math.max(0, outH).toFixed(1));
      rout.setAttribute('fill', '#e2614c'); rout.setAttribute('rx', '1.5');
      rout.appendChild(Object.assign(document.createElementNS(ns, 'title'), { textContent: `${d.date}\n${tr('u.kpi.input')}: ${fmtNum(hi)} tok\n${tr('u.kpi.output')}: ${fmtNum(ho)} tok\n${tr('u.kpi.total')}: ${fmtNum(d.tokens)} tok` }));
      svg.appendChild(rout);
    });
  } else {
    // 费用模式:费用柱(金)+ 请求次数细柱(紫,右轴,Cherry 双指标同屏)
    const maxCost = Math.max(1e-6, ...daily.map((d) => d.cost));
    const maxReq = Math.max(1, ...daily.map((d) => d.requests));
    const yC = (v: number) => pad.t + ch * (1 - v / maxCost);
    const yR = (v: number) => pad.t + ch * (1 - v / maxReq);
    for (const f of [0, 0.5, 1]) {
      const yy = pad.t + ch * (1 - f);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', String(pad.l)); line.setAttribute('x2', String(W - pad.r));
      line.setAttribute('y1', String(yy)); line.setAttribute('y2', String(yy));
      line.setAttribute('stroke', 'var(--border-soft)'); line.setAttribute('stroke-width', '1');
      svg.appendChild(line);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(pad.l - 6)); label.setAttribute('y', String(yy + 3));
      label.setAttribute('text-anchor', 'end'); label.setAttribute('fill', 'var(--text-faint)'); label.setAttribute('font-size', '9');
      label.textContent = '$' + (maxCost * f).toFixed(2);
      svg.appendChild(label);    }
    daily.forEach((d, i) => {
      const rh = ch * (d.requests / maxReq);
      const rreq = document.createElementNS(ns, 'rect');
      rreq.setAttribute('x', (x(i) - bw / 2).toFixed(1)); rreq.setAttribute('y', yR(d.requests).toFixed(1));
      rreq.setAttribute('width', bw.toFixed(1)); rreq.setAttribute('height', Math.max(0, rh).toFixed(1));
      rreq.setAttribute('fill', '#b48be8'); rreq.setAttribute('opacity', '0.3'); rreq.setAttribute('rx', '1.5');
      svg.appendChild(rreq);
      const cH = ch * (d.cost / maxCost);
      const rc = document.createElementNS(ns, 'rect');
      rc.setAttribute('x', (x(i) - bw / 2).toFixed(1)); rc.setAttribute('y', yC(d.cost).toFixed(1));
      rc.setAttribute('width', bw.toFixed(1)); rc.setAttribute('height', Math.max(0, cH).toFixed(1));
      rc.setAttribute('fill', '#e8b339'); rc.setAttribute('rx', '1.5');
      rc.appendChild(Object.assign(document.createElementNS(ns, 'title'), { textContent: `${d.date}\n${tr('u.kpi.cost')}: ${fmtCostFull(d.cost)}\n${tr('u.trend.requests')}: ${fmtNum(d.requests)}` }));
      svg.appendChild(rc);
    });
  }
// X 轴标签: ≤31天首/中/尾; >31天均匀5刻度+年(防长范围糊成一坨)
     const isLong = daily.length > 31;
     const tickIdx = isLong ? Array.from({ length: 5 }, (_, k) => Math.round((daily.length - 1) * (k / 4))) : [0, Math.floor(daily.length / 2), daily.length - 1];
     tickIdx.forEach((i) => {
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(x(i))); label.setAttribute('y', String(H - 6));
      label.setAttribute('text-anchor', i === 0 ? 'start' : daily[i].date === daily[daily.length - 1]?.date ? 'end' : 'middle');
      label.setAttribute('fill', 'var(--text-faint)'); label.setAttribute('font-size', '9');
      const dd = new Date(daily[i].date + 'T00:00:00');
      label.textContent = isLong ? `${dd.getFullYear() % 100}/${String(dd.getMonth() + 1).padStart(2, '0')}` : daily[i].date.slice(5);
      svg.appendChild(label);
    });
}

// ── 排行条(模型/引擎/会话共用):名称 + 横条 + token + 占比 ──
// 模型分色:对齐 Cherry Studio 数据看板 —— 每个模型固定一个色,同色系引擎图区分度更高。
// 从名字 hash 稳定取色(同模型每次渲染同色,不闪变)。
const MODEL_PALETTE = ['#4c8dff', '#4ec27a', '#e2614c', '#e8b339', '#b48be8', '#3fb8bf', '#e87ba8', '#8fa832'];
function modelColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return MODEL_PALETTE[h % MODEL_PALETTE.length];
}
function rankRows(rows: Array<{ name: string; sub: string; tokens: number; cost: number }>, colorOf: (name: string) => string, maxTok: number): string {
  const total = rows.reduce((s, r) => s + r.tokens, 0) || 1;
  if (!rows.length) return `<div class="u-empty">${esc(tr('u.noData'))}</div>`;
  return rows.map((r) => `
    <div class="u-rank-row">
      <div class="u-rank-head">
        <span class="u-rank-name" title="${esc(r.name)}">${esc(r.name)}<span class="u-rank-sub">${esc(r.sub)}</span></span>
        <span class="u-rank-val">${esc(fmtTok(r.tokens))} · ${esc(fmtCost(r.cost))} · ${Math.round((r.tokens / total) * 100)}%</span>
      </div>
      <div class="u-rank-bar-bg"><div class="u-rank-bar" style="width:${Math.max(2, (r.tokens / (maxTok || 1)) * 100).toFixed(1)}%;background:${colorOf(r.name)}"></div></div>
    </div>`).join('');
}

function renderRankings(u: UsageStat): void {
  const maxModel = Math.max(1, ...u.byModel.map((m) => m.tokens));
  document.getElementById('u-models')!.innerHTML = rankRows(
    u.byModel.slice(0, 8).map((m) => ({ name: m.model, sub: `${fmtNum(m.requests)} req`, tokens: m.tokens, cost: m.cost })),
    modelColor, maxModel);
  const maxEngine = Math.max(1, ...u.byEngine.map((m) => m.tokens));
  document.getElementById('u-engines')!.innerHTML = rankRows(
    u.byEngine.slice(0, 8).map((m) => ({ name: engineLabel(lang, m.engine as EngineKind), sub: `${fmtNum(m.requests)} req`, tokens: m.tokens, cost: m.cost })),
    (name) => ENGINE_COLORS[(u.byEngine.find((e) => engineLabel(lang, e.engine as EngineKind) === name)?.engine) as EngineKind] ?? '#a8b0c2', maxEngine);
  const maxConv = Math.max(1, ...u.byConv.map((m) => m.tokens));
  document.getElementById('u-convs')!.innerHTML = rankRows(
    u.byConv.slice(0, 8).map((m) => ({ name: m.title, sub: m.model, tokens: m.tokens, cost: m.cost })),
    () => '#e8b339', maxConv);
  // 项目排行:模型 hash 分色,sub 显请求数
  const maxProj = Math.max(1, ...u.byProject.map((m) => m.tokens));
  document.getElementById('u-projects')!.innerHTML = rankRows(
    u.byProject.slice(0, 8).map((m) => ({ name: m.project, sub: `${fmtNum(m.requests)} req`, tokens: m.tokens, cost: m.cost })),
    modelColor, maxProj);
}

// ── 加载用量看板 ──
// lastUsage:最近一次聚合数据缓存,指标 tab 切换时免重拉(不闪空图)。
let lastUsage: UsageStat | null = null;
async function loadUsageStats(): Promise<void> {
  try {
    const u = await api.usageStats(usageRange);
    lastUsage = u;
    renderKpis(u);
    renderHeatmap(u);
    renderTrendChart(u);
    renderRankings(u);
  } catch {
    // 静默失败(首次启动无 cost_log)
  }
}

// ── 范围切换按钮组 ──
function renderRangeTabs(): void {
  // 粒度对齐 Cherry/Juejin:3D/7D/1M(30)/6M(90)/半年(180)/一年(365),覆盖全跨度。
  // 90D 档在 Cherry 里叫 6M,这里保持天数口径一致,标签用通用的 M/Y 缩写(四语言同形)。
  const tabs: Array<{ d: Range; key: string }> = [
    { d: 3, key: 'u.range.3d' }, { d: 7, key: 'u.range.7d' }, { d: 30, key: 'u.range.30d' },
    { d: 90, key: 'u.range.6m' }, { d: 180, key: 'u.range.180d' }, { d: 365, key: 'u.range.1y' },
  ];
  document.getElementById('u-range-tabs')!.innerHTML = tabs.map((tb) =>
    `<button class="u-range-btn${tb.d === usageRange ? ' active' : ''}" data-range="${tb.d}">${esc(tr(tb.key))}</button>`).join('');
  document.querySelectorAll<HTMLButtonElement>('#u-range-tabs .u-range-btn').forEach((btn) => {
    btn.onclick = () => {
      usageRange = Number(btn.dataset.range) as Range;
      try { localStorage.setItem(RANGE_KEY, String(usageRange)); } catch { /* ignore */ }
      renderRangeTabs();
      loadUsageStats();
    };
  });
}

// ── 雷达图:五维引擎对比(Arena)──
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
      const a = (Math.PI * 2 * i) / N - Math.PI / 2;
      pts.push(`${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`);
    }
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', pts.join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', 'var(--border)');
    svg.appendChild(poly);
  }
  // 轴 + 轴标签
  for (let i = 0; i < N; i++) {
    const a = (Math.PI * 2 * i) / N - Math.PI / 2;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', '0'); line.setAttribute('y1', '0');
    line.setAttribute('x2', (R * Math.cos(a)).toFixed(1));
    line.setAttribute('y2', (R * Math.sin(a)).toFixed(1));
    line.setAttribute('stroke', 'var(--border)');
    svg.appendChild(line);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', ((R + 16) * Math.cos(a)).toFixed(1));
    label.setAttribute('y', ((R + 16) * Math.sin(a)).toFixed(1));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', 'var(--text-dim)');
    label.setAttribute('font-size', '10');
    label.textContent = dims[i].label;
    svg.appendChild(label);
  }
  // 每个引擎一个多边形
  for (const stat of stats) {
    if (stat.sessions === 0 && stat.totalTokens === 0) continue;
    const color = ENGINE_COLORS[stat.engine as EngineKind] ?? '#a8b0c2';
    const pts: string[] = [];
    for (let i = 0; i < N; i++) {
      const v = (stat[dims[i].key as keyof ArenaStat] as number) / dims[i].max;
      const a = (Math.PI * 2 * i) / N - Math.PI / 2;
      pts.push(`${(R * Math.min(1, v) * Math.cos(a)).toFixed(1)},${(R * Math.min(1, v) * Math.sin(a)).toFixed(1)}`);
    }
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', pts.join(' '));
    poly.setAttribute('fill', color);
    poly.setAttribute('fill-opacity', '0.12');
    poly.setAttribute('stroke', color);
    poly.setAttribute('stroke-width', '1.5');
    svg.appendChild(poly);
  }
  // 图例
  document.getElementById('dash-radar-legend')!.innerHTML = stats
    .filter((s) => s.sessions > 0 || s.totalTokens > 0)
    .map((s) => {
      const color = ENGINE_COLORS[s.engine as EngineKind] ?? '#a8b0c2';
      return `<div class="dash-legend-item"><span class="dash-legend-dot" style="background:${color}"></span>${esc(engineLabel(lang, s.engine as EngineKind))}</div>`;
    }).join('');
}

// ── 7 天成本趋势线(Arena,按引擎)──
function renderTrend(stats: ArenaStat[]): void {
  const svg = document.getElementById('dash-trend')!;
  svg.innerHTML = '';
  const W = 700, H = 180;
  const padding = { left: 40, right: 10, top: 10, bottom: 24 };
  const chartW = W - padding.left - padding.right;
  const chartH = H - padding.top - padding.bottom;
  if (!stats.length || !stats.some((s) => s.costByDay.some((d) => d.cost > 0))) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--text-faint)" font-size="12">${esc(tr('dash.noData'))}</text>`;
    return;
  }
  const days = stats[0].costByDay.map((d) => d.date);
  const maxCost = Math.max(0.0001, ...stats.flatMap((s) => s.costByDay.map((d) => d.cost)));
  // Y 轴刻度
  for (const f of [0, 0.5, 1]) {
    const yy = padding.top + chartH * (1 - f);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(padding.left)); line.setAttribute('x2', String(W - padding.right));
    line.setAttribute('y1', String(yy)); line.setAttribute('y2', String(yy));
    line.setAttribute('stroke', 'var(--border-soft)');
    svg.appendChild(line);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', String(padding.left - 6)); label.setAttribute('y', String(yy + 3));
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('fill', 'var(--text-dim)');
    label.setAttribute('font-size', '9');
    label.textContent = '$' + (maxCost * f).toFixed(3);
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
    label.textContent = d.slice(5); // MM-DD
    svg.appendChild(label);
  });
  // 每个引擎一条折线
  for (const stat of stats) {
    if (stat.costByDay.every((d) => d.cost === 0)) continue;
    const color = ENGINE_COLORS[stat.engine as EngineKind] ?? '#a8b0c2';
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
    const color = ENGINE_COLORS[s.engine as EngineKind] ?? '#a8b0c2';
    const dot = `<span class="dash-legend-dot" style="display:inline-block;background:${color};margin-right:6px"></span>`;
    return `<tr>
      <td>${dot}${esc(engineLabel(lang, s.engine as EngineKind))}</td>
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

// ── 会话状态表(原有逻辑保留)──
function renderDashboard(): void {
  const overview = document.getElementById('dash-overview')!;
  const table = document.getElementById('dash-table')!;
  const list = [...convs.values()].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  const running = list.filter((c) => c.status === 'running').length;
  const totalTokens = list.reduce((s, c) => s + (c.tokens ?? 0), 0);
  const totalCost = list.reduce((s, c) => s + (c.cost ?? 0), 0);
  overview.innerHTML = `
    <div class="dash-card"><div class="dc-label">${esc(tr('dash.sessions'))}</div><div class="dc-value">${list.length}</div></div>
    <div class="dash-card"><div class="dc-label">${esc(tr('dash.running'))}</div><div class="dc-value">${running}</div></div>
    <div class="dash-card"><div class="dc-label">${esc(tr('dash.tokens'))}</div><div class="dc-value">${esc(fmtTok(totalTokens))}</div></div>
    <div class="dash-card"><div class="dc-label">${esc(tr('dash.cost'))}</div><div class="dc-value">${esc(fmtCostFull(totalCost))}</div></div>`;
  if (!list.length) {
    table.innerHTML = `<tbody><tr><td class="dash-empty">${esc(tr('dash.empty'))}</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `<thead><tr>
    <th>${esc(tr('dash.col.name'))}</th>
    <th>${esc(tr('dash.col.engine'))}</th>
    <th>${esc(tr('dash.col.model'))}</th>
    <th>${esc(tr('dash.col.status'))}</th>
    <th>${esc(tr('dash.col.tokens'))}</th>
    <th>${esc(tr('dash.col.cost'))}</th>
    <th>${esc(tr('dash.col.last'))}</th>
  </tr></thead><tbody>` + list.map((c) => {
    const isRun = c.status === 'running';
    const last = c.turns?.[c.turns.length - 1];
    const status = isRun ? esc(tr('dash.status.running')) : esc(tr('dash.status.ready'));
    return `<tr class="${isRun ? 'run' : ''}">
      <td class="dt-name" title="${esc(c.customTitle || c.id)}">${esc(c.customTitle || (last?.prompt || c.id).slice(0, 40))}</td>
      <td>${esc(engineLabel(lang, c.engine))}</td>
      <td class="mono">${esc(c.model || '—')}</td>
      <td class="dt-status">${isRun ? '<span class="dt-run"></span>' : ''}${status}</td>
      <td>${esc(fmtTok(c.tokens ?? 0))}</td>
      <td>${esc(fmtCostFull(c.cost ?? 0))}</td>
      <td class="dt-last">${esc(relTime(last?.ts ?? 0))}</td>
    </tr>`;
    }).join('') + '</tbody>';
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
  renderRangeTabs();
  renderTrendMetricTabs();
  renderDashboard();
  loadUsageStats();
  loadArenaStats();

  api.onConversation((conv) => { convs.set(conv.id, conv); renderDashboard(); });
  api.onConversationRemoved((id) => { convs.delete(id); renderDashboard(); });
  api.onAgentEvent((convId, ev: AgentEvent) => {
    const c = convs.get(convId);
    if (!c) return;
    applyEvent(c, ev);
    renderDashboard();
    // done/error 事件意味着 cost_log 可能新增一行,重拉用量看板
    if (ev.type === 'done' || ev.type === 'error') loadUsageStats();
  });

  // 刷新按钮
  document.getElementById('dash-refresh')!.onclick = () => {
    loadUsageStats();
    loadArenaStats();
    renderDashboard();
  };
})();
