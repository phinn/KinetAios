// 轨迹反事实对比(2026-11):步数/失败/成本差异 + 首次分叉点 + 结论。
import { assert, test, run } from './harness';
import { compareTraces, formatTraceDiff, traceFromEvents } from '../../src/main/trace-compare';
import type { EventRow } from '../../src/main/store';
import type { ConvEvent } from '../../src/shared/types';

function ev(seq: number, data: ConvEvent, ts = 1000 + seq): EventRow {
  return { seq, turnId: 't', type: data.type, data, ts };
}

const A = {
  id: 'A',
  steps: [
    { tool: 'read_file', ok: true },
    { tool: 'edit_file', ok: true },
    { tool: 'diagnostics', ok: false },
    { tool: 'edit_file', ok: true },
    { tool: 'diagnostics', ok: true },
  ],
  tokensIn: 1000, tokensOut: 500, costUSD: 0.05, answerChars: 120, turnErrors: 0, durationMs: 9000,
};
const B = {
  id: 'B',
  steps: [
    { tool: 'read_file', ok: true },
    { tool: 'edit_file', ok: true },
    { tool: 'write_file', ok: true },
    { tool: 'diagnostics', ok: true },
  ],
  tokensIn: 800, tokensOut: 400, costUSD: 0.03, answerChars: 100, turnErrors: 0, durationMs: 6000,
};

test('traceFromEvents:只统计工具/成本/答复/错误', () => {
  const t = traceFromEvents([
    ev(1, { type: 'tool/call', name: 'read_file', args: '{}', result: 'x', outcome: 'ok' }),
    ev(2, { type: 'tool/call', name: 'shell', args: '{}', result: 'boom', outcome: 'error' }),
    ev(3, { type: 'turn/meta', costUSD: 0.02, tokensIn: 10, tokensOut: 5 }),
    ev(4, { type: 'assistant/message', text: '答案是 42' }),
    ev(5, { type: 'turn/error', message: 'x' }),
  ], 'conv');
  assert.equal(t.steps.length, 2);
  assert.equal(t.steps[1].ok, false);
  assert.equal(t.costUSD, 0.02);
  assert.equal(t.tokensIn, 10);
  assert.equal(t.answerChars, '答案是 42'.length);
  assert.equal(t.turnErrors, 1);
  assert.equal(t.durationMs, 4, 'ts 跨度');
});

test('compareTraces:失败更少 → B 更好;分叉点可定位', () => {
  const d = compareTraces(A, B);
  assert.equal(d.verdict, 'better');
  assert.equal(d.failureDelta, -1);
  assert.equal(d.stepDelta, -1);
  assert.equal(d.firstDivergence, 2, '第 3 步 A=diagnostics / B=write_file');
  assert.equal(d.sequence[2].a, 'diagnostics');
  assert.equal(d.sequence[2].b, 'write_file');
  assert.ok(d.costDelta < 0);
  assert.ok(d.notes.some((n) => n.includes('第 3 步开始分叉')));
});

test('compareTraces:失败更多 → B 更差(失败优先于步数)', () => {
  const cleanA = { ...A, steps: A.steps.map((s) => ({ ...s, ok: true })) };
  const worse = { ...B, steps: [...B.steps, { tool: 'shell', ok: false }] };
  assert.equal(compareTraces(cleanA, worse).verdict, 'worse');
});

test('compareTraces:完全一致 → same', () => {
  const d = compareTraces(A, A);
  assert.equal(d.verdict, 'same');
  assert.equal(d.firstDivergence, null);
  assert.equal(d.toolsOnlyA.length, 0);
  assert.equal(d.toolsOnlyB.length, 0);
});

test('compareTraces:仅一边使用的工具会被列出', () => {
  const d = compareTraces(A, B);
  assert.ok(d.toolsOnlyB.includes('write_file'));
  assert.ok(d.toolsOnlyA.includes('diagnostics'), 'A 用了 2 次 diagnostics,B 只用 1 次 → 还剩 1 次只在 A');
});

test('formatTraceDiff 输出关键字段', () => {
  const text = formatTraceDiff(compareTraces(A, B));
  assert.ok(text.includes('结论: B 更好'));
  assert.ok(text.includes('Δ失败'));
  assert.ok(text.includes('分叉点附近'));
});

run();
