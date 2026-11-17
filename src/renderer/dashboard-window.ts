// ══ 5h 窗口消耗解剖(Token 诊断视图)══
// 5h coding-plan window breakdown: live quota bar + per-turn fat-turn bars.
// 数据源:turnTokens5h()(store 聚合好,input 含 cache,降序 top20)+ quotaWindowState()。
// 诊断三看点:①窗口实时百分比 ②top5 肥 turn 标红(长会话×工具往返乘法效应)
// ③cache 占比(cache_read 计费打 1 折,但按原始 token 吃 5h 窗口 —— 省$≠省窗口)。
// Data: pre-aggregated per-turn stats + live quota state from the coding-plan endpoint.
import type { KinetAPI } from '../shared/types';

interface Deps {
  api: KinetAPI;
  tr: (key: string, params?: Record<string, string | number>) => string;
  esc: (s: string) => string;
}

const fmtM = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`);

export async function renderWindow(deps: Deps): Promise<void> {
  const { api, tr, esc } = deps;
  const host = document.getElementById('u-window');
  if (!host) return;
  try {
    const [stat, quota] = await Promise.all([
      api.turnTokens5h(),
      api.quotaWindowState().catch(() => null),
    ]);
    if (!stat.turns.length) {
      host.innerHTML = `<div class="u-win-empty">${esc(tr('u.win.empty'))}</div>`;
      return;
    }

    // ── ① 窗口条:quota 实时百分比优先;非 coding-plan 时用本地 input 折算(口径在 note 说明)──
    // Live pct from the coding-plan endpoint; fallback = local input scaled (noted in the footnote).
    const pct = quota?.usedPct ?? Math.min(100, (stat.totalIn / 60e6) * 100);
    const mins = quota?.minsLeft ?? null;
    const remainTxt = mins !== null ? tr('u.win.remain', { mins }) : tr('u.win.remainUnknown');
    const barColor = pct >= 80 ? 'var(--run, #e5484d)' : pct >= 50 ? '#e6a23c' : '#4ec27a';

    // ── ② turn 粒度条:每行一个 turn,宽度∝input,top5 标 ▲ 红(窗口杀手)──
    // Per-turn bars: width ∝ input; top-5 fat turns marked red — the window killers.
    const maxIn = Math.max(1, ...stat.turns.map((x) => x.input));
    const rows = stat.turns.slice(0, 10).map((x, i) => {
      const w = Math.max(2, (x.input / maxIn) * 100);
      const fat = i < 5; // turns 已按 input 降序(store 保证)
      const time = new Date(x.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const cacheRatio = x.input > 0 ? Math.round((x.cache / x.input) * 100) : 0;
      const tip = `${x.title} · ${x.model} · ${new Date(x.ts).toLocaleString()}`;
      return `<div class="u-win-row${fat ? ' fat' : ''}" title="${esc(tip)}">
        <span class="u-win-time">${fat ? '▲' : '·'} ${esc(time)}</span>
        <div class="u-win-track"><div class="u-win-fill" style="width:${w.toFixed(1)}%"></div></div>
        <span class="u-win-val">${esc(fmtM(x.input))}<i class="u-win-cache">↻${cacheRatio}%</i></span>
      </div>`;
    }).join('');

    // ── ③ 构成脚注:cache 占比 + 口径说明 ──
    const cachePct = stat.totalIn > 0 ? Math.round((stat.totalCache / stat.totalIn) * 100) : 0;

    host.innerHTML = `
      <div class="u-win-head">
        <div class="u-win-pct" style="color:${barColor}">${esc(pct.toFixed(0))}%</div>
        <div class="u-win-meta">
          <div class="u-win-track big"><div class="u-win-fill" style="width:${Math.min(100, pct).toFixed(1)}%;background:${barColor}"></div></div>
          <div class="u-win-sub">${esc(tr('u.win.turns', { n: stat.turns.length }))} · ${esc(tr('u.win.input', { m: fmtM(stat.totalIn) }))} · ${esc(tr('u.win.cache', { p: cachePct }))} · ${esc(remainTxt)}</div>
        </div>
      </div>
      <div class="u-win-rows">${rows}</div>
      <div class="u-win-note">${esc(tr('u.win.note'))}</div>`;
  } catch {
    host.innerHTML = `<div class="u-win-empty">${esc(tr('u.win.empty'))}</div>`;
  }
}
