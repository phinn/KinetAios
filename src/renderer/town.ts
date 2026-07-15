// Town View — game-style isometric town visualization.
// 项目 = 房子(house),会话 = 村民(villager)。与 Workbench 平行,同一数据两种看法。
// Town View — game-style isometric town: projects = houses, conversations = villagers.
// Parallel to Workbench — same data, different view. Zero-dependency (pure SVG + CSS + DOM).
// 设计理念:背景跟主题走(radial-gradient),房子用低饱和+多层光影做出精致等距感。
import type { Conversation, EngineKind } from '../shared/types';
import { t } from '../shared/i18n';
import type { Lang } from '../shared/i18n';

// ── 外部传入的依赖(由 app.ts 设置) / External deps (set by app.ts) ──
let lang: Lang = 'zh-CN';
let homeDir = '';

export function setTownLang(l: Lang): void { lang = l; }
export function setTownHomeDir(d: string): void { homeDir = d; }

// 远程节点信息 / Remote node info (passed from app.ts)
export type RemoteNodeInfo = {
  name: string;
  url?: string;
  online: boolean;    // 是否已连上(从 listMcp 判断) / connected (from listMcp)
  toolCount: number;  // 可用工具数 / available tools
};

// 引擎颜色 / Engine colors (muted, sophisticated tones)
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

// ═══════════════════════════════════════════════════
// SVG 生成器 / SVG generators
// ═══════════════════════════════════════════════════

/**
 * 等距小房子 SVG / Isometric house SVG
 * 宽 130 高 125。低饱和墙面 + 多层光影 + 精致细节。
 * 高级感来源: SVG <defs> 渐变定义,墙面/屋顶都有暗→亮渐变;
 * 窗户用暖光发光 + 圆角窗框;烟囱有立体砖纹。
 */
export function houseSVG(cwd: string, agents: Conversation[], _accentHue?: number): string {
  const hue = hashHue(cwd);
  // 低饱和度配色,整体偏灰调 / Low-saturation, muted palette
  const s = 22;   // saturation %
  const wallL = 62, wallM = 52, wallD = 40;  // lightness for 3 walls
  const roofL = 38, roofM = 30, roofD = 24;
  const cWallRight = `hsl(${hue}, ${s}%, ${wallL}%)`;
  const cWallLeft  = `hsl(${hue}, ${s}%, ${wallD}%)`;
  const cWallMid   = `hsl(${hue}, ${s}%, ${wallM}%)`;
  const cRoofRight = `hsl(${hue}, ${s + 8}%, ${roofL}%)`;
  const cRoofLeft  = `hsl(${hue}, ${s + 8}%, ${roofD}%)`;
  const cRoofMid   = `hsl(${hue}, ${s + 8}%, ${roofM}%)`;
  const cTrim      = `hsl(${hue}, ${s}%, ${wallD - 8}%)`;

  const hasRunning = agents.some((c) => c.status === 'running');
  const hasError = agents.some((c) => villagerState(c) === 'error');

  // 窗户最多显示 6 个(2 列 × 3 行),超出用 +N 表示
  const maxWindows = 6;
  const shown = agents.slice(0, maxWindows);
  const overflow = agents.length - shown.length;

  // ── 窗户 / Windows ──
  let windows = '';
  shown.forEach((conv, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const wx = 74 + col * 24;
    const wy = 50 + row * 18;
    const vs = villagerState(conv);
    // 暖色调窗户灯光 / warm window glow
    const lightColor = vs === 'error' ? '#ef4444' : vs === 'done' ? '#22c55e' : '#fbbf24';
    const lit = vs === 'working' || vs === 'done';
    const darkFill = vs === 'error' ? '#7f1d1d' : `hsl(${hue}, ${s}%, ${wallD - 12}%)`;
    // 光晕 / glow halo
    const glow = lit
      ? `<ellipse cx="${wx + 10}" cy="${wy + 6}" rx="16" ry="10" fill="${lightColor}" opacity="0.08"/>`
      : '';
    // 窗框 + 玻璃 / frame + glass
    windows += `${glow}<rect x="${wx}" y="${wy}" width="20" height="12" rx="1.5" fill="${lit ? lightColor : darkFill}" opacity="${lit ? 0.85 : 0.65}"/>`;
    // 窗框描边 / window border
    windows += `<rect x="${wx}" y="${wy}" width="20" height="12" rx="1.5" fill="none" stroke="${cTrim}" stroke-width="0.7"/>`;
    // 窗户十字格 / mullion cross
    windows += `<line x1="${wx + 10}" y1="${wy}" x2="${wx + 10}" y2="${wy + 12}" stroke="${cTrim}" stroke-width="0.5" opacity="0.6"/>`;
    windows += `<line x1="${wx}" y1="${wy + 6}" x2="${wx + 20}" y2="${wy + 6}" stroke="${cTrim}" stroke-width="0.5" opacity="0.6"/>`;
    // 引擎色小人头部剪影 / tiny engine-colored head silhouette
    windows += `<circle cx="${wx + 10}" cy="${wy + 6}" r="2.2" fill="${ENGINE_COLORS[conv.engine]}" opacity="${lit ? 0.85 : 0.3}"/>`;
  });

  if (overflow > 0) {
    windows += `<text x="95" y="110" font-size="9" fill="rgba(140,140,150,0.55)" font-family="system-ui" font-weight="600">+${overflow}</text>`;
  }

  // ── 烟囱(有 running agent 时冒烟) / Chimney with smoke ──
  const chimney = hasRunning ? `
    <rect x="88" y="16" width="8" height="14" fill="${cRoofLeft}" rx="0.5"/>
    <rect x="86" y="14" width="12" height="4" fill="${cRoofMid}" rx="0.5"/>
    <circle cx="92" cy="10" r="3" fill="rgba(180,180,190,0.18)">
      <animate attributeName="cy" values="10;-2;10" dur="2.8s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.18;0;0.18" dur="2.8s" repeatCount="indefinite"/>
      <animate attributeName="r" values="3;4.5;3" dur="2.8s" repeatCount="indefinite"/>
    </circle>
    <circle cx="94" cy="13" r="2" fill="rgba(180,180,190,0.12)">
      <animate attributeName="cy" values="13;1;13" dur="3.2s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.12;0;0.12" dur="3.2s" repeatCount="indefinite"/>
    </circle>` : '';

  // ── 错误指示 / Error indicator ──
  const errorFx = hasError ? `
    <circle cx="20" cy="25" r="4" fill="#ef4444" opacity="0.7">
      <animate attributeName="opacity" values="0.3;0.7;0.3" dur="1.8s" repeatCount="indefinite"/>
    </circle>` : '';

  // 门牌首字母 / Door plate initial
  const initial = projName(cwd).charAt(0).toUpperCase();

  return `<svg width="130" height="125" viewBox="0 0 130 125" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="wall-r-${hue}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${cWallRight}"/>
        <stop offset="100%" stop-color="${cWallMid}"/>
      </linearGradient>
      <linearGradient id="roof-r-${hue}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${cRoofRight}"/>
        <stop offset="100%" stop-color="${cRoofMid}"/>
      </linearGradient>
    </defs>
    <!-- 地基阴影 / ground shadow -->
    <ellipse cx="65" cy="116" rx="50" ry="6" fill="rgba(0,0,0,0.12)"/>
    <!-- 左墙(暗面) / left wall (shadow side) -->
    <polygon points="12,58 65,84 65,112 12,86" fill="${cWallLeft}"/>
    <!-- 右墙(亮面,渐变) / right wall (lit, gradient) -->
    <polygon points="65,84 118,58 118,86 65,112" fill="url(#wall-r-${hue})"/>
    <!-- 右墙顶部高光 / right wall top highlight -->
    <polygon points="65,84 118,58 118,61 65,87" fill="rgba(255,255,255,0.04)"/>
    <!-- 左屋顶 / left roof -->
    <polygon points="12,58 65,30 65,84" fill="${cRoofLeft}"/>
    <!-- 右屋顶(渐变) / right roof (gradient) -->
    <polygon points="65,30 118,58 65,84" fill="url(#roof-r-${hue})"/>
    <!-- 屋顶折线高光 / roof edge highlight -->
    <line x1="65" y1="30" x2="65" y2="84" stroke="rgba(255,255,255,0.06)" stroke-width="0.8"/>
    <!-- 屋脊盖 / roof ridge cap -->
    <polygon points="61,28 69,28 71,32 59,32" fill="${cRoofLeft}"/>
    <!-- 门 / door (recessed) -->
    <polygon points="48,82 48,98 54,101 54,85" fill="${cTrim}" stroke="${cRoofLeft}" stroke-width="0.4"/>
    <circle cx="52" cy="92" r="0.7" fill="rgba(255,255,255,0.15)"/>
    <!-- 门牌 / door plate -->
    <rect x="57" y="84" width="7" height="7" rx="1" fill="${cTrim}" opacity="0.6"/>
    <text x="60.5" y="89.5" text-anchor="middle" font-size="5.5" fill="rgba(255,255,255,0.35)" font-family="system-ui" font-weight="700">${esc(initial)}</text>
    ${chimney}
    ${errorFx}
    ${windows}
  </svg>`;
}

/**
 * 村民小人 SVG / Villager (isometric character) SVG
 * 宽 24 高 36。头部颜色由引擎决定。简洁可爱的等距小人。
 */
export function villagerSVG(engine: EngineKind, state: VillagerState): string {
  const headColor = ENGINE_COLORS[engine];
  const bodyHue = hashHue(engine);
  const bodyColor = `hsl(${bodyHue}, 20%, 42%)`;
  const bodyDark = `hsl(${bodyHue}, 20%, 34%)`;
  const idle = state === 'idle';
  const working = state === 'working';
  const isError = state === 'error';

  // 眼睛 / eyes
  const eyes = idle
    ? '<path d="M9 8 Q10 7.5 11 8 M13 8 Q14 7.5 15 8" stroke="#2a2a2a" stroke-width="0.7" stroke-linecap="round" fill="none"/>'
    : '<circle cx="10" cy="8" r="0.9" fill="#2a2a2a"/><circle cx="14" cy="8" r="0.9" fill="#2a2a2a"/>';

  // 小腮红 / subtle blush
  const blush = !isError
    ? '<circle cx="8" cy="9.5" r="0.8" fill="rgba(255,140,140,0.25)"/><circle cx="16" cy="9.5" r="0.8" fill="rgba(255,140,140,0.25)"/>'
    : '';

  // 错误时的 ! 气泡 / error bubble
  const errBubble = isError
    ? `<circle cx="12" cy="-2" r="4.5" fill="#ef4444"/><text x="12" y="0" text-anchor="middle" font-size="5.5" fill="white" font-weight="bold">!</text>`
    : '';

  // 工作时的气泡(...) / working bubble
  const workBubble = working
    ? `<circle cx="6" cy="-1" r="1.2" fill="rgba(120,120,130,0.6)"/><circle cx="10" cy="-1" r="1.2" fill="rgba(120,120,130,0.6)"/><circle cx="14" cy="-1" r="1.2" fill="rgba(120,120,130,0.6)"/>`
    : '';

  // done 时的星星 / done star
  const doneStar = state === 'done'
    ? `<text x="12" y="-1" text-anchor="middle" font-size="8" fill="#e8b339" opacity="0.8">✦</text>`
    : '';

  return `<svg width="24" height="36" viewBox="-2 -6 28 42" xmlns="http://www.w3.org/2000/svg" class="villager-svg state-${state}">
    ${doneStar}${errBubble}${workBubble}
    <!-- 脚 / feet -->
    <ellipse cx="9" cy="31" rx="2" ry="1.5" fill="${bodyDark}"/>
    <ellipse cx="15" cy="31" rx="2" ry="1.5" fill="${bodyDark}"/>
    <!-- 身体 / body -->
    <rect x="6" y="14" width="12" height="16" rx="3.5" fill="${bodyColor}"/>
    <!-- 身体底部暗影 / body bottom shadow -->
    <rect x="6" y="26" width="12" height="4" rx="3.5" fill="${bodyDark}"/>
    <!-- 头 / head -->
    <circle cx="12" cy="8" r="5" fill="${headColor}" stroke="${bodyDark}" stroke-width="0.4"/>
    ${eyes}
    ${blush}
  </svg>`;
}

/**
 * 云端房子 SVG / Cloud house SVG (for remote MCP nodes)
 * 与本地房子视觉区分:房子坐在一朵云上,配色偏冷蓝/紫调。
 * 宽 130 高 150(含云朵底座)。
 */
export function cloudHouseSVG(name: string, online: boolean, toolCount: number): string {
  const hue = hashHue(name);
  // 远程房子用冷色调 / Remote houses use cool tones
  const cWall = online ? `hsl(${hue}, 28%, 58%)` : `hsl(${hue}, 12%, 42%)`;
  const cWallD = online ? `hsl(${hue}, 28%, 44%)` : `hsl(${hue}, 12%, 32%)`;
  const cWallL = online ? `hsl(${hue}, 28%, 68%)` : `hsl(${hue}, 12%, 52%)`;
  const cRoof = online ? `hsl(${hue}, 35%, 40%)` : `hsl(${hue}, 15%, 30%)`;
  const cRoofD = online ? `hsl(${hue}, 35%, 30%)` : `hsl(${hue}, 15%, 22%)`;
  // 窗户:在线时亮灯,离线时暗 / Windows: lit when online, dark when offline
  const winColor = online ? '#7dd3fc' : '#444';
  const winGlow = online ? `<circle cx="82" cy="62" r="14" fill="#7dd3fc" opacity="0.1"/>` : '';
  // 云朵 / cloud base
  const cloudOpacity = online ? '0.8' : '0.35';
  const cloudFill = online ? 'rgba(180,200,220,0.6)' : 'rgba(100,100,110,0.3)';

  // 信号波纹(在线时) / signal ripples when online
  const signal = online ? `
    <circle cx="100" cy="20" r="3" fill="none" stroke="#7dd3fc" stroke-width="0.8" opacity="0.6">
      <animate attributeName="r" values="3;8;3" dur="2s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.6;0;0.6" dur="2s" repeatCount="indefinite"/>
    </circle>
    <circle cx="100" cy="20" r="2" fill="#7dd3fc">
      <animate attributeName="opacity" values="1;0.4;1" dur="1.5s" repeatCount="indefinite"/>
    </circle>` : '<text x="100" y="24" text-anchor="middle" font-size="10" fill="#666">✕</text>';

  return `<svg width="130" height="150" viewBox="0 0 130 150" xmlns="http://www.w3.org/2000/svg">
    <!-- 信号 / signal indicator -->
    ${signal}
    <!-- 地基云朵阴影 / cloud ground shadow -->
    <ellipse cx="65" cy="138" rx="50" ry="5" fill="rgba(0,0,0,0.08)"/>
    <!-- 云朵底座 / cloud base -->
    <ellipse cx="35" cy="128" rx="20" ry="10" fill="${cloudFill}" opacity="${cloudOpacity}"/>
    <ellipse cx="65" cy="132" rx="30" ry="12" fill="${cloudFill}" opacity="${cloudOpacity}"/>
    <ellipse cx="95" cy="128" rx="22" ry="10" fill="${cloudFill}" opacity="${cloudOpacity}"/>
    <!-- 左墙(暗面) / left wall -->
    <polygon points="14,60 65,86 65,118 14,92" fill="${cWallD}"/>
    <!-- 右墙(亮面) / right wall -->
    <polygon points="65,86 116,60 116,92 65,118" fill="${cWall}"/>
    <!-- 右墙高光 / right wall highlight -->
    <polygon points="65,86 116,60 116,64 65,90" fill="${cWallL}" opacity="0.25"/>
    <!-- 左屋顶 / left roof -->
    <polygon points="14,60 65,32 65,86 14,60" fill="${cRoofD}"/>
    <!-- 右屋顶 / right roof -->
    <polygon points="65,32 116,60 65,86" fill="${cRoof}"/>
    <!-- 屋脊 / roof ridge -->
    <polygon points="61,30 69,30 71,34 59,34" fill="${cRoofD}"/>
    <!-- 天线(在线时亮) / antenna (glowing when online) -->
    <line x1="65" y1="32" x2="65" y2="20" stroke="${cWallD}" stroke-width="1"/>
    <circle cx="65" cy="19" r="1.5" fill="${online ? '#7dd3fc' : '#555'}"/>
    <!-- 门 / door -->
    <polygon points="48,86 48,104 54,107 54,89" fill="${cWallD}"/>
    <!-- 窗户 / window -->
    ${winGlow}
    <rect x="72" y="54" width="20" height="14" rx="1.5" fill="${winColor}" opacity="${online ? '0.85' : '0.4'}" stroke="${cWallD}" stroke-width="0.5"/>
    <line x1="82" y1="54" x2="82" y2="68" stroke="${cWallD}" stroke-width="0.4" opacity="0.4"/>
    <line x1="72" y1="61" x2="92" y2="61" stroke="${cWallD}" stroke-width="0.4" opacity="0.4"/>
    <!-- 工具数标签 / tool count badge -->
    ${online && toolCount > 0 ? `<rect x="95" y="100" width="22" height="12" rx="6" fill="rgba(125,211,252,0.2)" stroke="#7dd3fc" stroke-width="0.5"/><text x="106" y="108" text-anchor="middle" font-size="7" fill="#7dd3fc" font-family="system-ui" font-weight="600">${toolCount}</text>` : ''}
  </svg>`;
}

// ═══════════════════════════════════════════════════
// 主渲染 / Main rendering
// ═══════════════════════════════════════════════════

let selectedConvId: string | null = null; // 当前在面板查看的 agent
let onSend: ((id: string, text: string) => void) | null = null;
let onCancel: ((id: string) => void) | null = null;
let onSelectChat: ((id: string) => void) | null = null;
let onNewTask: ((cwd: string) => void) | null = null;
let onNewProject: (() => void) | null = null;
let getConvs: (() => Map<string, Conversation>) | null = null;
let getOrder: (() => string[]) | null = null;
let onShowWorkbench: (() => void) | null = null;
// 远程节点 / Remote nodes
let getRemoteNodes: (() => RemoteNodeInfo[]) | null = null;
let onRemoteTask: ((serverName: string, prompt: string) => Promise<string>) | null = null;

export interface TownCallbacks {
  send: (id: string, text: string) => void;
  cancel: (id: string) => void;
  selectChat: (id: string) => void;
  newTask: (cwd: string) => void;
  newProject: () => void;
  showWorkbench: () => void;
  convs: () => Map<string, Conversation>;
  order: () => string[];
  remoteNodes: () => RemoteNodeInfo[];
  remoteTask: (serverName: string, prompt: string) => Promise<string>;
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
  getRemoteNodes = cb.remoteNodes;
  onRemoteTask = cb.remoteTask;
}

const ICON_TOWN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V8l5-4v17M19 21V11l-6-4"/><path d="M9 9v.01M9 12v.01M9 15v.01M9 18v.01"/></svg>';
const ICON_GRID = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
const ICON_CLOUD = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 100-9 6 6 0 00-11.5 2A4 4 0 006 19h11.5z"/></svg>';
const ICON_CLOUD_SMALL = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 100-9 6 6 0 00-11.5 2A4 4 0 006 19h11.5z"/></svg>';
const ICON_SEND = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

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

  // ── 远程节点区块 / Remote nodes section ──
  let remoteHTML = '';
  const remoteNodes = getRemoteNodes ? getRemoteNodes() : [];
  if (remoteNodes.length > 0) {
    const remoteCols = Math.min(3, remoteNodes.length);
    remoteHTML = `<div class="town-remote-header">${ICON_CLOUD} ${esc(tr('town.remoteSection'))}</div>
      <div class="town-remote-sub">${esc(tr('town.remoteSub'))}</div>
      <div class="town-grid town-remote-grid" style="--town-cols:${remoteCols}">`;
    for (const node of remoteNodes) {
      const statusCls = node.online ? 'online' : 'offline';
      const statusText = node.online ? tr('town.remoteOnline') : tr('town.remoteOffline');
      remoteHTML += `<div class="town-house town-remote ${statusCls}" data-remote-name="${esc(node.name)}">
        <div class="house-roof-label">${ICON_CLOUD_SMALL} ${esc(node.name)}</div>
        <div class="house-svg">${cloudHouseSVG(node.name, node.online, node.toolCount)}</div>
        <div class="house-sign">
          <span class="house-stats ${statusCls}">${esc(statusText)}</span>
          <span class="house-last">${node.online ? esc(tr('town.remoteTools', { n: node.toolCount })) : esc(node.url || '')}</span>
        </div>
        <div class="house-actions">
          <button class="ghost town-remote-task" ${node.online ? '' : 'disabled'} title="${esc(tr('town.remoteTask'))}">${ICON_SEND} ${esc(tr('town.remoteTask'))}</button>
        </div>
      </div>`;
    }
    remoteHTML += '</div>';
  }

  root.innerHTML = `<div class="town-sky"></div>
    <div class="town-header">
      <div class="town-title">${ICON_TOWN} ${esc(tr('town.title'))}</div>
      <div class="town-sub">${esc(tr('town.sub'))}</div>
      <span class="town-spacer"></span>
      <button class="ghost" id="town-goto-wb" title="${esc(tr('wb.title'))}">${ICON_GRID}</button>
      <button class="primary" id="town-new-proj">${esc(tr('town.newProject'))}</button>
    </div>
    <div class="town-body">${houses}${remoteHTML}</div>`;

  // 绑定事件 / Wire events
  const newProjBtn = document.getElementById('town-new-proj');
  if (newProjBtn && onNewProject) newProjBtn.onclick = () => onNewProject!();
  const gotoWbBtn = document.getElementById('town-goto-wb');
  if (gotoWbBtn && onShowWorkbench) gotoWbBtn.onclick = () => onShowWorkbench!();

  root.querySelectorAll<HTMLElement>('.town-house:not(.town-remote)').forEach((house) => {
    const cwd = house.dataset.cwd!;
    const taskBtn = house.querySelector<HTMLElement>('.town-newtask');
    if (taskBtn) taskBtn.onclick = (e) => {
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

  // 远程节点:点击发起远程任务 / Remote nodes: click to send remote task
  root.querySelectorAll<HTMLElement>('.town-remote').forEach((house) => {
    const rName = house.dataset.remoteName!;
    const taskBtn = house.querySelector<HTMLElement>('.town-remote-task');
    if (taskBtn) {
      taskBtn.onclick = (e) => {
        e.stopPropagation();
        openRemoteTaskPanel(rName);
      };
    }
  });

  // 如果有选中的 villager,刷新面板 / Refresh panel if a villager is selected
  if (selectedConvId) {
    refreshTownPanel();
  }
}

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

// ── 远程任务面板 / Remote task panel ──
// 远程节点不支持本地会话,用独立的居中面板发任务。
let selectedRemote: string | null = null;

function openRemoteTaskPanel(serverName: string): void {
  selectedRemote = serverName;
  const panel = document.getElementById('town-panel');
  if (!panel) return;
  const nodes = getRemoteNodes ? getRemoteNodes() : [];
  const node = nodes.find((n) => n.name === serverName);

  panel.innerHTML = `<div class="tp-head">
    <span class="tp-villager">${ICON_CLOUD_SMALL}</span>
    <div class="tp-info">
      <div class="tp-name">${ICON_CLOUD_SMALL} ${esc(serverName)}</div>
      <div class="tp-engine">${node ? esc(node.url || '') : ''}</div>
    </div>
    <button class="ghost tp-close" title="${esc(tr('common.close'))}">✕</button>
  </div>
  <div class="tp-body">
    <div class="tp-section">
      <div class="tp-label">${esc(tr('town.remoteTask'))}</div>
      <textarea class="tp-remote-input" rows="3" placeholder="${esc(tr('town.remoteTaskPh'))}"></textarea>
    </div>
    <div class="tp-remote-result"></div>
  </div>
  <div class="tp-footer">
    <div class="tp-actions">
      <button class="primary tp-remote-run">${ICON_SEND} ${esc(tr('town.remoteRun'))}</button>
      <button class="ghost tp-close-btn">${esc(tr('common.close'))}</button>
    </div>
  </div>`;
  panel.classList.add('open');
  const backdrop = document.getElementById('town-backdrop');
  if (backdrop) {
    backdrop.classList.add('open');
    backdrop.onclick = () => closeTownPanel();
  }

  panel.querySelector<HTMLElement>('.tp-close')!.onclick = () => closeTownPanel();
  panel.querySelector<HTMLElement>('.tp-close-btn')!.onclick = () => closeTownPanel();

  const input = panel.querySelector<HTMLTextAreaElement>('.tp-remote-input')!;
  const runBtn = panel.querySelector<HTMLButtonElement>('.tp-remote-run')!;
  const resultEl = panel.querySelector<HTMLElement>('.tp-remote-result')!;

  const doRun = async () => {
    const prompt = input.value.trim();
    if (!prompt || !onRemoteTask) return;
    runBtn.disabled = true;
    runBtn.innerHTML = `${ICON_SEND} ${esc(tr('town.remoteRunning'))}`;
    resultEl.innerHTML = `<div class="tp-remote-running"><span class="tp-spinner"></span> ${esc(tr('town.remoteRunning'))}</div>`;
    try {
      const result = await onRemoteTask(serverName, prompt);
      resultEl.innerHTML = `<div class="tp-section"><div class="tp-label">${esc(tr('town.remoteResult'))}</div><div class="tp-answer">${esc(result)}</div></div>`;
    } catch (err) {
      resultEl.innerHTML = `<div class="tp-error">${esc((err as Error).message || tr('town.remoteErr'))}</div>`;
    } finally {
      runBtn.disabled = false;
      runBtn.innerHTML = `${ICON_SEND} ${esc(tr('town.remoteRun'))}`;
    }
  };
  runBtn.onclick = doRun;
  input.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void doRun(); } };
  input.focus();
}

/** 刷新面板内容(全量重建 innerHTML) / Refresh panel content */
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
  wrap.className = `villager-wrap vs-${vs}`;
  wrap.dataset.engine = engine;
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
      const houseSvgEl = house.querySelector('.house-svg');
      if (houseSvgEl) houseSvgEl.innerHTML = houseSVG(cwd, agents, hashHue(cwd));
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
