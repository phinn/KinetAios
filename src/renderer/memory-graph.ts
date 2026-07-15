// 记忆图谱(Memory Graph):力导向图可视化 memory_triples 表中的 (subject, predicate, object) 三元组。
// 纯 SVG + 物理模拟,零外部依赖。节点 = 实体,边 = 关系(predicate 标注在边上)。
// 交互:拖拽节点 / 滚轮缩放 / 点击节点高亮关联边 / 点击空白取消 / 详情面板。
// 增强:搜索过滤 / 度数过滤 / Fit 视图 / 节点碰撞防重叠 / 双击聚焦。
// 差异化:记忆溯源(每条记忆来自哪次对话、原始问题) + 记忆冲突检测(同 subject+predicate 不同 object)。
import type { KinetAPI } from '../shared/types';
import { t, type Lang } from '../shared/i18n';

declare global { interface Window { kinet: KinetAPI } }

const api = window.kinet;
let lang: Lang = 'zh-CN';

// ── 扩展类型(含溯源和冲突数据)──
type TripleSource = {
  id: string; subject: string; predicate: string; object: string;
  convId: string | null; createdAt: number;
  sourceEngine: string | null; sourcePrompt: string | null;
};
type Conflict = {
  subject: string; predicate: string;
  entries: Array<{ tripleId: string; object: string; convId: string | null; createdAt: number }>;
};
type GNode = { id: string; label: string; x: number; y: number; vx: number; vy: number; degree: number; fixed?: boolean };
type GEdge = { source: string; target: string; predicate: string; tripleId: string; convId: string | null; createdAt: number };

let allNodes: GNode[] = [];
let allEdges: GEdge[] = [];
let nodes: GNode[] = [];
let edges: GEdge[] = [];
let triples: TripleSource[] = [];
let conflicts: Conflict[] = [];
let showLabels = true;
let layoutMode: 'force' | 'circle' = 'force';

// ── 冲突节点集合(用于渲染时高亮)──
let conflictNodeIds = new Set<string>();
let conflictEdgeTripleIds = new Set<string>();

// ── 过滤状态 ──
let searchQuery = '';
let minDegreeFilter = 1;

// ── 物理参数 ──
const REPULSION = 1200;
const SPRING_LENGTH = 140;
const SPRING_K = 0.04;
const DAMPING = 0.85;
const CENTER_PULL = 0.001;
const MAX_VELOCITY = 8;
const MIN_NODE_DIST = 44;

// ── 视口变换 ──
let viewX = 0, viewY = 0, viewScale = 1;

// ── 交互状态 ──
let selectedNode: string | null = null;
let draggingNode: GNode | null = null;
let didDrag = false;
let isPanning = false;
let panStartX = 0, panStartY = 0, panStartVX = 0, panStartVY = 0;

const svg = document.getElementById('mgraph-svg') as unknown as SVGElement;
const detailEl = document.getElementById('mgraph-detail') as HTMLElement;
const conflictEl = document.getElementById('mgraph-conflict-panel') as HTMLElement;

// ── 屏幕坐标 → 世界坐标 ──
function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  return {
    x: (sx - rect.left - viewX) / viewScale,
    y: (sy - rect.top - viewY) / viewScale,
  };
}

// ── 命中测试 ──
function hitTest(sx: number, sy: number): GNode | null {
  const wx = screenToWorld(sx, sy);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const maxDeg = Math.max(1, ...nodes.map((nd) => nd.degree));
    const r = 8 + (n.degree / maxDeg) * 18;
    const dx = wx.x - n.x, dy = wx.y - n.y;
    if (dx * dx + dy * dy <= r * r) return n;
  }
  return null;
}

// ── 过滤节点 ──
function applyFilter(): void {
  const q = searchQuery.trim().toLowerCase();

  if (!q && minDegreeFilter <= 1) {
    nodes = allNodes.map(n => ({ ...n }));
    edges = allEdges.map(e => ({ ...e }));
    return;
  }

  let candidateIds = new Set(allNodes.filter(n => n.degree >= minDegreeFilter).map(n => n.id));

  if (q) {
    const matched = allNodes.filter(n =>
      n.degree >= minDegreeFilter && n.label.toLowerCase().includes(q)
    );
    const matchedIds = new Set(matched.map(n => n.id));
    for (const e of allEdges) {
      if (matchedIds.has(e.source)) candidateIds.add(e.target);
      if (matchedIds.has(e.target)) candidateIds.add(e.source);
    }
    candidateIds = new Set([...matchedIds, ...candidateIds].filter(id =>
      allNodes.find(n => n.id === id && n.degree >= minDegreeFilter) || matchedIds.has(id)
    ));
  }

  nodes = allNodes.filter(n => candidateIds.has(n.id)).map(n => ({ ...n }));
  edges = allEdges.filter(e => candidateIds.has(e.source) && candidateIds.has(e.target)).map(e => ({ ...e }));
}

// ── 构建冲突索引 ──
function buildConflictIndex(): void {
  conflictNodeIds = new Set();
  conflictEdgeTripleIds = new Set();
  for (const c of conflicts) {
    conflictNodeIds.add(c.subject);
    for (const entry of c.entries) {
      conflictEdgeTripleIds.add(entry.tripleId);
    }
  }
}

// ── 加载数据 ──
async function loadData(): Promise<void> {
  const data = await api.memoryGraphData();
  triples = data.triples;
  conflicts = data.conflicts;
  allEdges = data.edges as GEdge[];

  buildConflictIndex();

  // 构建节点
  const degreeMap = new Map<string, number>();
  for (const e of allEdges) {
    degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1);
  }
  const rect = svg.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  allNodes = data.nodes.map((n) => {
    const angle = Math.random() * Math.PI * 2;
    const r = 50 + Math.random() * 100;
    return {
      id: n.id,
      label: n.label,
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      vx: 0, vy: 0,
      degree: degreeMap.get(n.id) ?? 1,
    };
  });

  applyFilter();

  // 更新统计
  updateStats();

  detailEl.innerHTML = '';

  // 更新冲突面板
  renderConflictPanel();

  if (allNodes.length === 0) {
    svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--text-dim)" font-size="14">${t(lang, 'mgraph.empty')}</text>`;
    return;
  }

  if (nodes.length === 0) {
    svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--text-dim)" font-size="14">⚠ No nodes match filter</text>`;
    return;
  }

  if (layoutMode === 'circle') layoutCircle();
  startSimulation();
}

function updateStats(): void {
  const statsEl = document.getElementById('mgraph-stats');
  if (statsEl) {
    const maxDeg = Math.max(1, ...allNodes.map(n => n.degree));
    const conflictBadge = conflicts.length > 0
      ? `<span class="mg-conflict-badge">⚠ ${conflicts.length} ${t(lang, 'mgraph.conflicts')}</span>`
      : '';
    statsEl.innerHTML = `
      <span><b>${t(lang, 'mgraph.nodes')}</b> ${nodes.length}/${allNodes.length}</span>
      <span><b>${t(lang, 'mgraph.edges')}</b> ${edges.length}/${allEdges.length}</span>
      <span><b>${t(lang, 'mgraph.triples')}</b> ${triples.length}</span>
      <span><b>${t(lang, 'mgraph.degree')}</b> max ${maxDeg}</span>
      ${conflictBadge}
    `;
  }
}

// ── 渲染冲突面板 ──
function renderConflictPanel(): void {
  if (conflicts.length === 0) {
    conflictEl.innerHTML = '';
    conflictEl.style.display = 'none';
    return;
  }

  conflictEl.style.display = 'block';
  const items = conflicts.map((c, ci) => {
    const objs = c.entries.map((e, ei) => {
      const date = new Date(e.createdAt * 1000).toLocaleString(lang === 'zh-CN' ? 'zh-CN' : lang === 'zh-TW' ? 'zh-TW' : lang === 'ja' ? 'ja' : 'en');
      return `<div class="mg-conflict-obj">
        <span class="mg-conflict-val">${escapeHtml(e.object)}</span>
        <span class="mg-conflict-meta">${date}</span>
        <button class="mg-conflict-del" data-triple-id="${e.tripleId}" data-idx="${ci}.${ei}" title="${t(lang, 'mgraph.delete')}">✕</button>
      </div>`;
    }).join('');
    return `<div class="mg-conflict-item">
      <div class="mg-conflict-head">
        <span class="mg-conflict-subj">${escapeHtml(c.subject)}</span>
        <span class="mg-conflict-pred">${escapeHtml(c.predicate)}</span>
      </div>
      <div class="mg-conflict-vals">${objs}</div>
    </div>`;
  }).join('');

  conflictEl.innerHTML = `
    <div class="mg-conflict-title">
      ⚠ ${t(lang, 'mgraph.conflicts')} (${conflicts.length})
      <span class="mg-conflict-desc">${t(lang, 'mgraph.conflictDesc')}</span>
    </div>
    ${items}
  `;

  // 绑定删除按钮
  conflictEl.querySelectorAll<HTMLButtonElement>('.mg-conflict-del').forEach(btn => {
    btn.onclick = async () => {
      const tripleId = btn.dataset.tripleId!;
      if (!confirm(t(lang, 'mgraph.deleteConfirm'))) return;
      await api.deleteMemoryTriple(tripleId);
      loadData();
    };
  });
}

function layoutCircle(): void {
  const rect = svg.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  const radius = Math.min(rect.width, rect.height) * 0.35;
  const sorted = [...nodes].sort((a, b) => b.degree - a.degree);
  sorted.forEach((n, i) => {
    const angle = (i / sorted.length) * Math.PI * 2;
    n.x = cx + Math.cos(angle) * radius;
    n.y = cy + Math.sin(angle) * radius;
    n.vx = 0; n.vy = 0;
  });
}

// ── 物理模拟 ──
let animFrame = 0;
let iterations = 0;

function simulate(): void {
  iterations++;
  const rect = svg.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      const distSq = Math.max(dx * dx + dy * dy, 1);
      const force = REPULSION / distSq;
      const dist = Math.sqrt(distSq);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      nodes[i].vx -= fx; nodes[i].vy -= fy;
      nodes[j].vx += fx; nodes[j].vy += fy;
    }
  }

  // 碰撞检测
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      if (dist < MIN_NODE_DIST) {
        const overlap = (MIN_NODE_DIST - dist) / 2;
        const ux = dx / dist, uy = dy / dist;
        if (!nodes[i].fixed) { nodes[i].x -= ux * overlap; nodes[i].y -= uy * overlap; }
        if (!nodes[j].fixed) { nodes[j].x += ux * overlap; nodes[j].y += uy * overlap; }
      }
    }
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    const s = nodeMap.get(e.source);
    const tg = nodeMap.get(e.target);
    if (!s || !tg) continue;
    const dx = tg.x - s.x;
    const dy = tg.y - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = (dist - SPRING_LENGTH) * SPRING_K;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    s.vx += fx; s.vy += fy;
    tg.vx -= fx; tg.vy -= fy;
  }

  for (const n of nodes) {
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    n.vx += (cx - n.x) * CENTER_PULL;
    n.vy += (cy - n.y) * CENTER_PULL;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    const v = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (v > MAX_VELOCITY) { n.vx = (n.vx / v) * MAX_VELOCITY; n.vy = (n.vy / v) * MAX_VELOCITY; }
    n.x += n.vx;
    n.y += n.vy;
  }

  render();

  if (iterations > 400) return;
  animFrame = requestAnimationFrame(simulate);
}

function startSimulation(): void {
  if (animFrame) cancelAnimationFrame(animFrame);
  iterations = 0;
  simulate();
}

// ── Fit 视图 ──
function fitView(padding = 60): void {
  if (nodes.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  const w = maxX - minX + padding * 2;
  const h = maxY - minY + padding * 2;
  const rect = svg.getBoundingClientRect();
  const scale = Math.min(rect.width / w, rect.height / h, 2.5);
  viewScale = Math.max(0.2, scale);
  const bcx = (minX + maxX) / 2;
  const bcy = (minY + maxY) / 2;
  viewX = rect.width / 2 - bcx * viewScale;
  viewY = rect.height / 2 - bcy * viewScale;
  render();
}

// ── 格式化引擎名 ──
function engineLabel(engine: string | null): string {
  if (!engine) return '—';
  const labels: Record<string, string> = { direct: 'Kaios', claudeCode: 'Claude Code', codex: 'Codex' };
  return labels[engine] ?? engine;
}

// ── 格式化时间 ──
function formatTime(ts: number): string {
  if (!ts) return '—';
  const locale = lang === 'zh-CN' ? 'zh-CN' : lang === 'zh-TW' ? 'zh-TW' : lang === 'ja' ? 'ja' : 'en';
  return new Date(ts * 1000).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── 渲染 SVG ──
function render(): void {
  if (nodes.length === 0) return;
  const ns = 'http://www.w3.org/2000/svg';

  svg.innerHTML = '';

  const g = document.createElementNS(ns, 'g');
  g.setAttribute('transform', `translate(${viewX},${viewY}) scale(${viewScale})`);

  const maxDeg = Math.max(1, ...nodes.map((n) => n.degree));

  // ── 边 ──
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    const s = nodeMap.get(e.source);
    const tg = nodeMap.get(e.target);
    if (!s || !tg) continue;

    const isHighlighted = selectedNode && (e.source === selectedNode || e.target === selectedNode);
    const isConflict = conflictEdgeTripleIds.has(e.tripleId);

    // 冲突边用脉冲红色虚线
    if (isConflict) {
      const pulseLine = document.createElementNS(ns, 'line');
      pulseLine.setAttribute('x1', String(s.x));
      pulseLine.setAttribute('y1', String(s.y));
      pulseLine.setAttribute('x2', String(tg.x));
      pulseLine.setAttribute('y2', String(tg.y));
      pulseLine.setAttribute('stroke', '#e85d5d');
      pulseLine.setAttribute('stroke-width', '2');
      pulseLine.setAttribute('stroke-dasharray', '6 4');
      pulseLine.setAttribute('opacity', selectedNode && !isHighlighted ? '0.2' : '0.8');
      pulseLine.style.animation = 'mg-pulse 2s ease-in-out infinite';
      g.appendChild(pulseLine);
    }

    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(s.x));
    line.setAttribute('y1', String(s.y));
    line.setAttribute('x2', String(tg.x));
    line.setAttribute('y2', String(tg.y));
    line.setAttribute('stroke', isConflict ? '#e85d5d' : isHighlighted ? 'var(--accent)' : 'var(--border)');
    line.setAttribute('stroke-width', isHighlighted || isConflict ? '2' : '1');
    line.setAttribute('opacity', selectedNode && !isHighlighted ? '0.15' : '0.5');
    g.appendChild(line);

    // 关系标签
    if (showLabels && viewScale > 0.5) {
      const mx = (s.x + tg.x) / 2;
      const my = (s.y + tg.y) / 2;
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(mx));
      label.setAttribute('y', String(my));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', isConflict ? '#e85d5d' : isHighlighted ? 'var(--accent)' : 'var(--text-dim)');
      label.setAttribute('font-size', '10');
      label.setAttribute('opacity', selectedNode && !isHighlighted ? '0.1' : '0.7');
      label.style.pointerEvents = 'none';
      label.style.userSelect = 'none';
      const pred = e.predicate.length > 15 ? e.predicate.slice(0, 14) + '…' : e.predicate;
      label.textContent = pred;
      g.appendChild(label);
    }
  }

  // ── 节点 ──
  for (const n of nodes) {
    const r = 8 + (n.degree / maxDeg) * 18;
    const isSelected = selectedNode === n.id;
    const isConnected = selectedNode && edges.some((e) =>
      (e.source === selectedNode && e.target === n.id) ||
      (e.target === selectedNode && e.source === n.id));
    const isConflict = conflictNodeIds.has(n.id);

    // 外发光
    if (isSelected || isConnected) {
      const glow = document.createElementNS(ns, 'circle');
      glow.setAttribute('cx', String(n.x));
      glow.setAttribute('cy', String(n.y));
      glow.setAttribute('r', String(r + 6));
      glow.setAttribute('fill', 'var(--accent)');
      glow.setAttribute('opacity', '0.15');
      g.appendChild(glow);
    }

    // 冲突节点外圈红色警告环
    if (isConflict && !isSelected) {
      const warnRing = document.createElementNS(ns, 'circle');
      warnRing.setAttribute('cx', String(n.x));
      warnRing.setAttribute('cy', String(n.y));
      warnRing.setAttribute('r', String(r + 4));
      warnRing.setAttribute('fill', 'none');
      warnRing.setAttribute('stroke', '#e85d5d');
      warnRing.setAttribute('stroke-width', '2');
      warnRing.setAttribute('stroke-dasharray', '3 2');
      warnRing.setAttribute('opacity', '0.6');
      g.appendChild(warnRing);
    }

    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', String(n.x));
    circle.setAttribute('cy', String(n.y));
    circle.setAttribute('r', String(r));
    // 冲突节点用红色填充
    if (isSelected) {
      circle.setAttribute('fill', 'var(--accent)');
    } else if (isConflict) {
      circle.setAttribute('fill', 'rgba(232,93,93,0.2)');
      circle.setAttribute('stroke', '#e85d5d');
    } else {
      circle.setAttribute('fill', isConnected ? 'rgba(232,179,57,0.3)' : 'var(--bg-elev)');
      circle.setAttribute('stroke', 'var(--border)');
    }
    circle.setAttribute('stroke-width', '1.5');
    circle.style.cursor = 'pointer';
    circle.setAttribute('data-id', n.id);
    g.appendChild(circle);

    // 节点标签
    const showThisLabel = viewScale > 0.35 || n.degree >= 3;
    if (showThisLabel) {
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', String(n.x));
      text.setAttribute('y', String(n.y + r + 14));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', isSelected ? 'var(--accent)' : isConflict ? '#e85d5d' : 'var(--text)');
      text.setAttribute('font-size', '11');
      text.setAttribute('opacity', selectedNode && !isSelected && !isConnected ? '0.2' : '0.9');
      text.style.pointerEvents = 'none';
      text.style.userSelect = 'none';
      const label = n.label.length > 20 ? n.label.slice(0, 19) + '…' : n.label;
      text.textContent = label;
      g.appendChild(text);
    }
  }

  svg.appendChild(g);
  updateZoomIndicator();
}

function updateZoomIndicator(): void {
  const el = document.getElementById('mgraph-zoom-val');
  if (el) el.textContent = Math.round(viewScale * 100) + '%';
}

// ── 节点详情面板(含溯源)──
function showNodeDetail(n: GNode): void {
  // 找到与该节点相关的所有三元组(含溯源数据)
  const related = triples.filter(t => t.subject === n.id || t.object === n.id);

  const rows = related.map((tr) => {
    const isSource = tr.subject === n.id;
    const other = isSource ? tr.object : tr.subject;
    const arrow = isSource ? '→' : '←';

    // 溯源信息
    const sourceBadge = tr.sourceEngine
      ? `<span class="mg-engine-badge mg-engine-${tr.sourceEngine}">${engineLabel(tr.sourceEngine)}</span>`
      : '';
    const sourcePromptText = tr.sourcePrompt
      ? `<div class="mg-source-prompt" title="${escapeHtml(tr.sourcePrompt)}">💬 ${escapeHtml(tr.sourcePrompt.slice(0, 80))}${tr.sourcePrompt.length > 80 ? '…' : ''}</div>`
      : '';
    const time = formatTime(tr.createdAt);

    return `<div class="mg-detail-row" data-triple-id="${tr.id}">
      <div class="mg-rel-row">
        <span class="mg-rel">${escapeHtml(n.label)} <span class="mg-arrow">${arrow}</span> <span class="mg-pred">${escapeHtml(tr.predicate)}</span> ${arrow} ${escapeHtml(other)}</span>
        <button class="mg-row-del" data-triple-id="${tr.id}" title="${t(lang, 'mgraph.delete')}">✕</button>
      </div>
      <div class="mg-rel-meta">
        ${sourceBadge}
        <span class="mg-time">⏱ ${time}</span>
      </div>
      ${sourcePromptText}
    </div>`;
  }).join('');

  detailEl.innerHTML = `
    <div class="mg-detail-head">
      <span class="mg-detail-name">${escapeHtml(n.label)}</span>
      <span class="mg-detail-deg">${t(lang, 'mgraph.degree')}: ${n.degree}</span>
    </div>
    <div class="mg-detail-body">${rows || `<span class="mg-empty">${t(lang, 'mgraph.noRelations')}</span>`}</div>
  `;

  // 绑定删除按钮
  detailEl.querySelectorAll<HTMLButtonElement>('.mg-row-del').forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const tripleId = btn.dataset.tripleId!;
      if (!confirm(t(lang, 'mgraph.deleteConfirm'))) return;
      await api.deleteMemoryTriple(tripleId);
      selectedNode = null;
      loadData();
    };
  });
}

function clearDetail(): void {
  detailEl.innerHTML = '';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ════════════════════════════════════════════════════════════════════
// MARK: 事件处理
// ════════════════════════════════════════════════════════════════════

svg.addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const rect = svg.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  viewX = mx - (mx - viewX) * delta;
  viewY = my - (my - viewY) * delta;
  viewScale *= delta;
  viewScale = Math.max(0.15, Math.min(6, viewScale));
  render();
});

svg.addEventListener('mousedown', (e: MouseEvent) => {
  const hit = hitTest(e.clientX, e.clientY);
  if (hit) {
    draggingNode = hit;
    didDrag = false;
    hit.fixed = true;
  } else {
    isPanning = true;
    panStartX = e.clientX; panStartY = e.clientY;
    panStartVX = viewX; panStartVY = viewY;
    svg.style.cursor = 'grabbing';
  }
});

window.addEventListener('mousemove', (e: MouseEvent) => {
  if (draggingNode) {
    didDrag = true;
    const pt = screenToWorld(e.clientX, e.clientY);
    draggingNode.x = pt.x;
    draggingNode.y = pt.y;
    draggingNode.vx = 0; draggingNode.vy = 0;
    if (layoutMode === 'force' && iterations > 400) {
      iterations = 350;
      simulate();
    } else {
      render();
    }
  } else if (isPanning) {
    viewX = panStartVX + (e.clientX - panStartX);
    viewY = panStartVY + (e.clientY - panStartY);
    render();
  }
});

window.addEventListener('mouseup', () => {
  if (draggingNode) {
    draggingNode.fixed = false;
    if (!didDrag) {
      const n = draggingNode;
      selectedNode = selectedNode === n.id ? null : n.id;
      if (selectedNode) showNodeDetail(n);
      else clearDetail();
      render();
    }
    draggingNode = null;
  }
  if (isPanning) {
    isPanning = false;
    svg.style.cursor = '';
  }
});

svg.addEventListener('dblclick', (e: MouseEvent) => {
  const hit = hitTest(e.clientX, e.clientY);
  if (!hit) return;
  const neighborIds = new Set<string>([hit.id]);
  for (const ed of edges) {
    if (ed.source === hit.id) neighborIds.add(ed.target);
    if (ed.target === hit.id) neighborIds.add(ed.source);
  }
  const subNodes = nodes.filter(n => neighborIds.has(n.id));
  if (subNodes.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of subNodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
  }
  const padding = 80;
  const w = maxX - minX + padding * 2;
  const h = maxY - minY + padding * 2;
  const rect = svg.getBoundingClientRect();
  const scale = Math.min(rect.width / w, rect.height / h, 3);
  viewScale = Math.max(0.3, scale);
  const bcx = (minX + maxX) / 2;
  const bcy = (minY + maxY) / 2;
  viewX = rect.width / 2 - bcx * viewScale;
  viewY = rect.height / 2 - bcy * viewScale;
  selectedNode = hit.id;
  showNodeDetail(hit);
  render();
});

// ── 控件 ──
(document.getElementById('mgraph-show-labels') as HTMLInputElement).addEventListener('change', (e) => {
  showLabels = (e.target as HTMLInputElement).checked;
  render();
});
(document.getElementById('mgraph-layout') as HTMLSelectElement).addEventListener('change', (e) => {
  layoutMode = (e.target as HTMLSelectElement).value as 'force' | 'circle';
  if (layoutMode === 'circle') {
    layoutCircle();
    render();
  } else {
    nodes.forEach((n) => n.fixed = false);
    startSimulation();
  }
});
document.getElementById('mgraph-refresh')!.onclick = () => {
  viewX = 0; viewY = 0; viewScale = 1;
  loadData();
};

// ── 搜索框 ──
const searchInput = document.getElementById('mgraph-search') as HTMLInputElement | null;
if (searchInput) {
  let searchTimer = 0;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const val = (e.target as HTMLInputElement).value;
    searchTimer = window.setTimeout(() => {
      searchQuery = val;
      selectedNode = null;
      clearDetail();
      applyFilter();
      if (layoutMode === 'circle') { layoutCircle(); render(); }
      else { startSimulation(); }
      if (searchQuery.trim()) setTimeout(() => fitView(80), 500);
    }, 200);
  });
}

// ── 度数过滤滑块 ──
const degreeSlider = document.getElementById('mgraph-degree-slider') as HTMLInputElement | null;
const degreeVal = document.getElementById('mgraph-degree-val');
if (degreeSlider) {
  degreeSlider.addEventListener('input', (e) => {
    minDegreeFilter = parseInt((e.target as HTMLInputElement).value, 10);
    if (degreeVal) degreeVal.textContent = '≥ ' + minDegreeFilter;
    selectedNode = null;
    clearDetail();
    applyFilter();
    updateStats();
    if (layoutMode === 'circle') { layoutCircle(); render(); }
    else { startSimulation(); }
  });
}

// ── Fit / 缩放 ──
const fitBtn = document.getElementById('mgraph-fit');
if (fitBtn) fitBtn.onclick = () => fitView(60);

const zoomInBtn = document.getElementById('mgraph-zoom-in');
if (zoomInBtn) zoomInBtn.onclick = () => {
  const rect = svg.getBoundingClientRect();
  const mx = rect.width / 2, my = rect.height / 2;
  const delta = 1.25;
  viewX = mx - (mx - viewX) * delta;
  viewY = my - (my - viewY) * delta;
  viewScale = Math.min(6, viewScale * delta);
  render();
};
const zoomOutBtn = document.getElementById('mgraph-zoom-out');
if (zoomOutBtn) zoomOutBtn.onclick = () => {
  const rect = svg.getBoundingClientRect();
  const mx = rect.width / 2, my = rect.height / 2;
  const delta = 0.8;
  viewX = mx - (mx - viewX) * delta;
  viewY = my - (my - viewY) * delta;
  viewScale = Math.max(0.15, viewScale * delta);
  render();
};

// ── 初始化 ──
(async () => {
  const [settings, brand] = await Promise.all([api.getSettings(), api.getBrand()]);
  lang = settings.lang;
  document.documentElement.dataset.theme = settings.theme;
  document.title = `${brand.productName} · ${t(lang, 'mgraph.title')}`;
  const b = document.getElementById('mgraph-brand');
  if (b) b.textContent = brand.productName;
  setTimeout(() => loadData(), 50);
})();
