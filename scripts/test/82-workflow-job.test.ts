// workflow Job 化(跨会话恢复)回归测试 — 纯逻辑层,不起 LLM 不进 JobManager。
// 覆盖:阶段拓扑排序(线性/DAG/环检测)、prompt 组装、结果合并、重试规划、断点续跑、校验。
import { assert, test, run } from './harness';
import {
  validateStages,
  topoOrder,
  buildStagePrompt,
  mergeStageResults,
  nextRetryPlan,
  skippedDoneStages,
} from '../../src/main/workflow-job';

test('validateStages:空阶段/空成员/坏依赖校验', () => {
  assert.match(validateStages([], 't')!.error!, /至少需要一个阶段/);
  assert.match(
    validateStages([{ label: 'a', members: [] }], 't')!.error!,
    /没有成员/,
  );
  assert.match(
    validateStages([{ label: 'a', members: [{ name: 'a', prompt: 'x' }] }, { label: 'b', members: [{ name: 'a', prompt: 'y' }], depends_on: ['ghost'] }], 't')!.error!,
    /依赖不存在的阶段/,
  );
  assert.match(
    validateStages([{ label: 'a', members: [{ name: 'a', prompt: 'x' }] }, { label: 'a', members: [{ name: 'a', prompt: 'y' }] }], 't')!.error!,
    /重复/,
  );
  const ok = validateStages([{ label: 'ok', members: [{ name: 'a', prompt: 'x' }] }], 't');
  assert.ok(!ok!.error);
  assert.equal(ok!.stages!.length, 1);
});

test('topoOrder:线性/DAG 分层并行/环检测', () => {
  const linear = topoOrder([
    { label: 'a', members: [], depends_on: [] },
    { label: 'b', members: [], depends_on: ['a'] },
  ]);
  assert.deepEqual(linear, [['a'], ['b']]);

  const dag = topoOrder([
    { label: 'root', members: [], depends_on: [] },
    { label: 'l1a', members: [], depends_on: ['root'] },
    { label: 'l1b', members: [], depends_on: ['root'] },
    { label: 'join', members: [], depends_on: ['l1a', 'l1b'] },
  ]);
  assert.equal(dag.length, 3);
  assert.deepEqual(dag[0], ['root']);
  assert.deepEqual([...dag[1]].sort(), ['l1a', 'l1b']);
  assert.deepEqual(dag[2], ['join']);

  assert.throws(() =>
    topoOrder([
      { label: 'a', members: [], depends_on: ['b'] },
      { label: 'b', members: [], depends_on: ['a'] },
    ]),
  );
});

test('buildStagePrompt:上一阶段汇总注入 + 成员分工', () => {
  const answers = new Map([
    ['scout', '发现 bug 在 parser.ts 42 行'],
    ['docs', 'docs 里有 API 约定'],
  ]);
  const p = buildStagePrompt('复审并给出修复方案', answers, [{ name: 'scout', prompt: '探查' }, { name: 'docs', prompt: '读文档' }]);
  assert.ok(p.includes('复审并给出修复方案'));
  assert.ok(p.includes('scout') && p.includes('docs'), '分工清单在');
  assert.ok(p.includes('parser.ts 42 行'), '上一阶段产出注入');
});

test('mergeStageResults:缺失成员=failed 不掩盖', () => {
  const answers = new Map([['a', 'done-a']]);
  const statuses = mergeStageResults([{ name: 'a', prompt: '' }, { name: 'b', prompt: '' }], answers);
  assert.equal(statuses.a, 'done');
  assert.equal(statuses.b, 'failed');
});

test('nextRetryPlan:重试只限失败成员 + 次数上限', () => {
  const states = { a: 'done', b: 'failed', c: 'failed' } as Record<string, string>;
  // (states, allNames, retried=1, retryLimit=2):还可再试一轮失败成员
  assert.deepEqual(nextRetryPlan(states, ['a', 'b', 'c'], 1, 2), ['b', 'c']);
  // retried=1 ≥ retryLimit=1 → 整阶段失败(null)
  assert.deepEqual(nextRetryPlan(states, ['a', 'b', 'c'], 1, 1), null);
});

test('skippedDoneStages:断点续跑跳过已完成阶段', () => {
  const done = ['探查A', '探查B', '汇总'];
  assert.deepEqual(skippedDoneStages(done), ['探查A', '探查B', '汇总']);
  assert.deepEqual(skippedDoneStages([]), []);
});

run();
