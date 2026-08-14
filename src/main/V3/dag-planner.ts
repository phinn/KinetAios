// V3 DAG Planner — 结构化规划器
//
// V2 的 parsePlan 依赖 <plan> JSON 标签 + brace-counting,极易碎。
// V3 改用 forced tool_use:定义一个 submit_plan 工具,强制模型调用它,
// 从 tool arguments 直接拿结构化数据 — 100% 可靠。
//
// DAG Plan:有向无环图,节点之间有依赖关系。
// 同层节点(无互相依赖)可并行执行,不同层串行。

import type { ChatMsg, ConfigSnapshot, EngineContextPolicy, AgentEvent } from '../../shared/types';
import { runAgentLoop } from '../AgentLoop';
import type { Provider, ToolDef } from '../glm';
import type { Tool, ToolCtx } from '../tools';
import { readOnlyTools } from '../tools';
// ────────────────────────────────────────────────────────────────────────
// DAG 数据结构
// ────────────────────────────────────────────────────────────────────────

export interface DAGNode {
  id: string;
  title: string;
  action: string;           // 自然语言描述(给 LLM 执行的 prompt)
  tools: string[];           // 预期使用的工具名
  verify?: string;           // 验证命令(tsc/lint/test)
  parallelizable: boolean;   // 是否可与同层节点并行
  deps: string[];            // 依赖的节点 ID 列表
  // 运行时状态
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: string;
  retryCount: number;
}

export interface DAGPlan {
  goal: string;
  nodes: DAGNode[];
  summary: string;
}

// ────────────────────────────────────────────────────────────────────────
// forced tool_use:submit_plan 工具定义
// ────────────────────────────────────────────────────────────────────────

const SUBMIT_PLAN_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'submit_plan',
    description: '提交任务执行规划(有向无环图)。调用此工具后系统将按依赖关系并行执行各步骤。',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: '任务的最终目标(一句话描述)',
        },
        summary: {
          type: 'string',
          description: '规划摘要(给用户看的简短说明)',
        },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '节点唯一标识(如 "1", "2a", "3")' },
              title: { type: 'string', description: '节点标题(简短)' },
              action: { type: 'string', description: '执行指令(自然语言,相当于给子 agent 的 prompt)' },
              tools: {
                type: 'array',
                items: { type: 'string' },
                description: '预期使用的工具名列表(如 ["read_file", "grep", "shell"])',
              },
              verify: {
                type: 'string',
                description: '验证命令(可选,如 "npx tsc --noEmit")。仅写操作步骤需要。',
              },
              parallelizable: {
                type: 'boolean',
                description: '是否可与同层其他节点并行执行(无文件写冲突时为 true)',
              },
              deps: {
                type: 'array',
                items: { type: 'string' },
                description: '依赖的节点 ID 列表(必须在这些节点完成后才能开始)',
              },
            },
            required: ['id', 'title', 'action', 'tools', 'parallelizable', 'deps'],
          },
        },
      },
      required: ['goal', 'summary', 'nodes'],
    },
  },
};

const PLAN_SYSTEM_SUFFIX = `

# 你是 Kaios v3 引擎 — 具备结构化规划能力

你正在为一个自适应流水线系统工作。面对复杂任务,请先探查现状(用只读工具),然后调用 \`submit_plan\` 工具提交你的执行规划。

## 规划原则
1. **DAG 依赖**:节点之间的依赖关系必须显式声明(\`deps\` 字段)。无互相依赖的节点设为 \`parallelizable: true\`。
2. **粒度适中**:每个节点应该是一个逻辑完整的执行单元(如"修改 DirectV2Engine.ts 的 Plan 解析"或"搜索所有使用 brace-counting 的位置")。
3. **只读探查并行**:grep/read_file 等只读探查步骤尽量设为 parallelizable。
4. **写操作串行**:文件写操作要标明 verify 命令(tsc/lint)。
5. **节点数量**:2-6 个节点为佳,避免过度拆分。

## 关键:必须调用 submit_plan 工具
不要在回答文本中输出 plan,而是调用 \`submit_plan\` 工具。系统会自动解析你的规划并执行。
先探查,想清楚后一次性调用 submit_plan。
`;

// ────────────────────────────────────────────────────────────────────────
// submit_plan 伪工具:run 执行器,让 planner 走 runAgentLoop 时工具表完整可用
// ────────────────────────────────────────────────────────────────────────

const submitPlanPseudoTool: Tool = {
  name: 'submit_plan',
  description: SUBMIT_PLAN_TOOL.function.description,
  parameters: SUBMIT_PLAN_TOOL.function.parameters as Record<string, unknown>,
  readOnly: true, // 不产生副作用:只解析入参,由 planner 拦截
  run: async () => 'PLAN_SUBMITTED', // 实际解析在 runAgentLoop 返回的 history 里做,这里只回占位
};

// ────────────────────────────────────────────────────────────────────────
// Plan 生成
// ────────────────────────────────────────────────────────────────────────

/**
 * M1-fix: 用 runAgentLoop 生成 DAG plan(planner 可多轮探查)。
 *
 * 旧实现单轮 streamComplete,planner 无工具执行能力 → deep 任务(恰恰最需要
 * 先 grep/read 探查的)全凭想象规划,plan 质量差。
 *
 * 新实现:submit_plan 作为工具注入 runAgentLoop。模型先用只读工具探查
 * (grep/read_file 等),探查完自然调用 submit_plan 提交结构化 plan。
 * runAgentLoop 执行该工具(返回占位结果),我们再从返回的 history 尾部
 * 提取 submit_plan 的 tool call,解析 arguments。
 *
 * 与 V2 planner 的探查模式对齐,同时保留 forced-tool 结构化输出的可靠性。
 */
export async function generateDAGPlan(
  userInput: string,
  history: ChatMsg[],
  systemPrompt: string,
  provider: Provider,
  snap: ConfigSnapshot,
  signal: AbortSignal,
  readOnlyToolDefs: ToolDef[],  // 只读工具 defs(用于探查)
  onEvent: (e: { type: string; text?: string; token?: string; [k: string]: unknown }) => void,
  ctx?: ToolCtx,
  policy?: EngineContextPolicy,
): Promise<DAGPlan | null> {
  onEvent({ type: 'status', text: '🧠 v3: 规划中...' });

  try {
    // 从 ToolDef 还原 Tool(defs 是工具表的投影,这里需要可执行的 run)
    // 若调用方没传 ctx(旧签名),退化为单轮 streamComplete 保底。
    if (!ctx) {
      return await generateDAGPlanLegacy(userInput, history, systemPrompt, provider, snap, signal, readOnlyToolDefs, onEvent);
    }

    // planner 专用 Tool 数组:只读探查工具 + submit_plan 伪工具
    const readOnlyRunnables = readOnlyToolsFromDefs(readOnlyToolDefs);
    const plannerTools: Tool[] = [...readOnlyRunnables, submitPlanPseudoTool];

    const planHistory = await runAgentLoop({
      provider,
      tools: plannerTools,
      systemPrompt: systemPrompt + PLAN_SYSTEM_SUFFIX,
      snapshot: snap,
      userInput,
      history: history.filter((m) => !m._memory),
      ctx,
      signal,
      maxTurns: 10, // 探查轮次上限:足够 grep/read 几轮再规划,不至于无限烧
      policy,
      onEvent: (ev) => {
        if (ev.type === 'done' || ev.type === 'error') return; // 由 V3 统一发
        if (ev.type === 'token') {
          onEvent({ type: 'plan_token', token: ev.text }); // 规划思路流式输出(AgentEvent.token 的载荷字段是 text)
          return;
        }
        if (ev.type === 'status') {
          onEvent({ type: 'status', text: `v3: [plan] ${ev.text}` });
          return;
        }
        onEvent(ev);
      },
    });

    // 从 history 尾部找 submit_plan 的 assistant tool call(倒序找最近一次)
    const planCall = findSubmitPlanCall(planHistory);
    if (!planCall) {
      // 模型探查完直接给了文本结论(任务太简单/对话型回复)→ 退化为 std path
      if (planHistory.some((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())) {
        onEvent({ type: 'status', text: '💡 v3: 模型未生成 plan,退化为 std path' });
        return null;
      }
      onEvent({ type: 'status', text: '⚠️ v3: 规划失败(模型未调用 submit_plan)' });
      return null;
    }

    const plan = parseDAGFromToolArgs(planCall.arguments);
    if (!plan) {
      onEvent({ type: 'status', text: '⚠️ v3: plan 解析失败' });
      return null;
    }

    onEvent({
      type: 'status',
      text: `📋 v3: 规划完成 — ${plan.nodes.length} 个节点, ${countParallelizable(plan)} 个可并行`,
    });

    return plan;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    onEvent({ type: 'status', text: `⚠️ v3: 规划出错 — ${msg.slice(0, 100)}` });
    return null;
  }
}

/** 从 runAgentLoop 返回的 history 中提取最近一次 submit_plan tool call。 */
function findSubmitPlanCall(msgs: ChatMsg[]): { arguments: string } | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    const calls = (m as { tool_calls?: Array<{ function: { name: string; arguments: string } }> }).tool_calls;
    if (!Array.isArray(calls)) continue;
    const hit = calls.find((c) => c.function?.name === 'submit_plan');
    if (hit) return { arguments: hit.function.arguments };
  }
  return null;
}

/** ToolDef[] → 可执行 Tool[](从全局只读工具表按名字匹配 run 实现)。 */
function readOnlyToolsFromDefs(defs: ToolDef[]): Tool[] {
  // deep-path 传入的 readOnlyToolDefs 本来就是 readOnlyTools() 的投影,
  // 直接用全量只读表(名字集合一致,保证 run 一定找得到)。
  return readOnlyTools().filter((t) => defs.some((d) => d.function.name === t.name));
}

/** 旧版单轮规划(streamComplete),作为无 ctx 时的保底路径。 */
async function generateDAGPlanLegacy(
  userInput: string,
  history: ChatMsg[],
  systemPrompt: string,
  provider: Provider,
  snap: ConfigSnapshot,
  signal: AbortSignal,
  tools: ToolDef[],
  onEvent: (e: { type: string; text?: string; token?: string; [k: string]: unknown }) => void,
): Promise<DAGPlan | null> {
  const messages: ChatMsg[] = [
    { role: 'system', content: systemPrompt + PLAN_SYSTEM_SUFFIX },
    ...history.filter((m) => !m._memory),
    { role: 'user', content: userInput },
  ];

  const completion = await provider.streamComplete(
    messages,
    [...tools, SUBMIT_PLAN_TOOL],
    snap,
    signal,
    (token) => {
      onEvent({ type: 'plan_token', token });
    },
  );

  const planCall = completion.toolCalls.find((tc) => tc.name === 'submit_plan');
  if (!planCall) {
    if (completion.content?.trim()) {
      onEvent({ type: 'status', text: '💡 v3: 模型未生成 plan,退化为 std path' });
      return null;
    }
    onEvent({ type: 'status', text: '⚠️ v3: 规划失败(模型未调用 submit_plan)' });
    return null;
  }

  const plan = parseDAGFromToolArgs(planCall.arguments);
  if (!plan) {
    onEvent({ type: 'status', text: '⚠️ v3: plan 解析失败' });
    return null;
  }

  onEvent({
    type: 'status',
    text: `📋 v3: 规划完成 — ${plan.nodes.length} 个节点, ${countParallelizable(plan)} 个可并行`,
  });

  return plan;
}

/**
 * 从 submit_plan 工具的 arguments 中解析 DAG plan。
 * arguments 是 JSON 字符串,直接 JSON.parse 即可 — 不需要 brace-counting。
 */
function parseDAGFromToolArgs(argsJson: string): DAGPlan | null {
  try {
    const raw = JSON.parse(argsJson) as {
      goal?: string;
      summary?: string;
      nodes?: Array<{
        id?: string;
        title?: string;
        action?: string;
        tools?: string[];
        verify?: string;
        parallelizable?: boolean;
        deps?: string[];
      }>;
    };

    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) return null;

    // L4-fix: 元素类型严格校验 — LLM 偶尔会把 tools/deps 输出成嵌套对象/数字数组,
    // 只查 Array.isArray 会让脏元素漏进 executor(node.tools.every 判写工具时炸)。
    const cleanStrArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

    const nodes: DAGNode[] = raw.nodes.map((n, i) => ({
      id: String(n.id ?? i + 1),
      title: String(n.title ?? `步骤 ${i + 1}`),
      action: String(n.action ?? ''),
      tools: cleanStrArr(n.tools),
      verify: typeof n.verify === 'string' && n.verify.trim() ? n.verify : undefined,
      parallelizable: typeof n.parallelizable === 'boolean' ? n.parallelizable : true,
      deps: cleanStrArr(n.deps),
      status: 'pending' as const,
      retryCount: 0,
    }));

    // 验证 DAG 无环
    if (hasCycle(nodes)) {
      console.warn('[V3] DAG has cycle, falling back to linear execution');
      // 退化:忽略依赖,全部串行
      nodes.forEach((n) => { n.deps = []; n.parallelizable = false; });
    }

    return {
      goal: String(raw.goal ?? ''),
      summary: String(raw.summary ?? nodes.map((n) => n.title).join(', ')),
      nodes,
    };
  } catch {
    return null;
  }
}

/** 检测 DAG 是否有环(拓扑排序) */
function hasCycle(nodes: DAGNode[]): boolean {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(id: string): boolean {
    if (stack.has(id)) return true;  // 发现环
    if (visited.has(id)) return false;
    visited.add(id);
    stack.add(id);
    const node = nodeMap.get(id);
    if (node) {
      for (const dep of node.deps) {
        if (dfs(dep)) return true;
      }
    }
    stack.delete(id);
    return false;
  }

  return nodes.some((n) => dfs(n.id));
}

function countParallelizable(plan: DAGPlan): number {
  return plan.nodes.filter((n) => n.parallelizable).length;
}

export { PLAN_SYSTEM_SUFFIX };
