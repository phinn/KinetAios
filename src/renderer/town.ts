// Town View — game-style isometric town visualization.
// 项目 = 房子(house),会话 = 村民(villager)。与 Workbench 平行,同一数据两种看法。
// Town View — game-style isometric town: projects = houses, conversations = villagers.
// Parallel to Workbench — same data, different view. Zero-dependency (pure SVG + CSS + DOM).
// 支持 3 套皮肤: cozy(日落) / forest(森林) / neon(霓虹)。
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

// ── 皮肤系统 / Skin system ──
export type TownSkin = 'cozy' | 'forest' | 'neon';
let currentSkin: TownSkin = 'cozy';
let onSkinChange: ((skin: TownSkin) => void) | null = null;

export function setTownSkin(skin: TownSkin): void {
  currentSkin = skin;
  const canvas = document.getElementById('town-canvas');
  if (canvas) {
    canvas.setAttribute('data-town-skin', skin);
  }
  // 更新皮肤按钮高亮
  document.querySelectorAll('.town-skin-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.skin === skin);
  });
  // 重新渲染天空装饰
  renderSkyDeco();
}

export function getTownSkin(): TownSkin { return currentSkin; }

// ═══════════════════════════════════════════════════
// 工具函数 / Utility
// ═══════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════
// SVG 生成器 / SVG generators
// ═══════════════════════════════════════════════════

/**
 * 等距小房子 SVG / Isometric house SVG
 * 宽 140 高 130。比原来更大更精致。
 * 窗户按 agent 数动态排列,窗户颜色映射 agent 状态。
 */
export function houseSVG(cwd: string, agents: Conversation[], _accentHue?: number): string {
  const hue = hashHue(cwd);
  const wallLight = `hsl(${hue}, 38%, 66%)`;
  const wallColor = `hsl(${hue}, 35%, 56%)`;
  const wallDark = `hsl(${hue}, 35%, 44%)`;
  const roofColor = `hsl(${hue}, 48%, 40%)`;
  const roofDark = `hsl(${hue}, 48%, 32%)`;
  const roofHi = `hsl(${hue}, 50%, 48%)`;
  const hasRunning = agents.some((c) => c.status === 'running');
  const hasError = agents.some((c) => villagerState(c) === 'error');

  // 窗户最多显示 6 个(2 列 × 3 行),超出用 +N 表示
  const maxWindows = 6;
  const shown = agents.slice(0, maxWindows);
  const overflow = agents.length - shown.length;

  let windows = '';
  shown.forEach((conv, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    // 右墙面的窗户坐标 / window positions on right wall
    const wx = 72 + col * 26;
    const wy = 54 + row * 18;
    const vs = villagerState(conv);
    // 窗户灯光颜色 / window light color by state
    const lightColor = vs === 'error' ? '#ff5252' : vs === 'done' ? '#66bb6a' : '#ffeb3b';
    const lit = vs === 'working' || vs === 'done';
    const darkFill = vs === 'error' ? '#aa3333' : wallDark;
    // 光晕效果 / glow
    const glow = lit ? `<circle cx="${wx + 10}" cy="${wy + 6}" r="12" fill="${lightColor}" opacity="0.12"/>` : '';
    // 窗框 / window frame
    windows += `${glow}<rect x="${wx}" y="${wy}" width="20" height="12" rx="1.5" fill="${lit ? lightColor : darkFill}" stroke="${wallDark}" stroke-width="0.6" opacity="${lit ? 0.92 : 0.7}"/>`;
    // 窗户十字格 / window cross
    windows += `<line x1="${wx + 10}" y1="${wy}" x2="${wx + 10}" y2="${wy + 12}" stroke="${wallDark}" stroke-width="0.4" opacity="0.5"/>`;
    windows += `<line x1="${wx}" y1="${wy + 6}" x2="${wx + 20}" y2="${wy + 6}" stroke="${wallDark}" stroke-width="0.4" opacity="0.5"/>`;
    // 窗户里的小人剪影头部(引擎色) / tiny head silhouette
    const headColor = ENGINE_COLORS[conv.engine];
    windows += `<circle cx="${wx + 10}" cy="${wy + 6}" r="2.5" fill="${headColor}" opacity="${lit ? 0.9 : 0.35}"/>`;
  });

  if (overflow > 0) {
    windows += `<text x="96" y="112" font-size="9" fill="rgba(160,160,170,0.7)" font-family="system-ui" font-weight="600">+${overflow}</text>`;
  }

  // 烟囱冒烟(有 running agent 时) / chimney smoke when agents running
  const chimney = `
    <rect x="86" y="18" width="9" height="16" fill="${roofDark}" rx="0.5"/>
    <rect x="84" y="16" width="13" height="4" fill="${roofColor}" rx="0.5"/>`;
  const smoke = hasRunning ? `
    <circle cx="90" cy="12" r="3.5" fill="rgba(200,200,210,0.35)">
      <animate attributeName="cy" values="12;0;12" dur="2.5s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.35;0;0.35" dur="2.5s" repeatCount="indefinite"/>
      <animate attributeName="r" values="3.5;5;3.5" dur="2.5s" repeatCount="indefinite"/>
    </circle>
    <circle cx="92" cy="15" r="2.5" fill="rgba(200,200,210,0.25)">
      <animate attributeName="cy" values="15;3;15" dur="3s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.25;0;0.25" dur="3s" repeatCount="indefinite"/>
    </circle>` : '';

  // 错误时的闪电 / error lightning
  const errorFx = hasError ? `
    <path d="M30 20 L35 30 L32 30 L38 42" stroke="#ff5252" stroke-width="1.5" fill="none" opacity="0.7">
      <animate attributeName="opacity" values="0;0.7;0;0.7;0" dur="2s" repeatCount="indefinite"/>
    </path>` : '';

  // 门牌号(项目首字母) / door plate (project initial)
  const initial = projName(cwd).charAt(0).toUpperCase();

  return `<svg width="140" height="130" viewBox="0 0 140 130" xmlns="http://www.w3.org/2000/svg">
    <!-- 地基阴影 / ground shadow -->
    <ellipse cx="70" cy="120" rx="54" ry="7" fill="rgba(0,0,0,0.18)"/>
    <!-- 左墙(暗面) / left wall (dark side) -->
    <polygon points="14,60 70,88 70,118 14,90" fill="${wallDark}"/>
    <!-- 右墙(亮面) / right wall (light side) -->
    <polygon points="70,88 126,60 126,90 70,118" fill="${wallColor}"/>
    <!-- 右墙高光 / right wall highlight -->
    <polygon points="70,88 126,60 126,64 70,92" fill="${wallLight}" opacity="0.3"/>
    <!-- 左屋顶 / left roof -->
    <polygon points="14,60 70,32 70,88 14,60" fill="${roofDark}"/>
    <!-- 右屋顶 / right roof -->
    <polygon points="70,32 126,60 70,88" fill="${roofColor}"/>
    <!-- 屋顶高光线 / roof highlight line -->
    <polygon points="70,32 126,60 70,88" fill="none" stroke="${roofHi}" stroke-width="0.8" opacity="0.4"/>
    <!-- 屋脊盖瓦 / roof ridge cap -->
    <polygon points="66,30 74,30 76,34 64,34" fill="${roofDark}"/>
    <!-- 门 / door -->
    <polygon points="52,86 52,104 58,107 58,89" fill="${wallDark}" stroke="${roofDark}" stroke-width="0.5"/>
    <circle cx="56" cy="96" r="0.8" fill="${roofHi}"/>
    <!-- 门牌 / door plate -->
    <rect x="60" y="88" width="8" height="8" rx="1" fill="${wallDark}" stroke="${roofDark}" stroke-width="0.4"/>
    <text x="64" y="94" text-anchor="middle" font-size="6" fill="${wallLight}" font-family="system-ui" font-weight="700">${esc(initial)}</text>
    ${chimney}
    ${smoke}
    ${errorFx}
    ${windows}
  </svg>`;
}

/**
 * 村民小人 SVG / Villager (isometric character) SVG
 * 宽 24 高 36。头部颜色由引擎决定,更可爱的圆头小人。
 */
export function villagerSVG(engine: EngineKind, state: VillagerState): string {
  const headColor = ENGINE_COLORS[engine];
  const bodyColor = `hsl(${hashHue(engine)}, 30%, 45%)`;
  const idle = state === 'idle';
  const working = state === 'working';
  const isError = state === 'error';

  // 眼睛 / eyes
  const eyes = idle
    ? '<path d="M9 8 Q10 7.5 11 8 M13 8 Q14 7.5 15 8" stroke="#333" stroke-width="0.8" stroke-linecap="round" fill="none"/>' // 闭眼(眯眯眼)
    : '<circle cx="10" cy="8" r="1" fill="#333"/><circle cx="14" cy="8" r="1" fill="#333"/>'; // 睁眼

  // 小腮红 / blush marks
  const blush = !isError ? '<circle cx="8" cy="9.5" r="1" fill="rgba(255,150,150,0.4)"/><circle cx="16" cy="9.5" r="1" fill="rgba(255,150,150,0.4)"/>' : '';

  // 错误时的 ! 气泡 / error bubble
  const errBubble = isError
    ? `<circle cx="12" cy="-2" r="5" fill="#ff5252"/><text x="12" y="0" text-anchor="middle" font-size="6" fill="white" font-weight="bold">!</text>`
    : '';

  // 工作时的气泡(...) / working bubble
  const workBubble = working
    ? `<circle cx="6" cy="-1" r="1.5" fill="#888"/><circle cx="10" cy="-1" r="1.5" fill="#888"/><circle cx="14" cy="-1" r="1.5" fill="#888"/>`
    : '';

  // done 时的星星 / done star
  const doneStar = state === 'done'
    ? `<text x="12" y="-1" text-anchor="middle" font-size="9" fill="#FFD700">✦</text>`
    : '';

  // 手臂 / arms
  const arms = working
    ? '<rect x="3" y="16" width="3" height="7" rx="1.5" fill="${bodyColor}" transform="rotate(-20 4 16)"/><rect x="18" y="16" width="3" height="7" rx="1.5" fill="${bodyColor}" transform="rotate(20 20 16)"/>'
    : '<rect x="3" y="16" width="3" height="8" rx="1.5" fill="${bodyColor}"/><rect x="18" y="16" width="3" height="8" rx="1.5" fill="${bodyColor}"/>';

  return `<svg width="24" height="36" viewBox="-2 -6 28 42" xmlns="http://www.w3.org/2000/svg" class="villager-svg state-${state}">
    ${doneStar}${errBubble}${workBubble}
    <!-- 脚 / feet -->
    <ellipse cx="9" cy="32" rx="2.5" ry="1.8" fill="${bodyColor}"/>
    <ellipse cx="15" cy="32" rx="2.5" ry="1.8" fill="${bodyColor}"/>
    <!-- 身体 / body -->
    <rect x="6" y="14" width="12" height="16" rx="4" fill="${bodyColor}"/>
    ${arms}
    <!-- 头 / head -->
    <circle cx="12" cy="8" r="5" fill="${headColor}" stroke="${bodyColor}" stroke-width="0.5"/>
    ${eyes}
    ${blush}
  </svg>`;
}

// ═══════════════════════════════════════════════════
// 天空装饰 / Sky decorations
// ═══════════════════════════════════════════════════

/** 根据皮肤渲染天空装饰(太阳/月亮/星星) / Render sky decorations based on skin */
function renderSkyDeco(): string {
  if (currentSkin === 'cozy') {
    // 温馨日落:大太阳 + 云 / sunset: sun + clouds
    return `
      <div class="town-sky-deco">
        <!-- 太阳 / sun -->
        <svg style="position:absolute;top:8%;right:10%;width:80px;height:80px" viewBox="0 0 80 80">
          <defs>
            <radialGradient id="sun-glow">
              <stop offset="0%" stop-color="#ffd5a5" stop-opacity="0.4"/>
              <stop offset="100%" stop-color="#ffd5a5" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <circle cx="40" cy="40" r="36" fill="url(#sun-glow)"/>
          <circle cx="40" cy="40" r="18" fill="#ffe0b2" opacity="0.9"/>
          <circle cx="40" cy="40" r="14" fill="#ffcc80"/>
        </svg>
        <!-- 云 / clouds -->
        <svg style="position:absolute;top:15%;left:12%;width:100px;height:40px;opacity:0.3" viewBox="0 0 100 40">
          <ellipse cx="30" cy="20" rx="25" ry="12" fill="#fff"/>
          <ellipse cx="55" cy="18" rx="20" ry="10" fill="#fff"/>
          <ellipse cx="75" cy="22" rx="18" ry="8" fill="#fff"/>
        </svg>
      </div>`;
  } else if (currentSkin === 'forest') {
    // 森林:穿透树梢的光柱 + 飘浮萤火 / forest: light shafts + fireflies
    return `
      <div class="town-sky-deco">
        <!-- 光柱 / light shaft -->
        <div style="position:absolute;top:0;left:30%;width:60px;height:100%;background:linear-gradient(180deg,rgba(255,255,200,0.06),transparent 60%);transform:rotate(8deg);pointer-events:none"></div>
        <div style="position:absolute;top:0;left:65%;width:40px;height:100%;background:linear-gradient(180deg,rgba(180,255,180,0.04),transparent 50%);transform:rotate(-5deg);pointer-events:none"></div>
        <!-- 萤火虫 / fireflies -->
        ${Array.from({ length: 8 }, (_, i) => {
          const x = 5 + (i * 12) % 90;
          const y = 20 + (i * 37) % 50;
          const delay = (i * 0.5) % 3;
          const size = 2 + (i % 3);
          return `<div class="town-star" style="left:${x}%;top:${y}%;width:${size}px;height:${size}px;background:#aaffaa;box-shadow:0 0 6px #aaffaa;animation-delay:${delay}s"></div>`;
        }).join('')}
      </div>`;
  } else {
    // 霓虹:网格地面 + 闪烁星星 / neon: grid floor + twinkling stars
    return `
      <div class="town-sky-deco">
        <!-- 远处霓虹建筑剪影 / distant neon skyline -->
        <svg style="position:absolute;bottom:35%;left:0;width:100%;height:80px;opacity:0.15" viewBox="0 0 400 80" preserveAspectRatio="none">
          <rect x="10" y="30" width="30" height="50" fill="#7c3aed"/>
          <rect x="50" y="20" width="40" height="60" fill="#6d28d9"/>
          <rect x="100" y="40" width="25" height="40" fill="#5b21b6"/>
          <rect x="135" y="15" width="50" height="65" fill="#7c3aed"/>
          <rect x="200" y="35" width="35" height="45" fill="#6d28d9"/>
          <rect x="250" y="25" width="45" height="55" fill="#5b21b6"/>
          <rect x="310" y="10" width="30" height="70" fill="#7c3aed"/>
          <rect x="350" y="30" width="40" height="50" fill="#6d28d9"/>
        </svg>
        <!-- 闪烁星星 / twinkling stars -->
        ${Array.from({ length: 15 }, (_, i) => {
          const x = (i * 7) % 100;
          const y = (i * 13) % 35;
          const delay = (i * 0.3) % 3;
          const size = 1 + (i % 3);
          const color = i % 3 === 0 ? '#7c3aed' : i % 3 === 1 ? '#f43f5e' : '#a78bfa';
          return `<div class="town-star" style="left:${x}%;top:${y}%;width:${size}px;height:${size}px;background:${color};box-shadow:0 0 4px ${color};animation-delay:${delay}s"></div>`;
        }).join('')}
      </div>`;
  }
}

// ═══════════════════════════════════════════════════
// 主渲染 / Main rendering
// ═══════════════════════════════════════════════════

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

/** 设置皮肤变更回调(用于持久化) / Set skin change callback (for persistence) */
export function setTownSkinCallback(cb: (skin: TownSkin) => void): void {
  onSkinChange = cb;
}

/** 全量渲染小镇 / Full render of the town */
export function renderTown(): void {
  const root = document.getElementById('town-canvas');
  if (!root) return;
  if (!getConvs || !getOrder) return;
  const convsMap = getConvs();
  const orderList = getOrder();

  // 确保 skin 属性已设置 / Ensure skin attribute is set
  root.setAttribute('data-town-skin', currentSkin);

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
    ${renderSkyDeco()}
    <div class="town-ground"></div>
    <div class="town-header">
      <div class="town-title">${ICON_TOWN} ${esc(tr('town.title'))}</div>
      <div class="town-sub">${esc(tr('town.sub'))}</div>
      <span class="town-spacer"></span>
      <div class="town-skin-selector">
        <button class="town-skin-btn ${currentSkin === 'cozy' ? 'active' : ''}" data-skin="cozy" title="Cozy"></button>
        <button class="town-skin-btn ${currentSkin === 'forest' ? 'active' : ''}" data-skin="forest" title="Forest"></button>
        <button class="town-skin-btn ${currentSkin === 'neon' ? 'active' : ''}" data-skin="neon" title="Neon"></button>
      </div>
      <button class="ghost" id="town-goto-wb" title="${esc(tr('wb.title'))}">${ICON_GRID}</button>
      <button class="primary" id="town-new-proj">${esc(tr('town.newProject'))}</button>
    </div>
    <div class="town-body">${houses}</div>`;

  // 绑定事件 / Wire events
  const newProjBtn = document.getElementById('town-new-proj');
  if (newProjBtn && onNewProject) newProjBtn.onclick = () => onNewProject!();
  const gotoWbBtn = document.getElementById('town-goto-wb');
  if (gotoWbBtn && onShowWorkbench) gotoWbBtn.onclick = () => onShowWorkbench!();

  // 皮肤切换 / Skin switching
  root.querySelectorAll<HTMLElement>('.town-skin-btn').forEach((btn) => {
    btn.onclick = () => {
      const skin = btn.dataset.skin as TownSkin;
      if (!skin || skin === currentSkin) return;
      setTownSkin(skin);
      if (onSkinChange) onSkinChange(skin);
    };
  });

  root.querySelectorAll<HTMLElement>('.town-house').forEach((house) => {
    const cwd = house.dataset.cwd!;
    house.querySelector<HTMLElement>('.town-newtask')!.onclick = (e) => {
      e.stopPropagation();
      if (onNewTask) onNewTask(cwd);
    };
    // 点击村民 → 打开面板 / Click villager → open panel
    house.querySelectorAll<HTMLElement>('.villager-wrap').forEach((vw) => {
      vw.onclick = (e) => {
        e.stopPropagation();
        const cid = vw.dataset.convId!;
        openTownPanel(cid);
      };
    });
  });

  // 如果有选中的 villager,刷新面板 / Refresh panel if a villager is selected
  if (selectedConvId) {
    refreshTownPanel();
  }
}

const ICON_TOWN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V8l5-4v17M19 21V11l-6-4"/><path d="M9 9v.01M9 12v.01M9 15v.01M9 18v.01"/></svg>';
const ICON_GRID = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';

// ═══════════════════════════════════════════════════
// 居中弹出面板 / Centered modal panel
// ═══════════════════════════════════════════════════

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
    const visibleSteps = lastTurn.steps.slice(-5); // 最近 5 步 / last 5 steps
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
  // 更新 class / Update class
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
  // 更新所属房子的窗户和统计 / Update house windows and stats
  const house = wrap.closest('.town-house') as HTMLElement | null;
  if (house) {
    const cwd = house.dataset.cwd!;
    if (getConvs && getOrder) {
      const ids = getOrder().filter((id) => getConvs!().get(id)?.cwd === cwd);
      const agents = ids.map((id) => getConvs!().get(id)!).filter(Boolean);
      // 更新房子 SVG(窗户灯光) / Update house SVG
      const houseSvgEl = house.querySelector('.house-svg');
      if (houseSvgEl) houseSvgEl.innerHTML = houseSVG(cwd, agents, hashHue(cwd));
      // 更新统计 / Update stats
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
  // 如果正在查看该 agent,刷新面板 / Refresh panel if viewing this agent
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
