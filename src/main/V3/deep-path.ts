// V3 Deep Path — DAG Plan + 并行执行 + 嵌入式验证
//
// 适用于:跨多文件重构、架构级变更。
// 流程:Planner(forced tool_use) → DAG Executor(拓扑排序分层并行)→ 嵌入式验证
//
// 取消了 V2 的独立 Judge(用 verify gate 替代)和独立 Verifier(嵌入到步骤中)。

import type { AgentEvent, ChatMsg, ConfigSnapshot, EngineContextPolicy } from '../../shared/types';
import type { Provider, ToolDef } from '../glm';
import type { Tool, ToolCtx } from '../tools';
import { readOnlyTools } from '../tools';
import { generateDAGPlan, type DAGPlan } from './dag-planner';
import { executeDAG } from './dag-executor';
import { executeStdPath } from './std-path';

export interface DeepPathOpts {
  provider: Provider;
  tools: Tool[];
  systemPrompt: string;
  memoryBlock?: string;
  snapshot: ConfigSnapshot;
  userInput: string;
  history: ChatMsg[];
  ctx: ToolCtx;
  signal: AbortSignal;
  policy: EngineContextPolicy;
  onEvent: (e: AgentEvent) => void;
}

export async function executeDeepPath(opts: DeepPathOpts): Promise<ChatMsg[]> {
  const { provider, tools, systemPrompt, memoryBlock, snapshot, userInput, history, ctx, signal, policy, onEvent } = opts;

  // ── Phase 1: 规划(Planner) ──
  // Planner 有只读工具可以探查,但写入工具不在 planner 手中(避免 planner 直接改文件)
  const planTools = readOnlyTools();
  const planToolDefs = planTools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const plan = await generateDAGPlan(
    userInput,
    history,
    systemPrompt,
    provider,
    snapshot,
    signal,
    planToolDefs,
    onEvent as (e: { type: string; [k: string]: unknown }) => void,
    ctx,      // M1-fix: 传 ctx 让 planner 走 runAgentLoop 多轮探查
    policy,
    memoryBlock, // P2-fix: 规划阶段注入长期记忆(与 V2 planner 对齐)
  );

  if (!plan) {
    // 规划失败 → 退化为 std path
    onEvent({ type: 'status', text: '🔄 v3: 规划失败,退化为标准执行' });
    return executeStdPath({ provider, tools, systemPrompt, memoryBlock, snapshot, userInput, history, ctx, signal, policy, onEvent });
  }

  // 广播 plan 给用户(可视化)
  onEvent({
    type: 'status',
    text: `📋 v3: ${plan.summary}\n${plan.nodes.map((n) => `  [${n.id}] ${n.title} (并行: ${n.parallelizable ? '✓' : '✗'}, deps: [${n.deps.join(',')}])`).join('\n')}`,
  });

  // ── Phase 2: DAG 执行 ──
  const result = await executeDAG({
    plan,
    provider,
    tools,  // 执行阶段有完整工具集(含写工具)
    systemPrompt,
    memoryBlock,
    snapshot,
    ctx,
    signal,
    policy,
    history,
    onEvent,
  });

  // ── Phase 3: 结果汇总状态 ──
  const failedCount = result.failedNodeIds.size;
  const totalNodes = plan.nodes.length;
  const completedCount = result.completedNodeIds.size;

  if (failedCount > 0) {
    onEvent({
      type: 'status',
      text: `⚠️ v3: 完成 ${completedCount}/${totalNodes} 个节点,${failedCount} 个失败`,
    });
  } else {
    onEvent({ type: 'status', text: `✅ v3: 全部 ${totalNodes} 个节点完成` });
  }

  // ── Phase 3.5: 结果综合 — DAG 收尾后没有面向用户的总结,最后一个节点的流式
  // token 就是用户看到的全部答案。补一次轻量汇总(单次 streamComplete,无工具):
  // 失败只降级(不影响主流程),abort 时跳过。
  if (!signal.aborted && completedCount > 0) {
    try {
      onEvent({ type: 'status', text: '🧾 v3: 汇总各步骤结果…' });
      const evidence = synthesizeEvidence(userInput, plan, result.history, failedCount);
      const comp = await provider.streamComplete(
        [
          { role: 'system', content: DEEP_SYNTH_PROMPT },
          { role: 'user', content: evidence },
        ],
        [],
        snapshot,
        signal,
        (tok) => onEvent({ type: 'token', text: tok }),
      );
      if (comp.tokensIn > 0 || comp.tokensOut > 0) {
        const { priceUSD } = await import('../glm');
        onEvent({ type: 'cost', usd: priceUSD(snapshot.model, comp.tokensIn, comp.tokensOut), tokens: comp.tokensIn + comp.tokensOut });
      }
      const summaryText = (comp.content ?? '').trim();
      if (summaryText) result.history.push({ role: 'assistant', content: summaryText });
    } catch {
      // 综合失败 → 降级为原样返回(各节点产出仍在 history 中)
    }
  }

  return result.history;
}

// 综合提示词:面向用户的最终总结,不重复过程。
const DEEP_SYNTH_PROMPT = `你是执行结果汇总器。根据任务目标与各步骤的执行结果,输出面向用户的最终总结:
- 完成了什么(一句话结论放最前)
- 关键产出/修改的文件/数据
- 失败或遗留的问题(如有)
直接输出正文,不要标题、不要复述执行过程。`;

// 从 execHistory 提取汇总材料:节点摘要 user 消息(✅/❌/⏭️ 开头的步骤条目)+
// assistant 文本,截断到预算内。工具噪声不进入。
function synthesizeEvidence(userInput: string, plan: DAGPlan, history: ChatMsg[], failedCount: number): string {
  const BUDGET = 8000;
  const lines: string[] = [`【任务目标】${plan.goal || userInput}`];
  if (failedCount > 0) lines.push(`【注意】有 ${failedCount} 个节点失败或被跳过,总结时必须如实说明`);
  let total = lines.join('\n').length;
  for (const m of history) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content : '';
    if (!text.trim()) continue;
    const isStepNote = m.role === 'user' && (text.includes('✅ 步骤[') || text.includes('❌ 步骤[') || text.includes('⏭️ 步骤['));
    if (m.role === 'user' && !isStepNote) continue; // 普通用户消息(原始请求)已由【任务目标】代表
    if (m.role === 'assistant' && text.startsWith('[')) continue;
    const clipped = text.slice(0, 600);
    total += clipped.length;
    if (total > BUDGET) break;
    lines.push(`${m.role === 'user' ? '' : '[输出] '}${clipped}${text.length > 600 ? '…' : ''}`);
  }
  return lines.join('\n');
}
