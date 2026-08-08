// NEXUS — 空间认知 Agent 界面 / Spatial Cognition Surface
//
// 设计理念:抛弃传统左右分栏,以"轨道"隐喻组织 Agent 会话。
// 每个 Agent 是轨道上一颗发光节点,围绕中央意图核心运转。
// 数据流以粒子形式在轨道间流动,实时呈现 Agent 的思维过程。
//
// Phase 2: SVG 轨道 + Canvas 粒子 + DOM overlay(对话气泡 + 弧形输入区)
//          + hover tooltip + 双击跳转 + 右键菜单 + 自适应缩放 + 快捷指令
//          + 滚轮缩放/拖拽平移 + overlay 流式滚动跟随 + 节点连线
// Phase 2: SVG orbits + Canvas particles + DOM overlay + interactions + zoom/pan. Zero dependencies.

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
  newTask: (cwd: string) => void;
  convs: () => Map<string, Conversation>;
  order: () => string[];
  selectedId: () => string | null;
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
const ENGINE_COLORS: Record<EngineKind, string> = {
  direct: '#e8b339',
  directV2: '#6c5ce7',
  directV3: '#00b894',
  claudeCode: '#d97757',
  codex: '#10a37f',
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

// ── 粒子系统 / Particle system ──
// 当 Agent 正在运行时,从核心向节点发射粒子,模拟"意图流向 Agent"。
// Emits particles from core to running agents, simulating intent flow.

interface Particle {
  fromX: number; fromY: number;
  toX: number; toY: number;
  x: number; y: number;
  progress: number;  // 0 → 1
  speed: number;
  size: number;
  color: string;
  alpha: number;
}

function spawnParticle(fromX: number, fromY: number, toX: number, toY: number, color: string): void {
  particles.push({
    fromX, fromY, toX, toY,
    x: fromX, y: fromY,
    progress: 0,
    speed: 0.008 + Math.random() * 0.012,
    size: 1.5 + Math.random() * 2,
    color,
    alpha: 0.6 + Math.random() * 0.4,
  });
}

function projName(cwd: string): string {
  if (!cwd) return tr('wb.ungrouped');
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return base || cwd;
}

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
  const ringRadius = Math.max(60, 110 * compression); // 每环间距 / ring spacing
  const baseRadius = Math.max(55, 90 * compression);  // 最内圈半径 / innermost radius
  rings.forEach((ring, i) => {
    const r = baseRadius + i * ringRadius;
    ring.nodes.forEach(n => { n.radius = r; });
  });
}

// ── 全量渲染 / Full render ──
export function renderNexus(): void {
  const root = document.getElementById('nexus-canvas');
  if (!root) return;

  buildRings();

  // 选中当前会话 / Select current conversation
  if (cb) selectedNodeId = cb.selectedId();

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
      <div class="nexus-hint" id="nexus-hint">${esc(tr('nexus.hint'))}</div>
      <div class="nexus-tooltip" id="nexus-tooltip" hidden></div>
      <div class="nexus-ctx-menu" id="nexus-ctx-menu" hidden></div>
    </div>
  `;

  // 初始化 Canvas / Init canvas
  canvas = document.getElementById('nexus-particle-canvas') as HTMLCanvasElement;
  ctx = canvas?.getContext('2d') || null;

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
  if (backBtn) backBtn.onclick = () => { if (cb) cb.selectChat(selectedNodeId || cb.order()[0] || ''); };

  // Phase 2: 重置视图按钮 / Reset view button
  const resetBtn = document.getElementById('nexus-reset');
  if (resetBtn) resetBtn.onclick = () => {
    viewScale = 1; viewOffsetX = 0; viewOffsetY = 0;
    applyViewTransform();
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

  // Phase 3: 键盘快捷键 / Keyboard shortcuts
  const stageEl = document.getElementById('nexus-stage');
  if (stageEl) {
    stageEl.tabIndex = 0; // 使其可聚焦以接收键盘事件
    stageEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        selectedNodeId = null;
        if (cb) {
          const sid = cb.selectedId();
          if (sid) cb.selectChat(sid);
        }
        updateOverlay();
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
    }, { passive: false });

    // 拖拽平移 / Drag pan (在 SVG 层上)
    svgWrap.addEventListener('mousedown', (e: MouseEvent) => {
      // 只在点击空白处(非节点)时启动拖拽 / Only start drag on empty space
      const target = e.target as SVGElement;
      if (target.hasAttribute('data-nid')) return;
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartOffX = viewOffsetX;
      dragStartOffY = viewOffsetY;
      svgWrap.style.cursor = 'grabbing';
    });

    svgWrap.addEventListener('mousemove', (e: MouseEvent) => {
      if (!isDragging) return;
      viewOffsetX = dragStartOffX + (e.clientX - dragStartX);
      viewOffsetY = dragStartOffY + (e.clientY - dragStartY);
      applyViewTransform();
    });

    const endDrag = () => {
      isDragging = false;
      if (svgWrap) svgWrap.style.cursor = 'default';
    };
    svgWrap.addEventListener('mouseup', endDrag);
    svgWrap.addEventListener('mouseleave', endDrag);

    // 双击空白重置视图 / Double-click empty space resets view
    svgWrap.addEventListener('dblclick', (e: MouseEvent) => {
      const target = e.target as SVGElement;
      if (target.hasAttribute('data-nid')) return;
      viewScale = 1;
      viewOffsetX = 0;
      viewOffsetY = 0;
      applyViewTransform();
    });
  }

  // 开始动画 / Start animation
  startAnimation();
  updateOverlay();
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
  renderSVG();

  // 更新 Canvas 粒子 / Update canvas particles
  updateParticles();

  // 定期发射粒子到运行中的节点 / Periodically emit particles to running nodes
  if (Math.random() < 0.15) emitParticlesToRunning();
}

// ── SVG 尺寸缓存 / Cached SVG dimensions ──
let svgSize = 400;
let svgCx = 200;
let svgCy = 200;

// ── 应用视图变换 / Apply view transform ──
function applyViewTransform(): void {
  const svg = document.querySelector('.nexus-svg-wrap svg') as SVGSVGElement | null;
  if (svg) {
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

  let svg = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);">`;

  // ── 渐变定义 / Gradient defs ──
  svg += `<defs>`;
  // 核心光晕 / Core glow
  svg += `<radialGradient id="nx-core-glow" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#e8b339" stop-opacity="0.6"/>
    <stop offset="40%" stop-color="#e8b339" stop-opacity="0.15"/>
    <stop offset="100%" stop-color="#e8b339" stop-opacity="0"/>
  </radialGradient>`;
  // 节点状态渐变 / Node state gradients
  svg += `<radialGradient id="nx-node-running" cx="35%" cy="35%" r="65%">
    <stop offset="0%" stop-color="#f4d06f"/>
    <stop offset="60%" stop-color="#e8b339"/>
    <stop offset="100%" stop-color="#6b5320"/>
  </radialGradient>`;
  svg += `<radialGradient id="nx-node-idle" cx="35%" cy="35%" r="65%">
    <stop offset="0%" stop-color="#3a3a44"/>
    <stop offset="100%" stop-color="#222226"/>
  </radialGradient>`;
  svg += `<radialGradient id="nx-node-error" cx="35%" cy="35%" r="65%">
    <stop offset="0%" stop-color="#ff8a76"/>
    <stop offset="60%" stop-color="#e2614c"/>
    <stop offset="100%" stop-color="#6b2a20"/>
  </radialGradient>`;
  svg += `<radialGradient id="nx-node-done" cx="35%" cy="35%" r="65%">
    <stop offset="0%" stop-color="#7ed99f"/>
    <stop offset="60%" stop-color="#4ec27a"/>
    <stop offset="100%" stop-color="#1e5e3a"/>
  </radialGradient>`;
  svg += `</defs>`;

  // ── 轨道环 / Orbit rings ──
  for (const ring of rings) {
    const r = ring.nodes[0]?.radius || 100;
    // 轨道线 / Orbit line
    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(232,179,57,0.06)" stroke-width="1" stroke-dasharray="2 4"/>`;
    // 轨道标签 / Orbit label (上方位置 / top position)
    const labelX = cx + r * Math.cos(-Math.PI / 2);
    const labelY = cy + r * Math.sin(-Math.PI / 2) - 8;
    svg += `<text x="${labelX}" y="${labelY}" fill="rgba(150,150,160,0.4)" font-size="10" text-anchor="middle" font-family="system-ui">${esc(ring.label)}</text>`;
  }

  // ── 核心意图球 / Central intent core ──
  const corePulse = 1 + Math.sin(Date.now() / 800) * 0.05;
  const coreR = 28 * corePulse;
  svg += `<circle cx="${cx}" cy="${cy}" r="${coreR * 2.5}" fill="url(#nx-core-glow)"/>`;
  svg += `<circle cx="${cx}" cy="${cy}" r="${coreR}" fill="rgba(232,179,57,0.08)" stroke="rgba(232,179,57,0.3)" stroke-width="1"/>`;
  svg += `<circle cx="${cx}" cy="${cy}" r="${coreR * 0.6}" fill="rgba(232,179,57,0.15)"/>`;
  // 核心中心点 / Core center dot
  svg += `<circle cx="${cx}" cy="${cy}" r="4" fill="#e8b339"/>`;
  // 核心标签 / Core label
  svg += `<text x="${cx}" y="${cy + coreR + 16}" fill="rgba(232,179,57,0.5)" font-size="9" text-anchor="middle" font-family="system-ui" letter-spacing="1">INTENT CORE</text>`;

  // ── Phase 2: 数据流连线(运行中节点 → 核心) / Data flow lines (running → core) ──
  for (const ring of rings) {
    for (const node of ring.nodes) {
      if (node.state !== 'running') continue;
      const nx = cx + node.radius * Math.cos(node.angle);
      const ny = cy + node.radius * Math.sin(node.angle);
      const color = ENGINE_COLORS[node.engine] || '#e8b339';
      // 虚线连接,带动画 / Dashed line with animation
      svg += `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${color}" stroke-width="1" opacity="0.25" stroke-dasharray="3 6">
        <animate attributeName="stroke-dashoffset" from="0" to="-18" dur="1s" repeatCount="indefinite"/>
      </line>`;
    }
  }

  // ── Phase 2: 选中节点 ↔ 核心高亮连线 / Selected ↔ core highlight line ──
  if (selectedNodeId) {
    for (const ring of rings) {
      const node = ring.nodes.find(n => n.id === selectedNodeId);
      if (node) {
        const nx = cx + node.radius * Math.cos(node.angle);
        const ny = cy + node.radius * Math.sin(node.angle);
        const color = ENGINE_COLORS[node.engine] || '#e8b339';
        svg += `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${color}" stroke-width="1.5" opacity="0.4"/>`;
      }
    }
  }

  // ── Agent 节点 / Agent nodes ──
  for (const ring of rings) {
    for (const node of ring.nodes) {
      const x = cx + node.radius * Math.cos(node.angle);
      const y = cy + node.radius * Math.sin(node.angle);
      const isSelected = node.id === selectedNodeId;
      const color = ENGINE_COLORS[node.engine] || '#e8b339';
      const nodeR = isSelected ? 14 : 10;

      // 选中光环 / Selection halo
      if (isSelected) {
        svg += `<circle cx="${x}" cy="${y}" r="${nodeR + 10}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.4">
          <animate attributeName="r" values="${nodeR + 8};${nodeR + 14};${nodeR + 8}" dur="2s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.4;0.15;0.4" dur="2s" repeatCount="indefinite"/>
        </circle>`;
      }

      // 运行中脉冲 / Running pulse
      if (node.state === 'running') {
        svg += `<circle cx="${x}" cy="${y}" r="${nodeR}" fill="none" stroke="${color}" stroke-width="1" opacity="0.3">
          <animate attributeName="r" values="${nodeR};${nodeR + 12};${nodeR}" dur="1.5s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.5;0;0.5" dur="1.5s" repeatCount="indefinite"/>
        </circle>`;
      }

      // 节点本体 / Node body — 含 data-nid 用于点击/hover/右键
      const gradId = `nx-node-${node.state}`;
      svg += `<circle cx="${x}" cy="${y}" r="${nodeR}" fill="url(#${gradId})" stroke="${color}" stroke-width="${isSelected ? 2 : 1}" opacity="${isSelected ? 1 : 0.85}" style="cursor:pointer" data-nid="${node.id}"/>`;

      // 节点中心点 / Node center dot
      svg += `<circle cx="${x}" cy="${y}" r="3" fill="${color}" data-nid="${node.id}" style="cursor:pointer"/>`;

      // 引擎标签(仅选中) / Engine label (only when selected)
      if (isSelected) {
        const labelText = ENGINE_LABELS[node.engine] || node.engine;
        svg += `<text x="${x}" y="${y - nodeR - 6}" fill="${color}" font-size="9" text-anchor="middle" font-family="system-ui">${esc(labelText)}</text>`;
      }
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
}

// ── 节点 tooltip / Node tooltip ──
function showNodeTooltip(nid: string, ev: MouseEvent): void {
  const tip = document.getElementById('nexus-tooltip');
  if (!tip || !cb) return;
  const conv = cb.convs().get(nid);
  if (!conv) return;

  const color = ENGINE_COLORS[conv.engine] || '#e8b339';
  const state = agentState(conv);
  const stateLabel = tr(`nexus.state${state.charAt(0).toUpperCase() + state.slice(1)}`);
  const title = conv.customTitle || conv.turns[0]?.prompt?.slice(0, 40) || conv.id.slice(0, 8);
  const turns = conv.turns.length;
  const engineLabel = ENGINE_LABELS[conv.engine] || conv.engine;

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

    // 淡入淡出 / Fade in/out
    let alpha = p.alpha;
    if (p.progress < 0.15) alpha *= p.progress / 0.15;
    else if (p.progress > 0.85) alpha *= (1 - p.progress) / 0.15;

    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = alpha;
    ctx.fill();

    // 光晕 / Glow
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * 2.5, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = alpha * 0.15;
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
    for (const node of ring.nodes) {
      if (node.state !== 'running') continue;
      // canvas 坐标系:中心 = canvas 中心,偏移 = radius * cos/sin * scale
      const canvasNodeX = cx + node.radius * Math.cos(node.angle) * scale;
      const canvasNodeY = cy + node.radius * Math.sin(node.angle) * scale;
      const color = ENGINE_COLORS[node.engine] || '#e8b339';
      spawnParticle(cx, cy, canvasNodeX, canvasNodeY, color);
    }
  }
}

// ── DOM overlay:选中节点的对话流 / DOM overlay: conversation for selected node ──
function updateOverlay(): void {
  const overlay = document.getElementById('nexus-overlay');
  if (!overlay || !cb) return;

  if (!selectedNodeId) {
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

  const stateColor = ENGINE_COLORS[conv.engine] || '#e8b339';
  const stateText = conv.status === 'running' ? tr('nexus.stateRunning') : (conv.turns.length > 0 ? tr('nexus.stateIdle') : tr('nexus.stateEmpty'));

  overlay.innerHTML = `
    <div class="nx-panel">
      <div class="nx-panel-head">
        <span class="nx-panel-dot" style="background:${stateColor};box-shadow:0 0 8px ${stateColor}"></span>
        <span class="nx-panel-title">${esc(conv.customTitle || conv.id.slice(0, 8))}</span>
        <span class="nx-panel-state">${esc(stateText)}</span>
      </div>
      <div class="nx-panel-body" id="nx-panel-body">
        ${turnsHTML || `<div class="nx-empty-turns">${esc(tr('nexus.noMessages'))}</div>`}
      </div>
    </div>
  `;

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
  // 如果是当前选中的节点,更新 overlay / If it's the selected node, update overlay
  // 用 rAF 防抖:高频 token 流时避免每帧全量 innerHTML 重建。
  if (conv.id === selectedNodeId) {
    if (nexusOverlayPending) return;
    nexusOverlayPending = true;
    requestAnimationFrame(() => {
      nexusOverlayPending = false;
      updateOverlay();
    });
  }
}

// ── 会话切换时重渲 / Re-render on conversation change ──
export function nexusOnConversationChanged(): void {
  buildRings();
  if (cb) selectedNodeId = cb.selectedId();
  updateOverlay();
}
