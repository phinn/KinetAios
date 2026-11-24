// 失败归因分类器回归(2026-11-24)。P2:turn_feedback 只知道"被否",不知道"谁的锅"。
// 这里钉死三件事:①不是失败的不算能力问题(用户停止)②外部抖动单列,别记成模型不行
// ③拿不准就 unknown,不猜 —— 归因错了会一路错到技能淘汰和 planner 调参。
import { assert, test, run } from './harness';
import { attributeTurnFailure } from '../../src/main/turn-attribution';

const ok = { name: 'read_file', outcome: 'ok' as const };
const bad = (name: string) => ({ name, outcome: 'error' as const });

test('用户主动停止 → user:stop,不当成能力失败', () => {
  const r = attributeTurnFailure({ aborted: true, steps: [ok, bad('shell')], errorMsg: 'aborted' });
  assert.equal(r.primary, 'user');
  assert.deepEqual(r.tags, ['fail:user:stop'], '停止时不叠加工具归因,避免污染统计');
});

test('errorKind=cancelled 与 aborted 同口径', () => {
  const r = attributeTurnFailure({ errorKind: 'cancelled' });
  assert.equal(r.primary, 'user');
});

test('上下文溢出 → context:overflow', () => {
  const r = attributeTurnFailure({ errorKind: 'contextTooLong', steps: [ok] });
  assert.equal(r.primary, 'context');
  assert.deepEqual(r.tags, ['fail:context:overflow']);
});

test('轮次耗尽 → plan:max-turns;伴随大量工具失败时叠加 tool:retry-storm', () => {
  const solo = attributeTurnFailure({ errorKind: 'maxTurns', steps: [ok] });
  assert.equal(solo.primary, 'plan');
  assert.deepEqual(solo.tags, ['fail:plan:max-turns']);

  const storm = attributeTurnFailure({ errorKind: 'maxTurns', steps: [bad('shell'), bad('shell'), bad('grep')] });
  assert.deepEqual(storm.tags, ['fail:plan:max-turns', 'fail:tool:retry-storm']);
});

test('上游限流/网络错误 → env:transient(不记成模型能力问题)', () => {
  const a = attributeTurnFailure({ errorMsg: 'HTTP 429 rate limit exceeded' });
  assert.equal(a.primary, 'env');
  assert.deepEqual(a.tags, ['fail:env:transient']);

  const b = attributeTurnFailure({ errorKind: 'transient', errorMsg: 'whatever' });
  assert.equal(b.primary, 'env');

  const c = attributeTurnFailure({ errorMsg: 'read ECONNRESET' });
  assert.equal(c.primary, 'env');
});

test('工具失败 → tool:<最后一个失败的工具名>', () => {
  const r = attributeTurnFailure({ steps: [ok, bad('shell'), ok, bad('edit_file')] });
  assert.equal(r.primary, 'tool');
  assert.deepEqual(r.tags, ['fail:tool:edit_file'], '取最后一个失败的工具,后续成功的步骤不推翻它');
});

test('工具连续失败 ≥3 → 追加 plan:retry-storm', () => {
  const r = attributeTurnFailure({ steps: [bad('shell'), bad('shell'), bad('shell')] });
  assert.equal(r.primary, 'tool');
  assert.deepEqual(r.tags, ['fail:tool:shell', 'fail:plan:retry-storm']);
});

test('鉴权失败(401/403) → env:auth,不能误判成模型不行', () => {
  const a = attributeTurnFailure({ errorMsg: "HTTP 401 — login fail: Please carry the API secret key in the 'X-Api-Key' field" });
  assert.equal(a.primary, 'env');
  assert.deepEqual(a.tags, ['fail:env:auth']);

  const b = attributeTurnFailure({ errorMsg: '403 Forbidden: invalid api key', steps: [] });
  assert.equal(b.primary, 'env', '有错误且零工具调用时,401 也必须优先于 model:no-tool');
});

test('有错误但一个工具都没调 → model:no-tool', () => {
  const r = attributeTurnFailure({ errorMsg: '模型拒绝回答', steps: [] });
  assert.equal(r.primary, 'model');
  assert.deepEqual(r.tags, ['fail:model:no-tool']);
});

test('交付了但用户不认 → unknown:unmet(不硬猜环节)', () => {
  const r = attributeTurnFailure({ unmet: true });
  assert.equal(r.primary, 'unknown');
  assert.deepEqual(r.tags, ['fail:unknown:unmet']);
});

test('没有失败信号 → 空归因', () => {
  const r = attributeTurnFailure({ steps: [ok] });
  assert.equal(r.primary, null);
  assert.deepEqual(r.tags, []);
});

test('优先级:用户停止 > 工具失败(停止产生的工具中断不算工具问题)', () => {
  const r = attributeTurnFailure({ aborted: true, steps: [bad('shell'), bad('shell'), bad('shell')] });
  assert.deepEqual(r.tags, ['fail:user:stop']);
});

run();
