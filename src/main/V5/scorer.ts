// 计分:成败 0.6 + 成本 0.3 + 步数 0.1,其中成本/步数必须"类内归一化"——
// 数据清洗天然比查资料贵,跨签名比成本会让选择压力偏爱"接简单活的个体"。
// 归一化基于「该签名下已有的全部非中止记录」的 min-max:1=同类中最省,0=同类中最贵。
// 样本 <2 或全类同值 → 中性 1(pioneer 不因没数据被惩罚)。
//
// Scoring: success 0.6 / cost 0.3 / steps 0.1, with cost/steps normalized WITHIN a
// signature class (min-max over all non-aborted runs of that signature): 1 = cheapest.
// <2 samples or zero span → neutral 1 so pioneers aren't punished for lacking data.

import type { RunOutcome } from './phylum-types';

export const W_SUCCESS = 0.6;
export const W_COST = 0.3;
export const W_STEPS = 0.1;

/**
 * 类内归一化器:先喂历史(或当批)记录,再对单条记录取 norm。
 * 确定性:同一组输入永远同一输出;纯函数无内部状态。
 */
export class ClassNormalizer {
  private bySig = new Map<string, { min: number; max: number }>();

  constructor(outcomes: RunOutcome[]) {
    for (const o of outcomes) {
      if (o.aborted) continue; // 中止记录不参与分布
      this.feed(o.signature, o.tokens);
    }
  }

  private feed(sig: string, v: number): void {
    const cur = this.bySig.get(sig);
    if (!cur) this.bySig.set(sig, { min: v, max: v });
    else {
      cur.min = Math.min(cur.min, v);
      cur.max = Math.max(cur.max, v);
    }
  }

  /** 单条记录的成本 norm ∈ [0,1](1 = 与同类最省者持平或更省)。 */
  costNorm(o: RunOutcome): number {
    return this.norm(o.signature, o.tokens);
  }

  private norm(sig: string, v: number): number {
    const cur = this.bySig.get(sig);
    if (!cur) return 1; // 无同类数据:中性
    const span = cur.max - cur.min;
    if (span === 0) return 1; // 全类同值:无差异信息,中性
    return 1 - (v - cur.min) / span;
  }
}

/** 单次执行综合得分 ∈ [0,1](排序/日志用;繁殖判定用支系成功率,不用它)。 */
export function scoreRun(success: boolean, costNorm: number, stepNorm: number): number {
  return W_SUCCESS * (success ? 1 : 0) + W_COST * costNorm + W_STEPS * stepNorm;
}
