// viz 卡片宽度回路回归(2026-11-24 用户报「对话里的 HTML 页面宽度一直不停地变宽」):
// 根因是内层用 fit-content 量内容宽 —— 收窄后流体内容量回来的就是"刚给它的宽度",
// 宿主再 +2px 写回,每轮 +2 → 一路撑到满宽。修法见 src/renderer/viz-width.ts。
import fs from 'node:fs';
import path from 'node:path';
import { assert, test, run } from './harness';
import { planVizWidth, VIZ_NARROW_ENTER, VIZ_NARROW_EXIT } from '../../src/renderer/viz-width';

const PARENT = 700; // 卡片父容器宽(恒定基准),base = 698

test('固定宽内容(360)→ 窄态,尺寸 = w+18 / w+2', () => {
  const p = planVizWidth({ measuredW: 360, frameW: PARENT - 2, parentW: PARENT, wasNarrow: false });
  assert.equal(p.narrow, true);
  assert.equal(p.cardW, 378);
  assert.equal(p.frameW, 362);
});

test('回声宽(measured == frameW)→ 一律铺满,绝不收窄', () => {
  // 这是"变宽"的直接来源:流体文档量回来的永远是当前 iframe 宽
  const p = planVizWidth({ measuredW: 362, frameW: 362, parentW: PARENT, wasNarrow: true });
  assert.equal(p.narrow, false, '回声不能当成内容宽');
  assert.equal(p.cardW, null);
  assert.equal(p.frameW, null);
});

test('回声宽即使比例够小(300/700)也不收窄 —— 先看饱和,再看比例', () => {
  const p = planVizWidth({ measuredW: 300, frameW: 300, parentW: PARENT, wasNarrow: false });
  assert.equal(p.narrow, false);
});

test('固定宽内容连续 50 轮上报 → 第 2 轮起完全不动(无增长)', () => {
  let narrow = false;
  let cardW = PARENT;
  let frameW = PARENT;
  const seen: number[] = [];
  for (let i = 0; i < 50; i++) {
    const p = planVizWidth({ measuredW: 360, frameW, parentW: PARENT, wasNarrow: narrow });
    narrow = p.narrow;
    if (p.narrow && p.cardW != null && p.frameW != null) { cardW = p.cardW; frameW = p.frameW; }
    else { cardW = PARENT; frameW = PARENT; }
    seen.push(cardW);
  }
  assert.equal(narrow, true);
  assert.equal(cardW, 378, '第 50 轮仍是 378');
  assert.equal(frameW, 362);
  assert.equal(new Set(seen.slice(1)).size, 1, '第 2 轮起宽度恒定(旧实现每轮 +2)');
});

test('流体内容(内在宽 5000)连续 50 轮 → 始终铺满且不超父宽', () => {
  let narrow = false;
  let frameW = PARENT - 2;
  let cardW = PARENT;
  for (let i = 0; i < 50; i++) {
    // 模拟 fit-content 语义:可用宽不够时回声成可用宽
    const measured = Math.min(5000, frameW);
    const p = planVizWidth({ measuredW: measured, frameW, parentW: PARENT, wasNarrow: narrow });
    narrow = p.narrow;
    if (p.narrow && p.cardW != null && p.frameW != null) { cardW = p.cardW; frameW = p.frameW; }
    else { cardW = PARENT; frameW = PARENT; }
    assert.ok(cardW <= PARENT, `第 ${i} 轮卡片 ${cardW} 溢出父容器`);
  }
  assert.equal(narrow, false);
  assert.equal(cardW, PARENT);
});

test('迟滞:进窄 0.78 / 出窄 0.92', () => {
  const mid = Math.round(698 * 0.85); // 0.78 < 0.85 < 0.92 的夹缝
  assert.equal(planVizWidth({ measuredW: mid, frameW: PARENT, parentW: PARENT, wasNarrow: false }).narrow, false, '宽态在夹缝里保持宽');
  assert.equal(planVizWidth({ measuredW: mid, frameW: PARENT, parentW: PARENT, wasNarrow: true }).narrow, true, '窄态在夹缝里保持窄');
  assert.equal(planVizWidth({ measuredW: 400, frameW: PARENT, parentW: PARENT, wasNarrow: false }).narrow, true);
  assert.equal(planVizWidth({ measuredW: Math.ceil(698 * VIZ_NARROW_EXIT) + 1, frameW: PARENT, parentW: PARENT, wasNarrow: true }).narrow, false, '超过 0.92 退出');
  assert.equal(planVizWidth({ measuredW: Math.floor(698 * VIZ_NARROW_ENTER) + 1, frameW: PARENT, parentW: PARENT, wasNarrow: false }).narrow, false, '未过 0.78 不进窄');
});

test('窄卡宽夹在父容器内 + 有最小宽(内容 40px 也不收成一条)', () => {
  const tiny = planVizWidth({ measuredW: 40, frameW: PARENT, parentW: PARENT, wasNarrow: false });
  assert.equal(tiny.narrow, true);
  assert.equal(tiny.cardW, 160, '最小 160');
  // 内容比父容器还宽 → 铺满,不溢出
  const big = planVizWidth({ measuredW: 900, frameW: PARENT, parentW: PARENT, wasNarrow: false });
  assert.equal(big.narrow, false);
  // 内容贴着父容器上限 → 卡片不得超父宽
  const edge = planVizWidth({ measuredW: 600, frameW: PARENT, parentW: PARENT, wasNarrow: false });
  assert.ok(edge.narrow === false || (edge.cardW ?? 0) <= PARENT - 2);
});

test('父容器未布局(parentW=0)/ 测量无效 → 一个尺寸都不动', () => {
  const a = planVizWidth({ measuredW: 360, frameW: 0, parentW: 0, wasNarrow: true });
  assert.equal(a.narrow, true, '状态保持原样');
  assert.equal(a.cardW, null);
  assert.equal(a.frameW, null);
  const b = planVizWidth({ measuredW: 0, frameW: 500, parentW: PARENT, wasNarrow: true });
  assert.equal(b.narrow, true);
  assert.equal(b.cardW, null);
});

// ── 源码闸:量宽必须用 max-content,宿主必须走 planVizWidth ──
function repoRoot(): string {
  let d = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    d = path.dirname(d);
  }
  throw new Error('找不到仓库根目录');
}

test('app.ts:内层量宽用 max-content(不是 fit-content),宿主走纯函数', () => {
  const src = fs.readFileSync(path.join(repoRoot(), 'src/renderer/app.ts'), 'utf8');
  assert.ok(src.includes(`b.style.width='max-content'`), '量宽必须 max-content(内在宽,与可用宽无关)');
  assert.ok(!src.includes(`b.style.width='fit-content'`), 'fit-content 会回声成可用宽 → 变宽');
  assert.ok(src.includes('planVizWidth('), '宿主走 viz-width.ts 的判定');
});

run();
