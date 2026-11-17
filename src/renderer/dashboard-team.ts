// ══ 团队看板(活跃团队 × 成员状态 × 黑板沉淀)══
// Team board: active teams, member status pills, blackboard stats + latest notes.
// 数据源:teamBoardData()(store 聚合 team_members 表 + 内存黑板)。黑板是运行时协作层,
// 此处只读展示 —— 看板让「谁在跑/跑出什么/沉淀了几条」从会话流外可观测。
import type { KinetAPI } from '../shared/types';

interface Deps {
  api: Pick<KinetAPI, 'teamBoard'>;
  tr: (key: string, params?: Record<string, string | number>) => string;
  esc: (s: string) => string;
}

// 成员状态徽章配色(idle 灰/running 蓝/done 绿/failed 红,其余走灰)
function statusClass(s: string): string {
  if (s === 'running') return 'tb-run';
  if (s === 'done') return 'tb-done';
  if (s === 'failed') return 'tb-fail';
  return 'tb-idle';
}
function ago(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export async function renderTeamBoard(deps: Deps): Promise<void> {
  const host = document.getElementById('u-team');
  if (!host) return;
  const { tr, esc } = deps;
  try {
    const { teams } = await deps.api.teamBoard();
    if (!teams.length) { host.innerHTML = `<div class="u-win-empty">${esc(tr('t.empty'))}</div>`; return; }

    const cards = teams.map((tm) => {
      const memberRows = tm.members.map((m) => {
        const running = m.status === 'running';
        const brief = (running ? (m.lastMessage ?? '') : (m.lastResult ?? '')).slice(0, 60);
        return `
        <div class="tb-member" title="${esc(m.role)}">
          <span class="tb-dot ${statusClass(m.status)}"></span>
          <span class="tb-mname">${esc(m.name)}</span>
          <span class="tb-mstat">${esc(m.status)}${running ? ' …' : ''}</span>
          <span class="tb-mbrief">${esc(brief)}</span>
        </div>`;
      }).join('');
      const notes = tm.recentNotes.map((n) => `
        <div class="tb-note" title="${esc(n.title)}">
          <span class="tb-kind">${n.kind === 'artifact' ? '📦' : '📝'}</span>
          <span class="tb-ntitle">${esc(n.title)}</span>
          <span class="tb-nfrom">${esc(n.from)}</span>
        </div>`).join('');
      const boardTxt = tm.board
        ? esc(tr('t.board', { n: tm.board.notes, c: tm.board.cachedFiles, h: tm.board.cacheHits }))
        : esc(tr('t.boardClosed'));
      return `
      <div class="tb-card">
        <div class="tb-head">
          <span class="tb-title" title="${esc(tm.teamId)}">${esc(tm.title)}</span>
          <span class="tb-ago">${esc(ago(tm.updatedAt))}</span>
        </div>
        <div class="tb-members">${memberRows}</div>
        <div class="tb-boardline">${boardTxt}</div>
        ${notes ? `<div class="tb-notes">${notes}</div>` : ''}
      </div>`;
    }).join('');

    host.innerHTML = `<div class="tb-grid">${cards}</div>`;
  } catch {
    host.innerHTML = `<div class="u-win-empty">${esc(tr('t.empty'))}</div>`;
  }
}
