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
import { GeneRegistry } from '../../src/main/V5/registry';
import { replay } from '../../src/main/V5/replay';
import {
  FOSSIL_MISS_RETIRE, CONVERGE_MIN_TRIALS,
  type TraceStep,
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

run();
