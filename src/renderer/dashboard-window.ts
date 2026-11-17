// ══ 5h 窗口消耗解剖(Token 诊断视图)══
// 5h coding-plan window breakdown: live quota head + per-turn fat-turn bars.
// 数据源:turnTokens5h()(store 聚合好,input 含 cache,降序 top20)+ quotaWindowState()。
// 类名对齐 styles.css 既有体系(u-win-head/pct/track/rows/row),不另起一套。
// Data: pre-aggregated per-turn stats + live quota state from the coding-plan endpoint.
import type { KinetAPI } from '../shared/types';

interface Deps {
  api: Pick<KinetAPI, 'turnTokens5h' | 'quotaWindowState'>;
  tr: (key: string, params?: Record<string, string | number>) => string;
  esc: (s: string) => string;
}

function fmtTokShort(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1) + 'K';
  return String(v);
}
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// 渲染入口:两个 IPC 并行拉数,塞进 #u-window。quota 挂了降级显示本地聚合,不整块报废。
export async function renderWindow(deps: Deps): Promise<void> {
  const host = document.getElementById('u-window');
  if (!host) return;
  const { tr, esc } = deps;
  try {
    const [d, q] = await Promise.all([deps.api.turnTokens5h(), deps.api.quotaWindowState().catch(() => null)]);
    if (!d.turns.length) { host.innerHTML = `<div class="u-win-empty">${esc(tr('u.win.empty'))}</div>`; return; }

    const inPct = q?.usedPct ?? null;
    const cachePct = Math.round((d.totalCache / Math.max(1, d.totalIn)) * 100);
    // 窗口头:API 百分比优先(智谱 quota 实时值);拿不到 → 本地 input 对经验水位(81M)归一,示意相对高低
    const barPct = inPct !== null
      ? Math.min(100, Math.max(2, inPct))
      : Math.min(100, Math.max(2, (d.totalIn / 81e6) * 100));
    const hot = barPct >= 80 ? ' hot' : '';
    const remain = q?.minsLeft !== null && q?.minsLeft !== undefined
      ? esc(tr('u.win.remain', { mins: q.minsLeft }))
      : '';
    const fillCls = barPct >= 80 ? 'u-win-fill' : 'u-win-fill'; // 颜色分级走 inline background
    const fillBg = barPct >= 80 ? 'var(--run)' : barPct >= 50 ? '#d9a441' : '#4ec27a';

    // turn 行:input 越肥杠越长;input 降序前 5 名标红 .fat(窗口杀手)
    const rows = d.turns.map((t, i) => {
      const w = Math.max(2, Math.round((t.input / Math.max(1, d.turns[0].input)) * 100));
      const fat = i < 5 ? ' fat' : '';
      const cacheTxt = t.cache > 0 ? `<i class="u-win-cache">${esc(fmtTokShort(t.cache))}↻</i>` : '';
      const title = `${esc(t.title)} · ${esc(t.model || t.engine)} · ${esc(new Date(t.ts).toLocaleString())}`;
      return `
      <div class="u-win-row${fat}" title="${title}">
        <span class="u-win-time">${esc(fmtTime(t.ts))}</span>
        <div class="u-win-track"><div class="${fillCls}" style="width:${w}%"></div></div>
        <span class="u-win-val">${esc(fmtTokShort(t.input))}${cacheTxt}</span>
      </div>`;
    }).join('');

    host.innerHTML = `
    <div class="u-win-head">
      <span class="u-win-pct${hot}">${inPct !== null ? Math.round(inPct) + '%' : esc(fmtTokShort(d.totalIn))}</span>
      <div class="u-win-meta">
        <div class="u-win-track big"><div class="${fillCls}" style="width:${barPct}%;background:${fillBg}"></div></div>
        <span class="u-win-sub">${esc(tr('u.win.turns', { n: d.turns.length }))} · ${esc(tr('u.win.input', { m: fmtTokShort(d.totalIn) }))} · ${esc(tr('u.win.cache', { p: cachePct }))}${remain ? ' · ' + remain : ''}</span>
      </div>
    </div>
    <div class="u-win-rows">${rows}</div>
    <div class="u-win-note">${esc(tr('u.win.note'))}</div>`;
  } catch {
    host.innerHTML = `<div class="u-win-empty">${esc(tr('u.win.empty'))}</div>`;
  }
}
