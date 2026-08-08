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
let townStyle: 'classic' | 'minecraft' = 'classic';

export function setTownLang(l: Lang): void { lang = l; }
export function setTownHomeDir(d: string): void { homeDir = d; }
export function setTownStyle(s: 'classic' | 'minecraft'): void { townStyle = s; }

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
  directV2: '#6c5ce7',
  directV3: '#00b894',
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

// ═══════════════════════════════════════════════════
// Minecraft 风格 SVG 生成器 / Minecraft-style SVG generators
// 方块感建筑:零圆角、硬偏移阴影、像素纹理。
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// Minecraft 风格 SVG 生成器 / Minecraft-style SVG generators
// 设计理念:像素艺术纹理(用 SVG <pattern> + <rect> 铺像素网格)、
// 3D 斜角光照(上亮下暗 左亮右暗)、Minecraft 原版配色(橡木 / 圆石 / 草方块 / 红砖)。
// ═══════════════════════════════════════════════════

// ── MC 配色调色板(参照 Minecraft 原版) / MC palette (referencing vanilla MC) ──

/** 橡木板墙配色:6 档明度模拟像素纹理 / Oak plank wall: 6-step luminance */
const MC_OAK = {
  lightest: '#b08652', // 橡木最亮(光照面) / brightest oak (lit face)
  light: '#9a7340',   // 橡木亮 / light oak
  mid: '#866336',     // 橡木中 / mid oak
  dark: '#6e5028',    // 橡木暗 / dark oak
  darkest: '#563d1c', // 橡木最暗(阴影面) / darkest oak (shadow face)
  line: '#4a3318',    // 木板缝隙线 / plank gap line
};

/** 圆石/石砖配色:4 档灰色 / Cobblestone / stone brick: 4-step gray */
const MC_STONE = {
  light: '#a0a0a0',  // 石头高光 / stone highlight
  mid: '#808080',    // 石头中 / stone mid
  dark: '#606060',   // 石头暗 / stone dark
  darker: '#484848', // 石头最暗 / stone darkest
  line: '#3a3a3a',   // 砖缝 / mortar line
};

/** 草方块配色 / Grass block */
const MC_GRASS = {
  top: '#7ab84a',    // 草顶 / grass top
  side: '#866534',   // 泥土侧 / dirt side
  dark: '#5a4520',   // 泥土暗 / dirt dark
};

/** 红砖屋顶配色 / Red brick roof */
const MC_BRICK = {
  light: '#c47248',  // 砖亮 / brick light
  mid: '#a85a34',   // 砖中 / brick mid
  dark: '#82442a',  // 砖暗 / brick dark
  mortar: '#d5b8a0', // 水泥缝 / mortar
};

/**
 * MC 风格方块房子 SVG / Minecraft-style blocky house SVG
 * 宽 130 高 125。
 * 设计: 等距伪 3D 方块房屋 — 草方块地基 + 橡木板墙体(像素木板纹理) +
 *   红砖尖顶(像素砖缝) + 方形玻璃窗(MC 玻璃纹理) + 圆石烟囱(冒烟)。
 * 光照: 左上为光源,所有面遵循亮(上/左)→ 暗(下/右)的 bevel 光照规则。
 */
export function mcHouseSVG(cwd: string, agents: Conversation[], _hue?: number): string {
  const hue = _hue ?? hashHue(cwd);
  const hasRunning = agents.some((c) => c.status === 'running');
  const hasError = agents.some((c) => villagerState(c) === 'error');
  const uid = `h${hue.toFixed(0)}`; // 唯一 ID 防止 pattern 冲突 / unique ID to avoid pattern collision

  // 按项目 hue 微调橡木色相,但保持 MC 原版的明暗关系 / hue-shift oak palette per project
  const hue2 = hue % 20 - 10; // ±10 度微调 / ±10 degree jitter
  const oak = {
    lightest: `hsl(${30 + hue2}, 42%, 56%)`,
    light: `hsl(${30 + hue2}, 42%, 48%)`,
    mid: `hsl(${30 + hue2}, 42%, 40%)`,
    dark: `hsl(${30 + hue2}, 42%, 32%)`,
    darkest: `hsl(${30 + hue2}, 42%, 24%)`,
    line: `hsl(${30 + hue2}, 42%, 16%)`,
  };

  // 窗户:最多 4 个(2x2) / Windows: max 4 (2x2)
  const maxWin = 4;
  const shown = agents.slice(0, maxWin);
  const overflow = agents.length - shown.length;

  let windows = '';
  shown.forEach((conv, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const wx = 50 + col * 32;
    const wy = 48 + row * 22;
    const vs = villagerState(conv);
    const lit = vs === 'working' || vs === 'done';
    const glassColor = vs === 'error' ? '#ef4444' : vs === 'done' ? '#5db340' : vs === 'working' ? '#fce896' : '#3a4a5a';
    // MC 玻璃:外框深色 + 玻璃面板 + 像素高光 + 十字格 / MC glass pane
    windows += `<rect x="${wx}" y="${wy}" width="24" height="18" fill="${oak.darkest}"/>`;
    // 玻璃面板(内缩 2px) / glass pane (2px inset)
    windows += `<rect x="${wx + 2}" y="${wy + 2}" width="20" height="14" fill="${glassColor}" opacity="${lit ? 0.88 : 0.55}"/>`;
    // 像素高光(左上角 4x2) / pixel highlight (top-left corner)
    windows += `<rect x="${wx + 3}" y="${wy + 3}" width="6" height="2" fill="rgba(255,255,255,0.3)"/>`;
    // 十字窗框 / mullion cross
    windows += `<rect x="${wx + 11}" y="${wy + 2}" width="2" height="14" fill="${oak.darkest}"/>`;
    windows += `<rect x="${wx + 2}" y="${wy + 8}" width="20" height="2" fill="${oak.darkest}"/>`;
    // 窗户灯光光晕(亮着时) / window glow when lit
    if (lit) {
      windows += `<rect x="${wx - 2}" y="${wy - 2}" width="28" height="22" fill="${glassColor}" opacity="0.06"/>`;
    }
  });
  if (overflow > 0) {
    windows += `<rect x="88" y="104" width="22" height="12" fill="${MC_STONE.darker}"/>`;
    windows += `<text x="99" y="113" text-anchor="middle" font-size="8" fill="rgba(255,255,255,0.5)" font-family="system-ui" font-weight="700">+${overflow}</text>`;
  }

  // ── 烟囱:圆石方块 + 像素烟 / Chimney: cobblestone + pixel smoke ──
  const chimney = hasRunning ? `
    <rect x="86" y="14" width="12" height="20" fill="${MC_STONE.dark}"/>
    <rect x="84" y="12" width="16" height="4" fill="${MC_STONE.darker}"/>
    <!-- 圆石像素纹理 / cobble pixel texture -->
    <rect x="87" y="16" width="4" height="3" fill="${MC_STONE.mid}"/>
    <rect x="93" y="16" width="3" height="3" fill="${MC_STONE.mid}"/>
    <rect x="88" y="21" width="3" height="3" fill="${MC_STONE.light}"/>
    <rect x="93" y="22" width="4" height="3" fill="${MC_STONE.mid}"/>
    <rect x="87" y="27" width="3" height="3" fill="${MC_STONE.light}"/>
    <rect x="92" y="27" width="4" height="3" fill="${MC_STONE.mid}"/>
    <!-- 像素烟(方块上升) / pixel smoke (blocky puffs rising) -->
    <rect x="89" y="9" width="3" height="3" fill="rgba(220,220,225,0.25)">
      <animate attributeName="y" values="9;0;9" dur="2.4s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.25;0;0.25" dur="2.4s" repeatCount="indefinite"/>
    </rect>
    <rect x="91" y="6" width="3" height="3" fill="rgba(220,220,225,0.18)">
      <animate attributeName="y" values="6;-3;6" dur="3s" repeatCount="indefinite" begin="0.5s"/>
      <animate attributeName="opacity" values="0.18;0;0.18" dur="3s" repeatCount="indefinite" begin="0.5s"/>
    </rect>` : '';

  // ── 错误指示:红色火把(MC 红石火把风) / Error: redstone torch ──
  const errorFx = hasError ? `
    <rect x="14" y="88" width="4" height="12" fill="${MC_STONE.darker}"/>
    <rect x="13" y="82" width="6" height="8" fill="#ef4444">
      <animate attributeName="opacity" values="0.5;1;0.5" dur="1.4s" repeatCount="indefinite"/>
    </rect>
    <rect x="14" y="83" width="2" height="2" fill="#ff7777"/>` : '';

  const initial = projName(cwd).charAt(0).toUpperCase();

  return `<svg width="130" height="125" viewBox="0 0 130 125" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
    <defs>
      <!-- 橡木板纹理 pattern:4 行木板,每行有缝隙线 + 垂直缝错位 / Oak plank pattern -->
      <pattern id="oak-${uid}" x="0" y="0" width="16" height="14" patternUnits="userSpaceOnUse">
        <rect width="16" height="14" fill="${oak.mid}"/>
        <!-- 木板水平缝隙 / plank horizontal gap -->
        <rect width="16" height="1" y="0" fill="${oak.line}"/>
        <!-- 木板纹理:竖纹(年轮感) / wood grain vertical streaks -->
        <rect x="2" y="2" width="1" height="11" fill="${oak.dark}" opacity="0.4"/>
        <rect x="7" y="2" width="1" height="11" fill="${oak.light}" opacity="0.2"/>
        <rect x="11" y="2" width="1" height="11" fill="${oak.dark}" opacity="0.3"/>
        <!-- 节疤 / knot -->
        <rect x="5" y="6" width="2" height="2" fill="${oak.dark}" opacity="0.35"/>
      </pattern>
      <!-- 红砖纹理 pattern / Red brick pattern -->
      <pattern id="brick-${uid}" x="0" y="0" width="16" height="8" patternUnits="userSpaceOnUse">
        <rect width="16" height="8" fill="${MC_BRICK.mid}"/>
        <!-- 水泥缝 / mortar lines -->
        <rect width="16" height="1" fill="${MC_BRICK.mortar}"/>
        <rect x="0" y="4" width="16" height="1" fill="${MC_BRICK.mortar}"/>
        <!-- 垂直缝(错位) / vertical mortar (offset) -->
        <rect x="7" y="1" width="1" height="3" fill="${MC_BRICK.mortar}"/>
        <rect x="0" y="5" width="1" height="3" fill="${MC_BRICK.mortar}"/>
        <rect x="15" y="5" width="1" height="3" fill="${MC_BRICK.mortar}"/>
        <!-- 砖面色差 / brick shade variation -->
        <rect x="1" y="2" width="5" height="2" fill="${MC_BRICK.light}" opacity="0.3"/>
        <rect x="9" y="2" width="5" height="2" fill="${MC_BRICK.dark}" opacity="0.2"/>
      </pattern>
      <!-- 圆石纹理 pattern / Cobblestone pattern -->
      <pattern id="cobble-${uid}" x="0" y="0" width="16" height="16" patternUnits="userSpaceOnUse">
        <rect width="16" height="16" fill="${MC_STONE.dark}"/>
        <rect x="1" y="1" width="6" height="6" fill="${MC_STONE.mid}"/>
        <rect x="9" y="1" width="6" height="4" fill="${MC_STONE.light}" opacity="0.6"/>
        <rect x="1" y="9" width="4" height="6" fill="${MC_STONE.light}" opacity="0.5"/>
        <rect x="7" y="7" width="8" height="8" fill="${MC_STONE.mid}"/>
        <rect x="2" y="2" width="2" height="2" fill="${MC_STONE.light}"/>
        <rect x="10" y="2" width="2" height="1" fill="${MC_STONE.light}"/>
        <rect x="8" y="9" width="2" height="2" fill="${MC_STONE.darker}" opacity="0.5"/>
        <rect x="13" y="12" width="2" height="2" fill="${MC_STONE.darker}" opacity="0.4"/>
      </pattern>
    </defs>

    <!-- 地面阴影(硬偏移) / ground shadow (hard offset) -->
    <rect x="8" y="114" width="114" height="5" fill="rgba(0,0,0,0.18)"/>

    <!-- ═══ 草方块地基(2层) / Grass block foundation ═══ -->
    <!-- 泥土侧 / dirt side -->
    <rect x="10" y="96" width="110" height="18" fill="${MC_GRASS.side}"/>
    <!-- 草顶(1px 绿边) / grass top (1px green edge) -->
    <rect x="10" y="94" width="110" height="4" fill="${MC_GRASS.top}"/>
    <!-- 泥土暗纹 / dirt dark texture -->
    <rect x="14" y="100" width="4" height="4" fill="${MC_GRASS.dark}" opacity="0.5"/>
    <rect x="30" y="104" width="5" height="3" fill="${MC_GRASS.dark}" opacity="0.4"/>
    <rect x="52" y="99" width="3" height="4" fill="${MC_GRASS.dark}" opacity="0.5"/>
    <rect x="70" y="105" width="4" height="3" fill="${MC_GRASS.dark}" opacity="0.4"/>
    <rect x="88" y="101" width="5" height="4" fill="${MC_GRASS.dark}" opacity="0.5"/>
    <rect x="104" y="106" width="4" height="3" fill="${MC_GRASS.dark}" opacity="0.4"/>
    <!-- 草顶像素高光 / grass top pixel highlights -->
    <rect x="22" y="95" width="3" height="1" fill="#9ad06a"/>
    <rect x="44" y="95" width="3" height="1" fill="#9ad06a"/>
    <rect x="68" y="95" width="3" height="1" fill="#9ad06a"/>
    <rect x="94" y="95" width="3" height="1" fill="#9ad06a"/>

    <!-- ═══ 墙体:橡木板 / Wall: oak planks ═══ -->
    <rect x="16" y="42" width="98" height="54" fill="url(#oak-${uid})"/>
    <!-- 墙体上边高光 / wall top highlight -->
    <rect x="16" y="42" width="98" height="1" fill="${oak.light}" opacity="0.5"/>
    <!-- 墙体下边暗 / wall bottom shadow -->
    <rect x="16" y="95" width="98" height="1" fill="${oak.darkest}" opacity="0.6"/>
    <!-- 墙体右边暗(bevel) / wall right shadow (bevel) -->
    <rect x="112" y="42" width="2" height="54" fill="${oak.darkest}" opacity="0.4"/>

    <!-- ═══ 尖顶:红砖 / Roof: red brick ═══ -->
    <polygon points="10,44 65,12 120,44" fill="url(#brick-${uid})"/>
    <!-- 屋顶左暗面 / roof left shadow -->
    <polygon points="10,44 65,12 65,44" fill="rgba(0,0,0,0.18)"/>
    <!-- 屋脊高光 / roof ridge highlight -->
    <polygon points="63,12 67,12 67,16 63,16" fill="${MC_BRICK.light}" opacity="0.4"/>
    <!-- 屋檐底边 / roof eave bottom edge -->
    <polygon points="10,44 120,44 120,47 10,47" fill="${MC_BRICK.dark}" opacity="0.5"/>

    ${chimney}
    ${errorFx}
    ${windows}

    <!-- ═══ 门:橡木(深色) / Door: dark oak ═══ -->
    <rect x="56" y="68" width="18" height="26" fill="${oak.darkest}"/>
    <!-- 门框 / door frame -->
    <rect x="54" y="66" width="22" height="2" fill="${oak.dark}"/>
    <rect x="54" y="92" width="22" height="2" fill="${oak.dark}"/>
    <!-- 门板纹理(竖线) / door panel vertical lines -->
    <rect x="60" y="70" width="1" height="20" fill="${oak.line}" opacity="0.4"/>
    <rect x="65" y="70" width="1" height="20" fill="${oak.line}" opacity="0.4"/>
    <rect x="70" y="70" width="1" height="20" fill="${oak.line}" opacity="0.4"/>
    <!-- 门把手(铁锭色) / door knob (iron ingot) -->
    <rect x="70" y="80" width="2" height="2" fill="#d8d8d8"/>

    <!-- 门牌 / door plate -->
    <rect x="82" y="70" width="12" height="12" fill="${MC_STONE.darker}"/>
    <rect x="83" y="71" width="10" height="10" fill="${MC_STONE.dark}"/>
    <text x="88" y="78.5" text-anchor="middle" font-size="6" fill="rgba(255,255,255,0.45)" font-family="system-ui" font-weight="700">${esc(initial)}</text>

    <!-- 角落圆石装饰 / cobblestone corner detail -->
    <rect x="16" y="88" width="8" height="8" fill="url(#cobble-${uid})"/>
    <rect x="106" y="88" width="8" height="8" fill="url(#cobble-${uid})"/>
  </svg>`;
}

/**
 * MC 风格村民 — Steve 风格方块小人 / Minecraft-style villager (Steve-like blocky character)
 * 宽 22 高 34。头部肤色 + 像素眼 + 头发 + 身体(引擎色衬衫) + 手臂 + 腿。
 * 设计参照 Minecraft Steve:8x8 头 + 4x8 身体 + 4x3 手臂 + 4x3 腿。
 * shape-rendering=crispEdges 保证像素清晰。
 */
export function mcVillagerSVG(engine: EngineKind, state: VillagerState): string {
  const engineColor = ENGINE_COLORS[engine];
  const idle = state === 'idle';
  const working = state === 'working';
  const isError = state === 'error';

  // ── Steve 配色 / Steve palette ──
  const skin = '#c0915a';      // 肤色 / skin
  const skinDark = '#9a7340';  // 肤色暗 / skin shadow
  const skinLight = '#d4a673'; // 肤色高光 / skin highlight
  const hair = '#3a2818';      // 头发(深棕) / hair (dark brown)
  const hairLight = '#4a3420'; // 头发亮 / hair light
  const eyeWhite = '#ffffff';  // 眼白 / eye white
  const eyeColor = '#5a3a1a';  // 瞳色(棕) / iris (brown)
  const mouth = '#7a5a3a';     // 嘴色 / mouth color
  const shirt = engineColor;   // 衬衫色 = 引擎色 / shirt = engine color
  const shirtDark = `hsl(${hashHue(engine)}, 30%, 28%)`;
  const pants = '#3a3a4a';     // 裤子 / pants
  const pantsDark = '#2a2a3a';
  const shoes = '#4a3a20';     // 鞋 / shoes

  // ── 状态指示 / Status indicators ──
  // 错误:红石火把(头上冒红色) / Error: redstone torch above head
  const errFx = isError ? `
    <rect x="8" y="-6" width="4" height="2" fill="#ef4444">
      <animate attributeName="opacity" values="0.4;1;0.4" dur="1.2s" repeatCount="indefinite"/>
    </rect>
    <rect x="9" y="-8" width="2" height="2" fill="#ff6666">
      <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1.2s" repeatCount="indefinite"/>
    </rect>` : '';

  // 工作中:头顶省略号(像素方块) / Working: pixel ellipsis above head
  const workFx = working ? `
    <rect x="4" y="-4" width="2" height="2" fill="rgba(200,200,210,0.6)">
      <animate attributeName="opacity" values="0.2;0.6;0.2" dur="1.5s" repeatCount="indefinite"/>
    </rect>
    <rect x="9" y="-4" width="2" height="2" fill="rgba(200,200,210,0.6)">
      <animate attributeName="opacity" values="0.2;0.6;0.2" dur="1.5s" repeatCount="indefinite" begin="0.3s"/>
    </rect>
    <rect x="14" y="-4" width="2" height="2" fill="rgba(200,200,210,0.6)">
      <animate attributeName="opacity" values="0.2;0.6;0.2" dur="1.5s" repeatCount="indefinite" begin="0.6s"/>
    </rect>` : '';

  // done:绿宝石(头上) / Done: emerald above head
  const doneFx = state === 'done' ? `
    <rect x="8" y="-6" width="4" height="4" fill="#17b07a"/>
    <rect x="9" y="-5" width="2" height="1" fill="#2ee8a8"/>
    <rect x="8" y="-7" width="1" height="1" fill="#2ee8a8"/>
    <rect x="11" y="-7" width="1" height="1" fill="#2ee8a8"/>` : '';

  return `<svg width="22" height="34" viewBox="0 -8 22 42" xmlns="http://www.w3.org/2000/svg" class="villager-svg state-${state}" shape-rendering="crispEdges">
    ${doneFx}${errFx}${workFx}

    <!-- ═══ 头部(8x8 方块) / Head (8x8 block) ═══ -->
    <!-- 头发顶 / hair top -->
    <rect x="4" y="0" width="12" height="2" fill="${hair}"/>
    <rect x="4" y="2" width="2" height="1" fill="${hair}"/>
    <rect x="14" y="2" width="2" height="1" fill="${hair}"/>
    <rect x="6" y="1" width="1" height="1" fill="${hairLight}"/>
    <rect x="10" y="1" width="1" height="1" fill="${hairLight}"/>
    <!-- 脸部 / face -->
    <rect x="6" y="2" width="8" height="6" fill="${skin}"/>
    <!-- 脸部右侧暗 / face right shadow -->
    <rect x="12" y="3" width="2" height="5" fill="${skinDark}" opacity="0.3"/>
    <!-- 脸部顶部高光 / face top highlight -->
    <rect x="7" y="2" width="5" height="1" fill="${skinLight}" opacity="0.4"/>
    <!-- 眼睛(Steve 式:白底 + 棕瞳) / Eyes (Steve-style: white + brown iris) -->
    <rect x="7" y="4" width="2" height="1" fill="${eyeWhite}"/>
    <rect x="11" y="4" width="2" height="1" fill="${eyeWhite}"/>
    <rect x="8" y="4" width="1" height="1" fill="${eyeColor}"/>
    <rect x="12" y="4" width="1" height="1" fill="${eyeColor}"/>
    <!-- 嘴 / mouth -->
    <rect x="9" y="6" width="3" height="1" fill="${mouth}"/>
    <rect x="9" y="7" width="1" height="1" fill="${mouth}" opacity="0.5"/>
    <rect x="11" y="7" width="1" height="1" fill="${mouth}" opacity="0.5"/>

    <!-- ═══ 颈部 / Neck ═══ -->
    <rect x="8" y="8" width="4" height="1" fill="${skinDark}"/>

    <!-- ═══ 身体(衬衫 8x6) / Body (shirt 8x6) ═══ -->
    <rect x="5" y="9" width="10" height="8" fill="${shirt}"/>
    <!-- 衬衫暗面(右侧) / shirt shadow (right) -->
    <rect x="12" y="9" width="3" height="8" fill="${shirtDark}" opacity="0.35"/>
    <!-- 衣领 V / collar -->
    <rect x="8" y="9" width="4" height="1" fill="${shirtDark}" opacity="0.5"/>
    <rect x="9" y="10" width="2" height="1" fill="${skinDark}" opacity="0.3"/>

    <!-- ═══ 手臂(左右各 3x6) / Arms (left + right, 3x6 each) ═══ -->
    <!-- 左手臂 / left arm -->
    <rect x="2" y="9" width="3" height="6" fill="${shirt}"/>
    <rect x="2" y="15" width="3" height="2" fill="${skin}"/>
    <!-- 右手臂(暗) / right arm (shadow) -->
    <rect x="15" y="9" width="3" height="6" fill="${shirtDark}"/>
    <rect x="15" y="15" width="3" height="2" fill="${skinDark}"/>

    <!-- ═══ 腿(裤子 4x4 x2) / Legs (pants 4x4 ×2) ═══ -->
    <rect x="5" y="17" width="4" height="5" fill="${pants}"/>
    <rect x="11" y="17" width="4" height="5" fill="${pantsDark}"/>
    <!-- 裤腰暗 / belt shadow -->
    <rect x="5" y="17" width="10" height="1" fill="${pantsDark}" opacity="0.5"/>

    <!-- ═══ 鞋(4x2 x2) / Shoes (4x2 ×2) ═══ -->
    <rect x="5" y="22" width="4" height="2" fill="${shoes}"/>
    <rect x="11" y="22" width="4" height="2" fill="${shoes}"/>
    <!-- 鞋底暗 / sole dark -->
    <rect x="5" y="23" width="4" height="1" fill="#2a1a08"/>
    <rect x="11" y="23" width="4" height="1" fill="#2a1a08"/>
  </svg>`;
}

/**
 * MC 风格云端房子 — 钻石方块塔 + 像素云 / Minecraft-style cloud house (diamond spire + pixel cloud)
 * 宽 130 高 150。
 * 设计:钻石/青金方块塔楼(3D 斜角光照) + 像素云朵底座(方块化的 MC 云) +
 *   发光窗户(MC 红石灯风格) + 尖塔顶(钻石锥)。
 */
export function mcCloudHouseSVG(name: string, online: boolean, _toolCount: number): string {
  // ── 钻石方块配色 / Diamond block palette ──
  const dia = {
    lightest: online ? '#5ee8d8' : '#4a9888',
    light: online ? '#3ec8b8' : '#3a8074',
    mid: online ? '#2db0a0' : '#2a685e',
    dark: online ? '#1e8478' : '#1a4a44',
    darkest: online ? '#106860' : '#0a3a36',
    edge: online ? '#0a4a48' : '#062a28',
  };
  // ── 青金蓝配色(窗框) / Lapis lazuli (window frame) ──
  const lapis = online ? '#1a4ab8' : '#1a2a58';
  // ── 红石灯色(窗户) / Redstone lamp (window glow) ──
  const lampOn = '#fce896';
  const lampOff = '#3a3a2a';

  // 像素云:白色方块组合 / Pixel cloud: white blocky puffs
  const cloudColor = online ? 'rgba(230,238,245,0.18)' : 'rgba(120,130,140,0.08)';

  return `<svg width="130" height="150" viewBox="0 0 130 150" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
    <!-- ═══ 像素云朵底座 / Pixel cloud base ═══ -->
    <rect x="22" y="118" width="86" height="12" fill="${cloudColor}"/>
    <rect x="30" y="112" width="70" height="8" fill="${cloudColor}" opacity="0.7"/>
    <rect x="38" y="108" width="54" height="6" fill="${cloudColor}" opacity="0.5"/>
    <rect x="46" y="104" width="38" height="6" fill="${cloudColor}" opacity="0.3"/>
    <!-- 云朵像素细节 / cloud pixel detail -->
    <rect x="26" y="124" width="6" height="2" fill="${cloudColor}"/>
    <rect x="98" y="124" width="6" height="2" fill="${cloudColor}"/>

    <!-- 云朵阴影 / cloud shadow -->
    <ellipse cx="65" cy="138" rx="50" ry="4" fill="rgba(0,0,0,0.06)"/>

    <!-- ═══ 钻石方块塔楼 / Diamond block tower ═══ -->
    <!-- 塔身主体 / tower body -->
    <rect x="30" y="54" width="70" height="56" fill="${dia.mid}"/>
    <!-- 上边高光 / top highlight -->
    <rect x="30" y="54" width="70" height="2" fill="${dia.lightest}"/>
    <!-- 左边高光 / left highlight -->
    <rect x="30" y="54" width="2" height="56" fill="${dia.light}" opacity="0.6"/>
    <!-- 右边暗 / right shadow -->
    <rect x="98" y="54" width="2" height="56" fill="${dia.darkest}"/>
    <!-- 下边暗 / bottom shadow -->
    <rect x="30" y="108" width="70" height="2" fill="${dia.darkest}"/>

    <!-- 钻石纹理:像素高光斑点 / Diamond texture: pixel highlight specks -->
    <rect x="36" y="60" width="3" height="3" fill="${dia.light}" opacity="0.4"/>
    <rect x="50" y="70" width="2" height="2" fill="${dia.light}" opacity="0.3"/>
    <rect x="72" y="64" width="3" height="3" fill="${dia.light}" opacity="0.35"/>
    <rect x="84" y="80" width="2" height="2" fill="${dia.light}" opacity="0.3"/>
    <rect x="42" y="92" width="3" height="3" fill="${dia.light}" opacity="0.25"/>
    <rect x="78" y="98" width="2" height="2" fill="${dia.light}" opacity="0.3"/>

    <!-- ═══ 尖塔顶(钻石锥) / Spire top (diamond cone) ═══ -->
    <polygon points="30,56 65,22 100,56" fill="${dia.dark}"/>
    <!-- 左面亮 / left face bright -->
    <polygon points="30,56 65,22 65,56" fill="${dia.mid}"/>
    <!-- 尖顶高光 / spire highlight -->
    <polygon points="63,22 67,22 65,28" fill="${dia.light}"/>

    <!-- ═══ 发光窗户(红石灯风格) / Glowing windows (redstone lamp) ═══ -->
    <!-- 左窗 / left window -->
    <rect x="40" y="70" width="14" height="12" fill="${lapis}"/>
    <rect x="42" y="72" width="10" height="8" fill="${online ? lampOn : lampOff}" opacity="${online ? 0.85 : 0.4}"/>
    <rect x="42" y="72" width="4" height="1" fill="rgba(255,255,255,0.4)"/>
    <!-- 右窗 / right window -->
    <rect x="76" y="70" width="14" height="12" fill="${lapis}"/>
    <rect x="78" y="72" width="10" height="8" fill="${online ? lampOn : lampOff}" opacity="${online ? 0.85 : 0.4}"/>
    <rect x="78" y="72" width="4" height="1" fill="rgba(255,255,255,0.4)"/>

    <!-- ═══ 门:圆石拱门 / Door: cobblestone arch ═══ -->
    <rect x="54" y="84" width="22" height="26" fill="${MC_STONE.darker}"/>
    <rect x="56" y="86" width="18" height="22" fill="${dia.edge}"/>
    <!-- 门框圆石纹理 / door frame cobble texture -->
    <rect x="55" y="85" width="2" height="24" fill="${MC_STONE.mid}" opacity="0.5"/>
    <rect x="74" y="85" width="2" height="24" fill="${MC_STONE.mid}" opacity="0.5"/>

    <!-- ═══ 塔顶旗杆 + 旗帜 / Flagpole + banner ═══ -->
    <rect x="64" y="14" width="2" height="8" fill="#6a6a6a"/>
    ${online ? `<rect x="66" y="15" width="8" height="5" fill="#5db340">
      <animate attributeName="opacity" values="0.6;1;0.6" dur="2s" repeatCount="indefinite"/>
    </rect>` : `<rect x="66" y="15" width="8" height="5" fill="#555" opacity="0.4"/>`}

    <!-- ═══ 地面阴影 / Ground shadow ═══ -->
    <rect x="28" y="108" width="74" height="3" fill="rgba(0,0,0,0.12)"/>
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

// ═══════════════════════════════════════════════════
// SEED 高达主题 SVG 生成器 / Gundam SEED-style SVG generators
// 设计理念:ZAFT 军事基地 — 机甲格纳库(房子)+ Mobile Suit 驾驶员(村民)+
//   通讯卫星塔(远程节点)。配色严格遵循 Strike Gundam 三色 + ZAFT 绿。
// 视觉特征:金属装甲板分割线、HUD 发光线条、V-fin 天线、ZAFT 绿光辉。
// ═══════════════════════════════════════════════════

// ── SEED 配色 / SEED palette ──
const SEED = {
  // 机身装甲白 / Gundam frame white
  white: '#e8ecf0', whiteMid: '#c8d0d8', whiteDark: '#a0aab4', whiteShadow: '#7a8290',
  // 强袭蓝(胸部/肩甲) / Strike blue
  blue: '#1a5cb8', blueLight: '#2a7fd8', blueDark: '#0e3d80',
  // 强袭红(脚部/下巴) / Strike red
  red: '#c83040', redLight: '#e04858', redDark: '#902030',
  // 高达黄(V-fin/点缀) / Gundam yellow
  yellow: '#f5d020', yellowDark: '#c0a010',
  // ZAFT 绿 / ZAFT green
  green: '#7fcc19', greenDark: '#4a8a0a',
  // 金属灰骨架 / Gunmetal skeleton
  metal: '#3a4048', metalDark: '#22262c', metalLight: '#4a5258',
  // 驾驶舱绿光 / Cockpit green glow
  glow: '#7fcc19',
};

/**
 * SEED 机甲格纳库 SVG / Gundam SEED hangar SVG
 * 宽 130 高 125。
 * 设计:等距军事机库 — 金属装甲板墙壁 + V-fin 天线 + HUD 窗口(引擎色发光) +
 *   ZAFT 绿光辉边缘 + 装甲分割线。机库门带强化装甲纹理。
 */
export function seedHouseSVG(cwd: string, agents: Conversation[], _hue?: number): string {
  const hasRunning = agents.some((c) => c.status === 'running');
  const hasError = agents.some((c) => villagerState(c) === 'error');

  // HUD 窗口最多 6 个 / HUD screens (max 6)
  const maxScreens = 6;
  const shown = agents.slice(0, maxScreens);
  const overflow = agents.length - shown.length;

  let screens = '';
  shown.forEach((conv, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const wx = 74 + col * 22;
    const wy = 50 + row * 16;
    const vs = villagerState(conv);
    const screenColor = vs === 'error' ? SEED.red : vs === 'done' ? SEED.green : SEED.yellow;
    const lit = vs === 'working' || vs === 'done' || vs === 'error';
    const darkFill = '#0e1218';
    // HUD 辉光 / HUD glow
    const glow = lit
      ? `<ellipse cx="${wx + 9}" cy="${wy + 5}" rx="14" ry="8" fill="${screenColor}" opacity="0.08"/>`
      : '';
    // HUD 屏幕框 / HUD screen frame
    screens += `${glow}<rect x="${wx}" y="${wy}" width="18" height="10" rx="1" fill="${lit ? screenColor : darkFill}" opacity="${lit ? 0.80 : 0.70}"/>`;
    // 屏幕边框 / screen border
    screens += `<rect x="${wx}" y="${wy}" width="18" height="10" rx="1" fill="none" stroke="${SEED.metalLight}" stroke-width="0.6"/>`;
    // HUD 十字线 / HUD crosshair
    screens += `<line x1="${wx + 9}" y1="${wy}" x2="${wx + 9}" y2="${wy + 10}" stroke="rgba(0,0,0,0.25)" stroke-width="0.4"/>`;
    screens += `<line x1="${wx}" y1="${wy + 5}" x2="${wx + 18}" y2="${wy + 5}" stroke="rgba(0,0,0,0.25)" stroke-width="0.4"/>`;
    // 引擎色点 / engine dot
    screens += `<circle cx="${wx + 9}" cy="${wy + 5}" r="1.8" fill="${ENGINE_COLORS[conv.engine]}" opacity="${lit ? 0.90 : 0.30}"/>`;
  });

  if (overflow > 0) {
    screens += `<text x="94" y="110" font-size="8" fill="${SEED.green}" opacity="0.55" font-family="system-ui" font-weight="700">+${overflow}</text>`;
  }

  // V-fin 天线(有 running 时旋转) / V-fin antenna (spins when running)
  const vfin = hasRunning ? `
    <line x1="65" y1="28" x2="65" y2="16" stroke="${SEED.metal}" stroke-width="1.2"/>
    <polygon points="60,18 63,16 65,12 67,16 70,18" fill="${SEED.yellow}"/>
    <rect x="64" y="12" width="2" height="4" fill="${SEED.yellowDark}">
      <animateTransform attributeName="transform" type="rotate" from="0 65 14" to="360 65 14" dur="3s" repeatCount="indefinite"/>
    </rect>` : `
    <line x1="65" y1="28" x2="65" y2="16" stroke="${SEED.metal}" stroke-width="1.2"/>
    <polygon points="60,18 63,16 65,12 67,16 70,18" fill="${SEED.yellow}" opacity="0.6"/>`;

  // 错误警报 / Error alarm
  const errorFx = hasError ? `
    <circle cx="18" cy="24" r="4" fill="${SEED.red}" opacity="0.7">
      <animate attributeName="opacity" values="0.3;0.7;0.3" dur="1.2s" repeatCount="indefinite"/>
    </circle>
    <text x="18" y="26" text-anchor="middle" font-size="6" fill="white" font-weight="bold">!</text>` : '';

  const initial = projName(cwd).charAt(0).toUpperCase();

  return `<svg width="130" height="125" viewBox="0 0 130 125" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="seed-wall-r" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${SEED.whiteMid}"/>
        <stop offset="100%" stop-color="${SEED.whiteDark}"/>
      </linearGradient>
    </defs>
    <!-- 地基阴影 / ground shadow -->
    <ellipse cx="65" cy="116" rx="50" ry="6" fill="rgba(0,0,0,0.20)"/>
    <!-- 左墙(蓝色暗面) / left wall (blue shadow side) -->
    <polygon points="12,58 65,84 65,112 12,86" fill="${SEED.blueDark}"/>
    <!-- 左墙装甲分割线 / left wall armor panel lines -->
    <line x1="12" y1="72" x2="65" y2="98" stroke="${SEED.metalDark}" stroke-width="0.4" opacity="0.6"/>
    <line x1="38" y1="58" x2="38" y2="98" stroke="${SEED.metalDark}" stroke-width="0.3" opacity="0.4"/>
    <!-- 右墙(白色亮面,渐变) / right wall (white lit, gradient) -->
    <polygon points="65,84 118,58 118,86 65,112" fill="url(#seed-wall-r)"/>
    <!-- 右墙顶部高光 / right wall top highlight -->
    <polygon points="65,84 118,58 118,61 65,87" fill="rgba(255,255,255,0.06)"/>
    <!-- 右墙装甲分割线 / right wall armor panel lines -->
    <line x1="65" y1="72" x2="118" y2="46" stroke="${SEED.metalDark}" stroke-width="0.4" opacity="0.5"/>
    <line x1="92" y1="58" x2="92" y2="98" stroke="${SEED.metalDark}" stroke-width="0.3" opacity="0.4"/>
    <!-- 屋顶(蓝色斜面) / roof (blue slope) -->
    <polygon points="12,58 65,30 65,84" fill="${SEED.blueDark}"/>
    <polygon points="65,30 118,58 65,84" fill="${SEED.blue}"/>
    <!-- 屋顶折线高光 / roof edge highlight -->
    <line x1="65" y1="30" x2="65" y2="84" stroke="rgba(127,204,25,0.15)" stroke-width="0.6"/>
    <!-- 屋脊(黄色装饰条) / roof ridge (yellow trim) -->
    <polygon points="61,28 69,28 71,32 59,32" fill="${SEED.blueDark}"/>
    <rect x="62" y="29" width="6" height="1" fill="${SEED.yellow}" opacity="0.5"/>
    <!-- ZAFT 绿光辉边缘(底部) / ZAFT green glow edge -->
    <line x1="12" y1="86" x2="65" y2="112" stroke="${SEED.green}" stroke-width="0.5" opacity="0.25"/>
    <line x1="65" y1="112" x2="118" y2="86" stroke="${SEED.green}" stroke-width="0.5" opacity="0.25"/>
    <!-- 机库门 / hangar door -->
    <polygon points="48,82 48,100 54,103 54,85" fill="${SEED.metalDark}" stroke="${SEED.metal}" stroke-width="0.4"/>
    <!-- 门上黄色警示条 / door hazard stripes -->
    <rect x="49" y="90" width="4" height="1" fill="${SEED.yellow}" opacity="0.4"/>
    <rect x="49" y="93" width="4" height="1" fill="${SEED.yellow}" opacity="0.4"/>
    <!-- 门牌 / door plate -->
    <rect x="57" y="84" width="7" height="7" rx="1" fill="${SEED.metal}" opacity="0.7"/>
    <text x="60.5" y="89.5" text-anchor="middle" font-size="5.5" fill="${SEED.green}" opacity="0.50" font-family="system-ui" font-weight="700">${esc(initial)}</text>
    ${vfin}
    ${errorFx}
    ${screens}
  </svg>`;
}

/**
 * SEED Mobile Suit 驾驶员 SVG / Gundam SEED pilot (chibi Mobile Suit)
 * 宽 24 高 36。简化 Q 版机甲:V-fin 头部 + 单眼 + 引擎色胸甲。
 */
export function seedVillagerSVG(engine: EngineKind, state: VillagerState): string {
  const engineColor = ENGINE_COLORS[engine];
  const idle = state === 'idle';
  const working = state === 'working';
  const isError = state === 'error';

  // 状态指示 / Status indicators
  // 错误:红色警报三角形 / Error: red alert triangle
  const errFx = isError ? `
    <polygon points="12,-5 8,1 16,1" fill="${SEED.red}" opacity="0.8">
      <animate attributeName="opacity" values="0.4;0.8;0.4" dur="1.2s" repeatCount="indefinite"/>
    </polygon>
    <text x="12" y="-0.5" text-anchor="middle" font-size="4" fill="white" font-weight="bold">!</text>` : '';

  // 工作中:绿色 HUD 扫描点 / Working: green HUD scan dots
  const workFx = working ? `
    <circle cx="6" cy="-2" r="1" fill="${SEED.green}">
      <animate attributeName="opacity" values="0.2;0.9;0.2" dur="1.5s" repeatCount="indefinite"/>
    </circle>
    <circle cx="10" cy="-2" r="1" fill="${SEED.green}">
      <animate attributeName="opacity" values="0.2;0.9;0.2" dur="1.5s" repeatCount="indefinite" begin="0.3s"/>
    </circle>
    <circle cx="14" cy="-2" r="1" fill="${SEED.green}">
      <animate attributeName="opacity" values="0.2;0.9;0.2" dur="1.5s" repeatCount="indefinite" begin="0.6s"/>
    </circle>` : '';

  // done:黄色星章 / Done: yellow star
  const doneFx = state === 'done' ? `
    <polygon points="12,-3 13.5,-0.5 16,0 13.5,0.5 12,3 10.5,0.5 8,0 10.5,-0.5" fill="${SEED.yellow}" opacity="0.85"/>` : '';

  // 单眼(绿色监视器) / Mono-eye (green sensor)
  const eye = working
    ? `<rect x="8" y="6" width="8" height="2" rx="1" fill="${SEED.green}">
         <animate attributeName="fill" values="${SEED.green};${SEED.yellowDark};${SEED.green}" dur="1s" repeatCount="indefinite"/>
       </rect>`
    : `<rect x="8" y="6" width="8" height="2" rx="1" fill="${SEED.green}" opacity="0.70"/>`;

  return `<svg width="24" height="36" viewBox="-2 -6 28 42" xmlns="http://www.w3.org/2000/svg" class="villager-svg state-${state}">
    ${doneFx}${errFx}${workFx}
    <!-- 脚(红色装甲) / Feet (red armor) -->
    <rect x="7" y="29" width="4" height="3" fill="${SEED.red}" rx="0.5"/>
    <rect x="13" y="29" width="4" height="3" fill="${SEED.redDark}" rx="0.5"/>
    <!-- 腿(金属骨架) / Legs (gunmetal) -->
    <rect x="8" y="22" width="3" height="7" fill="${SEED.metal}"/>
    <rect x="13" y="22" width="3" height="7" fill="${SEED.metalDark}"/>
    <!-- 身体(白色胸甲 + 引擎色中心) / Body (white chest + engine core) -->
    <rect x="6" y="13" width="12" height="10" rx="2" fill="${SEED.white}"/>
    <!-- 胸甲右侧暗影 / chest right shadow -->
    <rect x="12" y="13" width="6" height="10" rx="2" fill="${SEED.whiteDark}" opacity="0.30"/>
    <!-- 引擎色核心(胸部驾驶舱) / Engine color core -->
    <rect x="9" y="15" width="6" height="3" rx="1" fill="${engineColor}" opacity="0.85"/>
    <rect x="9" y="15" width="6" height="1" rx="1" fill="rgba(255,255,255,0.20)"/>
    <!-- 肩甲(蓝色) / Shoulder armor (blue) -->
    <rect x="4" y="13" width="3" height="4" rx="1" fill="${SEED.blue}"/>
    <rect x="17" y="13" width="3" height="4" rx="1" fill="${SEED.blueDark}"/>
    <!-- 手臂 / Arms -->
    <rect x="3" y="17" width="3" height="5" rx="1" fill="${SEED.whiteMid}"/>
    <rect x="18" y="17" width="3" height="5" rx="1" fill="${SEED.whiteDark}"/>
    <!-- 颈部 / Neck -->
    <rect x="10" y="11" width="4" height="2" fill="${SEED.metalDark}"/>
    <!-- 头部(白色机甲头盔) / Head (white mech helmet) -->
    <rect x="6" y="3" width="12" height="9" rx="2.5" fill="${SEED.white}"/>
    <!-- 头部右侧暗 / head right shadow -->
    <rect x="12" y="3" width="6" height="9" rx="2.5" fill="${SEED.whiteDark}" opacity="0.25"/>
    <!-- V-fin / V-fin antenna -->
    <polygon points="12,0 9,3 11,2.5" fill="${SEED.yellow}"/>
    <polygon points="12,0 15,3 13,2.5" fill="${SEED.yellow}"/>
    <rect x="11.5" y="0" width="1" height="2" fill="${SEED.yellowDark}"/>
    ${eye}
  </svg>`;
}

/**
 * SEED 通讯卫星塔 SVG / Gundam SEED comm satellite (remote nodes)
 * 宽 130 高 150。设计:金属卫星塔 + 太阳能板 + 绿色通讯光环(在线时)。
 */
export function seedCloudHouseSVG(name: string, online: boolean, _toolCount: number): string {
  const sat = online
    ? { body: SEED.metal, panel: SEED.blue, glow: SEED.green, signal: 0.35 }
    : { body: SEED.metalDark, panel: SEED.blueDark, glow: SEED.metalLight, signal: 0.10 };

  return `<svg width="130" height="150" viewBox="0 0 130 150" xmlns="http://www.w3.org/2000/svg">
    <!-- ═══ 通讯光环(在线时绿色脉冲) / Comm ring (green pulse when online) ═══ -->
    ${online ? `<ellipse cx="65" cy="70" rx="50" ry="12" fill="none" stroke="${SEED.green}" stroke-width="0.6" opacity="0.15">
      <animate attributeName="rx" values="40;55;40" dur="3s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.05;0.20;0.05" dur="3s" repeatCount="indefinite"/>
    </ellipse>` : ''}

    <!-- ═══ 卫星主体 / Satellite body ═══ -->
    <rect x="52" y="48" width="26" height="40" rx="2" fill="${sat.body}"/>
    <!-- 主体高光 / body highlight -->
    <rect x="52" y="48" width="26" height="2" rx="1" fill="${SEED.metalLight}" opacity="0.6"/>
    <rect x="52" y="48" width="2" height="40" fill="${SEED.metalLight}" opacity="0.4"/>
    <!-- 主体暗面 / body shadow -->
    <rect x="76" y="48" width="2" height="40" fill="${SEED.metalDark}"/>
    <!-- 装甲分割线 / armor panel lines -->
    <line x1="52" y1="60" x2="78" y2="60" stroke="${SEED.metalDark}" stroke-width="0.4"/>
    <line x1="52" y1="72" x2="78" y2="72" stroke="${SEED.metalDark}" stroke-width="0.4"/>

    <!-- ═══ 太阳能板 / Solar panels ═══ -->
    <rect x="14" y="56" width="34" height="18" fill="${sat.panel}" rx="0.5"/>
    <rect x="82" y="56" width="34" height="18" fill="${sat.panel}" rx="0.5" opacity="0.85"/>
    <!-- 太阳能板网格 / solar panel grid lines -->
    <line x1="14" y1="62" x2="48" y2="62" stroke="rgba(0,0,0,0.3)" stroke-width="0.4"/>
    <line x1="14" y1="68" x2="48" y2="68" stroke="rgba(0,0,0,0.3)" stroke-width="0.4"/>
    <line x1="22" y1="56" x2="22" y2="74" stroke="rgba(0,0,0,0.3)" stroke-width="0.4"/>
    <line x1="31" y1="56" x2="31" y2="74" stroke="rgba(0,0,0,0.3)" stroke-width="0.4"/>
    <line x1="40" y1="56" x2="40" y2="74" stroke="rgba(0,0,0,0.3)" stroke-width="0.4"/>
    <line x1="82" y1="62" x2="116" y2="62" stroke="rgba(0,0,0,0.3)" stroke-width="0.4"/>
    <line x1="82" y1="68" x2="116" y2="68" stroke="rgba(0,0,0,0.3)" stroke-width="0.4"/>
    <line x1="90" y1="56" x2="90" y2="74" stroke="rgba(0,0,0,0.3)" stroke-width="0.4"/>
    <line x1="99" y1="56" x2="99" y2="74" stroke="rgba(0,0,0,0.3)" stroke-width="0.4"/>
    <line x1="108" y1="56" x2="108" y2="74" stroke="rgba(0,0,0,0.3)" stroke-width="0.4"/>

    <!-- ═══ 天线 / Antenna ═══ -->
    <line x1="65" y1="48" x2="65" y2="36" stroke="${SEED.metal}" stroke-width="1.2"/>
    <circle cx="65" cy="34" r="2" fill="${online ? SEED.green : SEED.metalLight}">
      ${online ? `<animate attributeName="opacity" values="0.5;1;0.5" dur="2s" repeatCount="indefinite"/>` : ''}
    </circle>
    <polygon points="61,36 63,34 65,30 67,34 69,36" fill="${SEED.yellow}" opacity="${online ? 0.8 : 0.3}"/>

    <!-- ═══ 窗口(HUD 绿) / HUD windows ═══ -->
    <rect x="56" y="62" width="8" height="5" rx="1" fill="${online ? SEED.green : '#1a1e26'}" opacity="${online ? 0.75 : 0.40}"/>
    <rect x="56" y="62" width="8" height="5" rx="1" fill="none" stroke="${SEED.metalLight}" stroke-width="0.4"/>
    <rect x="66" y="62" width="8" height="5" rx="1" fill="${online ? SEED.green : '#1a1e26'}" opacity="${online ? 0.50 : 0.25}"/>
    <rect x="66" y="62" width="8" height="5" rx="1" fill="none" stroke="${SEED.metalLight}" stroke-width="0.4"/>

    <!-- ═══ 驱动器(底部) / Thrusters (bottom) ═══ -->
    <rect x="55" y="88" width="6" height="6" fill="${SEED.metalDark}" rx="0.5"/>
    <rect x="69" y="88" width="6" height="6" fill="${SEED.metalDark}" rx="0.5"/>
    ${online ? `<ellipse cx="58" cy="96" rx="3" ry="4" fill="${SEED.green}" opacity="0.12">
      <animate attributeName="opacity" values="0.06;0.16;0.06" dur="2s" repeatCount="indefinite"/>
    </ellipse>
    <ellipse cx="72" cy="96" rx="3" ry="4" fill="${SEED.green}" opacity="0.12">
      <animate attributeName="opacity" values="0.06;0.16;0.06" dur="2s" repeatCount="indefinite" begin="0.5s"/>
    </ellipse>` : ''}

    <!-- ═══ 数据流(在线时绿色下传光束) / Data beam (green download when online) ═══ -->
    ${online ? `<line x1="65" y1="94" x2="65" y2="140" stroke="${SEED.green}" stroke-width="0.5" opacity="0.10" stroke-dasharray="2 3">
      <animate attributeName="stroke-dashoffset" values="0;-10" dur="1s" repeatCount="indefinite"/>
    </line>` : ''}

    <!-- ═══ 地面阴影 / Ground shadow ═══ -->
    <ellipse cx="65" cy="142" rx="30" ry="4" fill="rgba(0,0,0,0.15)"/>
  </svg>`;
}

// ── 检测当前是否应显示 SEED 风格 / Detect if SEED style should be shown ──
// townStyle = minecraft 时优先 MC 风格;否则 theme = seed 时用 SEED 风格。
function isSeedTheme(): boolean {
  return document.documentElement.dataset.theme === 'seed';
}
/** 获取有效 SVG 风格 / Get effective SVG style */
function effStyle(): 'classic' | 'minecraft' | 'seed' {
  if (townStyle === 'minecraft') return 'minecraft';
  if (isSeedTheme()) return 'seed';
  return 'classic';
}

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
        <div class="house-svg">${effStyle() === 'minecraft' ? mcHouseSVG(cwd, agents, hue) : effStyle() === 'seed' ? seedHouseSVG(cwd, agents, hue) : houseSVG(cwd, agents, hue)}</div>
        <div class="house-sign">
          <span class="house-stats">${esc(stats.join(' · '))}</span>
          <span class="house-last ${running ? 'running' : ''}">${esc(when)}</span>
        </div>
        <div class="house-villagers">
          ${agents.map((c) => {
            const vs = villagerState(c);
            const label = c.customTitle || c.turns[0]?.prompt?.slice(0, 16) || '…';
            return `<div class="villager-wrap vs-${vs}" data-conv-id="${esc(c.id)}" data-engine="${c.engine}" title="${esc(label)}">
              ${effStyle() === 'minecraft' ? mcVillagerSVG(c.engine, vs) : effStyle() === 'seed' ? seedVillagerSVG(c.engine, vs) : villagerSVG(c.engine, vs)}
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
        <div class="house-svg">${effStyle() === 'minecraft' ? mcCloudHouseSVG(node.name, node.online, node.toolCount) : effStyle() === 'seed' ? seedCloudHouseSVG(node.name, node.online, node.toolCount) : cloudHouseSVG(node.name, node.online, node.toolCount)}</div>
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

  root.dataset.townStyle = townStyle;
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
    <span class="tp-villager">${effStyle() === 'minecraft' ? mcVillagerSVG(conv.engine, vs) : effStyle() === 'seed' ? seedVillagerSVG(conv.engine, vs) : villagerSVG(conv.engine, vs)}</span>
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
    svgContainer.outerHTML = effStyle() === 'minecraft' ? mcVillagerSVG(engine, vs) : effStyle() === 'seed' ? seedVillagerSVG(engine, vs) : villagerSVG(engine, vs);
  }
  // 更新所属房子的窗户和统计 / Update house windows and stats
  const house = wrap.closest('.town-house') as HTMLElement | null;
  if (house) {
    const cwd = house.dataset.cwd!;
    if (getConvs && getOrder) {
      const ids = getOrder().filter((id) => getConvs!().get(id)?.cwd === cwd);
      const agents = ids.map((id) => getConvs!().get(id)!).filter(Boolean);
      const houseSvgEl = house.querySelector('.house-svg');
      if (houseSvgEl) houseSvgEl.innerHTML = effStyle() === 'minecraft' ? mcHouseSVG(cwd, agents, hashHue(cwd)) : effStyle() === 'seed' ? seedHouseSVG(cwd, agents, hashHue(cwd)) : houseSVG(cwd, agents, hashHue(cwd));
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
