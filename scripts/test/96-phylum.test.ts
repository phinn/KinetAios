// 96-phylum.test.ts — Phylum 最小进化单元验收(8 条验收标准,来自设计预演)。
// 全走真实模块(registry/express/bodyplan/scorer);只有 ChatFn 和工具 run 是确定性 mock。
// 契约备忘(与实现一致,勿凭想象改):
//   - 签名 = `tpl@v1:<模板id>`(signature.ts 冻结前缀)
//   - lineage = `L0-<签名>`(founder 一代);个体字段名 genomeId(非 id)
//   - founder: affinity={} 空表(未知工具动态默认 TOOL_AFFINITY_DEFAULT=0.5)、assertions=[](零先天断言,只删不增)

import { test, run, assert } from './harness';
import {
  type Genome, TOOL_CUTOFF, MUTATION_STEP, CLONE_JITTER, TOOL_AFFINITY_DEFAULT,
} from '../../src/main/V5/phylum-types';
import { GeneRegistry } from '../../src/main/V5/registry';
import { express, checkAssertions } from '../../src/main/V5/express';
import { runBodyPlan, type ChatFn, type ToolDefLike } from '../../src/main/V5/bodyplan';
import { scriptChat } from './phylum-mock';
import type { Tool } from '../../src/main/tools';
import type { AssertionDsl } from '../../src/main/V5/phylum-types';

const SIG = 'data-clean@v1';
const FSIG = `tpl@v1:${SIG}`; // 冻结后的完整签名

function assertEq(actual: unknown, expected: unknown, msg?: string): void {
  assert.strictEqual(actual, expected, msg);
}

function mkRegistry(): GeneRegistry {
  return new GeneRegistry();
}

// ── A. 冷启动 founder ────────────────────────────────────────────
test('A1 冷启动: 无匹配 → founder 诞生且零战绩不可繁殖', () => {
  const reg = mkRegistry();
  assertEq(reg.needsFounder(FSIG), true);
  const g = reg.spawnFounder(SIG);
  assertEq(g.signature, FSIG);
  assertEq(g.lineage.startsWith('L0-'), true);
  assertEq(g.generation, 0);
  assertEq(reg.needsFounder(FSIG), false);
  // founder 无战绩:不满足繁殖判据
  assertEq(reg.mayBreed(g.lineage, []), false);
});

// ── B. 死亡归因 → 定向突变位点 ───────────────────────────────────
test('B1 tool_error 归因: 肇事工具亲和下降 AFFINITY_PENALTY,其余基因位不动', () => {
  const reg = mkRegistry();
  const parent = reg.spawnFounder(SIG);
  // 未见过工具 → 动态默认 0.5;扰动后 = 0.5 - 0.15
  const child = reg.mutateFrom(parent, { cause: 'tool_error', toolName: 'shell' });
  const d = child.affinity.shell - TOOL_AFFINITY_DEFAULT;
  assertEq(Math.abs(d - (-0.15)) < 1e-9, true, `shell Δ=${d}`);
  // 其余基因位零扰动:assertions/maxSteps/granularity 原样
  assertEq(child.assertions.length, parent.assertions.length);
  assertEq(child.routing.maxSteps, parent.routing.maxSteps);
  assertEq(child.routing.granularity, parent.routing.granularity);
});

test('B1b tool_error 二次归因: 累积下降并钳制在 [0,0.95]', () => {
  const reg = mkRegistry();
  let g = reg.spawnFounder(SIG);
  for (let i = 0; i < 5; i++) g = reg.mutateFrom(g, { cause: 'tool_error', toolName: 'shell' });
  // 0.5 - 5×0.15 = -0.25 → 钳到 0
  assertEq(g.affinity.shell, 0, '五次惩罚后钳到下限 0');
});

test('B2 assertion_fail 归因: 删除被违反的断言(断言基因位只删不增)', () => {
  const reg = mkRegistry();
  const parent = reg.spawnFounder(SIG);
  // 断言唯一来源 = 人工注入(founder 零先天断言)
  parent.assertions.push({ id: 'a-exit', when: 'after_each_tool', check: { type: 'exit_code_eq', value: 0 } });
  parent.assertions.push({ id: 'a-nonempty', when: 'after_each_tool', check: { type: 'output_not_empty' } });
  const child = reg.mutateFrom(parent, { cause: 'assertion_fail', assertionId: 'a-exit' });
  assertEq(child.assertions.some((a) => a.id === 'a-exit'), false);
  assertEq(child.assertions.length, 1);
  assertEq(child.assertions[0].id, 'a-nonempty');
});

// ── C. 冠军复用(克隆) ───────────────────────────────────────────
test('C1 克隆: 同血脉+代数+1+id 唯一+亲和抖动 ≤ CLONE_JITTER', () => {
  const reg = mkRegistry();
  const p = reg.spawnFounder(SIG);
  p.affinity.shell = 0.5;
  p.affinity.read_file = 0.8;
  const c = reg.cloneFrom(p);
  assertEq(c.lineage, p.lineage);
  assertEq(c.generation, p.generation + 1);
  assertEq(c.genomeId !== p.genomeId, true);
  for (const k of Object.keys(p.affinity)) {
    const d = Math.abs(c.affinity[k] - p.affinity[k]);
    assertEq(d <= CLONE_JITTER + 1e-9, true, `${k} Δ=${d}`);
  }
  // founder 无战绩 → 无配子(冠军复用前提是成功结算)
  assertEq(reg.bestGamete(FSIG), undefined);
});

// ── D. 必需工具保护 + 饿死归因 ───────────────────────────────────
function mockTool(name: string): Tool {
  return {
    name, description: `mock ${name}`, parameters: { type: 'object', properties: {} },
    async run() { return `${name}-ok`; },
  };
}
const ALL_TOOLS = [mockTool('shell'), mockTool('read_file'), mockTool('write_file')];

test('D1 亲和过滤: shell<0.2 被摘除;必需工具被保护不摘(记入 protectedTools)', () => {
  const reg = mkRegistry();
  let g = reg.spawnFounder(SIG);
  for (let i = 0; i < 3; i++) g = reg.mutateFrom(g, { cause: 'tool_error', toolName: 'shell' });
  // 0.5 - 3×0.15 = 0.05 < 0.2
  assertEq(g.affinity.shell < TOOL_CUTOFF, true, `shell=${g.affinity.shell}`);
  const ex1 = express(g, ALL_TOOLS, []);
  assertEq(ex1.tools.some((t) => t.name === 'shell'), false);
  assertEq(ex1.removedTools.includes('shell'), true);
  // 同一基因,任务必需 shell → 保护不摘,但显式记账
  const ex2 = express(g, ALL_TOOLS, ['shell']);
  assertEq(ex2.tools.some((t) => t.name === 'shell'), true);
  assertEq(ex2.protectedTools.includes('shell'), true);
});

test('D2 essential_tool_missing 归因: 全表回升 + 缺失工具拉到 0.3(环境教育)', () => {
  const reg = mkRegistry();
  let g = reg.spawnFounder(SIG);
  g.affinity.shell = 0.1;   // 将被摘除
  g.affinity.read_file = 0.2;
  const child = reg.mutateFrom(g, { cause: 'essential_tool_missing', missingTool: 'shell', removedTools: ['shell'] });
  assertEq(child.affinity.shell, 0.3, '缺失工具直接拉到 0.3');
  assertEq(Math.abs(child.affinity.read_file - 0.3) < 1e-9, true, `read_file=0.2+0.1回升,实际 ${child.affinity.read_file}`);
});

// ── E. 断言 DSL 确定性检查 ───────────────────────────────────────
function A(check: AssertionDsl, id = 'a'): { id: string; when: 'after_each_tool'; check: AssertionDsl } {
  return { id, when: 'after_each_tool', check };
}
test('E1 断言 gate: exit_code_eq / output_not_empty / line_count_gt / 坏正则 确定性判定', () => {
  assertEq(checkAssertions([A({ type: 'exit_code_eq', value: 0 })], { name: 'shell', output: 'x', exitCode: 1 })?.id, 'a');
  assertEq(checkAssertions([A({ type: 'exit_code_eq', value: 0 })], { name: 'shell', output: 'x', exitCode: 0 }), null);
  assertEq(checkAssertions([A({ type: 'output_not_empty' })], { name: 'shell', output: '  \n' })?.id, 'a');
  assertEq(checkAssertions([A({ type: 'line_count_gt', value: 2 })], { name: 'shell', output: '1' })?.id, 'a');
  assertEq(checkAssertions([A({ type: 'line_count_gt', value: 2 })], { name: 'shell', output: '1\n2\n3' }), null);
  // 坏正则 → 视为违规(死因归因会把这条删掉,防脏断言存活)
  assertEq(checkAssertions([A({ type: 'regex_contains', pattern: '[' })], { name: 'x', output: 'ok' })?.id, 'a');
});

// ── F/G. bodyplan 全链路(mock chat + 真 bodyplan + 真 registry 结算) ──
const shellOk: ChatFn = scriptChat([
  { toolName: 'shell', args: { cmd: 'echo phylum-ok' } },
  { content: 'done: phylum-ok' },
]);

test('F1 bodyplan 成功路径: 工具真跑 + cause=success + 结算入账', async () => {
  const reg = mkRegistry();
  const g = reg.spawnFounder(SIG);
  const r = await runBodyPlan({
    chat: shellOk,
    tools: ALL_TOOLS,
    task: '回显 phylum-ok',
    body: express(g, ALL_TOOLS, ['shell']),
    cwd: '/tmp/phylum-test-f1',
  });
  assertEq(r.aborted, false);
  // 生产语义:有工具轨迹的自然完成 = success(bodyplan 自裁);
  // 实验路径 grader 仍可在 runner 层否决(runner 映射为 wrong_answer + 归因)。
  assertEq(r.success, true);
  assertEq(r.cause, 'none');
  assertEq(r.finished, true);
  assertEq(r.lastOutput.includes('phylum-ok'), true, `lastOutput=${r.lastOutput}`);
  // 结算 1 条成功 → 支系账本 1/1
  reg.settle({
    taskId: 'f1', signature: FSIG, genomeId: g.genomeId, lineage: g.lineage,
    generation: g.generation, success: true, aborted: false, cause: 'none',
    steps: r.steps, tokens: r.tokens, detail: '',
  }, g, { cause: 'none' });
  const lg = reg.ledgerOf(g.lineage);
  assertEq(lg?.trials, 1);
  assertEq(lg?.successes, 1);
});

test('F2 断言拦截: 重试一次仍败 → cause=assertion_fail + 归因删除该断言', async () => {
  const reg = mkRegistry();
  const g = reg.spawnFounder(SIG);
  g.assertions.push({ id: 'a-nonempty', when: 'after_each_tool', check: { type: 'output_not_empty' } });
  // mock 工具:echo -n 输出空 → 触发 output_not_empty;两次都空 → 重试后判死
  const chat: ChatFn = scriptChat([
    { toolName: 'shell', args: { cmd: 'echo -n ""' } },
    { toolName: 'shell', args: { cmd: 'echo -n ""' } },
    { content: 'give up' },
  ]);
  const tools = ALL_TOOLS.map((t) => t.name === 'shell' ? { ...t, run: async () => '' } : t);
  const r = await runBodyPlan({
    chat, tools,
    task: '产生非空输出',
    body: express(g, tools, ['shell']),
    cwd: '/tmp/phylum-test-f2',
  });
  assertEq(r.cause, 'assertion_fail');
  assertEq(r.violatedAssertionId, 'a-nonempty');
  // 死亡归因:子代删除该断言,另一条保留
  g.assertions.push({ id: 'a-keep', when: 'after_each_tool', check: { type: 'exit_code_eq', value: 0 } });
  const child = reg.mutateFrom(g, { cause: 'assertion_fail', assertionId: r.violatedAssertionId });
  assertEq(child.assertions.some((a) => a.id === 'a-nonempty'), false);
  assertEq(child.assertions.some((a) => a.id === 'a-keep'), true);
});

test('G1 账本对账不变量: N 次结算 Σtrials=N 且 successes 精确', () => {
  const reg = mkRegistry();
  const g = reg.spawnFounder(SIG);
  for (let i = 0; i < 5; i++) {
    reg.settle({
      taskId: `g1-${i}`, signature: FSIG, genomeId: g.genomeId, lineage: g.lineage,
      generation: g.generation, success: i % 2 === 0, aborted: false,
      cause: i % 2 === 0 ? 'none' : 'tool_error',
      steps: 3, tokens: 100, detail: '',
    }, g, i % 2 === 0 ? { cause: 'none' } : { cause: 'tool_error', toolName: 'shell' });
  }
  const lg = reg.ledgerOf(g.lineage);
  assertEq(lg?.trials, 5);
  assertEq(lg?.successes, 3);
  assertEq(lg?.trials, (lg?.successes ?? 0) + 2, 'trials = successes + failures');
  const st = reg.stats();
  assertEq(st.fossils, 2, '两次失败 → 化石层 2 条');
});

test('G2 abort 零污染: 中止=无痕死亡(个体移出活体、零账本/配子/化石/归因)', () => {
  const reg = mkRegistry();
  const g = reg.spawnFounder(SIG);
  reg.settle({
    taskId: 'g2', signature: FSIG, genomeId: g.genomeId, lineage: g.lineage,
    generation: g.generation, success: false, aborted: true, cause: 'aborted',
    steps: 1, tokens: 50, detail: '外部中止',
  }, g, { cause: 'aborted' });
  const lg = reg.ledgerOf(g.lineage);
  assertEq(lg?.trials ?? 0, 0);
  assertEq(lg?.successes ?? 0, 0);
  assertEq(reg.fossilCount(), 0, '中止不进化石(死因非基因之过,不归档)');
  assertEq(reg.liveBySignature(FSIG).some((x) => x.genomeId === g.genomeId), false, '中止=个体死亡:被污染的 context 不复活');
  assertEq(reg.gameteCount(), 0, '中止不留配子');
  assertEq(lg?.aborted, 1, '审计计数独立记账');
});

test('F3 provider 挂起: quota 429(5h 窗口满)→ provider_suspended,个体无罪不记账', async () => {
  const reg = mkRegistry();
  const g = reg.spawnFounder(SIG);
  const gid = g.genomeId;
  assert.equal(reg.fitnessOf(gid)?.trials ?? 0, 0);
  const { GLMError } = await import('../../src/main/glm');
  const body = express(g, [], [], 6);
  // chat 直接抛 429 quota(用户实录场景);工具本可执行,但 LLM 一开口就挂
  const r = await runBodyPlan({
    task: 't', body, tools: [],
    chat: async () => { throw new GLMError('http', 429, '已达到 5 小时的使用上限', 'quota'); },
  });
  assert.equal(r.cause, 'provider_suspended', 'quota 必须走挂起通道,不是 tool_error');
  assert.equal(r.aborted, true, '挂起=aborted:settle 只记 aborted,不记 trial/疤');

  // 结算通路核对:挂起只进 aborted 桶,trials/successes/归因疤痕零污染
  reg.settle({ taskId: 'f3', signature: FSIG, genomeId: gid, lineage: g.lineage,
    generation: 0, success: r.success, aborted: r.aborted, cause: r.cause,
    steps: r.steps, tokens: r.tokens, detail: r.detail }, g, { cause: 'provider_suspended' });
  const f = reg.fitnessOf(gid);
  assert.equal(f?.trials, 0, '挂起不得记 trial');
  assert.equal(f?.aborted, 1, '挂起只进 aborted 桶');

  // 断网同理(network):世界停了 ≠ 个体的错
  const r2 = await runBodyPlan({
    task: 't', body, tools: [],
    chat: async () => { throw new Error('fetch failed: connect ECONNRESET'); },
  });
  assert.equal(r2.cause, 'provider_suspended');

  // 对照:普通 chat 异常仍归 tool_error(保真突变信号)
  const r3 = await runBodyPlan({
    task: 't', body, tools: [],
    chat: async () => { throw new Error('malformed tool call: missing arguments'); },
  });
  assert.equal(r3.cause, 'tool_error', '非 provider 类 chat 异常仍按个体错误处理');
});

run();
