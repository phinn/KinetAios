// Ralph → 基因库结算层:把一次 Ralph 自迭代 run 编码成 RunOutcome 记账进 GeneRegistry。
// 这是「Ralph 给 V5 喂真实种群」的桥:Ralph 产物不只是交付物,还是进化信号——
//   accepted          → success(配子池 + 可能沉积化石)
//   max_loops         → wrong_answer 疤痕(轮数烧尽 = 验收口径或环境问题,个体没错路,错在"改不对")
//   aborted           → 零进化信号(用户中止不是个体的错,与全库语义一致)
//   provider_suspended→ 不进本函数(世界停摆,上层直接短路,零记账)
//
// Settle-to-registry: encode one Ralph self-iteration run into RunOutcome and settle
// it into the GeneRegistry. Ralph artifacts double as evolution signal — acceptance
// feeds gametes/fossils, loop-exhaustion leaves a wrong_answer scar for directed mutation.

import type { Genome, RunOutcome, DeathCause } from './phylum-types';
import type { AttributionFacts } from './registry';
import type { AssertionGene } from './phylum-types';
import type { AcceptanceSpec } from './ralph-accept';
import type { RalphResult } from './ralph';

/** 结算所需的最小基因库面(GeneRegistry 结构化兼容;测试可用窄 stub)。 */
export interface RalphSettler {
  settle(o: RunOutcome, g: Genome, f: AttributionFacts): void;
  recordScar(lineage: string, f: AttributionFacts): void;
  scarOf(lineage: string): AttributionFacts | null;
  mutateFrom(parent: Genome, f: AttributionFacts): Genome;
  cloneFrom(parent: Genome): Genome;
  bestGamete(sig: string): { genome: Genome } | undefined;
  liveBySignature(sig: string): Genome[];
}

/** Ralph 停机原因 → 死因映射(纯函数,结算与 UI 归因共用)。 */
export function ralphDeathCause(r: RalphResult): DeathCause {
  switch (r.stop) {
    case 'accepted': return 'none';           // 验收过 = 成功(死因 none = 无突变)
    case 'max_loops': return 'wrong_answer';  // 轮数烧尽:断言口径没骗它,是它一直改不对
    case 'aborted': return 'aborted';
    case 'provider_suspended': return 'provider_suspended';
  }
}

/** RalphResult → RunOutcome(taskId 由调用方给:生产=convId,实验=模板 id)。 */
export function ralphToOutcome(r: RalphResult, taskId: string): RunOutcome {
  const genome: Genome | undefined = r.genome;
  return {
    taskId,
    signature: genome?.signature ?? 'ralph-neutral',
    genomeId: genome?.genomeId ?? 'ralph-default',
    lineage: genome?.lineage ?? 'ralph',
    generation: genome?.generation ?? 0,
    success: r.accepted,
    aborted: r.stop === 'aborted',
    cause: ralphDeathCause(r),
    steps: r.totalSteps,
    tokens: r.totalTokens,
    detail: ralphDetail(r),
    trace: r.last?.trace,
    finished: r.last?.finished,
  };
}

/** 审计 detail:轮数 + 停机原因 + 熔断时点名列出失败断言 id(疤痕定向突变的锚点)。 */
function ralphDetail(r: RalphResult): string {
  const failedIds = r.loopLog[r.loopLog.length - 1]?.verdict.failed.map((f) => f.id) ?? [];
  const bits = [`loops=${r.loops}/${r.loopLog.length}`, `stop=${r.stop}`];
  if (failedIds.length) bits.push(`failed=${failedIds.join(',')}`);
  return bits.join(' ');
}

/** Ralph 失败的归因事实(疤痕定向突变用):熔断 → wrong_answer + 最后失败断言 id。 */
export function ralphAttribution(r: RalphResult): AttributionFacts {
  const last = r.loopLog[r.loopLog.length - 1];
  const assertionId = last?.verdict.failed[0]?.id;
  return assertionId
    ? { cause: 'wrong_answer', assertionId }   // 断言基因位只删不增:这个 id 若在基因组里会被摘除
    : { cause: 'wrong_answer' };
}

/**
 * 结算一次 Ralph run 进基因库(生产入口;实验壳 Universe 有自己的结算,不走这里)。
 * 语义与 DirectV5Engine.run 完全对齐:
 *   - provider_suspended:不结算、不留疤、不计 aborted(世界停摆零进化信号)
 *   - aborted:只记账(fitness.aborted++),不进配子/化石,零突变信号
 *   - accepted:settle(配子池 + 近窗达标沉积化石)
 *   - max_loops:settle(化石层)+ recordScar(wrong_answer,定向突变依据)
 *   - 结算后若无活体 → 冠军配子替补出生(疤痕定向突变/无痕克隆),种群永续
 * 返回结算后的 RunOutcome(调用方做 UI 归因展示)。
 */
export function settleRalph(
  reg: RalphSettler,
  r: RalphResult,
  genome: Genome,
  taskId: string,
): RunOutcome {
  const outcome = { ...ralphToOutcome(r, taskId), signature: genome.signature, genomeId: genome.genomeId, lineage: genome.lineage, generation: genome.generation };
  // 世界停摆:不结算不留疤(与生产路径同语义,上层本不该走到这,防御性兜住)
  if (outcome.cause === 'provider_suspended') return outcome;

  reg.settle(outcome, genome, { cause: outcome.cause });

  if (!r.accepted && r.stop === 'max_loops') {
    const facts = ralphAttribution(r);
    reg.recordScar(genome.lineage, facts);
  }

  // 替补出生:非中止死亡清空种群 → 冠军配子接力(疤痕定向突变优先)
  if (!outcome.aborted && !reg.liveBySignature(genome.signature).length) {
    const gam = reg.bestGamete(genome.signature);
    if (gam) {
      const inh = reg.scarOf(gam.genome.lineage);
      if (inh) reg.mutateFrom(gam.genome, inh);
      else reg.cloneFrom(gam.genome);
    }
  }
  return outcome;
}

/** 从任务文本解析验收 DSL:行格式「验收: <check 的 JSON>」(每行一条,全部 AND)。
 *  无任何「验收:」行 → 返回 null(调用方走原生单轮拓扑,不进 Ralph)。
 *  解析失败的行跳过(垃圾进不出毒——缺一条断言只会放宽验收,不会误杀交付物)。 */
export function acceptanceFromPrompt(prompt: string): AcceptanceSpec | null {
  const lines = prompt.split('\n').filter((l) => l.trim().startsWith('验收:'));
  if (!lines.length) return null;
  const assertions = lines
    .map((l) => {
      const raw = l.trim().slice('验收:'.length).trim();
      try {
        return JSON.parse(raw) as AssertionGene['check'];
      } catch {
        return null; // 非 JSON 的行忽略(不支持自然语言断言——那会绕开防 Goodhart 根)
      }
    })
    .filter((c): c is AssertionGene['check'] => !!c);
  return assertions.length ? { assertions } : null;
}
