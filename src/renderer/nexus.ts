// NEXUS — 空间认知 Agent 界面 / Spatial Cognition Surface
//
// 设计理念:抛弃传统左右分栏,以"轨道"隐喻组织 Agent 会话。
// 每个 Agent 是轨道上一颗发光节点,围绕中央意图核心运转。
// 数据流以粒子形式在轨道间流动,实时呈现 Agent 的思维过程。
//
// Phase 1-5: SVG 轨道 + Canvas 粒子 + DOM overlay + 交互 + 缩放/平移
//          + 搜索 + 折叠 + 状态徽标 + 视图持久化 + Mini-map + 多选
// Phase 6: 3D 等离子球体
// Phase 7: 深空星空 + 等离子涡纹(被嫌丑,堆叠过重)
// Phase 8: 极简重置 — 纯色实心节点 + 单一光晕核心 + 精简星空(60 颗) + 冷调玻璃底
// SVG orbits + Canvas particles + DOM overlay + interactions + zoom/pan + fold + badges + minimap + multiselect. Zero dependencies.

import type { Conversation, EngineKind } from '../shared/types';
import { t } from '../shared/i18n';
import type { Lang } from '../shared/i18n';

// ── 外部依赖(由 app.ts 注入) / External deps (injected by app.ts) ──
let nexusLang: Lang = 'zh-CN';

export function setNexusLang(l: Lang): void { nexusLang = l; }

export interface NexusCallbacks {
  send: (id: string, text: string) => void;
  cancel: (id: string) => void;
  selectChat: (id: string) => void;
  exit: () => void; // 退出 NEXUS,返回聊天视图 / Exit NEXUS, return to chat view
  newTask: (cwd: string) => void;
  convs: () => Map<string, Conversation>;
  order: () => string[];
  selectedId: () => string | null;
  // Phase 5: 移动会话到不同 cwd 轨道 / Move conversation to a different cwd orbit
  changeCwd: (convId: string, newCwd: string) => void;
}

let cb: NexusCallbacks | null = null;

export function setNexusCallbacks(c: NexusCallbacks): void { cb = c; }

// ── 工具函数 / Utility ──
function tr(key: string, params?: Record<string, string | number>): string {
  return t(nexusLang, key, params);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── 轻量 Markdown 渲染 / Lightweight Markdown rendering ──
// 支持:代码块(```...```),行内代码(`code`),粗体(**text**),标题(# ),
// 无序列表(- ),链接 [text](url) — 足够 overlay 预览用。
// Supports: code blocks, inline code, bold, headings, lists, links — enough for overlay preview.
function simpleMarkdown(text: string): string {
  let html = esc(text);

  // 代码块 / Code blocks (```...```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) =>
    `<pre class="nx-md-code">${code.trim()}</pre>`
  );

  // 行内代码 / Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="nx-md-inline">$1</code>');

  // 粗体 / Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // 标题 / Headings
  html = html.replace(/^### (.+)$/gm, '<div class="nx-md-h3">$1</div>');
  html = html.replace(/^## (.+)$/gm, '<div class="nx-md-h2">$1</div>');
  html = html.replace(/^# (.+)$/gm, '<div class="nx-md-h1">$1</div>');

  // 无序列表 / Unordered list items
  html = html.replace(/^- (.+)$/gm, '<div class="nx-md-li">• $1</div>');

  // 链接 / Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // 换行 / Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

// 引擎颜色 / Engine colors (matching existing palette)
// Phase 8: 液态玻璃白雾调 — 全部冷系,告别金色。
const ENGINE_COLORS: Record<EngineKind, string> = {
  direct: '#c4a7ff',    // Kaios — 主紫光(Aurora 强调色)
  directV2: '#8ab4ff',  // Kaios v2 — 冷蓝
  directV3: '#7eeab5',  // Kaios v3 — 薄荷绿
  claudeCode: '#f0a8b8', // Claude — 雾粉(柔和,不像 #d97757 那么冲)
  codex: '#8fd4d0',     // Codex — 青雾
};

const ENGINE_LABELS: Record<EngineKind, string> = {
  direct: 'Kaios',
  directV2: 'Kaios v2',
  directV3: 'Kaios v3',
  claudeCode: 'Claude',
  codex: 'Codex',
};

// ── Agent 节点状态 / Agent node state ──
type AgentState = 'idle' | 'running' | 'error' | 'done';

function agentState(conv: Conversation): AgentState {
  if (conv.status === 'running') return 'running';
  const last = conv.turns[conv.turns.length - 1];
  if (last) {
    if (last.error) return 'error';
    if (last.done) return 'done';
  }
  return 'idle';
}

// ── 轨道布局算法 / Orbit layout algorithm ──
// 将会话按 cwd 分组,每组一条轨道,每个会话是轨道上一个节点。
// Groups conversations by cwd, each group = one orbit ring.

interface OrbitNode {
  id: string;
  conv: Conversation;
  state: AgentState;
  engine: EngineKind;
  // 极坐标位置(动画驱动) / Polar Position (animation-driven)
  angle: number;     // 当前角度(弧度) / current angle (rad)
  speed: number;     // 角速度(运行中加速) / angular velocity
  radius: number;    // 轨道半径 / orbit radius
}

interface OrbitRing {
  cwd: string;
  label: string;
  nodes: OrbitNode[];
}

let rings: OrbitRing[] = [];
let selectedNodeId: string | null = null;

// Phase 9: overlay 模式 — 'agent' 显示选中节点详情, 'dashboard' 显示全局概览
// Overlay mode — 'agent' for selected node detail, 'dashboard' for global overview
type OverlayMode = 'agent' | 'dashboard';
let overlayMode: OverlayMode = 'agent';
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let animationId = 0;
let particles: Particle[] = [];

// ── 视图变换(缩放/平移) / View transform (zoom/pan) ──
let viewScale = 1;
let viewOffsetX = 0;
let viewOffsetY = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartOffX = 0;
let dragStartOffY = 0;

// ── 搜索过滤 / Search filter ──
let searchQuery = '';
let overlayCollapsed = false;

// ── Phase 4: 轨道折叠状态 / Orbit fold state ──
let foldedCwds = new Set<string>();

// ── Phase 5: 多选状态 / Multi-select state ──
let selectedNodeIds = new Set<string>();
let isMultiSelectDrag = false; // 正在框选 / Box-select in progress
let boxSelectStartX = 0;
let boxSelectStartY = 0;

// ── Phase 5: 节点拖拽到不同轨道 / Node drag to different orbit ──
let draggingNodeId: string | null = null;
let dragHoverCwd: string | null = null; // 拖拽时悬停的目标轨道 / Hovered target orbit during drag

// ── Phase 4: 视图状态持久化 / View state persistence ──
// 用 sessionStorage 保存缩放/平移/折叠状态,刷新页面不丢。
// Persist zoom/pan/fold in sessionStorage so page refresh won't lose them.
// ── Phase 5: Mini-map 显隐 / Mini-map visibility ──
let minimapVisible = true;

const SS_KEY = 'nexus-view-state';
interface NexusViewState { scale: number; offsetX: number; offsetY: number; folded: string[]; minimap: boolean; }
function saveViewState(): void {
  try {
    const state: NexusViewState = {
      scale: viewScale, offsetX: viewOffsetX, offsetY: viewOffsetY,
      folded: Array.from(foldedCwds),
      minimap: minimapVisible,
    };
    sessionStorage.setItem(SS_KEY, JSON.stringify(state));
  } catch { /* sessionStorage 可能不可用 */
}
}
function loadViewState(): void {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw) as NexusViewState;
    viewScale = s.scale ?? 1;
    viewOffsetX = s.offsetX ?? 0;
    viewOffsetY = s.offsetY ?? 0;
    foldedCwds = new Set(s.folded || []);
    minimapVisible = s.minimap ?? true;
  } catch { /* ignore */
}
}

// ── 粒子系统 / Particle system ──
// 当 Agent 正在运行时,从核心向节点发射粒子,模拟"意图流向 Agent"。
// Emits particles from core to running agents, simulating intent flow.
// Phase 7: 带拖尾的粒子(Trail particles) — 每帧记录近期位置形成拖尾。

interface Particle {
  fromX: number; fromY: number;
  toX: number; toY: number;
  x: number; y: number;
  progress: number;  // 0 → 1
  speed: number;
  size: number;
  color: string;
  alpha: number;
  trail: { x: number; y: number }[]; // 拖尾点 / Trail points
}

function spawnParticle(fromX: number, fromY: number, toX: number, toY: number, color: string): void {
  particles.push({
    fromX, fromY, toX, toY,
    x: fromX, y: fromY,
    progress: 0,
    speed: 0.008 + Math.random() * 0.012,
    size: 2 + Math.random() * 2.5,
    color,
    alpha: 0.6 + Math.random() * 0.4,
    trail: [],
  });
}

// ── Phase 8: 星空背景层 / Starfield background ──
// 独立 Canvas 层,稀疏星点 + 微弱闪烁,只贡献空间感,不抢戏。
// Phase 7 有 180 个 + 十字光芒,视觉太吵;Phase 8 砍到 60 个、放弃十字光芒。
interface Star {
  x: number; y: number;
  size: number;
  baseAlpha: number;
  twinklePhase: number;
  twinkleSpeed: number;
}
let stars: Star[] = [];
let starCanvas: HTMLCanvasElement | null = null;
let starCtx: CanvasRenderingContext2D | null = null;

function initStarfield(root: HTMLElement): void {
  starCanvas = document.createElement('canvas');
  starCanvas.className = 'nexus-starfield';
  starCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  root.prepend(starCanvas);
  starCtx = starCanvas.getContext('2d');
  generateStars();
}

function generateStars(): void {
  if (!starCanvas) return;
  const w = starCanvas.clientWidth || 800;
  const h = starCanvas.clientHeight || 600;
  // Phase 8: 砍到 60 个,大幅放宽星等差(少数大星 + 多数小星)。
  const count = Math.min(60, Math.floor((w * h) / 14000));
  stars = [];
  for (let i = 0; i < count; i++) {
    // 二项分布抽样,让大星只占约 10%
    const tier = Math.random();
    const size = tier < 0.85
      ? 0.3 + Math.random() * 0.6         // 多数小星
      : 0.9 + Math.random() * 0.8;        // 少数稍大
    stars.push({
      x: Math.random() * w,
      y: Math.random() * h,
      size,
      baseAlpha: tier < 0.85 ? 0.10 + Math.random() * 0.25 : 0.45 + Math.random() * 0.25,
      twinklePhase: Math.random() * Math.PI * 2,
      twinkleSpeed: 0.003 + Math.random() * 0.008,
    });
  }
}

function renderStarfield(): void {
  if (!starCanvas || !starCtx) return;
  const rect = starCanvas.getBoundingClientRect();
  if (starCanvas.width !== rect.width || starCanvas.height !== rect.height) {
    starCanvas.width = rect.width;
    starCanvas.height = rect.height;
    generateStars();
  }
  starCtx.clearRect(0, 0, starCanvas.width, starCanvas.height);
  for (const s of stars) {
    s.twinklePhase += s.twinkleSpeed;
    const alpha = s.baseAlpha * (0.6 + 0.4 * Math.sin(s.twinklePhase));
    starCtx.beginPath();
    starCtx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    starCtx.fillStyle = `rgba(220,225,240,${alpha})`;
    starCtx.fill();
  }
}

function projName(cwd: string): string {
  if (!cwd) return tr('wb.ungrouped');
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return base || cwd;
}

// ── SVG DOM 脏标记 / SVG DOM dirty flag ──
// 结构变化(defs/轨道/节点数量)时设为 true,animate() 检测到后调 renderSVG() 全量重建。
// Set true when structure changes. animate() checks and calls renderSVG() for full DOM rebuild.
let svgStructureDirty = true;

// ── 构建轨道环 / Build orbit rings ──
function buildRings(): void {
  if (!cb) return;
  const convsMap = cb.convs();
  const orderList = cb.order();

  // 按 cwd 分组 / Group by cwd
  const groups = new Map<string, Conversation[]>();
  for (const id of orderList) {
    const c = convsMap.get(id);
    if (!c) continue;
    // Phase 3: 搜索过滤 / Search filter
    if (searchQuery) {
      const title = (c.customTitle || c.turns[0]?.prompt || c.id).toLowerCase();
      const engine = (c.engine || '').toLowerCase();
      if (!title.includes(searchQuery) && !engine.includes(searchQuery)) continue;
    }
    const cwd = c.cwd || '';
    if (!groups.has(cwd)) groups.set(cwd, []);
    groups.get(cwd)!.push(c);
  }

  rings = [];
  for (const [cwd, convs] of groups) {
    const nodes: OrbitNode[] = convs.map((conv, i) => {
      const nodeCount = convs.length;
      const baseAngle = (i / nodeCount) * Math.PI * 2;
      const state = agentState(conv);
      return {
        id: conv.id,
        conv,
        state,
        engine: conv.engine,
        angle: baseAngle,
        speed: state === 'running' ? 0.003 + Math.random() * 0.002 : 0.0008 + Math.random() * 0.0004,
        radius: 0, // 由布局分配 / set by layout
      };
    });
    rings.push({ cwd, label: projName(cwd), nodes });
  }

  // 自适应轨道间距 / Adaptive ring spacing
  // 会话/项目多时自动压缩间距,避免视图爆炸 / Compress spacing when many rings
  const ringCount = rings.length;
  const maxRings = 8;
  const compression = ringCount > maxRings ? maxRings / ringCount : 1;
  const ringRadius = Math.max(70, 130 * compression); // 每环间距 / ring spacing
  const baseRadius = Math.max(65, 105 * compression);  // 最内圈半径 / innermost radius
  rings.forEach((ring, i) => {
    // Phase 4: 折叠的轨道不参与布局间距计算(占位极小) / Folded rings get minimal space
    if (foldedCwds.has(ring.cwd)) {
      ring.nodes.forEach(n => { n.radius = baseRadius + i * ringRadius; });
    } else {
      const r = baseRadius + i * ringRadius;
      ring.nodes.forEach(n => { n.radius = r; });
    }
  });

  // 标记 SVG 结构变脏,下一帧 animate() 会调 renderSVG() 全量重建。
  // Mark SVG structure dirty — next animate() frame will full-rebuild via renderSVG().
  svgStructureDirty = true;
}

// ── Phase 4: 性能降级判断 / Performance tier ──
// 节点总数超过阈值时降级粒子频率和 SVG 重绘频率。
// Degrade particle frequency and SVG repaint when node count exceeds threshold.
function totalNodeCount(): number {
  return rings.reduce((sum, r) => sum + r.nodes.length, 0);
}
function isHeavyLoad(): boolean {
  return totalNodeCount() > 40;
}

// ── 全量渲染 / Full render ──
export function renderNexus(): void {
  const root = document.getElementById('nexus-canvas');
  if (!root) return;

  buildRings();

  // 选中当前会话 / Select current conversation
  if (cb) selectedNodeId = cb.selectedId();
  // Phase 9: 有选中 → agent,无选中 → dashboard 模式 / Has selection → agent, no selection → dashboard
  overlayMode = selectedNodeId ? 'agent' : 'dashboard';

  root.innerHTML = `
    <div class="nexus-stage" id="nexus-stage">
      <canvas class="nexus-particles" id="nexus-particle-canvas"></canvas>
      <div class="nexus-svg-wrap" id="nexus-svg-wrap"></div>
      <div class="nexus-search" id="nexus-search">
        <svg class="nexus-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input class="nexus-search-input" id="nexus-search-input" type="text"
          data-i18n-placeholder="nexus.searchPlaceholder"
          placeholder="${esc(tr('nexus.searchPlaceholder'))}" />
      </div>
      <div class="nexus-overlay" id="nexus-overlay"></div>
      <div class="nexus-arc-input" id="nexus-arc-input">
        <div class="nexus-arc-bg"></div>
        <textarea class="nexus-arc-text" id="nexus-arc-text" rows="1"
          data-i18n-placeholder="nexus.inputPlaceholder"
          placeholder="${esc(tr('nexus.inputPlaceholder'))}"></textarea>
        <button class="nexus-arc-send" id="nexus-arc-send" title="${esc(tr('nexus.send'))}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
      <button class="nexus-back" id="nexus-back" title="${esc(tr('nexus.backToChat'))}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      </button>
      <button class="nexus-reset" id="nexus-reset" title="${esc(tr('nexus.resetView'))}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
      </button>
      <button class="nexus-collapse" id="nexus-collapse" title="${esc(tr('nexus.toggleOverlay'))}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      </button>
      <button class="nexus-minimap-toggle" id="nexus-minimap-toggle" title="${esc(tr('nexus.toggleMinimap'))}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z" opacity="0.4"/></svg>
      </button>
      <div class="nexus-hint" id="nexus-hint">${esc(tr('nexus.hint'))}</div>
      <div class="nexus-tooltip" id="nexus-tooltip" hidden></div>
      <div class="nexus-ctx-menu" id="nexus-ctx-menu" hidden></div>
      <!-- Phase 5: Mini-map 缩略图导航 / Mini-map navigator -->
      <div class="nexus-minimap" id="nexus-minimap" ${minimapVisible ? '' : 'style="display:none"'}>
        <div class="nexus-minimap-title">${esc(tr('nexus.minimap'))}</div>
        <div class="nexus-minimap-canvas" id="nexus-minimap-canvas"></div>
      </div>
      <!-- Phase 5: 多选工具栏 / Multi-select toolbar -->
      <div class="nexus-multi-toolbar" id="nexus-multi-toolbar" hidden>
        <span class="nx-multi-count" id="nx-multi-count"></span>
        <button class="nx-multi-btn" data-maction="openAll">${esc(tr('nexus.multiOpen'))}</button>
        <button class="nx-multi-btn nx-multi-danger" data-maction="cancelAll">${esc(tr('nexus.multiCancel'))}</button>
        <button class="nx-multi-btn" data-maction="clear">${esc(tr('nexus.multiClear'))}</button>
      </div>
    </div>
  `;

  // 初始化 Canvas / Init canvas
  canvas = document.getElementById('nexus-particle-canvas') as HTMLCanvasElement;
  ctx = canvas?.getContext('2d') || null;

  // Phase 4: 恢复视图状态 / Restore view state
  loadViewState();
  applyViewTransform();

  // 绑定事件 / Bind events
  const arcText = document.getElementById('nexus-arc-text') as HTMLTextAreaElement | null;
  const arcSend = document.getElementById('nexus-arc-send');
  const backBtn = document.getElementById('nexus-back');

  if (arcText) {
    arcText.addEventListener('input', () => {
      arcText.style.height = 'auto';
      arcText.style.height = Math.min(arcText.scrollHeight, 120) + 'px';
    });
    arcText.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendArcMessage();
      }
    });
  }

  if (arcSend) arcSend.onclick = sendArcMessage;
  if (backBtn) backBtn.onclick = () => { if (cb) cb.exit(); };

  // Phase 2: 重置视图按钮 / Reset view button
  const resetBtn = document.getElementById('nexus-reset');
  if (resetBtn) resetBtn.onclick = () => {
    viewScale = 1; viewOffsetX = 0; viewOffsetY = 0;
    foldedCwds.clear();
    selectedNodeIds.clear();
    updateMultiToolbar();
    saveViewState();
    applyViewTransform();
    buildRings();
    updateMinimap();
  };

  // Phase 3: 搜索栏 / Search bar
  const searchInput = document.getElementById('nexus-search-input') as HTMLInputElement | null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.toLowerCase().trim();
      buildRings();
    });
  }

  // Phase 3: 折叠 overlay / Collapse overlay
  const collapseBtn = document.getElementById('nexus-collapse');
  if (collapseBtn) collapseBtn.onclick = () => {
    overlayCollapsed = !overlayCollapsed;
    const overlay = document.getElementById('nexus-overlay');
    if (overlay) overlay.style.display = overlayCollapsed ? 'none' : '';
    collapseBtn.style.color = overlayCollapsed ? 'var(--accent)' : '';
  };

  // Phase 5: Mini-map 显隐切换 / Mini-map visibility toggle
  const minimapToggle = document.getElementById('nexus-minimap-toggle');
  if (minimapToggle) minimapToggle.onclick = () => {
    minimapVisible = !minimapVisible;
    const mm = document.getElementById('nexus-minimap');
    if (mm) mm.style.display = minimapVisible ? '' : 'none';
    minimapToggle.style.color = minimapVisible ? '' : 'var(--text-faint)';
    saveViewState();
    if (minimapVisible) updateMinimap();
  };

  // Phase 3: 键盘快捷键 / Keyboard shortcuts
  const stageEl = document.getElementById('nexus-stage');
  if (stageEl) {
    stageEl.tabIndex = 0; // 使其可聚焦以接收键盘事件
    stageEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Escape:退出 NEXUS 返回聊天 / Exit NEXUS back to chat
        if (cb) cb.exit();
        return;
      }
      // Tab / Shift+Tab 切换节点 / Cycle nodes
      if (e.key === 'Tab' && cb) {
        e.preventDefault();
        const allNodes = rings.flatMap(r => r.nodes);
        if (allNodes.length === 0) return;
        const currentIdx = allNodes.findIndex(n => n.id === selectedNodeId);
        let nextIdx: number;
        if (e.shiftKey) {
          nextIdx = currentIdx <= 0 ? allNodes.length - 1 : currentIdx - 1;
        } else {
          nextIdx = currentIdx >= allNodes.length - 1 ? 0 : currentIdx + 1;
        }
        const next = allNodes[nextIdx];
        selectedNodeId = next.id;
        cb.selectChat(next.id);
        updateOverlay();
      }
    });
  }

  // 全局关闭右键菜单 / Global click closes context menu
  document.getElementById('nexus-stage')?.addEventListener('click', () => {
    const menu = document.getElementById('nexus-ctx-menu');
    if (menu) menu.hidden = true;
  });

  // ── Phase 2: 滚轮缩放 + 拖拽平移 / Wheel zoom + drag pan ──
  const stage = document.querySelector('.nexus-stage') as HTMLElement | null;
  const svgWrap = document.getElementById('nexus-svg-wrap');

  if (stage && svgWrap) {
    // 滚轮缩放 / Wheel zoom
    stage.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      viewScale = Math.max(0.3, Math.min(3, viewScale * delta));
      applyViewTransform();
      saveViewState();
    }, { passive: false });

    // 拖拽平移 / Drag pan (在 SVG 层上)
    svgWrap.addEventListener('mousedown', (e: MouseEvent) => {
      // 只在点击空白处(非节点)时启动拖拽 / Only start drag on empty space
      const target = e.target as SVGElement;
      if (target.hasAttribute('data-nid')) return;
      if (target.hasAttribute('data-fold')) return; // Phase 4: 轨道标签不触发拖拽
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartOffX = viewOffsetX;
      dragStartOffY = viewOffsetY;
      svgWrap.style.cursor = 'grabbing';
      // Phase 4: 拖拽时隐藏 tooltip 防闪烁 / Hide tooltip during drag
      hideNodeTooltip();
    });

    svgWrap.addEventListener('mousemove', (e: MouseEvent) => {
      if (!isDragging) return;
      viewOffsetX = dragStartOffX + (e.clientX - dragStartX);
      viewOffsetY = dragStartOffY + (e.clientY - dragStartY);
      applyViewTransform();
    });

    const endDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      if (svgWrap) svgWrap.style.cursor = 'default';
      // Phase 4: 拖拽结束后保存视图状态 / Save view state after drag
      saveViewState();
    };
    svgWrap.addEventListener('mouseup', endDrag);
    svgWrap.addEventListener('mouseleave', endDrag);

    // 双击空白重置视图 / Double-click empty space resets view
    svgWrap.addEventListener('dblclick', (e: MouseEvent) => {
      const target = e.target as SVGElement;
      if (target.hasAttribute('data-nid')) return;
      if (target.hasAttribute('data-fold')) return;
      viewScale = 1;
      viewOffsetX = 0;
      viewOffsetY = 0;
      applyViewTransform();
      saveViewState();
    });

    // ── Phase 5: 节点拖拽到不同轨道 / Node drag to different orbit ──
    // 在 SVG 节点 mousedown 时开始拖拽(如果拖到轨道标签上则移动 cwd)
    svgWrap.addEventListener('mousedown', (e: MouseEvent) => {
      const target = e.target as SVGElement;
      const nid = target.getAttribute('data-nid');
      if (!nid) return;
      // Shift / Cmd+click 进入多选模式 / Shift/Cmd+click for multi-select
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        e.preventDefault();
        if (selectedNodeIds.has(nid)) {
          selectedNodeIds.delete(nid);
        } else {
          selectedNodeIds.add(nid);
        }
        updateMultiToolbar();
        return;
      }
      // 单选时清除多选 / Clear multi-select on single pick
      selectedNodeIds.clear();
      updateMultiToolbar();
      // 开始潜在拖拽 / Start potential drag
      draggingNodeId = nid;
      dragHoverCwd = null;
    });

    // 全局 mouseup 处理拖拽放置 / Global mouseup for drag drop
    const handleNodeDrop = (e: MouseEvent) => {
      if (!draggingNodeId) return;
      // 检查是否落在轨道标签上 / Check if dropped on an orbit label
      const el = document.elementFromPoint(e.clientX, e.clientY) as SVGElement | null;
      const targetCwd = el?.getAttribute('data-fold') || el?.getAttribute('data-orbit-cwd');
      if (targetCwd && cb) {
        // 移动会话到新 cwd 轨道 / Move conversation to new cwd orbit
        const node = rings.flatMap(r => r.nodes).find(n => n.id === draggingNodeId);
        if (node && node.conv.cwd !== targetCwd) {
          cb.changeCwd(draggingNodeId, targetCwd);
          // rebuild rings after cwd change
          buildRings();
          updateOverlay();
          updateMinimap();
        }
      }
      // 清理拖拽状态 / Clean up drag state
      if (dragHoverCwd) {
        const hoverLabel = svgWrap.querySelector(`[data-orbit-cwd="${CSS.escape(dragHoverCwd)}"]`);
        if (hoverLabel) hoverLabel.classList.remove('nx-drag-target');
        dragHoverCwd = null;
      }
      draggingNodeId = null;
    };
    document.addEventListener('mouseup', handleNodeDrop, { once: true });

    // 拖拽时高亮目标轨道 / Highlight target orbit during drag
    svgWrap.addEventListener('mousemove', (e: MouseEvent) => {
      if (!draggingNodeId) return;
      const el = e.target as SVGElement;
      const cwd = el.getAttribute('data-fold') || el.getAttribute('data-orbit-cwd');
      if (cwd && cwd !== dragHoverCwd) {
        // 移除旧高亮 / Remove old highlight
        if (dragHoverCwd) {
          const old = svgWrap.querySelector(`[data-orbit-cwd="${CSS.escape(dragHoverCwd)}"]`);
          if (old) old.classList.remove('nx-drag-target');
        }
        dragHoverCwd = cwd;
        const newEl = svgWrap.querySelector(`[data-orbit-cwd="${CSS.escape(cwd)}"]`);
        if (newEl) newEl.classList.add('nx-drag-target');
      }
    });
  }

  // ── Phase 5: Mini-map 事件 / Mini-map events ──
  const minimapEl = document.getElementById('nexus-minimap');
  const minimapCanvas = document.getElementById('nexus-minimap-canvas');
  if (minimapCanvas) {
    let minimapDragging = false;
    minimapCanvas.addEventListener('mousedown', (e: MouseEvent) => {
      minimapDragging = true;
      handleMinimapClick(e);
    });
    minimapCanvas.addEventListener('mousemove', (e: MouseEvent) => {
      if (minimapDragging) handleMinimapClick(e);
    });
    document.addEventListener('mouseup', () => { minimapDragging = false; }, { once: true });
  }

  // Phase 5: 多选工具栏按钮 / Multi-select toolbar buttons
  const multiToolbar = document.getElementById('nexus-multi-toolbar');
  if (multiToolbar) {
    multiToolbar.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('[data-maction]') as HTMLElement | null;
      if (!btn || !cb) return;
      const action = btn.dataset.maction;
      switch (action) {
        case 'openAll':
          // 多选时打开第一个 / Open first selected when multiple
          if (selectedNodeIds.size > 0) {
            const first = Array.from(selectedNodeIds)[0];
            selectedNodeId = first;
            cb.selectChat(first);
            updateOverlay();
          }
          break;
        case 'cancelAll':
          selectedNodeIds.forEach(id => cb!.cancel(id));
          break;
        case 'clear':
          selectedNodeIds.clear();
          updateMultiToolbar();
          break;
      }
    });
  }

  // 开始动画 / Start animation
  initStarfield(document.getElementById('nexus-stage') || root);
  startAnimation();
  updateOverlay();
  updateMinimap();
}

// ── 发送弧形输入消息 / Send arc input message ──
function sendArcMessage(): void {
  if (!cb) return;
  const arcText = document.getElementById('nexus-arc-text') as HTMLTextAreaElement | null;
  if (!arcText) return;
  const text = arcText.value.trim();
  if (!text) return;

  // 快捷指令 / Slash commands
  if (text.startsWith('/')) {
    const cmd = text.toLowerCase();
    if (cmd === '/new' || cmd === '/n') {
      cb.newTask('');
      arcText.value = '';
      arcText.style.height = 'auto';
      return;
    }
    // /cancel → 取消当前选中会话 / Cancel selected conversation
    if (cmd === '/cancel' && selectedNodeId) {
      cb.cancel(selectedNodeId);
      arcText.value = '';
      arcText.style.height = 'auto';
      return;
    }
    // 未知指令不发送 / Unknown command, no-op
    arcText.value = '';
    arcText.style.height = 'auto';
    return;
  }

  if (selectedNodeId) {
    cb.send(selectedNodeId, text);
  } else {
    // 无选中节点 → 发到第一个并选中它 / No selected node → send to first and select it
    const firstOrder = cb.order()[0];
    if (firstOrder) {
      selectedNodeId = firstOrder;
      cb.selectChat(firstOrder);
      cb.send(firstOrder, text);
    }
  }
  arcText.value = '';
  arcText.style.height = 'auto';
}

// ── 动画循环 / Animation loop ──
let svgFrameSkip = 0;

function startAnimation(): void {
  cancelAnimationFrame(animationId);
  const loop = () => {
    animate();
    animationId = requestAnimationFrame(loop);
  };
  loop();
}

export function stopNexusAnimation(): void {
  cancelAnimationFrame(animationId);
}

function animate(): void {
  // 更新节点角度 / Update node angles
  for (const ring of rings) {
    for (const node of ring.nodes) {
      node.angle += node.speed;
      // 运行状态的节点加速 / Running nodes spin faster
      if (node.state === 'running') {
        node.speed = Math.min(node.speed + 0.00005, 0.008);
      } else {
        // 回归常速 / Drift back to normal speed
        const target = 0.0008;
        node.speed = node.speed * 0.99 + target * 0.01;
      }
    }
  }

  // 渲染 SVG / Render SVG
  // 不再每帧 innerHTML 重建 — 只在结构变脏时全量重建,否则只更新动态属性。
  // No more innerHTML rebuild every frame — full rebuild only when dirty, else update attributes only.
  svgFrameSkip++;

  // Phase 7: 星空背景(低频更新,每 2 帧) / Starfield (every 2 frames)
  if (svgFrameSkip % 2 === 0) renderStarfield();

  if (svgStructureDirty) {
    renderSVG();          // 全量重建 DOM + 绑定事件 / Full DOM rebuild + bind events
    svgStructureDirty = false;
  } else {
    updateSVGDynamic();   // 只更新节点坐标/连线/核心呼吸 / Update positions only
  }

  // 更新 Canvas 粒子 / Update canvas particles
  updateParticles();

  // 定期发射粒子到运行中的节点 / Periodically emit particles to running nodes
  // Phase 4: 性能降级 — 大量节点时降低发射频率 / Degrade frequency under heavy load
  const emitChance = isHeavyLoad() ? 0.05 : 0.15;
  if (Math.random() < emitChance) emitParticlesToRunning();

  // Phase 5: 定期更新 Mini-map(降频) / Update minimap at lower frequency
  if (svgFrameSkip % 6 === 0) updateMinimap();
}

// ── SVG 尺寸缓存 / Cached SVG dimensions ──
let svgSize = 400;
let svgCx = 200;
let svgCy = 200;

// ── 应用视图变换 / Apply view transform ──
function applyViewTransform(): void {
  const svg = document.querySelector('.nexus-svg-wrap svg') as SVGSVGElement | null;
  if (svg) {
    svg.style.transformOrigin = 'center';
    svg.style.transform = `translate(calc(-50% + ${viewOffsetX}px), calc(-50% + ${viewOffsetY}px)) scale(${viewScale})`;
  }
}

// ── 渲染 SVG 轨道 / Render SVG orbits ──
function renderSVG(): void {
  const wrap = document.getElementById('nexus-svg-wrap');
  if (!wrap) return;

  // 空状态处理 / Empty state
  if (rings.length === 0) {
    wrap.innerHTML = `
      <div class="nexus-empty-state">
        <div class="nexus-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <ellipse cx="12" cy="12" rx="10" ry="4"/>
            <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/>
            <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/>
          </svg>
        </div>
        <div class="nexus-empty-text">${esc(tr('nexus.emptyHint'))}</div>
        <button class="nexus-empty-btn" id="nexus-empty-new">${esc(tr('nexus.createNew'))}</button>
      </div>`;
    const newBtn = document.getElementById('nexus-empty-new');
    if (newBtn) newBtn.onclick = () => { cb?.newTask(''); };
    svgSize = 400; svgCx = 200; svgCy = 200;
    return;
  }

  // 计算布局尺寸 / Calculate layout dimensions
  const maxRadius = Math.max(...rings.map(r => r.nodes[0]?.radius || 0)) + 60;
  const size = Math.max(maxRadius * 2, 400);
  svgSize = size;
  svgCx = size / 2;
  svgCy = size / 2;
  const cx = svgCx;
  const cy = svgCy;

  let svg = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="position:absolute;top:50%;left:50%;transform:translate(calc(-50% + ${viewOffsetX}px), calc(-50% + ${viewOffsetY}px)) scale(${viewScale});transform-origin:center;">`;

  // ── 渐变定义 / Gradient defs ──
  // Phase 8: 极简重置 — 一层光晕 + 一个球。Less is more.
  // 经验法则:不要在 30px 的圆里堆 7 层滤镜,只让它自己呼吸。
  svg += `<defs>`;
  // 核心光晕(单层,冷白) / Core halo (single layer, cool white)
  svg += `<radialGradient id="nx-core-glow" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="rgba(232,238,248,0.28)"/>
    <stop offset="40%" stop-color="rgba(180,200,240,0.10)"/>
    <stop offset="100%" stop-color="rgba(180,200,240,0)"/>
  </radialGradient>`;
  // 核心球体(从玻璃白到月灰) / Core body (glass-white to moon-grey)
  svg += `<radialGradient id="nx-core-body" cx="38%" cy="32%" r="68%">
    <stop offset="0%" stop-color="#f4f6fa"/>
    <stop offset="55%" stop-color="#a8b0c2"/>
    <stop offset="100%" stop-color="#4a5060"/>
  </radialGradient>`;
  // 节点光晕(按引擎色,单层弥散) / Node halo (per engine, single-layer diffuse)
  for (const [engine, color] of Object.entries(ENGINE_COLORS)) {
    const gid = `nx-halo-${engine}`;
    svg += `<radialGradient id="${gid}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.20"/>
      <stop offset="60%" stop-color="${color}" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </radialGradient>`;
  }

  // 单一模糊滤镜(光晕用) / Single blur filter
  svg += `<filter id="nx-glow-blur" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="3"/>
  </filter>`;

  svg += `</defs>`;

  // ── 轨道环 / Orbit rings ──
  // Phase 8: 一条描边,没了。
  for (const ring of rings) {
    const r = ring.nodes[0]?.radius || 100;
    const isFolded = foldedCwds.has(ring.cwd);
    if (!isFolded) {
      // Phase 8: 单色 0.8 透明描边,一条够了。
      svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(180,190,210,0.08)" stroke-width="0.8"/>`;
    } else {
      svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(180,190,210,0.06)" stroke-width="0.8" stroke-dasharray="1 6"/>`;
    }
    // 轨道标签(可点击折叠/展开) / Orbit label (clickable to fold/unfold)
    const labelX = cx + r * Math.cos(-Math.PI / 2);
    const labelY = cy + r * Math.sin(-Math.PI / 2) - 8;
    const foldIcon = isFolded ? '+' : '−';
    svg += `<text x="${labelX}" y="${labelY}" fill="rgba(170,178,195,${isFolded ? '0.30' : '0.50'})" font-size="10" text-anchor="middle" font-family="system-ui" letter-spacing="1" style="cursor:pointer" data-orbit-cwd="${esc(ring.cwd)}" data-fold="${esc(ring.cwd)}">${foldIcon} ${esc(ring.label)}</text>`;
  }

  // ── 核心意图球 / Central intent core ──
  // Phase 8: 一层光晕 + 一个球 + 一个高光点。没有射线,没有涡纹。
  const corePulse = 1 + Math.sin(Date.now() / 1500) * 0.04;
  const coreR = 30 * corePulse;
  // 远场光晕(单层,呼吸缩放) / Halo (single layer, breathing)
  svg += `<circle id="nx-core-halo" cx="${cx}" cy="${cy}" r="${coreR * 3.5}" fill="url(#nx-core-glow)"/>`;
  // 核心球体 / Core body
  svg += `<circle id="nx-core-body" cx="${cx}" cy="${cy}" r="${coreR}" fill="url(#nx-core-body)" data-core="true" style="cursor:pointer"/>`;
  // 核心标签 / Core label
  svg += `<text x="${cx}" y="${cy + coreR + 22}" fill="rgba(170,178,195,0.45)" font-size="9" text-anchor="middle" font-family="system-ui" letter-spacing="3" font-weight="500" data-core="true" style="cursor:pointer;pointer-events:none">INTENT</text>`;

  // ── Phase 2: 数据流连线(运行中节点 → 核心) / Data flow lines (running → core) ──
  // Phase 8: 一条流动虚线,够了。
  // 容器 <g> 便于动态更新 / Container <g> for dynamic updates
  svg += `<g id="nx-flow-lines">`;
  for (const ring of rings) {
    if (foldedCwds.has(ring.cwd)) continue; // Phase 4: 跳过折叠轨道
    for (const node of ring.nodes) {
      if (node.state !== 'running') continue;
      const nx = cx + node.radius * Math.cos(node.angle);
      const ny = cy + node.radius * Math.sin(node.angle);
      const color = ENGINE_COLORS[node.engine] || '#a8b0c2';
      svg += `<line data-flow="${node.id}" x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${color}" stroke-width="0.8" opacity="0.45" stroke-dasharray="3 5">
        <animate attributeName="stroke-dashoffset" from="0" to="-16" dur="1.2s" repeatCount="indefinite"/>
      </line>`;
    }
  }
  svg += `</g>`;

  // ── Phase 2: 选中节点 ↔ 核心高亮连线 / Selected ↔ core highlight line ──
  // 空容器,由 updateSVGDynamic() 动态填充 / Empty container, filled by updateSVGDynamic()
  svg += `<g id="nx-sel-line"></g>`;

  // ── Agent 节点 / Agent nodes ──
  // Phase 8: 纯色实心圆 + 单层光晕 + 1px 高光环。
  // Phase 9: 节点大小随 turn 数微调 + 选中时显示引擎标签(已有)。
  // Node size scales subtly with turn count; status via color + border + badge.
  for (const ring of rings) {
    if (foldedCwds.has(ring.cwd)) continue;
    for (const node of ring.nodes) {
      const x = cx + node.radius * Math.cos(node.angle);
      const y = cy + node.radius * Math.sin(node.angle);
      const isSelected = node.id === selectedNodeId;
      const color = ENGINE_COLORS[node.engine] || '#a8b0c2';
      // Phase 9: 节点大小 = 基础 7 + turn 数权重(上限 +4),选中 +2
      // Node radius = base 7 + turn-count weight (max +4), selected +2
      const turnBoost = Math.min(Math.floor(node.conv.turns.length / 5), 4);
      const nodeR = (isSelected ? 9 : 7) + turnBoost;
      const haloId = `nx-halo-${node.engine}`;
      const isRunning = node.state === 'running';

      // 用 <g> 容器包裹节点所有子元素,每帧只更新 transform 即可移动整个组。
      // Wrap all node children in <g>, update transform per frame to move the whole group.
      svg += `<g data-node-group="${node.id}" transform="translate(${x},${y})">`;

      // 单层光晕 / Single-layer halo
      const haloOpacity = isSelected ? 0.9 : (isRunning ? 0.75 : 0.4);
      svg += `<circle cx="0" cy="0" r="${nodeR + 10}" fill="url(#${haloId})" opacity="${haloOpacity}" style="pointer-events:none"/>`;

      // 运行中:外圈脉冲(单一线条) / Running: outer pulse ring
      if (isRunning) {
        svg += `<circle cx="0" cy="0" r="${nodeR + 2}" fill="none" stroke="${color}" stroke-width="1" opacity="0.6">
          <animate attributeName="r" values="${nodeR + 2};${nodeR + 10};${nodeR + 2}" dur="2s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.6;0;0.6" dur="2s" repeatCount="indefinite"/>
        </circle>`;
      }

      // 节点主体:实心圆 + 1px 高光环 / Node body: solid circle + 1px rim
      const fillOpacity = node.state === 'idle' ? 0.85 : 1;
      svg += `<circle cx="0" cy="0" r="${nodeR}" fill="${color}" fill-opacity="${fillOpacity}" stroke="rgba(255,255,255,0.4)" stroke-width="0.8" style="cursor:pointer" data-nid="${node.id}"/>`;

      // 选中:加一圈细描边 / Selected: extra thin outline
      if (isSelected) {
        svg += `<circle cx="0" cy="0" r="${nodeR + 3}" fill="none" stroke="${color}" stroke-width="1" opacity="0.7"/>`;
      }

      // Phase 9: 微标签 — turn 数 > 0 时显示简短标题 / Mini-label: short title when turns > 0
      if (!isSelected && node.conv.turns.length > 0 && nodeR >= 8) {
        const rawTitle = node.conv.customTitle || node.conv.turns[0]?.prompt || '';
        const shortTitle = rawTitle.slice(0, 12).trim();
        if (shortTitle) {
          svg += `<text x="0" y="${nodeR + 11}" fill="rgba(170,178,195,0.38)" font-size="7.5" text-anchor="middle" font-family="system-ui" style="pointer-events:none">${esc(shortTitle)}</text>`;
        }
      }

      // 引擎标签(仅选中) / Engine label (selected only)
      if (isSelected) {
        const labelText = ENGINE_LABELS[node.engine] || node.engine;
        const labelW = labelText.length * 5.5 + 12;
        svg += `<rect x="${-labelW / 2}" y="${-nodeR - 18}" width="${labelW}" height="14" rx="7" fill="rgba(20,22,28,0.75)" stroke="${color}" stroke-width="0.5" stroke-opacity="0.5" style="pointer-events:none"/>`;
        svg += `<text x="0" y="${-nodeR - 8}" fill="${color}" font-size="9" text-anchor="middle" font-family="system-ui" style="pointer-events:none">${esc(labelText)}</text>`;
      }

      // 状态徽标(右上角小圆点) / Status badge (small dot, top-right)
      if (node.state === 'error') {
        svg += `<circle cx="${nodeR - 1}" cy="${-nodeR + 1}" r="3.5" fill="#e2614c" stroke="#18181c" stroke-width="1" data-nid="${node.id}" style="pointer-events:none"/>`;
      } else if (node.state === 'done') {
        svg += `<circle cx="${nodeR - 1}" cy="${-nodeR + 1}" r="3.5" fill="#4ec27a" stroke="#18181c" stroke-width="1" data-nid="${node.id}" style="pointer-events:none"/>`;
      }

      svg += `</g>`;
    }
  }

  svg += `</svg>`;
  wrap.innerHTML = svg;

  // 绑定节点交互 / Bind node interactions
  wrap.querySelectorAll<SVGCircleElement>('[data-nid]').forEach(el => {
    // 单击:选中节点 / Click: select node
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const nid = el.dataset.nid!;
      selectedNodeId = nid;
      overlayMode = 'agent'; // Phase 9: 节点点击 → agent 模式
      if (cb) cb.selectChat(nid);
      updateOverlay();
    });
    // 双击:跳转到 chat 视图 / Dblclick: jump to chat view
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const nid = el.dataset.nid!;
      if (cb) cb.selectChat(nid);
    });
    // hover:显示 tooltip / Hover: show tooltip
    el.addEventListener('mouseenter', (e) => {
      if (isDragging) return; // Phase 4: 拖拽时禁用 tooltip / Skip tooltip during drag
      const nid = el.dataset.nid!;
      showNodeTooltip(nid, e as MouseEvent);
    });
    el.addEventListener('mouseleave', () => {
      hideNodeTooltip();
    });
    // 右键:上下文菜单 / Context menu
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const nid = el.dataset.nid!;
      showContextMenu(nid, e as MouseEvent);
    });
  });

  // Phase 9: 核心球点击 → dashboard 模式 / Core click → dashboard mode
  wrap.querySelectorAll<SVGCircleElement>('[data-core="true"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      overlayMode = 'dashboard';
      selectedNodeId = null;
      updateOverlay();
    });
  });

  // Phase 4: 绑定轨道标签折叠 / Bind orbit label fold toggle
  wrap.querySelectorAll<SVGTextElement>('[data-fold]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const cwd = el.dataset.fold!;
      if (foldedCwds.has(cwd)) foldedCwds.delete(cwd);
      else foldedCwds.add(cwd);
      saveViewState();
      buildRings();
    });
    el.addEventListener('mouseenter', () => {
      el.style.fill = 'rgba(200,210,230,0.85)';
    });
    el.addEventListener('mouseleave', () => {
      el.style.fill = foldedCwds.has(el.dataset.fold!) ? 'rgba(150,160,180,0.30)' : 'rgba(170,178,195,0.50)';
    });
  });
}

// ── 动态更新(每帧调用,不重建 DOM)/ Dynamic update (per-frame, no DOM rebuild) ──
// 只更新 transform / cx / cy 等属性,保留事件绑定。
// Updates only coordinates — event listeners remain intact.
function updateSVGDynamic(): void {
  const wrap = document.getElementById('nexus-svg-wrap');
  if (!wrap) return;

  const cx = svgCx;
  const cy = svgCy;

  // 核心球呼吸 / Core breathing
  const corePulse = 1 + Math.sin(Date.now() / 1500) * 0.04;
  const coreR = 30 * corePulse;
  const halo = document.getElementById('nx-core-halo');
  const body = document.getElementById('nx-core-body');
  if (halo) halo.setAttribute('r', String(coreR * 3.5));
  if (body) body.setAttribute('r', String(coreR));

  // 节点位置更新(通过 <g> 的 transform)/ Update node positions via <g> transform
  const flowLines: SVGGElement | null = wrap.querySelector('#nx-flow-lines');
  const selLine: SVGGElement | null = wrap.querySelector('#nx-sel-line');

  for (const ring of rings) {
    if (foldedCwds.has(ring.cwd)) continue;
    for (const node of ring.nodes) {
      const x = cx + node.radius * Math.cos(node.angle);
      const y = cy + node.radius * Math.sin(node.angle);
      const g = wrap.querySelector<SVGGElement>(`[data-node-group="${CSS.escape(node.id)}"]`);
      if (g) g.setAttribute('transform', `translate(${x},${y})`);

      // 更新数据流连线(运行中节点)/ Update flow lines (running nodes)
      if (node.state === 'running' && flowLines) {
        let line = flowLines.querySelector(`[data-flow="${CSS.escape(node.id)}"]`);
        if (!line) {
          const color = ENGINE_COLORS[node.engine] || '#a8b0c2';
          line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('data-flow', node.id);
          line.setAttribute('stroke', color);
          line.setAttribute('stroke-width', '0.8');
          line.setAttribute('opacity', '0.45');
          line.setAttribute('stroke-dasharray', '3 5');
          const anim = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
          anim.setAttribute('attributeName', 'stroke-dashoffset');
          anim.setAttribute('from', '0');
          anim.setAttribute('to', '-16');
          anim.setAttribute('dur', '1.2s');
          anim.setAttribute('repeatCount', 'indefinite');
          line.appendChild(anim);
          flowLines.appendChild(line);
        }
        line.setAttribute('x1', String(cx));
        line.setAttribute('y1', String(cy));
        line.setAttribute('x2', String(x));
        line.setAttribute('y2', String(y));
      }
    }
  }

  // 清除非运行节点的旧连线 / Remove stale flow lines
  if (flowLines) {
    flowLines.querySelectorAll('line[data-flow]').forEach(line => {
      const fid = line.getAttribute('data-flow')!;
      const node = rings.flatMap(r => r.nodes).find(n => n.id === fid);
      if (!node || node.state !== 'running') line.remove();
    });
  }

  // 选中节点高亮连线 / Selected node highlight line
  if (selLine) {
    selLine.innerHTML = '';
    if (selectedNodeId) {
      for (const ring of rings) {
        if (foldedCwds.has(ring.cwd)) continue;
        const node = ring.nodes.find(n => n.id === selectedNodeId);
        if (node) {
          const nx = cx + node.radius * Math.cos(node.angle);
          const ny = cy + node.radius * Math.sin(node.angle);
          const color = ENGINE_COLORS[node.engine] || '#a8b0c2';
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', String(cx));
          line.setAttribute('y1', String(cy));
          line.setAttribute('x2', String(nx));
          line.setAttribute('y2', String(ny));
          line.setAttribute('stroke', color);
          line.setAttribute('stroke-width', '0.8');
          line.setAttribute('opacity', '0.55');
          selLine.appendChild(line);
        }
      }
    }
  }
}
function showNodeTooltip(nid: string, ev: MouseEvent): void {
  const tip = document.getElementById('nexus-tooltip');
  if (!tip || !cb) return;
  const conv = cb.convs().get(nid);
  if (!conv) return;

  const color = ENGINE_COLORS[conv.engine] || '#a8b0c2';
  const state = agentState(conv);
  const stateLabel = tr(`nexus.state${state.charAt(0).toUpperCase() + state.slice(1)}`);
  const title = conv.customTitle || conv.turns[0]?.prompt?.slice(0, 40) || conv.id.slice(0, 8);
  const turns = conv.turns.length;
  const engineLabel = ENGINE_LABELS[conv.engine] || conv.engine;
  // Phase 9: token + cost / Token + cost
  const convTokens = conv.tokens || 0;
  const tokStr = convTokens >= 1000 ? `${(convTokens / 1000).toFixed(1)}K` : `${convTokens}`;
  const convCost = conv.cost || 0;
  const costStr = convCost < 0.01 && convCost > 0 ? `$${convCost.toFixed(4)}` : `$${convCost.toFixed(2)}`;

  tip.innerHTML = `
    <div class="nx-tip-head">
      <span class="nx-tip-dot" style="background:${color}"></span>
      <span class="nx-tip-title">${esc(title)}</span>
    </div>
    <div class="nx-tip-meta">
      <span style="color:${color}">${esc(engineLabel)}</span>
      <span class="nx-tip-sep">·</span>
      <span>${esc(stateLabel)}</span>
      <span class="nx-tip-sep">·</span>
      <span>${turns} ${esc(tr('nexus.turns'))}</span>
      <span class="nx-tip-sep">·</span>
      <span>${tokStr} tok</span>
      <span class="nx-tip-sep">·</span>
      <span>${costStr}</span>
    </div>
  `;
  tip.hidden = false;

  // 定位(避免溢出) / Position (avoid overflow)
  const stage = tip.parentElement?.getBoundingClientRect();
  if (stage) {
    const x = Math.min(ev.clientX - stage.left + 12, stage.width - 200);
    const y = Math.min(ev.clientY - stage.top + 12, stage.height - 80);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
}

function hideNodeTooltip(): void {
  const tip = document.getElementById('nexus-tooltip');
  if (tip) tip.hidden = true;
}

// ── 右键上下文菜单 / Context menu ──
function showContextMenu(nid: string, ev: MouseEvent): void {
  const menu = document.getElementById('nexus-ctx-menu');
  if (!menu || !cb) return;

  const conv = cb.convs().get(nid);
  if (!conv) return;
  const isRunning = conv.status === 'running';

  menu.innerHTML = `
    <button class="nx-ctx-item" data-action="open">${esc(tr('nexus.ctxOpen'))}</button>
    <button class="nx-ctx-item" data-action="chat">${esc(tr('nexus.ctxChat'))}</button>
    ${isRunning ? `<button class="nx-ctx-item nx-ctx-danger" data-action="cancel">${esc(tr('nexus.ctxCancel'))}</button>` : ''}
    <div class="nx-ctx-divider"></div>
    <button class="nx-ctx-item" data-action="copyid">${esc(tr('nexus.ctxCopyId'))}</button>
  `;
  menu.hidden = false;

  // 定位 / Position
  const stage = menu.parentElement?.getBoundingClientRect();
  if (stage) {
    const x = Math.min(ev.clientX - stage.left, stage.width - 160);
    const y = Math.min(ev.clientY - stage.top, stage.height - 160);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  // 绑定菜单项 / Bind menu items
  menu.querySelectorAll<HTMLElement>('[data-action]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      menu.hidden = true;
      switch (action) {
        case 'open':
          selectedNodeId = nid;
          if (cb) cb.selectChat(nid);
          updateOverlay();
          break;
        case 'chat':
          if (cb) cb.selectChat(nid);
          break;
        case 'cancel':
          if (cb) cb.cancel(nid);
          break;
        case 'copyid':
          navigator.clipboard?.writeText(nid).catch(() => {});
          break;
      }
    };
  });
}

// ── Canvas 粒子渲染 / Canvas particle rendering ──
function updateParticles(): void {
  if (!canvas || !ctx) return;

  // 调整 canvas 尺寸 / Resize canvas
  const stage = canvas.parentElement;
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  if (canvas.width !== rect.width || canvas.height !== rect.height) {
    canvas.width = rect.width;
    canvas.height = rect.height;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // 更新和绘制粒子 / Update and draw particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.progress += p.speed;
    if (p.progress >= 1) {
      particles.splice(i, 1);
      continue;
    }

    // 缓动曲线(先快后慢) / Easing (fast then slow)
    const ease = 1 - Math.pow(1 - p.progress, 2);
    p.x = p.fromX + (p.toX - p.fromX) * ease;
    p.y = p.fromY + (p.toY - p.fromY) * ease;

    // Phase 7: 记录拖尾位置 / Record trail position
    p.trail.push({ x: p.x, y: p.y });
    if (p.trail.length > 8) p.trail.shift();

    // 淡入淡出 / Fade in/out
    let alpha = p.alpha;
    if (p.progress < 0.15) alpha *= p.progress / 0.15;
    else if (p.progress > 0.85) alpha *= (1 - p.progress) / 0.15;

    // Phase 7: 拖尾(从旧到新,逐渐变亮变粗) / Trail (old→new, brighter and thicker)
    for (let t = 0; t < p.trail.length; t++) {
      const tp = p.trail[t];
      const tFrac = t / p.trail.length;
      ctx.beginPath();
      ctx.arc(tp.x, tp.y, p.size * (0.3 + tFrac * 0.7), 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = alpha * tFrac * 0.3;
      ctx.fill();
    }

    // 外层光晕(弥散) / Outer glow (diffuse)
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * 4, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = alpha * 0.08;
    ctx.fill();

    // 中层光晕 / Mid glow
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * 2, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = alpha * 0.2;
    ctx.fill();

    // 核心(亮白) / Core (bright white-hot)
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * 0.8, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = alpha * 0.8;
    ctx.fill();

    // 引擎色内核 / Engine-colored inner
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * 1.3, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = alpha * 0.5;
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

// ── 向运行中的 Agent 发射粒子 / Emit particles to running agents ──
function emitParticlesToRunning(): void {
  if (!canvas) return;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // 计算缩放比(SVG viewBox → Canvas 像素) / Compute scale (SVG viewBox → canvas px)
  const scale = canvas.width / svgSize;

  for (const ring of rings) {
    if (foldedCwds.has(ring.cwd)) continue; // Phase 4: 跳过折叠轨道
    for (const node of ring.nodes) {
      if (node.state !== 'running') continue;
      // canvas 坐标系:中心 = canvas 中心,偏移 = radius * cos/sin * scale
      const canvasNodeX = cx + node.radius * Math.cos(node.angle) * scale;
      const canvasNodeY = cy + node.radius * Math.sin(node.angle) * scale;
      const color = ENGINE_COLORS[node.engine] || '#a8b0c2';
      // 正向:核心 → 节点(意图流) / Forward: core → node (intent flow)
      spawnParticle(cx, cy, canvasNodeX, canvasNodeY, color);
      // 逆向:节点 → 核心(结果回流),较低概率 / Reverse: node → core (result feedback), lower chance
      if (Math.random() < 0.3) {
        spawnParticle(canvasNodeX, canvasNodeY, cx, cy, color);
      }
    }
  }
}


// ── Phase 5: Mini-map 渲染 / Mini-map render ──
// 简化的 SVG 缩略图:轨道圆环 + 节点点位 + 视口框。
// Simplified SVG thumbnail: orbit rings + node dots + viewport rect.
function updateMinimap(): void {
  const el = document.getElementById('nexus-minimap-canvas');
  if (!el) return;
  if (rings.length === 0) {
    el.innerHTML = `<div class="nx-minimap-empty">—</div>`;
    return;
  }

  const maxR = Math.max(...rings.map(r => r.nodes[0]?.radius || 0), 100) + 40;
  const miniSize = Math.max(maxR * 2, 200);
  const miniCx = miniSize / 2;
  const miniCy = miniSize / 2;
  const scale = miniSize / svgSize; // 映射到 minimap 坐标 / Map to minimap coords

  let svg = `<svg viewBox="0 0 ${miniSize} ${miniSize}" width="100%" height="100%">`;

  // 轨道圆环 / Orbit circles
  for (const ring of rings) {
    if (foldedCwds.has(ring.cwd)) continue;
    const r = (ring.nodes[0]?.radius || 0) * scale;
    if (r > 0) {
      svg += `<circle cx="${miniCx}" cy="${miniCy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`;
    }
    // 节点点位 / Node dots
    for (const node of ring.nodes) {
      const nx = miniCx + r * Math.cos(node.angle);
      const ny = miniCy + r * Math.sin(node.angle);
      const color = ENGINE_COLORS[node.engine] || '#a8b0c2';
      const isSel = node.id === selectedNodeId || selectedNodeIds.has(node.id);
      const dotR = isSel ? 3 : 2;
      svg += `<circle cx="${nx}" cy="${ny}" r="${dotR}" fill="${color}" opacity="${isSel ? 1 : 0.6}"/>`;
    }
  }

  // 核心 / Core — Phase 8 冷白
  svg += `<circle cx="${miniCx}" cy="${miniCy}" r="3" fill="rgba(200,210,230,0.85)"/>`;

  // 视口指示框 / Viewport indicator rect
  const stageEl = document.querySelector('.nexus-stage') as HTMLElement | null;
  if (stageEl) {
    const sw = stageEl.clientWidth;
    const sh = stageEl.clientHeight;
    // 视口在 SVG 坐标系中的大小 / Viewport size in SVG coords
    const vpW = (sw / viewScale) * scale;
    const vpH = (sh / viewScale) * scale;
    // 视口中心偏移 / Viewport center offset
    const vpCx = miniCx - viewOffsetX * scale / viewScale;
    const vpCy = miniCy - viewOffsetY * scale / viewScale;
    svg += `<rect x="${vpCx - vpW/2}" y="${vpCy - vpH/2}" width="${vpW}" height="${vpH}"
      fill="rgba(170,180,210,0.05)" stroke="rgba(170,180,210,0.35)" stroke-width="1" stroke-dasharray="3 2"/>`;
  }

  svg += `</svg>`;
  el.innerHTML = svg;
}

// ── Phase 5: Mini-map 点击导航 / Mini-map click navigation ──
function handleMinimapClick(ev: MouseEvent): void {
  const el = ev.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;
  const ratio = el.clientWidth > 0 ? px / el.clientWidth : 0;
  const ratioY = el.clientHeight > 0 ? py / el.clientHeight : 0;

  // 将 minimap 点击位置映射回 SVG 坐标 / Map minimap click back to SVG coords
  const svgX = ratio * svgSize;
  const svgY = ratioY * svgSize;

  // 计算需要的 viewOffset 使 SVG 中心对准点击点 / Compute viewOffset to center on click point
  const stageEl = document.querySelector('.nexus-stage') as HTMLElement | null;
  if (!stageEl) return;
  viewOffsetX = -(svgX - svgCx) * viewScale;
  viewOffsetY = -(svgY - svgCy) * viewScale;
  applyViewTransform();
  saveViewState();
  updateMinimap();
}

// ── Phase 5: 多选工具栏更新 / Multi-select toolbar update ──
function updateMultiToolbar(): void {
  const toolbar = document.getElementById('nexus-multi-toolbar');
  const count = document.getElementById('nx-multi-count');
  if (!toolbar || !count) return;
  const n = selectedNodeIds.size;
  if (n < 2) {
    toolbar.hidden = true;
    return;
  }
  toolbar.hidden = false;
  count.textContent = String(n);

  // 隐藏 CancelAll 按钮如果没有 running 节点 / Hide cancel button if no running nodes
  const hasRunning = Array.from(selectedNodeIds).some(id => {
    const ring = rings.find(r => r.nodes.some(n => n.id === id));
    const node = ring?.nodes.find(n => n.id === id);
    return node?.state === 'running';
  });
  const cancelBtn = toolbar.querySelector('[data-maction="cancelAll"]') as HTMLElement | null;
  if (cancelBtn) cancelBtn.style.display = hasRunning ? '' : 'none';

  updateMinimap();
}

// ── Phase 9: 全局仪表盘 overlay / Global dashboard overlay ──
function updateDashboardOverlay(): void {
  const overlay = document.getElementById('nexus-overlay');
  if (!overlay || !cb) return;

  const convsMap = cb.convs();
  const allConvs = cb.order().map(id => convsMap.get(id)).filter(Boolean) as Conversation[];

  let running = 0, idle = 0, error = 0, totalTokens = 0, totalCost = 0;
  const engineCounts: Record<string, number> = {};

  for (const conv of allConvs) {
    const st = agentState(conv);
    if (st === 'running') running++;
    else if (st === 'error') error++;
    else if (st === 'idle' || st === 'done') idle++;
    totalTokens += conv.tokens || 0;
    totalCost += conv.cost || 0;
    engineCounts[conv.engine] = (engineCounts[conv.engine] || 0) + 1;
  }

  // 引擎分布条 / Engine distribution bar
  const total = allConvs.length || 1;
  let distHTML = '';
  const engines = Object.entries(engineCounts).sort((a, b) => b[1] - a[1]);
  for (const [engine, count] of engines) {
    const pct = (count / total * 100).toFixed(0);
    const color = ENGINE_COLORS[engine as EngineKind] || '#a8b0c2';
    const label = ENGINE_LABELS[engine as EngineKind] || engine;
    distHTML += `<div class="nx-dash-eng-row">
      <span class="nx-dash-eng-dot" style="background:${color}"></span>
      <span class="nx-dash-eng-label">${esc(label)}</span>
      <div class="nx-dash-eng-bar"><div class="nx-dash-eng-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="nx-dash-eng-count">${count}</span>
    </div>`;
  }

  // 最近活跃(按 updatedAt 排序前 5) / Recent activity (top 5 by updatedAt)
  const recent = [...allConvs]
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, 5);
  let recentHTML = '';
  if (recent.length === 0) {
    recentHTML = `<div class="nx-dash-empty">${esc(tr('nexus.dashNoRecent'))}</div>`;
  } else {
    for (const conv of recent) {
      const color = ENGINE_COLORS[conv.engine] || '#a8b0c2';
      const st = agentState(conv);
      const title = conv.customTitle || conv.turns[0]?.prompt?.slice(0, 30) || conv.id.slice(0, 8);
      const turns = conv.turns.length;
      recentHTML += `<div class="nx-dash-recent-item" data-nid="${conv.id}">
        <span class="nx-dash-recent-dot" style="background:${color}"></span>
        <span class="nx-dash-recent-title">${esc(title)}</span>
        <span class="nx-dash-recent-meta ${st === 'running' ? 'nx-state-running' : ''}">${turns} ${esc(tr('nexus.turns'))}</span>
      </div>`;
    }
  }

  const costStr = totalCost < 0.01 ? `$${totalCost.toFixed(4)}` : `$${totalCost.toFixed(2)}`;
  const tokStr = totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : `${totalTokens}`;

  overlay.innerHTML = `
    <div class="nx-panel nx-dash-panel">
      <div class="nx-panel-head">
        <span class="nx-panel-dot" style="background:rgba(200,210,230,0.6);box-shadow:0 0 8px rgba(200,210,230,0.3)"></span>
        <span class="nx-panel-title">${esc(tr('nexus.dashboard'))}</span>
        <span class="nx-panel-state">${allConvs.length} ${esc(tr('nexus.dashSessions'))}</span>
      </div>
      <div class="nx-panel-body" id="nx-panel-body">
        <div class="nx-dash-stats">
          <div class="nx-dash-stat ${running > 0 ? 'nx-stat-active' : ''}">
            <div class="nx-dash-stat-val">${running}</div>
            <div class="nx-dash-stat-label">${esc(tr('nexus.dashRunning'))}</div>
          </div>
          <div class="nx-dash-stat">
            <div class="nx-dash-stat-val">${idle}</div>
            <div class="nx-dash-stat-label">${esc(tr('nexus.dashIdle'))}</div>
          </div>
          <div class="nx-dash-stat ${error > 0 ? 'nx-stat-error' : ''}">
            <div class="nx-dash-stat-val">${error}</div>
            <div class="nx-dash-stat-label">${esc(tr('nexus.dashError'))}</div>
          </div>
        </div>
        <div class="nx-dash-metrics">
          <div class="nx-dash-metric">
            <span class="nx-dash-metric-label">${esc(tr('nexus.dashTokens'))}</span>
            <span class="nx-dash-metric-val">${tokStr}</span>
          </div>
          <div class="nx-dash-metric">
            <span class="nx-dash-metric-label">${esc(tr('nexus.dashCost'))}</span>
            <span class="nx-dash-metric-val">${costStr}</span>
          </div>
        </div>
        <div class="nx-dash-section-title">${esc(tr('nexus.dashByEngine'))}</div>
        <div class="nx-dash-eng-list">${distHTML}</div>
        <div class="nx-dash-section-title">${esc(tr('nexus.dashRecent'))}</div>
        <div class="nx-dash-recent-list">${recentHTML}</div>
      </div>
    </div>
  `;

  // 绑定最近活跃列表点击 → 切到该 Agent 详情 / Bind recent item click → switch to agent detail
  overlay.querySelectorAll<HTMLElement>('[data-nid]').forEach(el => {
    el.addEventListener('click', () => {
      const nid = el.dataset.nid!;
      selectedNodeId = nid;
      overlayMode = 'agent';
      if (cb) cb.selectChat(nid);
      updateOverlay();
    });
  });
}

// ── DOM overlay:选中节点的对话流 / DOM overlay: conversation for selected node ──
function updateOverlay(): void {
  const overlay = document.getElementById('nexus-overlay');
  if (!overlay || !cb) return;

  // Phase 9: 核心球点击 → dashboard 模式
  if (overlayMode === 'dashboard' || !selectedNodeId) {
    if (overlayMode === 'dashboard') {
      updateDashboardOverlay();
      return;
    }
    overlay.innerHTML = `<div class="nexus-empty">${esc(tr('nexus.selectAgent'))}</div>`;
    return;
  }

  const conv = cb.convs().get(selectedNodeId);
  if (!conv) {
    overlay.innerHTML = `<div class="nexus-empty">${esc(tr('nexus.selectAgent'))}</div>`;
    return;
  }

  // 渲染最近几轮对话 / Render recent turns (full content, no truncation)
  const recentTurns = conv.turns.slice(-8);
  let turnsHTML = '';
  for (const turn of recentTurns) {
    // 用户消息 / User message
    if (turn.prompt) {
      turnsHTML += `<div class="nx-msg nx-msg-user">${esc(turn.prompt)}</div>`;
    }
    // AI 回复 / AI response (完整内容 + 基础 Markdown) / Full content + basic Markdown
    if (turn.answer) {
      turnsHTML += `<div class="nx-msg nx-msg-ai">${simpleMarkdown(turn.answer)}</div>`;
    }
    // 工具调用摘要 / Tool call summary
    if (turn.steps && turn.steps.length > 0) {
      const toolNames = turn.steps.map((s: { name: string }) => s.name).join(', ');
      turnsHTML += `<div class="nx-msg nx-msg-tool">🔧 ${esc(toolNames)}</div>`;
    }
    if (turn.error) {
      turnsHTML += `<div class="nx-msg nx-msg-error">⚠ ${esc(turn.error)}</div>`;
    }
  }

  const stateColor = ENGINE_COLORS[conv.engine] || '#a8b0c2';
  const stateText = conv.status === 'running' ? tr('nexus.stateRunning') : (conv.turns.length > 0 ? tr('nexus.stateIdle') : tr('nexus.stateEmpty'));
  const engineLabel = ENGINE_LABELS[conv.engine] || conv.engine;

  // Phase 9: token / cost 指标 / Token / cost metrics
  const convTokens = conv.tokens || 0;
  const convCost = conv.cost || 0;
  const tokStr = convTokens >= 1000 ? `${(convTokens / 1000).toFixed(1)}K` : `${convTokens}`;
  const costStr = convCost < 0.01 && convCost > 0 ? `$${convCost.toFixed(4)}` : `$${convCost.toFixed(2)}`;

  // Phase 9: 快捷操作栏 / Quick actions bar
  const isRunning = conv.status === 'running';
  const hasTurns = conv.turns.length > 0;

  overlay.innerHTML = `
    <div class="nx-panel">
      <div class="nx-panel-head">
        <span class="nx-panel-dot" style="background:${stateColor};box-shadow:0 0 8px ${stateColor}"></span>
        <span class="nx-panel-title">${esc(conv.customTitle || conv.id.slice(0, 8))}</span>
        <span class="nx-panel-state">${esc(stateText)}</span>
      </div>
      <div class="nx-detail-meta">
        <div class="nx-detail-chip"><span class="nx-detail-chip-label">${esc(engineLabel)}</span></div>
        <div class="nx-detail-chip"><span class="nx-detail-chip-label">${esc(tr('nexus.detailTokens'))}</span><span class="nx-detail-chip-val">${tokStr}</span></div>
        <div class="nx-detail-chip"><span class="nx-detail-chip-label">${esc(tr('nexus.detailCost'))}</span><span class="nx-detail-chip-val">${costStr}</span></div>
        ${conv.model ? `<div class="nx-detail-chip"><span class="nx-detail-chip-val">${esc(conv.model)}</span></div>` : ''}
      </div>
      <div class="nx-panel-body" id="nx-panel-body">
        ${turnsHTML || `<div class="nx-empty-turns">${esc(tr('nexus.noMessages'))}</div>`}
      </div>
      <div class="nx-detail-actions">
        <button class="nx-action-btn" data-action="continue" ${isRunning ? 'disabled' : ''}>${esc(tr('nexus.actContinue'))}</button>
        <button class="nx-action-btn" data-action="summarize" ${!hasTurns ? 'disabled' : ''}>${esc(tr('nexus.actSummarize'))}</button>
        <button class="nx-action-btn" data-action="export" ${!hasTurns ? 'disabled' : ''}>${esc(tr('nexus.actExport'))}</button>
      </div>
    </div>
  `;

  // Phase 9: 绑定快捷操作 / Bind quick actions
  overlay.querySelectorAll<HTMLElement>('.nx-action-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (!action || !cb) return;
      const id = selectedNodeId!;
      switch (action) {
        case 'continue':
          // 聚焦输入框 / Focus the input bar
          const arc = document.getElementById('nexus-arc-text') as HTMLTextAreaElement | null;
          if (arc) arc.focus();
          break;
        case 'summarize':
          cb.send(id, '请总结当前对话的核心内容和关键结论。');
          break;
        case 'export':
          // 用对话框让用户选择格式——这里直接发指令 / Send export command
          cb.send(id, '/export md');
          break;
      }
    });
  });

  // Phase 2: 自动滚动到底部(流式回复时跟随) / Auto-scroll to bottom during streaming
  const panelBody = document.getElementById('nx-panel-body');
  if (panelBody) {
    panelBody.scrollTop = panelBody.scrollHeight;
  }
}

// ── 增量更新(流式事件到达时) / Incremental update (on streaming events) ──
let nexusOverlayPending = false;
export function refreshNexusNode(conv: Conversation): void {
  // 更新对应节点的状态 / Update the corresponding node's state
  for (const ring of rings) {
    const node = ring.nodes.find(n => n.id === conv.id);
    if (node) {
      node.state = agentState(conv);
      node.conv = conv;
      break;
    }
  }
  // Phase 9: dashboard 模式也要更新 / Update dashboard too in dashboard mode
  // 用 rAF 防抖:高频 token 流时避免每帧全量 innerHTML 重建。
  if (overlayMode === 'dashboard' || conv.id === selectedNodeId) {
    if (nexusOverlayPending) return;
    nexusOverlayPending = true;
    requestAnimationFrame(() => {
      nexusOverlayPending = false;
      updateOverlay();
      updateMinimap();
    });
  }
}

// ── 会话切换时重渲 / Re-render on conversation change ──
export function nexusOnConversationChanged(): void {
  buildRings();
  if (cb) selectedNodeId = cb.selectedId();
  // Phase 9: 有选中节点 → agent 模式,否则保持 dashboard
  if (selectedNodeId) overlayMode = 'agent';
  updateOverlay();
  updateMinimap();
}
