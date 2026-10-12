// V4 Legis Executor — 计划图运行时
//
// 拓扑分层 → 同层只读并行/写串行(复用 V3 dag-executor 语义)。
// 关键差异:
//   replay 节点:遍历 script 直接 tool.run —— 0 LLM(数据: >80 步 turn 占 80% 成本,
//                其中的 typecheck/sleep/grep 都是可零 LLM 重放的确定性动作)
//   agent 节点:runAgentLoop 子任务(步数保险丝),产出进 execHistory
//   429:park 而非 fail(60/120/240s 退避,信号量全局门)
//   断言失败 → 唤回(最小故障现场,LLM 出场 #2..n)→ 补丁 → 该节点续跑
//   验收:plan.acceptance 全过 → GOAL_COMPLETE(替代 supervisor 94% continue)
// Checkpoint:每节点完成整体覆写(对齐 V3 M3,断点续跑的事实源)。

import type { AgentEvent, ChatMsg, ConfigSnapshot, EngineContextPolicy, TodoItem } from '../../shared/types';
import { runAgentLoop, compactHistory } from '../AgentLoop';
import type { Provider } from '../glm';
import { priceUSD } from '../glm';
import type { Tool, ToolCtx } from '../tools';
import { withCache, cacheStats, clearConvCache } from './runtime-cache';
import { evaluateAssertions, type AssertOutcome } from './assertions';
import { waitForGate, reportTransient, isTransient, clearGate } from './backoff';
import { MAX_NODE_RETRIES, MAX_NODE_RECALLS, MAX_PLAN_RECALLS, type LegisNode, type LegisPlan, type LegisScriptStep, type RecallPatch } from './plan';

// ────────────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────────────

export interface LegisExecOpts {
  plan: LegisPlan;
  provider: Provider;
  tools: Tool[];
  systemPrompt: string;
  memoryBlock?: string;
  snapshot: ConfigSnapshot;
  ctx: ToolCtx;
  signal: AbortSignal;
  policy: EngineContextPolicy;
  history: ChatMsg[];
  /** 上一轮 checkpoint(断点续跑)。 */
  initialCheckpoint?: { completedNodeIds: string[]; history: ChatMsg[] };
  /** 每节点完成回调(整体覆写式存档)。 */
  onCheckpoint?: (cp: { completedNodeIds: string[]; history: ChatMsg[] }) => void;
  /** 唤回执行器(LLM 出场)。缺省 = 无唤回(失败节点按 failed 处理)。 */
  recall?: (input: { trigger: string; nodeId?: string; nodeTitle?: string; failureDetail: string; planSummary: string; attempt: number }) => Promise<RecallPatch>;
  onEvent: (e: AgentEvent) => void;
}

export interface LegisExecResult {
  history: ChatMsg[];
  completedNodeIds: string[];
  failedNodeIds: string[];
  /** acceptance 校验结果(全过 = goal 达成)。 */
  acceptancePassed: boolean | null; // null = 无验收断言
  acceptanceSummary: string;
  /** LLM 出场次数(编译 1 + 唤回 N)。 */
  recallsUsed: number;
}

// ────────────────────────────────────────────────────────────────────────
// 主执行循环
// ────────────────────────────────────────────────────────────────────────

export async function executeLegis(opts: LegisExecOpts): Promise<LegisExecResult> {
  const { plan, provider, tools, systemPrompt, memoryBlock, snapshot, ctx, signal, policy, history, initialCheckpoint, onCheckpoint, recall, onEvent } = opts;

  const completed = new Set<string>(initialCheckpoint?.completedNodeIds ?? []);
  const failed = new Set<string>();
  let execHistory = initialCheckpoint?.history?.length ? [...history, ...initialCheckpoint.history] : [...history];
  let recallsUsed = 0;

  // 步骤树(todo 事件)— 与 V3 DAG 的呈现契约一致
  const todos: TodoItem[] = plan.nodes.map((n) => ({ content: `[${n.id}] ${n.kind === 'replay' ? '⚙️' : '🤖'} ${n.title}`, status: 'pending' as const }));
  const todoOf = (id: string): TodoItem | undefined => todos.find((t) => t.content.startsWith(`[${id}]`));
  const emitTodos = (): void => { onEvent({ type: 'todo', todos: todos.map((t) => ({ ...t })) }); };
  const setNode = (id: string, status: TodoItem['status']): void => {
    const t = todoOf(id);
    if (t && t.status !== status) { t.status = status; emitTodos(); }
  };
  for (const id of completed) setNode(id, 'completed');
  emitTodos();

  const levels = topologicalLevels(plan.nodes);

  // ── 内部:单节点执行分派(replay 0 LLM / agent 走 runAgentLoop)──
  const runLegisNodeInner = (node: LegisNode): Promise<NodeOutput> =>
    runLegisNode(node, tools, ctx, signal, provider, systemPrompt, memoryBlock, snapshot, policy, execHistory, onEvent);

  for (let li = 0; li < levels.length; li++) {
    if (signal.aborted) break;
    const level = levels[li]!;
    onEvent({ type: 'status', text: `🔄 v4: 执行第 ${li + 1}/${levels.length} 层(${level.length} 节点)` });

    // 失败传播:依赖 failed/blocked 节点 → 跳过
    const blocked = new Set(failed);
    for (const node of level) {
      if (node.deps.some((d) => blocked.has(d))) {
        setNode(node.id, 'skipped');
        onEvent({ type: 'status', text: `⏭️ v4: [${node.id}] ${node.title} 被跳过(上游失败)` });
      }
    }
    const runnable = level.filter((n) => !n.deps.some((d) => blocked.has(d)));

    const { parallelSafe, mustSerialize } = partitionByWrite(level, tools, runnable);

    // 同层只读并行
    if (parallelSafe.length) {
      const results = await Promise.allSettled(parallelSafe.map((node) => runNodeWithLifecycle(node)));
      settleResults(parallelSafe, results);
    }
    // 写节点串行
    for (const node of mustSerialize) {
      if (signal.aborted) break;
      try {
        const r = await runNodeWithLifecycle(node);
        settleResults([node], [{ status: 'fulfilled', value: r }]);
      } catch (err) {
        settleResults([node], [{ status: 'rejected', reason: err }]);
      }
    }
  }

  // ── 验收断言表(0 LLM)──
  let acceptancePassed: boolean | null = null;
  let acceptanceSummary = '(无验收断言 — 退化 V3 语义)';
  if (plan.acceptance.length > 0) {
    onEvent({ type: 'status', text: `🧪 v4: 验收断言表(${plan.acceptance.length} 条)` });
    const outcome = evaluateAssertions(plan.acceptance, { cwd: ctx.cwd, output: acceptanceShellOutput(plan, completed) });
    acceptancePassed = outcome.passed;
    acceptanceSummary = outcome.summary;
    onEvent({ type: 'status', text: `${outcome.passed ? '✅' : '❌'} v4: 验收 ${outcome.summary}` });
    // 验收失败 → 唤回(总预算内)
    if (!outcome.passed && recall && recallsUsed < MAX_PLAN_RECALLS) {
      onEvent({ type: 'status', text: `🔁 v4: 验收失败,唤回立法者(第 ${recallsUsed + 1} 次)` });
      const patch = await recall({
        trigger: 'acceptanceFailed',
        failureDetail: outcome.summary,
        planSummary: plan.summary,
        attempt: recallsUsed + 1,
      });
      recallsUsed += 1;
      if (patch.abort) {
        execHistory.push({ role: 'user', content: `\n---\n❌ v4 验收失败且立法者判不可修: ${patch.reason ?? '(无理由)'}\n---\n` });
      }
      // acceptance 失败不重跑整个 DAG(节点已 completed,重放无意义);
      // 把失败详情记入 history 供用户裁决。plan 级重立法放二期。
      else {
        execHistory.push({ role: 'user', content: `\n---\n❌ v4 验收未通过: ${outcome.summary}\n立法者意见: ${patch.reason ?? '(已给修复方向)'}\n---\n` });
      }
    }
  }

  // 缓存统计
  const st = cacheStats(ctx.convId ?? '');
  if (st.hits > 0) onEvent({ type: 'status', text: `♻️ v4: 缓存命中 ${st.hits} 次(省 ${st.savedCalls} 次工具调用)` });

  return {
    history: execHistory,
    completedNodeIds: [...completed],
    failedNodeIds: [...failed],
    acceptancePassed,
    acceptanceSummary,
    recallsUsed,
  };

  // ── 内部:节点生命周期(执行 → 断言 → 429 park → 重试 → 唤回)──
  async function runNodeWithLifecycle(node: LegisNode): Promise<{ ok: boolean; summary: string }> {
    setNode(node.id, 'in_progress');
    let attempt = 0;
    let lastErr = '';
    while (attempt <= MAX_NODE_RETRIES + MAX_NODE_RECALLS && !signal.aborted) {
      try {
        const t0 = Date.now();
        const summary = await runLegisNodeInner(node);
        const durationMs = Date.now() - t0;
        // 节点级断言
        const assert = evaluateAssertions(node.asserts, { output: summary.output, cwd: ctx.cwd, durationMs });
        if (assert.passed) {
          setNode(node.id, 'completed');
          execHistory.push(...summary.stepMessages);
          execHistory.push({ role: 'user', content: `\n---\n✅ 步骤[${node.id}] 完成: ${node.title}\n${node.kind === 'replay' ? '(replay 零 LLM)' : '结果'}: ${(summary.summary ?? '').slice(0, policy.stepSummaryMaxChars || 600)}\n---\n` });
          onEvent({ type: 'status', text: `✅ v4: [${node.id}] ${node.title} 完成${node.kind === 'replay' ? ' (零 LLM)' : ''}` });
          try { onCheckpoint?.({ completedNodeIds: [...completed], history: execHistory }); } catch { /* 存档失败不影响执行 */ }
          return { ok: true, summary: summary.summary ?? '' };
        }
        // 断言失败 → 先同 args 重试(≤2),后唤回
        lastErr = assert.summary;
        onEvent({ type: 'status', text: `⚠️ v4: [${node.id}] ${node.title} 断言失败 — ${assert.summary}` });
      } catch (e) {
        const err = e as Error;
        // 429/瞬态 → park + 退避,不占重试预算
        if (isTransient(e)) {
          reportTransient();
          const wait = retryAfterMs(err);
          onEvent({ type: 'status', text: `⏸️ v4: [${node.id}] 遇限流,任务挂起等待退避(${wait ? `${Math.round(wait / 1000)}s` : '60-120s'})` });
          await waitForGate(signal);
          if (signal.aborted) break;
          continue;
        }
        lastErr = err.message?.slice(0, 200) ?? String(e);
        onEvent({ type: 'status', text: `⚠️ v4: [${node.id}] ${node.title} 执行失败 — ${lastErr}` });
      }
      attempt += 1;
      // 同 args 重试耗尽 → 唤回
      if (attempt > MAX_NODE_RETRIES && recall && recallsUsed < MAX_PLAN_RECALLS && recallsUsed < MAX_NODE_RECALLS * plan.nodes.length) {
        onEvent({ type: 'status', text: `🔁 v4: [${node.id}] 重试耗尽,唤回立法者修复` });
        const patch = await recall({
          trigger: 'nodeFailed',
          nodeId: node.id,
          nodeTitle: node.title,
          failureDetail: lastErr,
          planSummary: plan.summary,
          attempt,
        });
        recallsUsed += 1;
        if (patch.abort) {
          setNode(node.id, 'failed');
          throw new Error(`节点[${node.id}] 立法者判不可修: ${patch.reason ?? lastErr}`);
        }
        if (patch.nodeId === node.id) {
          if (patch.newScript) node.script = patch.newScript;
          if (patch.newAction) node.action = patch.newAction;
          if (patch.newAsserts) node.asserts = patch.newAsserts;
          onEvent({ type: 'status', text: `🩹 v4: [${node.id}] 已按补丁更新,续跑` });
        }
      } else if (attempt > MAX_NODE_RETRIES) {
        setNode(node.id, 'failed');
        throw new Error(`节点[${node.id}] 失败: ${lastErr}`);
      } else {
        onEvent({ type: 'status', text: `🔄 v4: [${node.id}] 重试 ${attempt}/${MAX_NODE_RETRIES}(同参数)` });
      }
    }
    setNode(node.id, 'failed');
    return { ok: false, summary: lastErr };
  }

  function settleResults(nodes: LegisNode[], results: Array<PromiseSettledResult<{ ok: boolean; summary: string }>>): void {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const r = results[i]!;
      if (r.status === 'fulfilled' && r.value.ok) {
        completed.add(node.id);
      } else {
        failed.add(node.id);
        const msg = r.status === 'rejected' ? (r.reason as Error)?.message?.slice(0, 120) : r.value?.summary;
        execHistory.push({ role: 'user', content: `\n---\n❌ 步骤[${node.id}] 失败: ${msg ?? '未知'}\n---\n` });
        onEvent({ type: 'status', text: `❌ v4: [${node.id}] ${node.title} 失败 — ${msg ?? ''}` });
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// 单节点执行:replay(0 LLM)vs agent(runAgentLoop)
// ────────────────────────────────────────────────────────────────────────

interface NodeOutput { output: string; summary: string; stepMessages: ChatMsg[] }

async function runLegisNode(node: LegisNode, tools: Tool[], ctx: ToolCtx, signal: AbortSignal, provider: Provider, systemPrompt: string, memoryBlock: string | undefined, snapshot: ConfigSnapshot, policy: EngineContextPolicy, history: ChatMsg[], onEvent: (e: AgentEvent) => void): Promise<NodeOutput> {
  if (node.kind === 'replay' && node.script) {
    return runReplay(node, tools, ctx, signal, onEvent);
  }
  return runAgent(node, tools, ctx, signal, provider, systemPrompt, memoryBlock, snapshot, policy, history, onEvent);
}

/** replay:Runtime 直跑工具链(0 LLM)。带缓存包装。 */
async function runReplay(node: LegisNode, tools: Tool[], ctx: ToolCtx, signal: AbortSignal, onEvent: (e: AgentEvent) => void): Promise<NodeOutput> {
  const stepMessages: ChatMsg[] = [];
  let lastOutput = '';
  for (let i = 0; i < (node.script?.length ?? 0); i++) {
    const step = node.script![i]!;
    const tool = tools.find((t) => t.name === step.tool);
    if (!tool) {
      throw new Error(`节点[${node.id}] 步骤 ${i + 1}: 工具 ${step.tool} 不存在`);
    }
    const cached = ctx.convId ? withCache(tool, ctx.convId, ctx.cwd, (note) => onEvent({ type: 'status', text: `♻️ v4: ${note}` })) : tool;
    const res = await cached.run(step.args, ctx);
    lastOutput = res;
    // 步级断言
    const outcome = evaluateAssertions(step.asserts, { output: res, cwd: ctx.cwd });
    if (!outcome.passed) {
      throw new Error(`节点[${node.id}] 步骤 ${i + 1}(${step.tool})断言失败: ${outcome.summary}`);
    }
    stepMessages.push({ role: 'assistant', content: null, tool_calls: [{ id: `replay_${node.id}_${i}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] });
    stepMessages.push({ role: 'tool', tool_call_id: `replay_${node.id}_${i}`, content: res.slice(0, 400) });
    onEvent({ type: 'tool', name: `⚙️ ${step.tool}`, args: JSON.stringify(step.args), result: res.slice(0, 2000), durationMs: 0 });
  }
  return {
    output: lastOutput,
    summary: `(replay ×${node.script?.length ?? 0} 步,零 LLM) ${(node.script ?? []).map((s) => s.tool).join('→')}`,
    stepMessages,
  };
}

/** agent:子 ReAct(runAgentLoop,步数保险丝)。 */
async function runAgent(node: LegisNode, tools: Tool[], ctx: ToolCtx, signal: AbortSignal, provider: Provider, systemPrompt: string, memoryBlock: string | undefined, snapshot: ConfigSnapshot, policy: EngineContextPolicy, history: ChatMsg[], onEvent: (e: AgentEvent) => void): Promise<NodeOutput> {
  const nodeSystem = systemPrompt + `\n\n# 当前节点任务\n你正在执行计划图的一个节点。节点 id: ${node.id}\n${node.action}`;
  const updated = await runAgentLoop({
    provider,
    tools,
    systemPrompt: nodeSystem,
    memoryBlock,
    snapshot,
    userInput: node.action,
    history: [...history],
    ctx,
    signal,
    maxTurns: node.maxSteps ?? 8,
    policy,
    onEvent,
  });
  // 产出 = 尾部 assistant 文本
  let answer = '';
  for (let i = updated.length - 1; i >= 0; i--) {
    const m = updated[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) { answer = m.content; break; }
  }
  // stepMessages = 本节点新增消息(排除注入的原始 history 前缀)
  const stepMessages = updated.slice(Math.min(history.length, updated.length));
  return { output: answer, summary: answer.slice(0, 400), stepMessages };
}

// retryAfterMs(错误文本里的 Retry-After/重置提示)
function retryAfterMs(e: Error): number | null {
  const text = `${(e as { detail?: string }).detail ?? ''} ${e.message ?? ''}`;
  const m = text.match(/(?:retry.?after|重试|重置).{0,20}?(\d{2,4})\s*(s|秒)/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n <= 900) return n * 1000;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// 分层/分流(与 V3 dag-executor 同语义)
// ────────────────────────────────────────────────────────────────────────

function topologicalLevels(nodes: LegisNode[]): LegisNode[][] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const done = new Set<string>();
  const levels: LegisNode[][] = [];
  let remaining = [...nodes];
  while (remaining.length > 0) {
    const cur = remaining.filter((n) => n.deps.every((d) => done.has(d) || !nodeMap.has(d)));
    if (cur.length === 0) { levels.push(remaining); break; }
    levels.push(cur);
    cur.forEach((n) => done.add(n.id));
    remaining = remaining.filter((n) => !done.has(n.id));
  }
  return levels;
}

/** 同层分流:replay + 只读 agent 可并行;含写/未知工具的 agent 串行(保守)。 */
function partitionByWrite(level: LegisNode[], tools: Tool[], runnable: LegisNode[]) {
  const knownReadonly = new Set(tools.filter((t) => t.readOnly).map((t) => t.name));
  const parallelSafe: LegisNode[] = [];
  const mustSerialize: LegisNode[] = [];
  for (const node of level) {
    if (!runnable.includes(node)) continue; // 被跳过的节点不进任何队列
    if (!node.parallelizable) { mustSerialize.push(node); continue; }
    if (node.kind === 'replay') { parallelSafe.push(node); continue; } // replay 白名单本就只读
    if (!Array.isArray(node.tools) || node.tools.length === 0) { mustSerialize.push(node); continue; }
    if (node.tools.every((t) => knownReadonly.has(t))) parallelSafe.push(node);
    else mustSerialize.push(node);
  }
  return { parallelSafe, mustSerialize };
}

/** acceptance 的 shell 证据:replay 节点的最后输出(acceptance 里的 exitZero 断言用)。 */
function acceptanceShellOutput(plan: LegisPlan, completed: Set<string>): string {
  // acceptance 断言的 evidence 通常自带(如 fileExists 用 cwd);
  // exitZero 类无直接证据 → 返回空(此类断言应由模型写进对应 replay 步)
  return '';
}
