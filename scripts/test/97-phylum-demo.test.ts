// 97-phylum-demo.test.ts — 种群级烟囱实测(决定性实验的最小闭环)
//
// 核心预测:同一签名连续喂任务副本,
//   Phylum(克隆+淘汰+归因突变):第 1 轮吃缺陷死亡率,之后子代继承"疤痕"
//   (肇事工具亲和被罚到摘除线下)→ 绕开死路 → 成功率爬升;
//   Static 基线(同世界无基因层):每个副本都是全新 founder,同缺陷,恒定死亡率。
//
// 缺陷模型设计(chatFactory):先"探查"(web_search,prior 0.5 会炸)再干活(read_file 必成)。
//   基因层的作用通路:死于 web_search 的个体 → 归因 tool_error → 子代 web_search 亲和 -0.3
//   → 低于摘除线 0.2 → express() 把它从注册表物理摘除 → 模型想探查也没有这个工具
//   → 直接走 read_file 必成路线。这就是"基因表达 = 硬约束"的可观测形态。
// 全程确定性:种子化 RNG。

import assert from 'node:assert/strict';
import { test, run } from './harness';
import { Universe } from '../../src/main/V5/runner';
import { geneSnapshot } from '../../src/main/V5/phylum-types';
import type { TaskTemplate } from '../../src/main/V5/runner';

const TOOLS_PRIOR = { read_file: 1.0, shell: 1.0, web_search: 0.5 };

test('H1 种群进化: 缺陷模型在 Phylum 下死亡率递减,Static 基线恒定', async () => {
  const tpl: TaskTemplate = {
    id: 'data-clean',
    render: (v) => `读取 data-${v}.txt 并总结`,
    grade: ({ lastOutput }) => ({ success: lastOutput.length > 0, detail: '产物非空即成功' }),
    requiredTools: ['read_file'],
  };

  /** 缺陷人格:50% 概率先调 web_search 探查(炸弹),否则直接干活。 */
  const flawedPersona = ({ rng }: { rng: () => number }) => {
    return async (messages: unknown[], toolDefs: Array<{ function: { name: string } }>) => {
      void messages;
      const names = toolDefs.map((d) => d.function.name);
      const wantProbe = rng() < 0.5 && names.includes('web_search');
      const target = wantProbe ? 'web_search' : 'read_file';
      return {
        content: '',
        toolCalls: [{ id: `c-${target}`, name: target, arguments: '{}' }],
        rawAssistant: { role: 'assistant' as const, content: '', tool_calls: [{ id: `c-${target}`, type: 'function' as const, function: { name: target, arguments: '{}' } }] },
        tokensIn: 100, tokensOut: 20,
      };
    };
  };

  // ── 对照公平性:两臂共享同一份缺陷(web_search 亲和 0.7 > 摘除线 0.2,炸弹都在注册表里)。
  //    差异只剩一个变量:基因是否跨轮继承。 ──
  const sharedDefect = { web_search: 0.7 };
  const u = new Universe({ templates: [tpl], toolSuccessPrior: TOOLS_PRIOR, rng: mulberry32(7), chatFactory: flawedPersona });
  u.overrideFounderAffinity(tpl.id, sharedDefect);
  const staticRuns: number[] = [];

  const phylum: number[] = [];
  for (let round = 1; round <= 4; round++) {
    const [s] = await u.round(round, { perTask: 8 });
    phylum.push(s.successRate);
    const b = new Universe({ templates: [tpl], toolSuccessPrior: TOOLS_PRIOR, rng: mulberry32(7), chatFactory: flawedPersona });
    b.overrideFounderAffinity(tpl.id, sharedDefect);
    const [bs] = await b.round(round, { perTask: 8 });
    staticRuns.push(bs.successRate);
  }

  console.log('\n    轮次   Phylum   Static(无基因)');
  for (let i = 0; i < 4; i++) console.log(`    ${i + 1}      ${(phylum[i] * 100).toFixed(0)}%      ${(staticRuns[i] * 100).toFixed(0)}%`);
  const ev = u.evoLog();
  const toolDeaths = ev.filter((e) => e.what === 'death' && (e as { cause: string }).cause === 'tool_error').length;
  console.log(`    进化事件: founder×${ev.filter((e) => e.what === 'founder').length} death×${ev.filter((e) => e.what === 'death').length}(其中 tool_error×${toolDeaths}) gamete×${ev.filter((e) => e.what === 'gamete').length} breed×${ev.filter((e) => e.what === 'breed').length} mutate×${ev.filter((e) => e.what === 'mutate').length}`);
  console.log(`    终态: 活体 ${u.reg.stats().live} / 化石 ${u.reg.stats().fossils}`);
  const finalGene = u.reg.allLive().map(geneSnapshot)[0];
  if (finalGene) console.log(`    冠军基因: web_search 亲和=${finalGene.toolAffinity.web_search?.toFixed(2)}(摘除线 0.20) read_file=${(finalGene.toolAffinity.read_file ?? TOOLS_PRIOR.read_file)?.toFixed(2)}`);

  // 核心断言(预注册,不看数据凑):
  assert.ok(ev.some((e) => e.what === 'founder'), 'founder 诞生');
  assert.ok(toolDeaths > 0, '应有 tool_error 死亡(选择压力真实存在)');
  assert.ok(u.reg.stats().fossils > 0, '化石沉淀(死因可归因)');
  // 机制级(确定性,这是范式的核心预测):疤痕随进化单调加深,最终压到摘除线下
  // → web_search 从注册表物理消失 → 个体不再可能探查 → tool_error 死亡通断根
  const ws = finalGene?.toolAffinity.web_search;
  assert.ok(ws !== undefined && ws < 0.2, `web_search 亲和应被罚到 <0.2, 实际 ${ws}`);
  // 方向级(统计,8 样本/轮 CI 很宽,只断言总量方向):
  // Phylum 4 轮累计成功率 ≥ Static 4 轮累计(学习型种群不吃亏于裸种群)
  const pAvg = phylum.reduce((a, b) => a + b, 0) / phylum.length;
  const sAvg = staticRuns.reduce((a, b) => a + b, 0) / staticRuns.length;
  assert.ok(pAvg >= sAvg, `Phylum 累计成功率应 ≥ Static: ${(pAvg * 100).toFixed(0)}% vs ${(sAvg * 100).toFixed(0)}%`);
  // 后期(R3+R4)合计 ≥ 前期(R1+R2)合计:学习曲线方向正确
  const early = (phylum[0] + phylum[1]) / 2, late = (phylum[2] + phylum[3]) / 2;
  assert.ok(late >= early, `后期成功率应 ≥ 前期: early=${(early * 100).toFixed(0)}% late=${(late * 100).toFixed(0)}%`);
});

/** mulberry32 — 确定性 RNG(与 runner 默认一致)。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

run();
