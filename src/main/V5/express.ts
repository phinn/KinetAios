// 基因表达:Genome → ExpressedBody(硬约束,绕过 prompt)。
// 核心原则:1.5B 和 70B 的表达保真度必须接近 —— 亲和过滤/步数预算/断言 gate 全是
// 执行器参数和注册表过滤,不依赖模型"听话";只有 successPrior 这一类风格软先验进 prompt。
//
// Gene expression: Genome → ExpressedBody, all HARD constraints (registry filtering,
// executor params, assertion gates). Only style-level soft priors go into the prompt.

import type { Tool } from '../tools';
import { MAX_STEPS_HARD_CAP } from './bodyplan';
import {
  type ExpressedBody, type Genome, type AssertionGene,
  TOOL_CUTOFF, TOOL_AFFINITY_DEFAULT, STEP_BUDGET_CEIL,
} from './phylum-types';

export interface ExpressResult extends ExpressedBody {
  /** 因必需工具保护而未摘除的工具(亲和再低也在):记日志用 */
  protectedTools: string[];
}

/**
 * 表达主入口。
 * @param genome 个体基因
 * @param allTools 全量工具注册表
 * @param requiredTools 本任务必需工具:模型没有它 = 物理不可能完成。
 *   注意:必需工具被保护 ≠ 一定可用 —— 若其亲和确实 < TOOL_CUTOFF,运行时仍可能被
 *   模型选错;必需工具保护解决的是"注册表整体摘除导致任务物理不可能",不是"保证成功"。
 *   亲和回升由死亡归因 essential_tool_missing 驱动(见 registry.mutateFrom)。
 */
export function express(genome: Genome, allTools: readonly Tool[], requiredTools: readonly string[], stepBudgetCeil?: number): ExpressResult {
  const required = new Set(requiredTools);
  const removedTools: string[] = [];
  const protectedTools: string[] = [];
  const tools = allTools.filter((t) => {
    const aff = genome.affinity[t.name] ?? TOOL_AFFINITY_DEFAULT;
    if (aff < TOOL_CUTOFF) {
      if (required.has(t.name)) { protectedTools.push(t.name); return true; }
      removedTools.push(t.name);
      return false;
    }
    return true;
  });
  return {
    tools,
    removedTools,
    protectedTools,
    // 步数预算(2026-10-13 无限循环事故修法):宿主 maxTurns=0 不再翻译成 Infinity。
    // 理由:那次 founder(基因 12 步)裸奔 443 步/3.6h 直到人肉取消 —— 「无限」对个体
    // 没有进化意义,只有烧钱意义。宿主 0 的语义 = 信任基因:预算就是个体自己的
    // maxSteps 基因(founder 12,由 step_budget 死亡 +4/次 自主进化,上限 MAX_STEPS_MAX)。
    // 门级护栏 stepBudgetCeil>0 时仍然夹紧(基因只能低于宿主天花板)。
    maxSteps: stepBudgetCeil === 0
      ? Math.min(genome.routing.maxSteps, MAX_STEPS_HARD_CAP)
      : Math.min(genome.routing.maxSteps, stepBudgetCeil ?? STEP_BUDGET_CEIL),
    instinctPrompt: instinct(genome),
    assertions: genome.assertions,
  };
}

/** 软先验:出生注入(占比刻意小;硬约束才是主表达通路)。 */
function instinct(g: Genome): string {
  const lines: string[] = [];
  if (g.routing.maxSteps >= 6) lines.push('- 这个任务值得稳扎稳打,不急于一步到位。');
  else lines.push('- 这个任务直接干,别过度规划。');
  if (g.routing.successPrior >= 0.7) lines.push('- 你的血脉在同类任务上胜率很高,按直觉走。');
  else if (g.routing.successPrior <= 0.3) lines.push('- 这类任务历史表现不佳,每步都先确认再执行。');
  return lines.length ? `[本能]\n${lines.join('\n')}` : '';
}

/**
 * 断言 gate:每次工具调用后逐条检查。全部确定性执行,不经 LLM。
 * @returns null = 全过;否则返回首个违规断言(归因用)。
 */
export function checkAssertions(
  assertions: readonly AssertionGene[],
  lastTool: { name: string; output: string; exitCode?: number },
): AssertionGene | null {
  for (const a of assertions) {
    if (violates(a, lastTool)) return a;
  }
  return null;
}

function violates(a: AssertionGene, last: { name: string; output: string; exitCode?: number }): boolean {
  const c = a.check;
  switch (c.type) {
    case 'exit_code_eq': return last.exitCode !== undefined && last.exitCode !== c.value;
    case 'regex_contains': {
      try { return !(new RegExp(c.pattern)).test(last.output); }
      catch { return true; } // 坏正则 = 断言本身坏了 → 视为违规(死因归因会删掉这条)
    }
    case 'output_not_empty': return last.output.trim().length === 0;
    case 'line_count_gt': return last.output.split('\n').length <= c.value;
    default: return true;
  }
}
