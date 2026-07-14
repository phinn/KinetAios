// Town View — game-style isometric town visualization.
// 项目 = 房子(house),会话 = 村民(villager)。与 Workbench 平行,同一数据两种看法。
// Town View — game-style isometric town: projects = houses, conversations = villagers.
// Parallel to Workbench — same data, different view. Zero-dependency (pure SVG + CSS + DOM).
import type { Conversation, EngineKind } from '../shared/types';
import { t } from '../shared/i18n';
import type { Lang } from '../shared/i18n';

// ── 外部传入的依赖(由 app.ts 设置) / External deps (set by app.ts) ──
let lang: Lang = 'zh-CN';
let homeDir = '';

export function setTownLang(l: Lang): void { lang = l; }
export function setTownHomeDir(d: string): void { homeDir = d; }

// 引擎颜色 / Engine colors
const ENGINE_COLORS: Record<EngineKind, string> = {
  direct: '#e8b339',
  claudeCode: '#d97757',
  codex: '#10a37f',
};

// ── 工具函数 / Utility ──

function tr(key: string, params?: Record<string, string | number>): string {
  return t(lang, key, params);
}

function projName(cwd: string): string {
  if (!cwd || cwd === homeDir) return tr('wb.ungrouped');
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return base || cwd;
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return tr('time.justNow');
  if (s < 3600) return tr('time.minutesAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return tr('time.hoursAgo', { n: Math.floor(s / 3600) });
  return tr('time.daysAgo', { n: Math.floor(s / 86400) });
}

// 村民状态判定 / Determine villager state from conversation
type VillagerState = 'idle' | 'working' | 'error' | 'done';

function villagerState(conv: Conversation): VillagerState {
  if (conv.status === 'running') return 'working';
  const last = conv.turns[conv.turns.length - 1];
  if (last) {
    if (last.error) return 'error';
    if (last.done) return 'done';
  }
  return 'idle';
}

// ── SVG 生成器 / SVG generators ──

/**
 * 等距小房子 SVG / Isometric house SVG
 * 宽 120 高 110。窗户按 agent 数动态排列。
 */
export function houseSVG(cwd: string, agents: Conversation[], _accentHue?: number): string {
  const hue = hashHue(cwd);
  const wallColor = `hsl(${hue}, 35%, 62%)`;
  const wallDark = `hsl(${hue}, 35%, 48%)`;
  const roofColor = `hsl(${hue}, 45%, 42%)`;
  const roofDark = `hsl(${hue}, 45%, 35%)`;
  const hasRunning = agents.some((c) => c.status === 'running');

  // 窗户最多显示 6 个(2 列 × 3 行),超出用 +N 表示
  const maxWindows = 6;
  const shown = agents.slice(0, maxWindows);
  const overflow = agents.length - shown.length;

  let windows = '';
  shown.forEach((conv, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const wx = 38 + col * 36;
    const wy = 50 + row * 18;
    const lit = conv.status === 'running';
    const vs = villagerState(conv);
    // 窗户颜色: working=暖黄灯, error=红, done=绿, idle=暗
    const lightColor = vs === 'error' ? '#ff5252' : vs === 'done' ? '#4caf50' : '#ffc107';
    const glow = lit ? `<rect x="${wx - 1}" y="${wy - 1}" width="26" height="16" rx="1" fill="${lightColor}" opacity="0.15"/>` : '';
    windows += `${glow}<rect x="${wx}" y="${wy}" width="24" height="14" rx="1" fill="${lit ? lightColor : wallDark}" stroke="${wallDark}" stroke-width="0.5"/>`;
    // 窗户里的小人剪影(头部颜色 = 引擎色)
    const headColor = ENGINE_COLORS[conv.engine];
    windows += `<circle cx="${wx + 12}" cy="${wy + 8}" r="3" fill="${headColor}" opacity="${lit ? 1 : 0.4}"/>`;
  });

  if (overflow > 0) {
    windows += `<text x="80" y="105" font-size="10" fill="rgba(128,128,128,0.8)" font-family="system-ui">+${overflow}</text>`;
  }

  // 烟囱冒烟(有 running agent 时)
  const smoke = hasRunning ? `
    <rect x="78" y="14" width="10" height="14" fill="${roofDark}"/>
    <circle cx="83" cy="8" r="4" fill="rgba(180,180,180,0.4)">
      <animate attributeName="cy" values="8;0;8" dur="2s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.4;0;0.4" dur="2s" repeatCount="indefinite"/>
    </circle>
    <circle cx="85" cy="12" r="3" fill="rgba(180,180,180,0.3)">
      <animate attributeName="cy" values="12;2;12" dur="2.5s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.3;0;0.3" dur="2.5s" repeatCount="indefinite"/>
    </circle>
  ` : '';

  return `<svg width="120" height="120" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
    <!-- 地基阴影 / ground shadow -->
    <ellipse cx="60" cy="112" rx="48" ry="6" fill="rgba(0,0,0,0.15)"/>
    <!-- 左墙 / left wall -->
    <polygon points="10,55 60,80 60,108 10,83" fill="${wallDark}"/>
    <!-- 右墙 / right wall -->
    <polygon points="60,80 110,55 110,83 60,108" fill="${wallColor}"/>
    <!-- 左屋顶 / left roof -->
    <polygon points="10,55 60,30 60,80 10,55" fill="${roofDark}"/>
    <!-- 右屋顶 / right roof -->
    <polygon points="60,30 110,55 60,80" fill="${roofColor}"/>
    <!-- 门 / door -->
    <polygon points="44,78 44,94 50,97 50,81" fill="${wallDark}" stroke="${roofDark}" stroke-width="0.5"/>
    ${smoke}
    ${windows}
  </svg>`;
}

/**
 * 村民小人 SVG / Villager (isometric character) SVG
 * 宽 24 高 36。头部颜色由引擎决定。
 */
export function villagerSVG(engine: EngineKind, state: VillagerState): string {
  const headColor = ENGINE_COLORS[engine];
  const bodyColor = `hsl(${hashHue(engine)}, 30%, 45%)`;
  const idle = state === 'idle';
  const working = state === 'working';
  const isError = state === 'error';

  // 眼睛
  const eyes = idle
    ? '<path d="M9 8 L11 8 M13 8 L15 8" stroke="#333" stroke-width="0.8" stroke-linecap="round"/>' // 闭眼(打瞌睡)
    : '<circle cx="10" cy="8" r="1" fill="#333"/><circle cx="14" cy="8" r="1" fill="#333"/>'; // 睁眼

  // 错误时的 ! 气泡
  const errBubble = isError
    ? `<circle cx="12" cy="-2" r="5" fill="#ff5252"/><text x="12" y="0" text-anchor="middle" font-size="6" fill="white" font-weight="bold">!</text>`
    : '';

  // 工作时的气泡(...)
  const workBubble = working
    ? `<circle cx="6" cy="-1" r="1.5" fill="#666"/><circle cx="10" cy="-1" r="1.5" fill="#666"/><circle cx="14" cy="-1" r="1.5" fill="#666"/>`
    : '';

  // done 时的星星
  const doneStar = state === 'done'
    ? `<text x="12" y="-1" text-anchor="middle" font-size="9" fill="#FFD700">✦</text>`
    : '';

  return `<svg width="24" height="36" viewBox="-2 -6 28 42" xmlns="http://www.w3.org/2000/svg" class="villager-svg state-${state}">
    ${doneStar}${errBubble}${workBubble}
    <!-- 脚 -->
    <rect x="7" y="28" width="4" height="5" rx="1" fill="${bodyColor}"/>
    <rect x="13" y="28" width="4" height="5" rx="1" fill="${bodyColor}"/>
    <!-- 身体 -->
    <rect x="6" y="14" width="12" height="16" rx="3" fill="${bodyColor}"/>
    <!-- 头 -->
    <circle cx="12" cy="8" r="5" fill="${headColor}" stroke="${bodyColor}" stroke-width="0.5"/>
    ${eyes}
  </svg>`;
}

// ── 主渲染 / Main rendering ──

let selectedConvId: string | null = null; // 当前在侧滑面板查看的 agent
let onSend: ((id: string, text: string) => void) | null = null;
let onCancel: ((id: string) => void) | null = null;
let onSelectChat: ((id: string) => void) | null = null;
let onNewTask: ((cwd: string) => void) | null = null;
let onNewProject: (() => void) | null = null;
let getConvs: (() => Map<string, Conversation>) | null = null;
let getOrder: (() => string[]) | null = null;

let onShowWorkbench: (() => void) | null = null;

export interface TownCallbacks {
  send: (id: string, text: string) => void;
  cancel: (id: string) => void;
  selectChat: (id: string) => void;
  newTask: (cwd: string) => void;
  newProject: () => void;
  showWorkbench: () => void;
  convs: () => Map<string, Conversation>;
  order: () => string[];
}

export function setTownCallbacks(cb: TownCallbacks): void {
  onSend = cb.send;
  onCancel = cb.cancel;
  onSelectChat = cb.selectChat;
  onNewTask = cb.newTask;
  onNewProject = cb.newProject;
  onShowWorkbench = cb.showWorkbench;
  getConvs = cb.convs;
  getOrder = cb.order;
}

/** 全量渲染小镇 / Full render of the town */
export function renderTown(): void {
  const root = document.getElementById('town-canvas');
  if (!root) return;
  if (!getConvs || !getOrder) return;
  const convsMap = getConvs();
  const orderList = getOrder();

  // 按 cwd 分组(同 Workbench) / Group by cwd (same as Workbench)
  const groups = new Map<string, string[]>();
  for (const id of orderList) {
    const c = convsMap.get(id);
    if (!c) continue;
    const key = c.cwd || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(id);
  }
  const items = [...groups.entries()];
  items.sort((a, b) => {
    const la = a[1][0] ? convsMap.get(a[1][0])?.createdAt ?? 0 : 0;
    const lb = b[1][0] ? convsMap.get(b[1][0])?.createdAt ?? 0 : 0;
    return lb - la;
  });

  const cols = Math.min(3, Math.max(1, items.length));

  let houses = '';
  if (items.length === 0) {
    houses = `<div class="town-empty">${esc(tr('town.empty'))}</div>`;
  } else {
    houses = '<div class="town-grid" style="--town-cols:' + cols + '">';
    items.forEach(([cwd, ids], idx) => {
      const agents = ids.map((id) => convsMap.get(id)!).filter(Boolean);
      const proj = projName(cwd);
      const hue = hashHue(cwd);
      let totalTokens = 0, totalCost = 0, lastTs = 0, running = false;
      for (const c of agents) {
        totalTokens += c.tokens;
        totalCost += c.cost;
        const t = c.turns[c.turns.length - 1]?.ts ?? c.createdAt;
        if (t > lastTs) lastTs = t;
        if (c.status === 'running') running = true;
      }
      const stats: string[] = [tr('town.tasks', { n: ids.length })];
      if (totalTokens) stats.push(`${(totalTokens / 1000).toFixed(1)}k tok`);
      if (totalCost) stats.push(`$${totalCost.toFixed(4)}`);
      const when = lastTs ? timeAgo(lastTs) : tr('wb.noActivity');

      houses += `<div class="town-house" data-cwd="${esc(cwd)}" data-idx="${idx}" style="--house-hue:${hue}">
        <div class="house-roof-label">${esc(proj)}</div>
        <div class="house-svg">${houseSVG(cwd, agents, hue)}</div>
        <div class="house-sign">
          <span class="house-stats">${esc(stats.join(' · '))}</span>
          <span class="house-last ${running ? 'running' : ''}">${esc(when)}</span>
        </div>
        <div class="house-villagers">
          ${agents.map((c) => {
            const vs = villagerState(c);
            const label = c.customTitle || c.turns[0]?.prompt?.slice(0, 16) || '…';
            return `<div class="villager-wrap vs-${vs}" data-conv-id="${esc(c.id)}" data-engine="${c.engine}" title="${esc(label)}">
              ${villagerSVG(c.engine, vs)}
              <span class="villager-name">${esc(label)}</span>
            </div>`;
          }).join('')}
        </div>
        <div class="house-actions">
          <button class="ghost town-newtask" title="${esc(tr('town.newTask'))}">＋ ${esc(tr('town.newTask'))}</button>
        </div>
      </div>`;
    });
    houses += '</div>';
  }

  root.innerHTML = `<div class="town-sky"></div>
    <div class="town-header">
      <div class="town-title">${ICON_TOWN} ${esc(tr('town.title'))}</div>
      <div class="town-sub">${esc(tr('town.sub'))}</div>
      <span class="town-spacer"></span>
      <button class="ghost" id="town-goto-wb" title="${esc(tr('wb.title'))}">${ICON_GRID}</button>
      <button class="primary" id="town-new-proj">${esc(tr('town.newProject'))}</button>
    </div>
    <div class="town-body">${houses}</div>`;

  // 绑定事件 / Wire events
  const newProjBtn = document.getElementById('town-new-proj');
  if (newProjBtn && onNewProject) newProjBtn.onclick = () => onNewProject!();
  const gotoWbBtn = document.getElementById('town-goto-wb');
  if (gotoWbBtn && onShowWorkbench) gotoWbBtn.onclick = () => onShowWorkbench!();

  root.querySelectorAll<HTMLElement>('.town-house').forEach((house) => {
    const cwd = house.dataset.cwd!;
    house.querySelector<HTMLElement>('.town-newtask')!.onclick = (e) => {
      e.stopPropagation();
      if (onNewTask) onNewTask(cwd);
    };
    // 点击村民 → 打开侧滑面板
    house.querySelectorAll<HTMLElement>('.villager-wrap').forEach((vw) => {
      vw.onclick = (e) => {
        e.stopPropagation();
        const cid = vw.dataset.convId!;
        openTownPanel(cid);
      };
    });
  });

  // 如果有选中的 villager,刷新面板
  if (selectedConvId) {
    refreshTownPanel();
  }
}

const ICON_TOWN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V8l5-4v17M19 21V11l-6-4"/><path d="M9 9v.01M9 12v.01M9 15v.01M9 18v.01"/></svg>';
const ICON_GRID = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';

// ── 侧滑面板 / Slide panel ──

function openTownPanel(convId: string): void {
  selectedConvId = convId;
  refreshTownPanel();
  const panel = document.getElementById('town-panel');
  if (panel) panel.classList.add('open');
  const backdrop = document.getElementById('town-backdrop');
  if (backdrop) backdrop.classList.add('open');
}

function closeTownPanel(): void {
  selectedConvId = null;
  const panel = document.getElementById('town-panel');
  if (panel) panel.classList.remove('open');
  const backdrop = document.getElementById('town-backdrop');
  if (backdrop) backdrop.classList.remove('open');
}

/** 刷新侧滑面板内容(全量重建 innerHTML) / Refresh panel content */
function refreshTownPanel(): void {
  if (!selectedConvId || !getConvs) return;
  const conv = getConvs().get(selectedConvId);
  if (!conv) { closeTownPanel(); return; }
  const panel = document.getElementById('town-panel');
  if (!panel) return;

  const vs = villagerState(conv);
  const stateLabel = vs === 'idle' ? tr('town.agentIdle')
    : vs === 'working' ? tr('town.agentWorking')
    : vs === 'error' ? tr('town.agentError')
    : tr('town.agentDone');

  const lastTurn = conv.turns[conv.turns.length - 1];

  // 工具步骤 / Tool steps
  let stepsHTML = '';
  if (lastTurn && lastTurn.steps.length) {
    const visibleSteps = lastTurn.steps.slice(-5); // 最近 5 步
    stepsHTML = '<div class="tp-section"><div class="tp-label">' + esc(tr('town.steps')) + '</div>' +
      visibleSteps.map((s) => {
        const dur = s.durationMs ? ` <span class="tp-dur">${(s.durationMs / 1000).toFixed(1)}s</span>` : '';
        const result = s.result ? s.result.slice(0, 200) : '';
        return `<div class="tp-step">
          <span class="tp-step-tool">${ICON_WRENCH} ${esc(s.name)}</span>${dur}
          <pre class="tp-step-args">${esc(s.args.slice(0, 300))}</pre>
          ${result ? `<pre class="tp-step-result">${esc(result)}${s.result.length > 200 ? '…' : ''}</pre>` : ''}
        </div>`;
      }).join('') + '</div>';
  }

  // 答案(token 流) / Answer (token stream)
  let answerHTML = '';
  if (lastTurn && lastTurn.answer) {
    const text = lastTurn.answer.length > 500 ? lastTurn.answer.slice(0, 500) + '…' : lastTurn.answer;
    answerHTML = `<div class="tp-section"><div class="tp-label">${esc(tr('town.output'))}</div><div class="tp-answer">${esc(text)}</div></div>`;
  }

  // 错误 / Error
  const errorHTML = (lastTurn && lastTurn.error)
    ? `<div class="tp-error">${esc(lastTurn.error)}</div>`
    : '';

  // Prompt
  const promptText = lastTurn?.prompt || tr('town.noPrompt');

  const statusNote = conv.statusNote ? `<div class="tp-status-note">${esc(conv.statusNote)}</div>` : '';

  panel.innerHTML = `<div class="tp-head">
    <span class="tp-villager">${villagerSVG(conv.engine, vs)}</span>
    <div class="tp-info">
      <div class="tp-name">${esc(conv.customTitle || projName(conv.cwd))}</div>
      <div class="tp-engine">${esc(conv.engine)} · <span class="tp-state vs-${vs}">${esc(stateLabel)}</span></div>
      <div class="tp-cwd">${esc(conv.cwd || tr('wb.ungrouped'))}</div>
    </div>
    <button class="ghost tp-close" title="${esc(tr('common.close'))}">✕</button>
  </div>
  ${statusNote}
  <div class="tp-body">
    <div class="tp-section">
      <div class="tp-label">${esc(tr('town.currentPrompt'))}</div>
      <div class="tp-prompt">${esc(promptText)}</div>
    </div>
    ${errorHTML}
    ${stepsHTML}
    ${answerHTML}
  </div>
  <div class="tp-footer">
    <div class="tp-input-wrap">
      <input type="text" class="tp-input" placeholder="${esc(tr('town.sayToAgent'))}" />
      <button class="primary tp-send">${esc(tr('town.send'))}</button>
    </div>
    <div class="tp-actions">
      <button class="ghost tp-stop" ${conv.status !== 'running' ? 'disabled' : ''}>${ICON_STOP} ${esc(tr('town.stop'))}</button>
      <button class="ghost tp-detail">${esc(tr('town.detail'))} →</button>
    </div>
  </div>`;

  // 绑定事件 / Wire events
  panel.querySelector<HTMLElement>('.tp-close')!.onclick = () => closeTownPanel();
  // 点击遮罩关闭 / Click backdrop to close
  const backdrop = document.getElementById('town-backdrop');
  if (backdrop) backdrop.onclick = () => closeTownPanel();

  const input = panel.querySelector<HTMLInputElement>('.tp-input')!;
  const sendBtn = panel.querySelector<HTMLElement>('.tp-send')!;
  const doSend = () => {
    const text = input.value.trim();
    if (!text || !onSend) return;
    onSend(conv.id, text);
    input.value = '';
  };
  sendBtn.onclick = doSend;
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } };

  panel.querySelector<HTMLElement>('.tp-stop')!.onclick = () => {
    if (onCancel) onCancel(conv.id);
  };

  panel.querySelector<HTMLElement>('.tp-detail')!.onclick = () => {
    if (onSelectChat) onSelectChat(conv.id);
  };
}

/** 增量更新单个村民状态(不重建整个小镇) / Incremental update of one villager */
export function refreshTownVillager(conv: Conversation): void {
  const safeId = conv.id.replace(/["\\]/g, '\\$&');
  const wrap = document.querySelector<HTMLElement>(`.villager-wrap[data-conv-id="${safeId}"]`);
  if (!wrap) return;
  const vs = villagerState(conv);
  const engine = conv.engine;
  // 更新 class(保留 data-conv-id 属性)
  wrap.className = `villager-wrap vs-${vs}`;
  wrap.dataset.engine = engine;
  // 更新 SVG
  const label = conv.customTitle || conv.turns[0]?.prompt?.slice(0, 16) || '…';
  wrap.title = label;
  wrap.querySelector('.villager-name')!.textContent = label;
  const svgContainer = wrap.querySelector('.villager-svg');
  if (svgContainer) {
    svgContainer.outerHTML = villagerSVG(engine, vs);
  }
  // 更新所属房子的窗户和统计
  const house = wrap.closest('.town-house') as HTMLElement | null;
  if (house) {
    const cwd = house.dataset.cwd!;
    if (getConvs && getOrder) {
      const ids = getOrder().filter((id) => getConvs!().get(id)?.cwd === cwd);
      const agents = ids.map((id) => getConvs!().get(id)!).filter(Boolean);
      // 更新房子 SVG(窗户灯光)
      const houseSvgEl = house.querySelector('.house-svg');
      if (houseSvgEl) houseSvgEl.innerHTML = houseSVG(cwd, agents, hashHue(cwd));
      // 更新统计
      let totalTokens = 0, totalCost = 0, lastTs = 0, running = false;
      for (const c of agents) {
        totalTokens += c.tokens; totalCost += c.cost;
        const t = c.turns[c.turns.length - 1]?.ts ?? c.createdAt;
        if (t > lastTs) lastTs = t;
        if (c.status === 'running') running = true;
      }
      const stats: string[] = [tr('town.tasks', { n: ids.length })];
      if (totalTokens) stats.push(`${(totalTokens / 1000).toFixed(1)}k tok`);
      if (totalCost) stats.push(`$${totalCost.toFixed(4)}`);
      const statsEl = house.querySelector('.house-stats');
      if (statsEl) statsEl.textContent = stats.join(' · ');
      const lastEl = house.querySelector('.house-last');
      if (lastEl) {
        lastEl.textContent = lastTs ? timeAgo(lastTs) : tr('wb.noActivity');
        lastEl.classList.toggle('running', running);
      }
    }
  }
  // 如果正在查看该 agent,刷新面板
  if (selectedConvId === conv.id) {
    refreshTownPanel();
  }
}

/** 对话增加/删除时调用(需要全量重排) / Call when conversations are added/removed */
export function townOnConversationChanged(): void {
  const canvas = document.getElementById('town-canvas');
  if (canvas && canvas.children.length > 0) {
    renderTown();
  }
}

// 面板使用的图标 / Icons used in panel
const ICON_WRENCH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 005.4-5.4l-2.1 2.1-2.4-.6-.6-2.4z"/></svg>';
const ICON_STOP = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
