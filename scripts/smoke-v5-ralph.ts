/* 冒烟:Ralph Loop 自迭代基因型(任务级外层验收循环)。用法: npx tsx scripts/smoke-v5-ralph.ts
 * 覆盖:①mock 模型首轮验收失败 → 失败清单注入反馈 → 第二轮验收通过
 *      ②轮数熔断(永不通过的 mock)
 *      ③file_exists/regex_file_contains/file_line_count_gt 断言真实读盘
 * 跑法:cd KinetAiosWin && npx tsx scripts/smoke-v5-ralph.ts
 * (纯逻辑层,V5 实验壳不用 electron;若哪天引 better-sqlite3 再换 ELECTRON_RUN_AS_NODE)
 * 注意:mock chat 返回的是内部 Completion 形状({ content, toolCalls:[{id,name,arguments}] }),
 * 不是 OpenAI 线格式 choices[].message.tool_calls —— bodyplan 只认前者。 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runRalphLoop } from '../src/main/V5/ralph';
import type { Completion, ToolCall } from '../src/main/glm';
import type { ChatFn, Tool } from '../src/main/tools';

async function main(): Promise<void> {

  // ── mock 基础设施 ──

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-ralph-smoke-'));
  const FIXTURE = path.join(TMP, 'REPORT.md');

  // write_file 工具真实现(与 src/main/tools.ts 同语义:落盘 + 回执文本),断言才能观测到产物
  const tools: Tool[] = [
    {
      name: 'write_file',
      description: '写文件',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      run: async (args) => {
        const p = String(args.path ?? '');
        fs.writeFileSync(p, String(args.content ?? ''));
        return `written: ${p} (${String(args.content ?? '').length} bytes)`;
      },
    },
  ];

  /** mock chat:按脚本逐轮返回内部 Completion。每轮对话独立计数。 */
  function scriptedChat(script: Array<(round: number) => Partial<Completion>>): { chat: ChatFn; rounds: () => number } {
    let round = 0;
    let i = 0;
    const chat: ChatFn = async () => {
      round++;
      const step = script[Math.min(i, script.length - 1)];
      i++;
      const c = step(round);
      return {
        content: c.content ?? '',
        toolCalls: c.toolCalls ?? [],
        rawAssistant: { role: 'assistant', content: c.content ?? '' },
        tokensIn: 0, tokensOut: 0,
      };
    };
    return { chat, rounds: () => round };
  }

  const tc = (id: string, args: Record<string, unknown>): ToolCall =>
    ({ id, name: 'write_file', arguments: JSON.stringify(args) });
  /** 交卷步:无 tool_calls = bodyplan 认为任务完成,单轮结束。 */
  const done = (text = '报告已交付'): Partial<Completion> => ({ content: text });

  // ── ① 首轮失败 → 反馈 → 二轮通过 ──
  {
    fs.writeFileSync(FIXTURE, '# 报告 v1(内容不足)\n短');
    const { chat, rounds } = scriptedChat([
      // 第 1 轮:写了个不合格的文件,然后交卷
      () => ({ toolCalls: [tc('c1', { path: FIXTURE, content: '# 报告 v1(内容不足)\n短' })] }),
      () => done('写完了'),
      // 第 2 轮:按反馈重写,写出达标内容,再交卷
      () => ({ toolCalls: [tc('c2', { path: FIXTURE, content: Array.from({ length: 8 }, (_, k) => `第 ${k + 1} 行:分析结论包含关键词 PASS-ALL`).join('\n') })] }),
      () => done('按反馈补齐了'),
    ]);

    const r = await runRalphLoop({
      task: '写一份分析报告',
      cwd: TMP,
      chat,
      tools,
      maxLoops: 3,
      acceptance: {
        assertions: [
          { type: 'file_exists', path: FIXTURE },
          { type: 'regex_file_contains', path: FIXTURE, pattern: 'PASS-ALL' },
          { type: 'file_line_count_gt', path: FIXTURE, value: 5 },
        ],
      },
    });

    assert.equal(r.accepted, true, `①应验收通过,实际 ${JSON.stringify(r.loopLog.map((l) => l.verdict))}`);
    assert.equal(r.loops, 2, `①应两轮收敛,实际 ${r.loops}`);
    assert.equal(rounds(), 4, '①chat 总调用 = 2 轮 × (1 工具步 + 1 交卷步)');
    // 第一轮反馈必须点名列出失败断言
    assert.ok(r.loopLog[0]?.feedback?.includes('regex_file_contains') || r.loopLog[0]?.feedback?.includes('内容应匹配'),
      '①首轮 feedback 应包含失败断言描述');
    console.log("✅ ① 失败→反馈→二轮验收过 loops=" + r.loops, JSON.stringify(r.loopLog));
  }

  // ── ② 轮数熔断 ──
  {
    const { chat, rounds } = scriptedChat([
      () => ({ content: '我觉得完成了' }), // 空谈,不写文件
    ]);

    const r = await runRalphLoop({
      task: '不可能完成的任务',
      cwd: TMP,
      chat,
      tools,
      maxLoops: 2,
      acceptance: { assertions: [{ type: 'file_exists', path: path.join(TMP, 'NEVER-WRITTEN.txt') }] },
    });

    assert.equal(r.accepted, false, '②永不应通过');
    assert.equal(r.loops, 2, `②应在 maxLoops=2 熔断,实际 ${r.loops}`);
    assert.equal(r.stop, 'max_loops', `②停机原因应为 max_loops,实际 ${r.stop}`);
    assert.equal(rounds(), 2, '②chat 总调用应等于熔断轮数');
    assert.equal(r.loopLog.length, 2, '②loopLog 应记满两轮');
    assert.ok(r.loopLog.every((l) => l.feedback?.includes('NEVER-WRITTEN')), '②每轮反馈都应点名缺失产物');
    console.log('✅ ② 轮数熔断 stop=' + r.stop + ' loops=' + r.loops);
  }

  // ── ③ 中止语义:signal.aborted → 立即让路,不烧轮数 ──
  {
    const ac = new AbortController();
    ac.abort(); // 直接预中止:第一轮循环开头就应退出
    const { chat, rounds } = scriptedChat([
      () => ({ toolCalls: [tc('cx', { path: path.join(TMP, 'X.txt'), content: 'x' })] }),
    ]);

    const r = await runRalphLoop({
      task: '被中止的任务',
      cwd: TMP,
      chat,
      tools,
      maxLoops: 5,
      signal: ac.signal,
      acceptance: { assertions: [{ type: 'file_exists', path: path.join(TMP, 'X.txt') }] },
    });

    assert.equal(r.accepted, false);
    assert.equal(r.stop, 'aborted');
    assert.equal(rounds(), 0, '③预中止时不应发起任何 chat 调用');
    console.log('✅ ③ 中止语义 stop=' + r.stop);
  }

  // ── ④ 结算语义:Ralph run → RunOutcome → GeneRegistry(真实记账,不烧盘走内存)──
  {
    const { GeneRegistry } = await import('../src/main/V5/registry');
    const { settleRalph, ralphToOutcome, ralphAttribution } = await import('../src/main/V5/ralph-settle');
    let seed = 42;
    const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const reg = new GeneRegistry({ rng }); // 无 dataDir = 纯内存,测试不落盘

    // genome 走真实出生链:founder → Ralph → settle,与生产路径同构
    const genome = reg.spawnFounder('smoke-ralph', 'light');
    const geneAssertions = genome.assertions;

    // ④a 验收过:success 结算 → 配子池;成功不产生疤痕
    const rOk = await runRalphLoop({
      task: '两轮收敛任务', cwd: TMP, genome, chat: scriptedChat([
        () => ({ toolCalls: [tc('s1', { path: path.join(TMP, 'OK.md'), content: 'only one line' })] }),
        () => done('交卷(应被判失败)'),
        () => ({ toolCalls: [tc('s2', { path: path.join(TMP, 'OK.md'), content: 'l1\nl2\nl3\nl4\nl5\nl6 PASS' })] }),
        () => done('交卷'),
      ]).chat, tools, maxLoops: 3,
      acceptance: { assertions: [{ type: 'file_line_count_gt', path: path.join(TMP, 'OK.md'), value: 5 }] },
    });
    assert.equal(rOk.accepted, true);
    const out = settleRalph(reg, rOk, genome, 'smoke#ok');
    assert.equal(out.success, true);
    assert.equal(out.cause, 'none');
    assert.ok(reg.bestGamete(genome.signature), '④a 成功结算应留配子');
    assert.equal(reg.scarOf(genome.lineage), null, '④a 成功不应留疤');
    // RalphResult 带回基因型(结算层单一真源)
    assert.equal(rOk.genome?.genomeId, genome.genomeId);

    // ④b 轮数熔断:wrong_answer 疤痕 + 替补出生(种群不清零)
    const rFail = await runRalphLoop({
      task: '永不通过', cwd: TMP, genome, chat: scriptedChat([
        () => ({ content: '空谈,不写文件' }),
      ]).chat, tools, maxLoops: 2,
      acceptance: { assertions: [{ type: 'file_exists', path: path.join(TMP, 'NEVER.md') }] },
    });
    assert.equal(rFail.stop, 'max_loops');
    const out2 = settleRalph(reg, rFail, genome, 'smoke#fail');
    assert.equal(out2.success, false);
    assert.equal(out2.cause, 'wrong_answer');
    assert.ok(ralphAttribution(rFail).cause === 'wrong_answer');
    // 失败结算清掉活体(死亡即结算),配子替补 → 活体池应回满
    assert.equal(reg.liveBySignature(genome.signature).length >= 1, true, '④b 结算后应由冠军配子替补出生');
    console.log('✅ ④ 结算语义:配子/疤痕/替补全部记账(geneFounder assertions=' + geneAssertions.length + ')');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('🎯 smoke-v5-ralph: 4/4 PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
