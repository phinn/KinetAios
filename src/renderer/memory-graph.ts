// 记忆图谱(Memory Graph):力导向图可视化 memory_triples 表中的 (subject, predicate, object) 三元组。
// 纯 SVG + 物理模拟,零外部依赖。节点 = 实体,边 = 关系(predicate 标注在边上)。
// 交互:拖拽节点 / 滚轮缩放 / 点击节点高亮关联边 / 双击展开详情。
import type { KinetAPI } from '../shared/types';
import { t, type Lang } from '../shared/i18n';

declare global { interface Window { kinet: KinetAPI } }

const api = window.kinet;
let lang: Lang = 'zh-CN';

type GNode = { id: string; label: string; x: number; y: number; vx: number; vy: number; degree: number; fixed?: boolean };
type GEdge = { source: string; target: string; predicate: string };

let nodes: GNode[] = [];
let edges: GEdge[] = [];
let triples: Array<{ id: string; subject: string; predicate: string; object: string }> = [];
let showLabels = true;
let layoutMode: 'force' | 'circle' = 'force';

// ── 物理参数 ──
const REPULSION = 800;     // 库仑斥力常数
const SPRING_LENGTH = 120;  // 弹簧自然长度
const SPRING_K = 0.04;      // 弹簧系数
const DAMPING = 0.85;       // 阻尼
const CENTER_PULL = 0.001;  // 向中心拉力(防止图飘走)
const MAX_VELOCITY = 8;

// ── 视口变换 ──
let viewX = 0, viewY = 0, viewScale = 1;
let isPanning = false, panStartX = 0, panStartY = 0, panStartVX = 0, panStartVY = 0;

const svg = document.getElementById('mgraph-svg') as unknown as SVGElement;
const detailEl = document.getElementById('mgraph-detail') as HTMLElement;

// ── 初始化数据 ──
async function loadData(): Promise<void> {
  const data = await api.memoryGraphData();
  triples = data.triples;
  edges = data.edges;

  // 构建节点:degree = 该实体出现次数(出入度之和)
  const degreeMap = new Map<string, number>();
  for (const e of edges) {
    degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1);
  }
  const rect = svg.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  nodes = data.nodes.map((n) => {
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

  // 更新统计
  document.getElementById('mgraph-stats')!.innerHTML = `
    <span class="mg-stat">${t(lang, 'mgraph.nodes')}: <b>${nodes.length}</b></span>
    <span class="mg-stat">${t(lang, 'mgraph.edges')}: <b>${edges.length}</b></span>
    <span class="mg-stat">${t(lang, 'mgraph.triples')}: <b>${triples.length}</b></span>
  `;

  if (nodes.length === 0) {
    svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--text-dim)" font-size="14">${t(lang, 'mgraph.empty')}</text>`;
    return;
  }

  if (layoutMode === 'circle') layoutCircle();
  startSimulation();
}

function layoutCircle(): void {
  const rect = svg.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  const radius = Math.min(rect.width, rect.height) * 0.35;
  // 按度排序,度大的放内圈
  const sorted = [...nodes].sort((a, b) => b.degree - a.degree);
  sorted.forEach((n, i) => {
    const angle = (i / sorted.length) * Math.PI * 2;
    n.x = cx + Math.cos(angle) * radius;
    n.y = cy + Math.sin(angle) * radius;
    n.vx = 0; n.vy = 0;
    n.fixed = true;
  });
}

// ── 力导向模拟(Verlet 积分)──
let animFrame: number | null = null;
let iterations = 0;

function simulate(): void {
  if (layoutMode === 'circle') { render(); animFrame = requestAnimationFrame(simulate); return; }
  iterations++;
  const rect = svg.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;

  // 斥力:每对节点
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

  // 弹簧引力:每条边
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

  // 中心引力 + 阻尼 + 位置更新
  for (const n of nodes) {
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    n.vx += (cx - n.x) * CENTER_PULL;
    n.vy += (cy - n.y) * CENTER_PULL;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    // 限速
    const v = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (v > MAX_VELOCITY) { n.vx = (n.vx / v) * MAX_VELOCITY; n.vy = (n.vy / v) * MAX_VELOCITY; }
    n.x += n.vx;
    n.y += n.vy;
  }

  render();

  // 300 轮后停止物理(稳定)
  if (iterations > 300) return;
  animFrame = requestAnimationFrame(simulate);
}

function startSimulation(): void {
  if (animFrame) cancelAnimationFrame(animFrame);
  iterations = 0;
  simulate();
}

// ── 渲染 ──
let selectedNode: string | null = null;

function render(): void {
  const ns = 'http://www.w3.org/2000/svg';
  svg.innerHTML = '';

  // 变换组
  const g = document.createElementNS(ns, 'g');
  g.setAttribute('transform', `translate(${viewX},${viewY}) scale(${viewScale})`);

  // 最大度(用于节点大小映射)
  const maxDeg = Math.max(1, ...nodes.map((n) => n.degree));

  // ── 边 ──
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    const s = nodeMap.get(e.source);
    const tg = nodeMap.get(e.target);
    if (!s || !tg) continue;

    const isHighlighted = selectedNode && (e.source === selectedNode || e.target === selectedNode);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(s.x));
    line.setAttribute('y1', String(s.y));
    line.setAttribute('x2', String(tg.x));
    line.setAttribute('y2', String(tg.y));
    line.setAttribute('stroke', isHighlighted ? 'var(--accent)' : 'var(--border)');
    line.setAttribute('stroke-width', isHighlighted ? '2' : '1');
    line.setAttribute('opacity', selectedNode && !isHighlighted ? '0.15' : '0.5');
    g.appendChild(line);

    // 关系标签(predicate)在边中点
    if (showLabels) {
      const mx = (s.x + tg.x) / 2;
      const my = (s.y + tg.y) / 2;
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(mx));
      label.setAttribute('y', String(my));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', isHighlighted ? 'var(--accent)' : 'var(--text-dim)');
      label.setAttribute('font-size', '10');
      label.setAttribute('opacity', selectedNode && !isHighlighted ? '0.1' : '0.7');
      label.style.pointerEvents = 'none';
      label.style.userSelect = 'none';
      // 截短 predicate
      const pred = e.predicate.length > 15 ? e.predicate.slice(0, 14) + '…' : e.predicate;
      label.textContent = pred;
      g.appendChild(label);
    }
  }

  // ── 节点 ──
  for (const n of nodes) {
    const r = 8 + (n.degree / maxDeg) * 18; // 度越大圆越大
    const isSelected = selectedNode === n.id;
    const isConnected = selectedNode && edges.some((e) =>
      (e.source === selectedNode && e.target === n.id) ||
      (e.target === selectedNode && e.source === n.id));

    // 外发光(选中/高亮时)
    if (isSelected || isConnected) {
      const glow = document.createElementNS(ns, 'circle');
      glow.setAttribute('cx', String(n.x));
      glow.setAttribute('cy', String(n.y));
      glow.setAttribute('r', String(r + 6));
      glow.setAttribute('fill', 'var(--accent)');
      glow.setAttribute('opacity', '0.15');
      g.appendChild(glow);
    }

    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', String(n.x));
    circle.setAttribute('cy', String(n.y));
    circle.setAttribute('r', String(r));
    circle.setAttribute('fill', isSelected ? 'var(--accent)' : isConnected ? 'var(--accent-dim, rgba(232,179,57,0.3))' : 'var(--bg-elevated, #2a2a30)');
    circle.setAttribute('stroke', isSelected ? 'var(--accent)' : 'var(--border)');
    circle.setAttribute('stroke-width', '1.5');
    circle.style.cursor = 'pointer';

    // 拖拽 + 点击
    let dragging = false;
    let dragOffsetX = 0, dragOffsetY = 0;
    circle.addEventListener('mousedown', (ev: MouseEvent) => {
      ev.stopPropagation();
      dragging = true;
      n.fixed = true;
      const pt = screenToWorld(ev.clientX, ev.clientY);
      dragOffsetX = pt.x - n.x;
      dragOffsetY = pt.y - n.y;
      const onMove = (e2: MouseEvent) => {
        if (!dragging) return;
        const pt2 = screenToWorld(e2.clientX, e2.clientY);
        n.x = pt2.x - dragOffsetX;
        n.y = pt2.y - dragOffsetY;
        n.vx = 0; n.vy = 0;
        if (layoutMode === 'force' && iterations > 300) {
          iterations = 200; // 重新启动物理
          simulate();
        }
      };
      const onUp = () => {
        dragging = false;
        n.fixed = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    circle.addEventListener('click', (ev: MouseEvent) => {
      ev.stopPropagation();
      selectedNode = selectedNode === n.id ? null : n.id;
      showNodeDetail(n);
      render();
    });

    g.appendChild(circle);

    // 节点标签
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', String(n.x));
    text.setAttribute('y', String(n.y + r + 14));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', isSelected ? 'var(--accent)' : 'var(--text)');
    text.setAttribute('font-size', '11');
    text.setAttribute('opacity', selectedNode && !isSelected && !isConnected ? '0.2' : '0.9');
    text.style.pointerEvents = 'none';
    text.style.userSelect = 'none';
    const label = n.label.length > 20 ? n.label.slice(0, 19) + '…' : n.label;
    text.textContent = label;
    g.appendChild(text);
  }

  // 点击空白取消选中
  svg.onclick = () => {
    if (selectedNode) { selectedNode = null; detailEl.innerHTML = ''; render(); }
  };

  svg.innerHTML = '';
  svg.appendChild(g);
}

function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  return {
    x: (sx - rect.left - viewX) / viewScale,
    y: (sy - rect.top - viewY) / viewScale,
  };
}

// ── 节点详情面板 ──
function showNodeDetail(n: GNode): void {
  const related = edges.filter((e) => e.source === n.id || e.target === n.id);
  const rows = related.map((e) => {
    const isSource = e.source === n.id;
    const other = isSource ? e.target : e.source;
    const arrow = isSource ? '→' : '←';
    return `<div class="mg-detail-row"><span class="mg-rel">${escapeHtml(n.label)} <span class="mg-arrow">${arrow}</span> <span class="mg-pred">${escapeHtml(e.predicate)}</span> ${arrow} ${escapeHtml(other)}</span></div>`;
  }).join('');
  detailEl.innerHTML = `
    <div class="mg-detail-head">
      <span class="mg-detail-name">${escapeHtml(n.label)}</span>
      <span class="mg-detail-deg">${t(lang, 'mgraph.degree')}: ${n.degree}</span>
    </div>
    <div class="mg-detail-body">${rows || `<span class="mg-empty">${t(lang, 'mgraph.noRelations')}</span>`}</div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ── 缩放 + 平移 ──
svg.addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const rect = svg.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  viewX = mx - (mx - viewX) * delta;
  viewY = my - (my - viewY) * delta;
  viewScale *= delta;
  viewScale = Math.max(0.2, Math.min(5, viewScale));
  render();
});

svg.addEventListener('mousedown', (e: MouseEvent) => {
  if (e.target === svg) {
    isPanning = true;
    panStartX = e.clientX; panStartY = e.clientY;
    panStartVX = viewX; panStartVY = viewY;
    svg.style.cursor = 'grabbing';
  }
});
window.addEventListener('mousemove', (e: MouseEvent) => {
  if (isPanning) {
    viewX = panStartVX + (e.clientX - panStartX);
    viewY = panStartVY + (e.clientY - panStartY);
    render();
  }
});
window.addEventListener('mouseup', () => {
  isPanning = false;
  svg.style.cursor = '';
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

// ── 初始化 ──
(async () => {
  const [settings, brand] = await Promise.all([api.getSettings(), api.getBrand()]);
  lang = settings.lang;
  document.documentElement.dataset.theme = settings.theme;
  document.title = `${brand.productName} · ${t(lang, 'mgraph.title')}`;
  const b = document.getElementById('mgraph-brand');
  if (b) b.textContent = brand.productName;
  // 等待 SVG 尺寸稳定后加载
  setTimeout(() => loadData(), 50);
})();
