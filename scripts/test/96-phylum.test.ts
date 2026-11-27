// 96-phylum.test.ts — Phylum 最小进化单元验收(8 条验收标准,来自设计预演)。
// 全走真实模块(registry/express/bodyplan/scorer);只有 ChatFn 和工具 run 是确定性 mock。
// 契约备忘(与实现一致,勿凭想象改):
//   - 签名 = `tpl@v1:<模板id>`(signature.ts 冻结前缀)
//   - lineage = `L0-<签名>`(founder 一代);个体字段名 genomeId(非 id)
//   - founder: affinity={} 空表(未知工具动态默认 TOOL_AFFINITY_DEFAULT=0.5)、assertions=[](零先天断言,只删不增)

import { test, run, assert } from './harness';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type Genome, TOOL_CUTOFF, MUTATION_STEP, CLONE_JITTER, TOOL_AFFINITY_DEFAULT, GRANULARITY_HINT_STEP,
} from '../../src/main/V5/phylum-types';
import { GeneRegistry, repoKeyOf } from '../../src/main/V5/registry';
import { express, checkAssertions } from '../../src/main/V5/express';
import { runBodyPlan, type ChatFn, type ToolDefLike } from '../../src/main/V5/bodyplan';
import { signatureOfTemplateWeighted } from '../../src/main/V5/signature';
import { HEAVY_FOUNDER_STEPS } from '../../src/main/V5/registry';
import { scriptChat } from './phylum-mock';
import { abCompare } from '../../src/main/V5/runner';
import { runBench, shouldSwap } from '../../src/main/V5/bench';
import type { Tool } from '../../src/main/tools';
import type { AssertionDsl } from '../../src/main/V5/phylum-types';

const SIG = 'data-clean@v1';
const FSIG = signatureOfTemplateWeighted(SIG, 'light'); // 冻结后的完整签名(分池后带重量后缀)

function assertEq(actual: unknown, expected: unknown, msg?: string): void {
  assert.strictEqual(actual, expected, msg);
}
function assertNotEq(actual: unknown, expected: unknown, msg?: string): void {
  assert.notStrictEqual(actual, expected, msg);
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
test('A9 重量分池: heavy/light 同模板不同签名,founder/账本/化石互不串池', () => {
  const reg = mkRegistry();
  const sigH = signatureOfTemplateWeighted('kx', 'heavy');
  const sigL = signatureOfTemplateWeighted('kx', 'light');
  assertNotEq(sigH, sigL);

  // light 池先出生 founder(12 步),heavy 池冷启动自己发 founder(maxSteps=60),
  // 两池活体/配子完全隔离 —— 12 步个体不会再被派去干小时级任务。
  const fl = reg.spawnFounder('kx', 'light');
  assertEq(fl.routing.maxSteps, 12);
  const fh = reg.spawnFounder('kx', 'heavy');
  assertEq(fh.routing.maxSteps, HEAVY_FOUNDER_STEPS);
  assertEq(sigH, fh.signature);
  assertEq(reg.liveBySignature(sigL).length, 1);
  assertEq(reg.liveBySignature(sigH).length, 1);
});
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

test('B1c 参数类失败(bad_args/edit_mismatch):不惩罚工具亲和,改为拆细 + 文字疤痕', () => {
  const reg = mkRegistry();
  const parent = reg.spawnFounder(SIG);
  const g0 = parent.routing.granularity;
  const bad = reg.mutateFrom(parent, { cause: 'tool_error', toolName: 'edit_file', errorKind: 'edit_mismatch' });
  assertEq(bad.affinity.edit_file, undefined, '参数类失败不得写入亲和惩罚');
  assertEq(Math.abs(bad.routing.granularity - (g0 + GRANULARITY_HINT_STEP)) < 1e-9, true, `granularity=${bad.routing.granularity}`);
  assert.ok(bad.scarNote?.includes('old_string'), `疤痕应指出具体坑: ${bad.scarNote}`);
  assert.ok(express(bad, ALL_TOOLS, []).instinctPrompt.includes('疤痕'), '疤痕必须进本能 prompt');
});

test('B1d 环境类失败(not_found/permission):零基因扰动、零疤痕', () => {
  const reg = mkRegistry();
  const parent = reg.spawnFounder(SIG);
  const child = reg.mutateFrom(parent, { cause: 'tool_error', toolName: 'read_file', errorKind: 'not_found' });
  assertEq(child.affinity.read_file ?? TOOL_AFFINITY_DEFAULT, TOOL_AFFINITY_DEFAULT);
  assertEq(child.routing.granularity, parent.routing.granularity);
  assertEq(child.scarNote, undefined);
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

test('E2 真实 shell 的 [exit 0] 能触发基因断言(修前只认 [exit:0])', async () => {
  const reg = mkRegistry();
  const g = reg.spawnFounder(SIG);
  g.assertions.push(A({ type: 'exit_code_eq', value: 0 }));
  const tools = ALL_TOOLS.map((t) => t.name === 'shell' ? { ...t, run: async () => 'ok\n[exit 0]\n' } : t);
  const chat = scriptChat([{ toolName: 'shell', args: { cmd: 'true' } }, { content: 'done' }]);
  const r = await runBodyPlan({
    chat, tools, task: 'x', body: express(g, tools, ['shell']), cwd: '/tmp/phylum-test-e2',
  });
  assert.equal(r.success, true, `真实 [exit 0] 不应被断言误杀: ${r.detail}`);

  const bad = ALL_TOOLS.map((t) => t.name === 'shell' ? { ...t, run: async () => 'boom\n[exit 1]\n' } : t);
  const g2 = reg.spawnFounder(SIG);
  g2.assertions.push(A({ type: 'exit_code_eq', value: 0 }));
  const chat2 = scriptChat([
    { toolName: 'shell', args: { cmd: 'false' } },
    { toolName: 'shell', args: { cmd: 'false' } },
    { content: 'give up' },
  ]);
  const r2 = await runBodyPlan({
    chat: chat2, tools: bad, task: 'x', body: express(g2, bad, ['shell']), cwd: '/tmp/phylum-test-e2',
  });
  assert.equal(r2.cause, 'assertion_fail', `[exit 1] 应被 exit_code_eq 拦住, got ${r2.cause}`);
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

test('F5 挂起语义端到端: 个体留活体池 + state.json 跨重启恢复(续跑不重开)', async () => {
  // 层1:挂起后个体仍在池里(旧 bug:settle 提前执行把它踢出池,UI 却说"保留在活体池")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phylum-f5-'));
  const reg = new GeneRegistry({ dataDir: dir });
  const g = reg.spawnFounder(SIG);
  const gid = g.genomeId;

  // 模拟生产路径的挂起处理:settle 被跳过(修复后 index.ts 直接 return)
  const f0 = reg.fitnessOf(gid);
  assert.equal(f0?.trials ?? 0, 0, '挂起零记账');
  assert.equal(reg.liveBySignature(FSIG).length, 1, '挂起个体必须仍在活体池');

  // 层2:重启(app 退出 → 新 GeneRegistry)后活体池从 state.json 恢复,同基因续跑
  const reg2 = new GeneRegistry({ dataDir: dir });
  const live = reg2.liveBySignature(FSIG);
  assert.equal(live.length, 1, '重启后挂起个体从 state.json 恢复');
  assert.equal(live[0].genomeId, gid, '同基因续跑(不是新 founder)');
  assert.equal(live[0].routing.maxSteps, 12, '基因位原样保留');

  // 层3:挂起个体死亡结算后 state.json 同步落盘(账本持久)
  reg2.settle({ taskId: 'f5', signature: FSIG, genomeId: gid, lineage: g.lineage,
    generation: 0, success: true, aborted: false, cause: 'none', steps: 3, tokens: 100,
    detail: 'ok' }, live[0], { cause: 'none' });
  const reg3 = new GeneRegistry({ dataDir: dir });
  assert.equal(reg3.ledgerOf(g.lineage)?.trials, 1, '结算后账本跨重启持久');
  assert.equal(reg3.liveBySignature(FSIG).length, 0, '已结算个体不再在池');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── H. 机制级熔断(2026-10-13 443 步/409 shell 事故的三道保险丝) ──
test('F6 重复动作熔断: 连续相同调用×3 → step_budget 判死', async () => {
  const loop: ChatFn = scriptChat(
    Array.from({ length: 10 }, () => ({ toolName: 'shell', args: { cmd: 'sleep 3600' } })));
  const reg = mkRegistry();
  const g = reg.spawnFounder(SIG);
  const r = await runBodyPlan({
    chat: loop, tools: ALL_TOOLS, task: '死循环任务',
    body: express(g, ALL_TOOLS, ['shell']),
    cwd: '/tmp/phylum-test-f6',
  });
  assert.equal(r.success, false);
  assert.equal(r.aborted, false);
  assert.equal(r.cause, 'step_budget');
  assert.ok(r.detail!.includes('重复'), `detail 应标明重复熔断, got: ${r.detail}`);
  assert.ok(r.steps! <= 4, `应在 ≤4 步内熔断, got steps=${r.steps}`);
});

test('F7(重写)进度门已删: 40+ 步长任务不再半路冤死,跑满宿主墙才停', async () => {
  // 每步都不同(绕开重复熔断),永远不收口 → 应跑满基因墙 40 步
  let n = 0;
  const wander: ChatFn = async () => ({ content: '', toolCalls: [
    { id: `w${++n}`, name: 'shell', arguments: JSON.stringify({ cmd: `echo ${n}` }) }],
    rawAssistant: { role: 'assistant', content: '', tool_calls: [] },
  } as never);
  const reg = mkRegistry();
  const g = reg.spawnFounder(SIG);
  g.routing.maxSteps = 40;
  const r = await runBodyPlan({
    chat: wander, tools: ALL_TOOLS, task: '漫游不收口',
    body: express(g, ALL_TOOLS, ['shell']),
    cwd: '/tmp/phylum-test-f7',
  });
  assert.equal(r.cause, 'step_budget');
  assert.equal(r.steps, 40, `应跑满基因墙 40(旧进度门会在 24 冤死), got ${r.steps}`);
});

test('F7b 宿主无限语义: express ceil=0 → 硬墙 200,基因 12 不再封顶', async () => {
  const g = mkRegistry().spawnFounder(SIG); // founder 基因 12
  const body = express(g, ALL_TOOLS, ['shell'], 0);
  assert.equal(body.maxSteps, 200, `无限模式应表达为硬墙 200, got ${body.maxSteps}`);
});

test('F8 步数墙硬上限: 基因 maxSteps=9999 被夹到 200', async () => {
  const g = mkRegistry().spawnFounder(SIG);
  g.routing.maxSteps = 9999; // 模拟失控进化出的超预算基因
  const body = express(g, ALL_TOOLS, ['shell']); // 缺省 ceil=STEP_BUDGET_CEIL=64
  assert.ok(body.maxSteps <= 200, `硬上限应生效, got ${body.maxSteps}`);
});

test('H1 离线 A/B:同一任务比较两个基因,按成功 → 步数裁决', async () => {
  const reg = mkRegistry();
  const parent = reg.spawnFounder(SIG);
  const child = reg.cloneFrom(parent);
  const report = await abCompare({
    task: '回显 ok', cwd: '/tmp/phylum-ab', tools: ALL_TOOLS, requiredTools: ['shell'],
    sides: [{ label: 'parent', genome: parent }, { label: 'child', genome: child }],
    chatFactory: () => scriptChat([{ toolName: 'shell', args: { cmd: 'echo ok' } }, { content: 'done' }]),
  });
  assert.equal(report.rows.length, 2);
  assert.equal(report.rows.every((r) => r.success), true, '两基因都应跑通');
  assert.ok(report.winner === 'parent' || report.winner === 'child', `winner=${report.winner}`);
});

test('B3 追溯否决:配子 rejections+1,连续 2 次出池并留疤', () => {
  const reg = mkRegistry();
  const g = reg.spawnFounder(SIG);
  reg.settle({
    taskId: 'b3', signature: g.signature, genomeId: g.genomeId, lineage: g.lineage,
    generation: g.generation, success: true, aborted: false, cause: 'none', steps: 2, tokens: 10, detail: 'ok',
  }, g, { cause: 'none' });
  assert.ok(reg.bestGamete(g.signature), '成功结算应留下配子');

  reg.noteTurnGenome('turn-b3-1', { genomeId: g.genomeId, lineage: g.lineage, signature: g.signature });
  const r1 = reg.applyUserRejection('turn-b3-1');
  assertEq(r1.applied, true);
  assertEq(r1.retiredGene, false, '第一次否决只降权');
  assert.ok(reg.bestGamete(g.signature), '一次否决不应直接出池');

  reg.noteTurnGenome('turn-b3-2', { genomeId: g.genomeId, lineage: g.lineage, signature: g.signature });
  const r2 = reg.applyUserRejection('turn-b3-2');
  assertEq(r2.retiredGene, true, '连续两次否决 → 配子出池');
  assertEq(reg.bestGamete(g.signature), undefined);
  assert.ok(reg.scarOf(g.lineage), '出池时留下 wrong_answer 疤');
});

test('B4 成本感知:同等成功率下,每成功步数更少的配子胜出', () => {
  const reg = mkRegistry();
  const cheap = reg.spawnFounder(SIG);
  const pricey = reg.spawnFounder(SIG);
  const settle = (g: Genome, steps: number) => reg.settle({
    taskId: 'b4', signature: g.signature, genomeId: g.genomeId, lineage: g.lineage,
    generation: 0, success: true, aborted: false, cause: 'none',
    steps, tokens: steps * 100, detail: 'ok',
  }, g, { cause: 'none' });
  settle(cheap, 2);
  settle(pricey, 9);
  assertEq(reg.bestGamete(cheap.signature)?.genome.genomeId, cheap.genomeId);
});

test('F9 化石轨迹只收成功动作:失败调用不进 trace', async () => {
  let n = 0;
  const tools = ALL_TOOLS.map((t) => t.name === 'shell'
    ? { ...t, run: async () => (++n === 1 ? '❌ 命令失败' : 'ok\n[exit 0]') }
    : t);
  const chat = scriptChat([
    { toolName: 'shell', args: { cmd: 'a' } },
    { toolName: 'shell', args: { cmd: 'b' } },
    { content: 'done' },
  ]);
  const g = mkRegistry().spawnFounder(SIG);
  const r = await runBodyPlan({ chat, tools, task: 'x', body: express(g, tools, ['shell']), cwd: '/tmp/phylum-f9' });
  assertEq(r.success, true);
  assertEq(r.trace?.length, 1, `失败动作不应进化石: ${JSON.stringify(r.trace)}`);
});

test('H2 离线评测任务集:被摘除工具的基因成功率下降', async () => {
  const reg = mkRegistry();
  const good = reg.spawnFounder(SIG);
  const bad = reg.cloneFrom(good);
  bad.affinity.shell = 0.1;
  bad.affinity.web_search = 0.1;
  const report = await runBench({
    sides: [{ label: 'good', genome: good }, { label: 'bad', genome: bad }],
  });
  const g = report.summary.find((s) => s.label === 'good')!;
  const b = report.summary.find((s) => s.label === 'bad')!;
  assert.ok(g.successes > b.successes, `good=${g.successes} bad=${b.successes}`);
  assertEq(report.winner, 'good');
});

test('B5 仓库级疤痕:参数类跨签名传递,环境类不传', () => {
  const reg = mkRegistry();
  reg.recordRepoScar('/repo-a', { cause: 'tool_error', toolName: 'edit_file', errorKind: 'edit_mismatch' });
  const seed = reg.repoScarOf('/repo-a');
  assert.ok(seed);
  const child = reg.spawnFounder('other-task', 'light', seed);
  assert.ok(child.routing.granularity > 0.7, '参数类疤痕应抬高粒度');
  assert.ok(child.scarNote?.includes('old_string'));
  reg.recordRepoScar('/repo-b', { cause: 'tool_error', toolName: 'read_file', errorKind: 'not_found' });
  assert.equal(reg.repoScarOf('/repo-b'), null, '环境类不进仓库疤痕');
});

test('H3 失败注入:重试任务能测出步数预算差异', async () => {
  const reg = mkRegistry();
  const normal = reg.spawnFounder(SIG);
  const tight = reg.spawnFounder(SIG);
  tight.routing.maxSteps = 1;
  const tasks = [{ id: 'retry', prompt: '命令偶发失败后重试', tools: ['shell'], failFirst: { tool: 'shell', times: 1 } }];
  const report = await runBench({
    sides: [{ label: 'normal', genome: normal }, { label: 'tight', genome: tight }],
    tasks,
  });
  assertEq(report.summary.find((s) => s.label === 'normal')!.successes, 1);
  assertEq(report.summary.find((s) => s.label === 'tight')!.successes, 0);
});

test('B6 仓库疤痕 key:子目录归一到 git 根 + 7 天 TTL 过期', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phylum-repo-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  const root = repoKeyOf(dir);
  assertEq(root, dir, '仓库根应解析为绝对路径');
  assertEq(repoKeyOf(path.join(dir, 'src', 'deep')), root, '子目录应归一到 git 根(同仓库共享疤痕)');

  const reg = mkRegistry();
  reg.recordRepoScar(path.join(dir, 'src', 'deep'), { cause: 'tool_error', toolName: 'edit_file', errorKind: 'edit_mismatch' });
  assert.ok(reg.repoScarOf(path.join(dir, 'src')), '同仓库任意子目录都应读到同一份疤痕');
  reg.debugSetRepoScarAt(dir, Date.now() - 8 * 24 * 3600_000);
  assertEq(reg.repoScarOf(dir), null, '超过 7 天 TTL 应惰性过期');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('B7 未核验:只记失败样本,不杀死活体(选择压力而非处死)', () => {
  const reg = mkRegistry();
  const g = reg.spawnFounder(SIG);
  reg.recordUnverified(g, {
    taskId: 'x', signature: g.signature, genomeId: g.genomeId, lineage: g.lineage,
    generation: 0, success: false, aborted: false, cause: 'none', steps: 4, tokens: 10, detail: '',
  });
  const f = reg.fitnessOf(g.genomeId);
  assertEq(f?.trials, 1);
  assertEq(f?.successes, 0);
  const lg = reg.ledgerOf(g.lineage);
  assertEq(lg?.recent?.length, 1);
  assertEq(lg?.recent?.[0], false, '未核验应作为失败样本进近窗');
  assertEq(reg.liveBySignature(FSIG).some((x) => x.genomeId === g.genomeId), true, '未核验不杀死活体');
});

test('B8 用户否决与重放 miss 分离:noteRejection 不动 replayMisses', () => {
  const reg = mkRegistry();
  const sig = signatureOfTemplateWeighted('fossil-rej', 'light');
  const g = reg.spawnFounder('fossil-rej');
  reg.debugFillLedger(sig, 8, 7);
  reg.settle({
    taskId: 'x', signature: g.signature, genomeId: g.genomeId, lineage: g.lineage,
    generation: 0, success: true, aborted: false, cause: 'none', steps: 2, tokens: 0,
    detail: 'ok', trace: [{ tool: 'shell', args: { command: 'echo hi' } }],
  }, g, { cause: 'none' });
  const tpl = reg.templatesBySignature(sig)[0];
  assert.ok(tpl);
  reg.noteRejection(tpl.id);
  const after = reg.templatesBySignature(sig)[0];
  assertEq(after.replayMisses, 0, '用户否决不污染重放口碑');
  assertEq(after.userRejects, 1);
  reg.noteRejection(tpl.id);
  assertEq(reg.templatesBySignature(sig).length, 0, '连续 2 次否决退役');
});

test('H4b 体检换血裁决:成功率优先,打平需步数明显更低,全败不换', () => {
  assertEq(shouldSwap({ successes: 2, avgSteps: 5 }, { successes: 3, avgSteps: 9 }), true, '成功更多 → 换');
  assertEq(shouldSwap({ successes: 3, avgSteps: 5 }, { successes: 3, avgSteps: 4 }), true, '同分且步数少 1 → 换');
  assertEq(shouldSwap({ successes: 3, avgSteps: 5 }, { successes: 3, avgSteps: 4.5 }), false, '步数差距不足 1 → 不换');
  assertEq(shouldSwap({ successes: 4, avgSteps: 5 }, { successes: 3, avgSteps: 1 }), false, '冠军成功更少 → 不换');
  assertEq(shouldSwap({ successes: 0, avgSteps: 5 }, { successes: 0, avgSteps: 1 }), false, '全败不换');
});

test('F10 化石轨迹排除意图工具:intent/intent_done 不进 trace', async () => {
  const tools = [...ALL_TOOLS, mockTool('intent'), mockTool('intent_done')];
  const chat = scriptChat([
    { toolName: 'intent', args: { action: 'start', title: 'x' } },
    { toolName: 'shell', args: { cmd: 'echo ok' } },
    { toolName: 'intent_done', args: {} },
    { content: 'done' },
  ]);
  const g = mkRegistry().spawnFounder(SIG);
  const r = await runBodyPlan({ chat, tools, task: 'x', body: express(g, tools, ['shell']), cwd: '/tmp/phylum-f10' });
  assertEq(r.success, true);
  assert.deepEqual(r.trace?.map((s) => s.tool), ['shell'], '意图工具不应进入化石轨迹');
});

test('H3b 失败注入覆盖 edit_mismatch:edit_file 被摘除 → retry-edit 失败', async () => {
  const reg = mkRegistry();
  const good = reg.spawnFounder(SIG);
  const bad = reg.cloneFrom(good);
  bad.affinity.edit_file = 0.1; // < TOOL_CUTOFF → 物理不可调
  const tasks = [{ id: 'retry-edit', prompt: '编辑失配重试', tools: ['read_file', 'edit_file'], failFirst: { tool: 'edit_file', times: 1 } }];
  const report = await runBench({
    sides: [{ label: 'good', genome: good }, { label: 'bad', genome: bad }],
    tasks,
  });
  assertEq(report.summary.find((s) => s.label === 'good')!.successes, 1);
  assertEq(report.summary.find((s) => s.label === 'bad')!.successes, 0);
});

run();
