// 99-phylum-fossil-smoke.test.ts — 化石层烟囱(修正版设计:化石层=档①冻结路由+档②轨迹重放)
//
// 验证四件事:
//   H1 成功轨迹沉积为槽位化化石模板 + JSON 持久化读回(跨会话墓园)
//   H2 重放命中:零 LLM、断言 gate 照跑、hit 记账清零 miss
//   H3 重放失败(环境漂移):槽位抽不出 → miss 记账 → FOSSIL_MISS_RETIRE=2 次后退役
//   H4 (档①)收敛判定 isConverged:近窗达标支系才放行冻结路由
//
// 全链确定性:mock 工具 + 无 rng 路径,不碰真实模型、不依赖 LLM。

import { test, run } from './harness';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeneRegistry } from '../../src/main/V5/registry';
import { replay, extractSlots, fillSlot } from '../../src/main/V5/replay';
import {
  FOSSIL_MISS_RETIRE, CONVERGE_MIN_TRIALS, MAX_FOSSILS_PER_SIGNATURE,
  type TraceStep, type TraceTemplate,
} from '../../src/main/V5/phylum-types';
import { signatureOfTemplateWeighted } from '../../src/main/V5/signature';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool, ToolCtx } from '../../src/main/tools';

/** 构造一笔成功结算所需的 Genome + RunOutcome(直接推 settle,绕过 LLM)。
 *  传 templateId(非签名):signatureOfTemplate 非幂等,生产路径只在出生/查找时各签一次。 */
function makeSuccess(reg: GeneRegistry, templateId: string, trace: TraceStep[]): void {
  const g = reg.spawnFounder(templateId);
  // 直接把 founder 顶到成功态:settle 只看 outcome.success + 支系账本
  reg.debugFillLedger(signatureOfTemplateWeighted(templateId, 'light'), 8, 7); // 近窗 7/8 = 0.875 ≥ 0.8(存款线)
  reg.settle({
    success: true, aborted: false, cause: 'none', steps: 3, tokens: 0,
    lastOutput: 'ok', trace, finished: true, detail: 'task example for fossil',
  }, g, { cause: 'none' });
}

test('H1: 成功轨迹沉积化石 → 同签名取回 → JSON 持久化读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v5fossil-'));
  const sig = signatureOfTemplateWeighted('fossil-h1', 'light');
  let reg = new GeneRegistry({ rng: () => 0.5, dataDir: dir });
  makeSuccess(reg, 'fossil-h1', [
    { tool: 'read_file', args: { path: '/tmp/in.txt' } },
    { tool: 'shell', args: { command: 'cp /tmp/in.txt /tmp/out.txt' } },
  ]);
  const tpl = reg.templateBySignature(sig);
  assert.ok(tpl, '成功结算后应有化石模板');
  assert.equal(tpl!.steps.length, 2);
  assert.ok(tpl!.slots.length > 0, 'trace 参数里应有可抽槽位');
  assert.equal(reg.templatesCount(), 1);

  // 持久化:新 registry 同 dataDir 读回
  reg = new GeneRegistry({ rng: () => 0.5, dataDir: dir });
  assert.equal(reg.templatesCount(), 1, 'templates.json 应跨实例读回');
  assert.ok(reg.templateBySignature(sig), '签名索引应完好');
});

test('H2: 重放命中链路(extractSlots → replay)→ 断言 gate + hit 记账', async () => {
  const reg = new GeneRegistry({ rng: () => 0.5 });
  const sig = signatureOfTemplateWeighted('fossil-h2', 'light');
  const trace: TraceStep[] = [
    { tool: 'read_file', args: { path: '/tmp/in.txt' } },
    { tool: 'shell', args: { command: 'echo done' } },
  ];
  makeSuccess(reg, 'fossil-h2', trace);
  const tpl = reg.templateBySignature(sig)!;
  assert.ok(tpl);

  const tools: Tool[] = [{
    name: 'read_file', description: '', parameters: {},
    async run(args: Record<string, unknown>) { return `读取 ${args.path}`; },
  }, {
    name: 'shell', description: '', parameters: {}, async run() { return 'stdout\n[exit:0]'; },
  }];
  const ctx: ToolCtx = { cwd: '/tmp', confirm: async () => true };

  // 槽位抽取:新任务含 path 形状 → 重放应全步命中
  const task = '处理 /tmp/new-input.txt 文件并回显';
  const report = await replay(tpl, task, tools, [], ctx);
  assert.ok(report.hit, `重放应命中(miss=${JSON.stringify(report.miss)})`);
  assert.equal(report.steps, 2);
  reg.noteReplay(tpl.id, true);
  const after = reg.templateBySignature(sig)!;
  assert.equal(after.replayMisses, 0, 'hit 后 miss 清零');
  assert.ok(after.replayHits >= 1);
});

test('H3: 任务漂移 → 槽位缺失 → miss ×2 → 化石退役', async () => {
  const reg = new GeneRegistry({ rng: () => 0.5 });
  const sig = signatureOfTemplateWeighted('fossil-h3', 'light');
  const trace: TraceStep[] = [
    { tool: 'shell', args: { command: 'grep -c ERROR /var/log/app-2026-10-13.log' } },
  ];
  makeSuccess(reg, 'fossil-h3', trace);
  const tpl = reg.templateBySignature(sig)!;
  assert.ok(tpl, '化石已沉积');

  // 漂移任务:抽不出任何槽位 → replay 直接 miss(不开口问 LLM——它不在场)
  reg.noteReplay(tpl.id, false);
  reg.noteReplay(tpl.id, false);
  assert.equal(reg.templateBySignature(sig), undefined, `连续 ${FOSSIL_MISS_RETIRE} 次 miss 应退役`);
});

test('H4: 收敛判定 isConverged(档①冻结路由门)', () => {
  const reg = new GeneRegistry({ rng: () => 0.5 });
  const sig = signatureOfTemplateWeighted('converge-h4', 'light');
  const g = reg.spawnFounder('converge-h4');
  assert.equal(g.signature, sig, 'spawnFounder 内部签名一次,与外部一致');
  assert.equal(reg.isConverged(sig), false, '无账本数据不收敛');

  reg.debugFillLedger(sig, CONVERGE_MIN_TRIALS, CONVERGE_MIN_TRIALS);
  assert.equal(reg.isConverged(sig), true, '近窗 100% 且 trials 够 → 收敛');

  reg.debugFillLedger(sig, 10, 5);
  assert.equal(reg.isConverged(sig), false, '成功率低于存款线 → 不收敛');
});

test('H5 化石竞争:同签名多路线并存,连续 miss 只退役该路线', () => {
  const reg = new GeneRegistry({ rng: () => 0.5 });
  const sig = signatureOfTemplateWeighted('fossil-h5', 'light');
  makeSuccess(reg, 'fossil-h5', [{ tool: 'read_file', args: { path: '/tmp/a.txt' } }]);
  makeSuccess(reg, 'fossil-h5', [{ tool: 'shell', args: { command: 'grep x /tmp/a.txt' } }]);
  assert.equal(reg.templatesBySignature(sig).length, 2, '两条不同路线应并存竞争');
  assert.equal(reg.templatesCount(), 2);

  const ranked = reg.templatesBySignature(sig);
  assert.ok(ranked[0].bornAt >= ranked[1].bornAt, '口碑同分时新模板优先曝光');
  const first = ranked[0];

  reg.noteReplay(first.id, false);
  reg.noteReplay(first.id, false);
  assert.equal(reg.templatesBySignature(sig).length, 1, `连续 ${FOSSIL_MISS_RETIRE} 次 miss 只退役该路线`);
  assert.notEqual(reg.templatesBySignature(sig)[0].id, first.id, '另一条路线应保留');
});

test('H6 同签名模板上限:超过上限按口碑淘汰', () => {
  const reg = new GeneRegistry({ rng: () => 0.5 });
  const sig = signatureOfTemplateWeighted('fossil-h6', 'light');
  for (let i = 0; i < 5; i++) {
    makeSuccess(reg, 'fossil-h6', [{ tool: 'shell', args: { command: `echo ${i}` } }]);
  }
  assert.equal(reg.templatesBySignature(sig).length, MAX_FOSSILS_PER_SIGNATURE);
});

test('H6c 新化石模板不饿死:untried 乐观置顶 + 沉积淘汰保护(2026-11-27 F 修复)', () => {
  const reg = new GeneRegistry({ rng: () => 0.5 });
  const sig = signatureOfTemplateWeighted('fossil-h6c', 'light');
  // 老模板:命中 1 次(口碑 >0.5)
  makeSuccess(reg, 'fossil-h6c', [{ tool: 'shell', args: { command: 'echo old' } }]);
  const oldTpl = reg.templateBySignature(sig)!;
  reg.noteReplay(oldTpl.id, true);
  // 新沉积一份模板(0/0,untried)
  makeSuccess(reg, 'fossil-h6c', [{ tool: 'shell', args: { command: 'echo new-route' } }]);
  const ranked = reg.templatesBySignature(sig);
  assert.equal(ranked.length, 2, 'F 修复前:新模板 Laplace 0.5 垫底,且满额时可能被砍');
  assert.equal(ranked[0].steps[0].args.command, 'echo new-route', 'untried 新模板应乐观置顶(至少一次探索)');
  // 试一次 miss 后回落口碑排序
  reg.noteReplay(ranked[0].id, false);
  const ranked2 = reg.templatesBySignature(sig);
  assert.equal(ranked2[0].steps[0].args.command, 'echo old', '探索结束回落口碑排序');
  // 沉积保护:老模板在场时再沉积两份新模板,untried 不被淘汰
  makeSuccess(reg, 'fossil-h6c', [{ tool: 'shell', args: { command: 'echo route-b' } }]);
  makeSuccess(reg, 'fossil-h6c', [{ tool: 'shell', args: { command: 'echo route-c' } }]);
  const after = reg.templatesBySignature(sig);
  const untriedLeft = after.filter((t) => t.replayHits === 0 && t.replayMisses === 0);
  assert.ok(untriedLeft.length >= 1, '沉积淘汰应保护 untried 模板(F 修复前新沉积立刻被 slice 砍掉)');
});
test('H6b 化石沉积用支系近窗而非累计成功率(2026-11-27 G 修复)', () => {
  const reg = new GeneRegistry({ rng: () => 0.5 });
  const sig = signatureOfTemplateWeighted('fossil-h6b', 'light');
  // 场景:早期 6 次失败把累计成功率压到 0.71,之后连赢 ——
  // 旧口径(累计 16/22=0.727)永远到不了 0.8,化石存不下;近窗口径应当沉积。
  const founder = reg.spawnFounder('fossil-h6b');
  for (let i = 0; i < 6; i++) {
    reg.settle({ success: false, aborted: false, cause: 'assertion_fail', steps: 2, tokens: 0,
      lastOutput: 'x', trace: undefined, finished: true, detail: '' }, founder, { cause: 'assertion_fail' });
  }
  // aborted 不入近窗(与 aborted 不计成败同口径):插 3 次中止,验证不影响窗口
  for (let i = 0; i < 3; i++) {
    reg.settle({ success: false, aborted: true, cause: 'timeout', steps: 2, tokens: 0,
      lastOutput: '', trace: undefined, finished: false, detail: '' }, reg.spawnFounder('fossil-h6b'), { cause: 'timeout' });
  }
  // 16 连胜:近窗 20 内 = 6 败滑出 → 16/16... 实际窗口 20 容量 = 4 败 + 16 胜 = 0.8
  const okTrace = [{ tool: 'shell', args: { command: 'echo deposit' } }] as never;
  const okOutcome = { success: true, aborted: false, cause: 'none', steps: 3, tokens: 0,
    lastOutput: 'ok', trace: okTrace, finished: true, detail: 'deposited example' };
  // 前 15 胜:窗口 4 败+15 胜=0.792 → 不沉积(累计口径此时 15/21=0.714 更低,双重不可达)
  for (let i = 0; i < 15; i++) reg.settle(okOutcome, reg.spawnFounder('fossil-h6b'), { cause: 'none' });
  const lgMid = reg.ledgerOf(founder.lineage);
  assert.ok(lgMid?.recent && lgMid.recent.length === 20, '近窗序列应有界 20');
  assert.equal(reg.templateBySignature(sig), undefined, '近窗 0.792 < 0.8 → 不沉积');
  // 第 16 胜:窗口 16 胜+4 败 = 0.8 → 沉积
  reg.settle(okOutcome, reg.spawnFounder('fossil-h6b'), { cause: 'none' });
  const tpl = reg.templateBySignature(sig);
  assert.ok(tpl, '近窗达标后应沉积化石(旧累计口径 16/22=0.727,永远达不到 0.8)');
});

test('H7 槽位抽取:引号内路径优先(支持空格 / 无扩展名)', () => {
  const slots = extractSlots([{ tool: 'read_file', args: { path: '/old/path.txt' } }]);
  assert.equal(fillSlot('读一下 "src/main/index" 并按要求改', slots[0]), 'src/main/index');
  assert.equal(fillSlot("处理 'a b.ts' 文件", slots[0]), 'a b.ts');
  assert.equal(fillSlot('处理 /tmp/new-input.txt', slots[0]), '/tmp/new-input.txt');
});

test('H8 槽位兜底:任务只给词干时用仓库索引唯一匹配', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-repo-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'foo-bar.ts'), 'export const x = 1;\n');
  const slots = extractSlots([{ tool: 'read_file', args: { path: '/old/foo-bar.ts' } }]);
  assert.equal(fillSlot('改一下 foo-bar 的样式', slots[0], dir), 'src/foo-bar.ts');
});

test('H10 重放不改写档案:slotWrite 只落私有副本,注册表模板原样(2026-11-27 污染防护)', async () => {
  const reg = new GeneRegistry({ rng: () => 0.5 });
  const sig = signatureOfTemplateWeighted('fossil-h10', 'light');
  // shell command 是 query kind → fillSlot 返回任务原文,重放必覆写(若无克隆防护)
  const trace: TraceStep[] = [{ tool: 'shell', args: { command: 'echo ORIGINAL_TASK' } }];
  makeSuccess(reg, 'fossil-h10', trace);
  const before = JSON.stringify(reg.templatesBySignature(sig)[0]);
  const tools: Tool[] = [{
    name: 'shell', description: '', parameters: {},
    async run(args: Record<string, unknown>) { return `ran: ${args.command}`; },
  }];
  const ctx: ToolCtx = { cwd: '/tmp', confirm: async () => true };
  const r = await replay(reg.templatesBySignature(sig)[0], 'BRAND_NEW_TASK', tools, [], ctx);
  assert.ok(r.hit, `query 槽位应可填充(miss=${JSON.stringify(r.miss)})`);
  assert.equal(JSON.stringify(reg.templatesBySignature(sig)[0]), before, '重放后注册表模板必须原样(档案不可变)');
});

test('H9 化石成本:口碑同分时步数更少的模板优先', () => {
  const reg = new GeneRegistry({ rng: () => 0.5 });
  const sig = signatureOfTemplateWeighted('fossil-h9', 'light');
  makeSuccess(reg, 'fossil-h9', [{ tool: 'read_file', args: { path: '/tmp/a' } }]);
  makeSuccess(reg, 'fossil-h9', [
    { tool: 'read_file', args: { path: '/tmp/b' } },
    { tool: 'shell', args: { command: 'cat /tmp/b' } },
    { tool: 'shell', args: { command: 'wc /tmp/b' } },
  ]);
  // F 修复(9b17d16)后 untried 模板乐观置顶(H6c 已覆盖该语义),步数决胜只在
  // 「已试模板口碑同分」时生效 —— 先给两份各记一次 hit 进入同口径,同时消除
  // 两次沉积跨 Date.now() 毫秒边界时 untried 内 bornAt 降序导致的偶发翻车。
  // After the F fix, untried templates rank first (covered by H6c); the
  // steps tiebreak applies to tried templates with equal reputation, so
  // record one replay hit each before asserting (also kills the same-ms flake).
  for (const t of reg.templatesBySignature(sig)) reg.noteReplay(t.id, true);
  assert.equal(reg.templatesBySignature(sig)[0].steps.length, 1, '便宜路线应排前面');
});

test('H11 重放:工具把错误当字符串返回 → 判 miss(tool_error),不假报成功', async () => {
  const reg = new GeneRegistry({ rng: () => 0.5 });
  const sig = signatureOfTemplateWeighted('fossil-h11', 'light');
  makeSuccess(reg, 'fossil-h11', [{ tool: 'read_file', args: { path: '/tmp/in.txt' } }]);
  const tpl = reg.templateBySignature(sig)!;
  const tools: Tool[] = [{
    name: 'read_file', description: '', parameters: {},
    async run() { return '读不到:/tmp/in.txt (ENOENT)'; },
  }];
  const ctx: ToolCtx = { cwd: '/tmp', confirm: async () => true };
  const r = await replay(tpl, '读 /tmp/in2.txt 并说明', tools, [], ctx);
  assert.equal(r.hit, false, '工具错误文本不得被当成命中');
  assert.equal(r.miss?.reason, 'tool_error', JSON.stringify(r.miss));
});

test('H12 重放跳过意图工具步(旧模板含 intent 调用也可安全重放)', async () => {
  const tpl: TraceTemplate = {
    version: 1, id: 'tpl-x', signature: 's', lineage: 'l',
    steps: [
      { tool: 'intent', args: { action: 'start', title: 'x' } },
      { tool: 'shell', args: { command: 'echo done' } },
    ],
    slots: [], taskExample: '', bornAt: 0, replayHits: 0, replayMisses: 0,
  };
  const calls: string[] = [];
  const tools: Tool[] = [
    { name: 'intent', description: '', parameters: {}, async run() { calls.push('intent'); return 'ok'; } },
    { name: 'shell', description: '', parameters: {}, async run() { calls.push('shell'); return 'ok\n[exit 0]'; } },
  ];
  const ctx: ToolCtx = { cwd: '/tmp', confirm: async () => true };
  const r = await replay(tpl, 'x', tools, [], ctx);
  assert.equal(r.hit, true);
  assert.deepEqual(calls, ['shell'], '意图工具步应被跳过,不执行旧 intent 调用');
});

run();
