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

  // ── Phase 3: 结果汇总 ──
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

  return result.history;
}
