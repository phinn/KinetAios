// V3 DAG Executor — 拓扑排序 + 分层并行执行
//
// 将 DAG 节点按依赖关系分层,同层节点并行执行,层间串行。
// 每个节点是一个独立的 ReAct loop(复用 runAgentLoop)。
// 失败节点局部 retry,不重做整个 plan。
//
// ┌────────────────────────────────────────────┐
// │ Level 0: [A] [B] [C]   ← 并行(无依赖)     │
// │            │   │                             │
// │ Level 1: [D](deps:A,B) ← 等 A+B 完成       │
// │            │                                │
// │ Level 2: [E] [F]         ← 并行(都只依赖 D)│
// └────────────────────────────────────────────┘

import type { AgentEvent, ChatMsg, ConfigSnapshot, EngineContextPolicy } from '../../shared/types';
import { runAgentLoop, compactHistory, compactWithSpill } from '../AgentLoop';
import type { Provider } from '../glm';
import { priceUSD } from '../glm';
import type { Tool, ToolCtx } from '../tools';
import { shellExec } from '../tools';
import { getSettings } from '../settings';
import type { DAGNode, DAGPlan } from './dag-planner';

const MAX_STEP_RETRIES = 2;
export const MAX_TURNS_PER_STEP = 8;
// 2026-09: 节点单段达到轮次上限时**续跑**(而非盲目重试)。每段 8 轮 × MAX_STEP_SEGMENTS 段
// = 24 有效轮;修前节点 >8 轮未收尾就被判失败 → 重试 2 次(仍 8 轮撞顶)→ 标记失败 → 下游 blocked,
// 整个 deep 任务到一半停止。续跑把部分产出当起点继续推进,绝大多数复杂步骤能完成。
export const MAX_STEP_SEGMENTS = 3;
const CONTINUE_PROMPT =
  '(上一段达到单段轮次上限被暂停,但你的工作可能还没完。请继续完成本步骤;如果事实上已经完成,直接输出该步骤的结论文字,不要再调用工具。)';

export interface DAGExecOpts {
  plan: DAGPlan;
  provider: Provider;
  tools: Tool[];
  systemPrompt: string;
  memoryBlock?: string;
  snapshot: ConfigSnapshot;
  ctx: ToolCtx;
  signal: AbortSignal;
  policy: EngineContextPolicy;
  history: ChatMsg[];          // execHistory,累积各步产出
  onEvent: (e: AgentEvent) => void;
}

export interface DAGExecResult {
  history: ChatMsg[];
  completedNodeIds: Set<string>;
  failedNodeIds: Set<string>;
}

/**
 * 执行 DAG plan:拓扑排序 → 分层并行 → 每步 ReAct loop。
 */
export async function executeDAG(opts: DAGExecOpts): Promise<DAGExecResult> {
  const { plan, provider, tools, systemPrompt, memoryBlock, snapshot, ctx, signal, policy, history, onEvent } = opts;

  const completed = new Set<string>();
  const failed = new Set<string>();
  // P1-fix: 失败传播 — failed 或被跳过的节点会阻断下游依赖(此前下游照跑,拿不到
  // 依赖产出,整层白烧 token)。blocked 在结果处理阶段填充,下一层执行前检查。
  const blocked = new Set<string>();
  // P1-fix: verify 审批改为每次 DAG 运行独立(此前模块级 Set 被并发会话共享/互清)。
  const verifyApprovedRun = new Set<string>();
  let execHistory = [...history];

  // ── 拓扑排序:按依赖关系分层 ──
  const levels = topologicalLevels(plan.nodes);

  for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
    if (signal.aborted) break;

    const level = levels[levelIdx];
    onEvent({ type: 'status', text: `🔄 v3: 执行第 ${levelIdx + 1}/${levels.length} 层 (${level.length} 个节点)` });

    // 失败传播:依赖了 failed/blocked 节点的本层节点直接跳过(传递标记,让隔层依赖也阻断)。
    for (const node of level) {
      const deadDep = node.deps.find((d) => blocked.has(d));
      if (deadDep) {
        blocked.add(node.id);
        execHistory.push({
          role: 'user',
          content: `\n---\n⏭️ 步骤[${node.id}] 跳过: 依赖的 [${deadDep}] 失败或已被跳过\n---\n`,
        });
        onEvent({ type: 'status', text: `⏭️ v3: [${node.id}] ${node.title} 跳过(依赖 ${deadDep} 未完成)` });
      }
    }
    const runnableLevel = level.filter((n) => !blocked.has(n.id));
    if (!runnableLevel.length) continue;

    // M3-fix: 同层节点按"是否含写操作"分流。
    // 旧实现:同层全部 Promise.all 并行,各节点持完整工具集(含 shell/write_file),
    // 两个写节点同时写同一文件 = 竞态。
    // 新策略:节点按 planner 标注的 tools 字段判定——纯只读节点照常并行,
    // 任何含写工具(shell/write_file/edit_file/excel_write…)的节点强制串行。
    const { parallelSafe, mustSerialize } = partitionByWrite(runnableLevel, tools);
    if (mustSerialize.length > 0 && parallelSafe.length > 0) {
      onEvent({ type: 'status', text: `🔀 v3: 同层 ${mustSerialize.length} 个写节点转串行(避免写竞态)` });
    }

    // 只读节点并行跑;写节点逐个串行(两者共享同一 execHistory 快照,层末统一合并)
    // 注意:结果按 [parallelSafe..., mustSerialize...] 顺序拼接,与 orderedNodes 对齐。
    const orderedNodes = [...parallelSafe, ...mustSerialize];
    const results: Array<PromiseSettledResult<NodeExecResult>> = await Promise.allSettled(
      parallelSafe.map((node) => executeNode(node, {
        provider, tools, systemPrompt, memoryBlock,
        snapshot, ctx, signal, policy,
        history: execHistory,  // 各节点共享当前 execHistory 快照
        onEvent,
        approved: verifyApprovedRun,
      })),
    );
    for (const node of mustSerialize) {
      if (signal.aborted) break;
      try {
        results.push({ status: 'fulfilled', value: await executeNode(node, {
          provider, tools, systemPrompt, memoryBlock,
          snapshot, ctx, signal, policy,
          history: execHistory,
          onEvent,
          approved: verifyApprovedRun,
        }) });
      } catch (err) {
        results.push({ status: 'rejected', reason: err });
      }
    }

    // 处理结果(与 orderedNodes 按索引配对 — level 原序已因分流打乱)
    for (let i = 0; i < orderedNodes.length; i++) {
      const node = orderedNodes[i]!;
      const result = results[i];

      if (result!.status === 'fulfilled' && result!.value.success) {
        completed.add(node.id);
        // 将节点的 step messages 追加到 execHistory
        execHistory = [...execHistory, ...result!.value.stepMessages];
        // 追加步骤摘要
        execHistory.push({
          role: 'user',
          content: `\n---\n✅ 步骤[${node.id}] 完成: ${node.title}\n结果: ${(result!.value.summary ?? '(无)').slice(0, policy.stepSummaryMaxChars || 600)}\n---\n`,
        });
        onEvent({ type: 'status', text: `✅ v3: [${node.id}] ${node.title} 完成` });
      } else {
        // 失败 → 局部 retry
        const errMsg = result!.status === 'rejected'
          ? (result!.reason as Error)?.message?.slice(0, 100) ?? '未知错误'
          : (result!.value as { error?: string }).error ?? '执行失败';

        onEvent({ type: 'status', text: `⚠️ v3: [${node.id}] ${node.title} 失败 — ${errMsg}` });

        // Retry
        let retried = false;
        for (let attempt = 1; attempt <= MAX_STEP_RETRIES && !signal.aborted; attempt++) {
          onEvent({ type: 'status', text: `🔄 v3: [${node.id}] 重试 ${attempt}/${MAX_STEP_RETRIES}` });
          const retryResult = await executeNode(node, {
            provider, tools, systemPrompt, memoryBlock,
            snapshot, ctx, signal, policy,
            history: execHistory,
            onEvent,
            approved: verifyApprovedRun,
            retryNote: `上一次尝试失败: ${errMsg}`,
          });
          if (retryResult.success) {
            completed.add(node.id);
            execHistory = [...execHistory, ...retryResult.stepMessages];
            execHistory.push({
              role: 'user',
              content: `\n---\n✅ 步骤[${node.id}] 完成(重试 ${attempt}): ${node.title}\n结果: ${(retryResult.summary ?? '(无)').slice(0, policy.stepSummaryMaxChars || 600)}\n---\n`,
            });
            retried = true;
            onEvent({ type: 'status', text: `✅ v3: [${node.id}] ${node.title} 重试成功` });
            break;
          }
        }

        if (!retried) {
          failed.add(node.id);
          blocked.add(node.id); // 阻断下游依赖
          execHistory.push({
            role: 'user',
            content: `\n---\n❌ 步骤[${node.id}] 最终失败: ${node.title}\n原因: ${errMsg}\n---\n`,
          });
        }
      }
    }

    // 层间上下文压缩(compaction seam:ctx.turnId 在 → spill 存证归一;不在 → 只压缩不存证)
    if (!signal.aborted && levelIdx < levels.length - 1) {
      execHistory = await compactWithSpill(execHistory, () =>
        compactHistory(execHistory, policy.interStepCompactBudget, provider, snapshot, signal, onEvent, opts.ctx.convId),
      { convId: opts.ctx.convId ?? '', turnId: opts.ctx.turnId });
    }
  }

  return { history: execHistory, completedNodeIds: completed, failedNodeIds: failed };
}

// ────────────────────────────────────────────────────────────────────────
// 单节点执行
// ────────────────────────────────────────────────────────────────────────

interface NodeExecResult {
  success: boolean;
  stepMessages: ChatMsg[];
  summary?: string;
  error?: string;
}

export async function executeNode(
  node: DAGNode,
  opts: {
    provider: Provider;
    tools: Tool[];
    systemPrompt: string;
    memoryBlock?: string;
    snapshot: ConfigSnapshot;
    ctx: ToolCtx;
    signal: AbortSignal;
    policy: EngineContextPolicy;
    history: ChatMsg[];
    onEvent: (e: AgentEvent) => void;
    approved: Set<string>;
    retryNote?: string;
  },
): Promise<NodeExecResult> {
  const { provider, tools, systemPrompt, memoryBlock, snapshot, ctx, signal, policy, history, onEvent, approved, retryNote } = opts;

  // 构建节点 prompt:明确告诉模型当前步骤目标和上下文
  const stepPrompt = retryNote
    ? `${node.action}\n\n---\n⚠️ 重试提示: ${retryNote}\n请特别注意上次失败的原因。`
    : node.action;

  let sawError = false;     // 非 maxTurns 错误(瞬时重试耗尽/API 鉴权失败/空回复)→ 不续跑,交 DAG 层重试
  let sawTurnCap = false;   // 达到单段轮次上限 → 续跑
  let historyNow = [...history];
  const segments: ChatMsg[] = [];
  let lastMessages: ChatMsg[] = [];

  try {
    for (let seg = 0; seg < MAX_STEP_SEGMENTS; seg++) {
      const before = historyNow.length;
      // 续跑段:用 CONTINUE_PROMPT 取代原始 action(任务上下文已在 history 里,模型继续即可)
      const segInput = seg === 0 ? stepPrompt : CONTINUE_PROMPT;
      lastMessages = await runAgentLoop({
        provider,
        tools,
        systemPrompt: systemPrompt + `\n\n# 当前步骤\n你正在执行以下步骤(目标: ${node.title}):\n${node.action}`,
        memoryBlock,
        snapshot,
        userInput: segInput,
        history: historyNow,
        ctx,
        signal,
        maxTurns: MAX_TURNS_PER_STEP,
        policy,
        onEvent: (ev) => {
          // 转发事件,过滤 done(由 V3 统一发);error 按 kind 区分:
          //  - kind==='maxTurns':单段轮次上限,交续跑逻辑(不算致命错误)
          //  - 其余 error(API 失败/空回复/超长 nuclear):转 status 透出 + 标 sawError
          // (与 V2 forwardEvent / index.terminalGate 同语义 — 中途 API 失败必须对用户可见,不能静默)
          if (ev.type === 'done') return;
          if (ev.type === 'error') {
            if (ev.kind === 'maxTurns') {
              sawTurnCap = true;
            } else {
              sawError = true;
              onEvent({ type: 'status', text: `v3: [${node.id}] ⚠️ ${ev.message}` });
            }
            return;
          }
          if (ev.type === 'status') {
            onEvent({ type: 'status', text: `v3: [${node.id}] ${ev.text}` });
          } else {
            onEvent(ev);
          }
        },
      });

      // 本段新增消息(不含我们传入的 history)
      const newMsgs = lastMessages.slice(before);
      segments.push(...newMsgs);
      historyNow = lastMessages; // 含完整历史 + 本段新增,作为续跑的 history 起点

      const last = lastMessages[lastMessages.length - 1];
      const completedNormally = !!last && last.role === 'assistant' && (!last.tool_calls || last.tool_calls.length === 0);
      if (completedNormally || signal.aborted) break;

      // 未正常收尾:出错(sawError)→ 不续跑(失败重试由 DAG 层接管);否则视为轮次上限 → 续跑
      if (sawError) break;
      if (sawTurnCap && seg < MAX_STEP_SEGMENTS - 1) {
        onEvent({ type: 'status', text: `⏳ v3: [${node.id}] 达到单段轮次上限,续跑(${seg + 2}/${MAX_STEP_SEGMENTS})…` });
        sawTurnCap = false; // 下段重新判定
      }
    }

    // P0-fix: 收尾校验 —— 正常完成 = 最后一段最后一条是无 tool_calls 的 assistant。
    const last = lastMessages[lastMessages.length - 1];
    const completedNormally = !!last && last.role === 'assistant' && (!last.tool_calls || last.tool_calls.length === 0);

    // 提取步骤摘要(各段的 assistant 文本拼接)
    const assistantMsgs = segments
      .filter((m) => m.role === 'assistant' && typeof m.content === 'string');
    const summary = assistantMsgs.map((m) => m.content as string).join('\n').slice(0, policy.stepResultMaxChars || 4000);

    if (!completedNormally && !signal.aborted) {
      return {
        success: false,
        stepMessages: segments,
        summary,
        error: sawError
          ? '节点执行中途出错(API 失败/空回复/超长),可能未完成'
          : `节点未在 ${MAX_TURNS_PER_STEP}×${MAX_STEP_SEGMENTS} 轮内完成,可能过于复杂`,
      };
    }

    // 嵌入式验证:如果节点有 verify 命令,自动执行
    if (node.verify && !signal.aborted) {
      const verifyResult = await runVerify(node.verify, ctx, signal, approved, onEvent);
      if (!verifyResult.passed) {
        return {
          success: false,
          stepMessages: segments,
          summary,
          error: `验证失败: ${verifyResult.output.slice(0, 200)}`,
        };
      }
    }

    return { success: true, stepMessages: segments, summary };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return { success: false, stepMessages: [], error: msg.slice(0, 200) };
  }
}

// ────────────────────────────────────────────────────────────────────────
// 嵌入式验证 — 首次走 confirm 审批,同节点重试免弹(与 V2 runVerify 对齐)
// ────────────────────────────────────────────────────────────────────────

async function runVerify(
  command: string,
  ctx: ToolCtx,
  signal: AbortSignal,
  approved: Set<string>,
  onEvent?: (e: AgentEvent) => void,
): Promise<{ passed: boolean; output: string }> {
  // H2-fix: verify 命令来自 planner LLM 输出,必须走 confirm 审批,不能绕过直接 exec。
  // 同一命令 confirm 过一次后跳过(同节点 retry / 多节点复用相同验证命令场景)。
  // approved 集合由 executeDAG 每次 run 新建 — 不再模块级共享(并发会话互清/复用审批)。
  if (!approved.has(command)) {
    const ok = await ctx.confirm(`[v3 验证] ${command}`);
    if (!ok) {
      // 拒绝 ≠ 验证通过:如实告知"未验证",由上层决定(默认继续但标记可见)。
      if (onEvent) onEvent({ type: 'status', text: `⚠️ v3: 用户拒绝验证命令,节点将在未验证状态下继续: ${command}` });
      return { passed: true, output: '(用户拒绝执行验证 — 节点未经验证)' };
    }
    approved.add(command);
  }

  try {
    // 与 V2 一致:走 shellExec 统一执行路径(超时/退出码格式化一致),120s
    const output = await shellExec(command, ctx.cwd, 120_000, signal);
    // shellExec 非零退出码加 [exit N] 前缀;超时返回 [超时(Ns),已终止。] — 两种都判为失败
    const passed = !/\[exit \d+\]/.test(output) && !output.startsWith('[超时');
    return { passed, output: output.slice(0, 500) };
  } catch {
    return { passed: false, output: '验证命令执行失败' };
  }
}

// ────────────────────────────────────────────────────────────────────────
// M3: 同层节点按写操作分流
// ────────────────────────────────────────────────────────────────────────

/**
 * 判断一个节点是否纯只读(按 planner 标注的 tools + parallelizable)。
 * 保守原则:tools 字段缺失/含未知工具名时视为写节点(宁可串行,不可竞态);
 * 即使标注只读,只要 parallelizable=false 也强制串行(planner 显式要求)。
 */
function nodeIsReadonlySafe(node: DAGNode, knownReadonly: Set<string>): boolean {
  if (!node.parallelizable) return false;
  if (!Array.isArray(node.tools) || node.tools.length === 0) return false;
  return node.tools.every((t) => knownReadonly.has(t));
}

/** 将同层节点分为 [可并行只读, 需串行含写] 两组。 */
function partitionByWrite(level: DAGNode[], tools: Tool[]) {
  const knownReadonly = new Set(tools.filter((t) => t.readOnly).map((t) => t.name));
  const parallelSafe: DAGNode[] = [];
  const mustSerialize: DAGNode[] = [];
  for (const node of level) {
    if (nodeIsReadonlySafe(node, knownReadonly)) parallelSafe.push(node);
    else mustSerialize.push(node);
  }
  return { parallelSafe, mustSerialize };
}

// ────────────────────────────────────────────────────────────────────────
// 拓扑排序:将 DAG 节点分层
// ────────────────────────────────────────────────────────────────────────

function topologicalLevels(nodes: DAGNode[]): DAGNode[][] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const completed = new Set<string>();
  const levels: DAGNode[][] = [];

  // 找出依赖为空(或依赖已完成)的节点 → 同层
  let remaining = [...nodes];
  while (remaining.length > 0) {
    const currentLevel = remaining.filter((n) =>
      n.deps.every((dep) => completed.has(dep) || !nodeMap.has(dep)),
    );

    if (currentLevel.length === 0) {
      // 死锁(循环依赖)→ 强制把剩余节点放到下一层
      levels.push(remaining);
      break;
    }

    levels.push(currentLevel);
    currentLevel.forEach((n) => completed.add(n.id));
    remaining = remaining.filter((n) => !completed.has(n.id));
  }

  return levels;
}
