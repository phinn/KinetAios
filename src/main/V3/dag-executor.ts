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
import { runAgentLoop, compactHistory } from '../AgentLoop';
import type { Provider } from '../glm';
import { priceUSD } from '../glm';
import type { Tool, ToolCtx } from '../tools';
import { getSettings } from '../settings';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
import type { DAGNode, DAGPlan } from './dag-planner';

const MAX_STEP_RETRIES = 2;
const MAX_TURNS_PER_STEP = 8;

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
  let execHistory = [...history];

  // ── 拓扑排序:按依赖关系分层 ──
  const levels = topologicalLevels(plan.nodes);

  for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
    if (signal.aborted) break;

    const level = levels[levelIdx];
    onEvent({ type: 'status', text: `🔄 v3: 执行第 ${levelIdx + 1}/${levels.length} 层 (${level.length} 个节点)` });

    // 同层节点并行执行
    const results = await Promise.allSettled(
      level.map((node) => executeNode(node, {
        provider, tools, systemPrompt, memoryBlock,
        snapshot, ctx, signal, policy,
        history: execHistory,  // 各节点共享当前 execHistory 快照
        onEvent,
      })),
    );

    // 处理结果
    for (let i = 0; i < results.length; i++) {
      const node = level[i]!;
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
          execHistory.push({
            role: 'user',
            content: `\n---\n❌ 步骤[${node.id}] 最终失败: ${node.title}\n原因: ${errMsg}\n---\n`,
          });
        }
      }
    }

    // 层间上下文压缩
    if (!signal.aborted && levelIdx < levels.length - 1) {
      execHistory = await compactHistory(
        execHistory, policy.interStepCompactBudget,
        provider, snapshot, signal, onEvent,
      );
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

async function executeNode(
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
    retryNote?: string;
  },
): Promise<NodeExecResult> {
  const { provider, tools, systemPrompt, memoryBlock, snapshot, ctx, signal, policy, history, onEvent, retryNote } = opts;

  // 构建节点 prompt:明确告诉模型当前步骤目标和上下文
  const stepPrompt = retryNote
    ? `${node.action}\n\n---\n⚠️ 重试提示: ${retryNote}\n请特别注意上次失败的原因。`
    : node.action;

  const startLen = history.length;

  try {
    const stepMessages = await runAgentLoop({
      provider,
      tools,
      systemPrompt: systemPrompt + `\n\n# 当前步骤\n你正在执行以下步骤(目标: ${node.title}):\n${node.action}`,
      memoryBlock,
      snapshot,
      userInput: stepPrompt,
      history: [...history],
      ctx,
      signal,
      maxTurns: MAX_TURNS_PER_STEP,
      policy,
      onEvent: (ev) => {
        // 转发事件,过滤 done/error(由 V3 统一发)
        if (ev.type === 'done' || ev.type === 'error') return;
        if (ev.type === 'status') {
          onEvent({ type: 'status', text: `v3: [${node.id}] ${ev.text}` });
        } else {
          onEvent(ev);
        }
      },
    });

    // 提取步骤摘要
    const assistantMsgs = stepMessages
      .slice(startLen)
      .filter((m) => m.role === 'assistant' && typeof m.content === 'string');
    const summary = assistantMsgs.map((m) => m.content as string).join('\n').slice(0, policy.stepResultMaxChars || 4000);

    // 嵌入式验证:如果节点有 verify 命令,自动执行
    if (node.verify && !signal.aborted) {
      const verifyResult = await runVerify(node.verify, ctx);
      if (!verifyResult.passed) {
        return {
          success: false,
          stepMessages: stepMessages.slice(startLen),
          summary,
          error: `验证失败: ${verifyResult.output.slice(0, 200)}`,
        };
      }
    }

    return { success: true, stepMessages: stepMessages.slice(startLen), summary };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return { success: false, stepMessages: [], error: msg.slice(0, 200) };
  }
}

// ────────────────────────────────────────────────────────────────────────
// 嵌入式验证 — 自动执行,无弹窗
// ────────────────────────────────────────────────────────────────────────

async function runVerify(
  command: string,
  ctx: ToolCtx,
): Promise<{ passed: boolean; output: string }> {
  try {
    // verify 命令直接执行(不经过 confirm,因为这是 planner 定义的自动验证)
    const { stdout, stderr } = await execAsync(command, {
      cwd: ctx.cwd,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const output = (stdout + stderr).trim();
    // 大多数验证工具(tsc, eslint):有 stderr 输出 = 有错误
    const passed = stderr.trim() === '' || !/error/i.test(stderr);
    return { passed, output: output.slice(0, 500) };
  } catch (e) {
    // 非零退出码 = 验证失败
    const output = (e as { stdout?: string; stderr?: string })?.stdout
      ?? (e as Error)?.message
      ?? String(e);
    return { passed: false, output: String(output).slice(0, 500) };
  }
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
