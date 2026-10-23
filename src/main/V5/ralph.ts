// Ralph Loop:任务级自迭代循环(V5 内置拓扑,2026-10)。
// 与 Phylum 种群进化正交:进化优化「单次执行怎么跑」,Ralph 解决「一次跑不完就再来一次」——
// 同一任务让 agent 自引用迭代,直到确定性验收断言全部通过或轮数熔断。
// 来源:cursor/plugins 的 ralph-loop(Geoffrey Huntley 的 "Ralph Wiggum" 模式:
// while(!done) { agent(task) }),关键差异:验收不经 LLM 之手,复用 AssertionDsl 确定性检查。
//
// Ralph Loop: task-level self-iteration loop (a V5 topology, orthogonal to evolution).
// The genome tunes how one attempt runs; Ralph decides what happens when an attempt
// fails acceptance: re-enter with structured failure feedback, until assertions pass
// or the loop budget blows. Acceptance is deterministic (AssertionDsl), never LLM-judged.

import type { AgentEvent } from '../../shared/types';
import type { Tool } from '../tools';
import type { AssertionGene, AssertionDsl, Genome, ExpressedBody } from './phylum-types';
import { GENOME_SCHEMA_VERSION } from './phylum-types';
import { runBodyPlan, type BodyPlanResult, type ChatFn } from './bodyplan';
import { express } from './express';
import { evaluateAcceptance, type AcceptanceVerdict } from './ralph-accept';

/** Ralph 循环参数。 */
export interface RalphOpts {
  task: string;
  cwd: string;
  /** 进化路径传 Genome;纯任务路径省略 = 中性默认基因(无亲和过滤,预算顶格)。 */
  genome?: Genome;
  /** 任务级验收断言(与基因断言不同层:基因断言管每步工具输出,Ralph 验收看整轮交付物)。
   *  DSL 与基因断言同源(AssertionDsl),evaluateAcceptance 确定性裁决。 */
  acceptance: { assertions: ReadonlyArray<AssertionGene['check']> };
  /** 单轮步数预算天花板(0/缺省 = 信任基因自主预算,与 bodyplan 语义一致)。 */
  stepBudgetCeil?: number;
  /** 轮数熔断:超过即放弃(防无限自迭代烧钱)。缺省 RALPH_DEFAULT_MAX_LOOPS。 */
  maxLoops?: number;
  chat: ChatFn;
  tools: readonly Tool[];
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  /** 每轮结束回调(记账/实验观察用):轮次、验收裁决、该轮 bodyplan 产物 */
  onLoop?: (loop: number, verdict: AcceptanceVerdict, result: BodyPlanResult) => void;
}

export type { AcceptanceVerdict } from './ralph-accept';

export interface RalphResult {
  /** 验收是否最终通过 */
  accepted: boolean;
  loops: number;
  /** 停机原因:accepted=验收过;max_loops=轮数熔断;aborted=用户中止;provider_suspended=世界停摆 */
  stop: 'accepted' | 'max_loops' | 'aborted' | 'provider_suspended';
  totalSteps: number;
  totalTokens: number;
  /** 本轮 run 用的基因型(结算层 ralphToOutcome 编码成 RunOutcome 用;中性基因也带上来) */
  genome?: Genome;
  /** 最后一轮 bodyplan 产物(验收通过时即交付物;熔断时是失败残骸,供调用方审计) */
  last: BodyPlanResult | null;
  /** 每轮审计日志:轮次 + 验收裁决 + 注入下一轮的反馈文本(通过轮 feedback 为 null) */
  loopLog: Array<{ loop: number; verdict: AcceptanceVerdict; feedback: string | null }>;
}

/** Ralph 默认轮数熔断:3 轮还验收不过 = 任务定义或环境有问题,人要接手而不是机器空转。 */
export const RALPH_DEFAULT_MAX_LOOPS = 3;

/** 中性默认基因:Ralph 不强制挂进种群——调用方不给 genome 就用这份(不注册、不繁殖,纯执行参数)。 */
function defaultRalphGenome(): Genome {
  return {
    version: GENOME_SCHEMA_VERSION,
    genomeId: 'ralph-default',
    lineage: 'ralph',
    signature: 'ralph-neutral',
    routing: { maxSteps: 24, granularity: 0.5, successPrior: 0.5 },
    affinity: {}, // 空 = 全部工具按 TOOL_AFFINITY_DEFAULT 放行
    assertions: [],
    generation: 0,
    bornAt: Date.now(),
  };
}

/** 结构化反馈文本:哪几条断言没过 + 上一轮最后输出。任务文本拼接与 loopLog 共用这一份。 */
function feedbackText(verdict: AcceptanceVerdict, last: BodyPlanResult | null): string {
  return [
    '--- 上一轮自迭代未通过验收,反馈如下 ---',
    ...verdict.failed.map((f) => `- 未过断言 ${f.id}: ${f.describe}`),
    last?.lastOutput ? `上一轮最后输出(参考,勿盲从):\n${last.lastOutput.slice(0, 4000)}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * 跑 Ralph 循环:每轮 = 一次完整 bodyplan 执行(全新上下文,不携带上一轮中间过程),
 * 验收失败 → 把「哪几条断言没过 + 上一轮最后输出」结构化注入下一轮任务文本重进。
 *
 * 设计要点:
 * - 验收全确定性(evaluateAcceptance),LLM 无法说服验收门 —— 防 Goodhart 的根。
 * - 每轮新 bodyplan(新 messages):上一轮中间过程不进下一轮,只有「验收反馈 + 最后
 *   产物」进 —— 上下文不滚雪球,强迫每轮从干净状态重新规划。
 * - provider_suspended:世界停摆不是任务失败,立即停循环让上层挂起续跑,不烧轮数。
 * - 无跨调用状态:全部局部变量,可重入。
 * - 基因表达跨轮不变(进化在种群层,不在任务层):一次 express 全轮共用。
 */
export async function runRalphLoop(opts: RalphOpts): Promise<RalphResult> {
  const maxLoops = Math.max(1, opts.maxLoops ?? RALPH_DEFAULT_MAX_LOOPS);
  let totalSteps = 0;
  let totalTokens = 0;
  let last: BodyPlanResult | null = null;
  let verdict: AcceptanceVerdict = { pass: false, failed: [] };
  const loopLog: RalphResult['loopLog'] = [];
  const genome = opts.genome ?? defaultRalphGenome(); // 结算层要从 Result 拿回基因型(RalphResult.genome)
  const body: ExpressedBody = express(
    genome,
    opts.tools, [], opts.stepBudgetCeil ?? 0,
  );

  for (let loop = 1; loop <= maxLoops; loop++) {
    if (opts.signal?.aborted) {
      return { accepted: false, loops: loop, stop: "aborted", totalSteps, totalTokens, genome, last, loopLog };
    }

    // ── 任务文本:首轮原样;后续轮 = 原任务 + 结构化验收反馈(feedbackText 单一真源)──
    const taskText = loop === 1 ? opts.task : [opts.task, '', feedbackText(verdict, last)].join('\n');

    opts.onEvent?.({ type: 'status', text: `🔁 ralph 第 ${loop}/${maxLoops} 轮 — 执行中` });

    const result = await runBodyPlan({
      task: taskText,
      cwd: opts.cwd,
      body: { ...body, instinctPrompt: ralphInstinct(loop, maxLoops) },
      genome: opts.genome ?? defaultRalphGenome(),
      chat: opts.chat,
      tools: opts.tools,
      signal: opts.signal,
      onEvent: opts.onEvent,
    });
    totalSteps += result.steps;
    totalTokens += result.tokens;
    last = result;

    // ── provider 挂起:世界停摆,整条循环立即让路(不烧轮数、不算失败)──
    if (result.cause === 'provider_suspended') {
      return { accepted: false, loops: loop, stop: "provider_suspended", totalSteps, totalTokens, genome, last, loopLog };
    }
    if (result.aborted) {
      return { accepted: false, loops: loop, stop: "aborted", totalSteps, totalTokens, genome, last, loopLog };
    }

    // ── 验收 gate:确定性,不经 LLM ──
    verdict = evaluateAcceptance(opts.acceptance, opts.cwd, result);
    loopLog.push({ loop, verdict, feedback: verdict.pass ? null : feedbackText(verdict, last) });
    opts.onLoop?.(loop, verdict, result);
    if (verdict.pass) {
      opts.onEvent?.({ type: 'status', text: `✅ ralph 第 ${loop} 轮验收通过(${totalSteps} 步 / ${maxLoops} 轮预算)。` });
      return { accepted: true, loops: loop, stop: "accepted", totalSteps, totalTokens, genome, last, loopLog };
    }
    opts.onEvent?.({
      type: 'status',
      text: `❌ ralph 第 ${loop} 轮验收未过:${verdict.failed.map((f) => f.id).join(', ') || '(无产物)'}${loop < maxLoops ? ' → 带反馈重进' : ' → 轮数熔断'}`,
    });
  }

  return { accepted: false, loops: maxLoops, stop: "max_loops", totalSteps, totalTokens, genome, last, loopLog };
}

/** Ralph 轮次本能:告诉个体这是自迭代的第几轮、还剩几发(短,直接进 system)。 */
function ralphInstinct(loop: number, maxLoops: number): string {
  if (loop === 1) return '[Ralph] 交付前自查:产物是否满足任务验收标准,不达标不要提前收工。';
  return `[Ralph] 第 ${loop}/${maxLoops} 轮自迭代:上一轮验收未过,反馈在任务末尾。只修不达标的部分,已验证的产物不要推翻重来。`;
}
