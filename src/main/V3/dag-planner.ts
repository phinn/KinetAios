// V3 DAG Planner — 结构化规划器
//
// V2 的 parsePlan 依赖 <plan> JSON 标签 + brace-counting,极易碎。
// V3 改用 forced tool_use:定义一个 submit_plan 工具,强制模型调用它,
// 从 tool arguments 直接拿结构化数据 — 100% 可靠。
//
// DAG Plan:有向无环图,节点之间有依赖关系。
// 同层节点(无互相依赖)可并行执行,不同层串行。

import type { ChatMsg, ConfigSnapshot } from '../../shared/types';
import type { Provider, ToolDef, Completion } from '../glm';

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
// Plan 生成
// ────────────────────────────────────────────────────────────────────────

/**
 * 用 forced tool_use 生成 DAG plan。
 * 模型被强制要求调用 submit_plan 工具,从 tool arguments 直接提取结构化数据。
 *
 * 注意:这里不调 runAgentLoop(避免复杂的中间状态),而是直接调 provider.streamComplete。
 * Planner 只需要一轮:模型探查 + 规划。
 */
export async function generateDAGPlan(
  userInput: string,
  history: ChatMsg[],
  systemPrompt: string,
  provider: Provider,
  snap: ConfigSnapshot,
  signal: AbortSignal,
  tools: ToolDef[],  // 传入只读工具让 planner 可以探查
  onEvent: (e: { type: string; text?: string; token?: string; [k: string]: unknown }) => void,
): Promise<DAGPlan | null> {
  onEvent({ type: 'status', text: '🧠 v3: 规划中...' });

  try {
    // Planner 可以做多轮 ReAct 探查,用 runAgentLoop + forced tool
    // 但为简化,这里用两阶段:
    // 1) 如果模型需要探查,它在回答中会用只读工具(由 runAgentLoop 处理)
    // 2) 探查完成后调用 submit_plan
    //
    // 方案:给 runAgentLoop 传入 submit_plan 作为额外工具,模型探查完自然调它。
    // 但 runAgentLoop 不会特殊处理 submit_plan → 我们在 history 尾部找 tool_call。
    //
    // 更可靠的方案:planner 只做一轮 streamComplete,模型已经有 history 可以参考。
    // 如果模型需要探查,应该已经在 fast/std path 的前几轮完成了。

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
        // 规划阶段也流式输出(让用户看到规划思路)
        onEvent({ type: 'plan_token', token });
      },
    );

    // 从 completion 中找 submit_plan tool call
    const planCall = completion.toolCalls.find((tc) => tc.name === 'submit_plan');
    if (!planCall) {
      // 模型没调 submit_plan — 可能是任务太简单不需要 plan
      // 检查是否有文本回答(可能是对话型回复)
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
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    onEvent({ type: 'status', text: `⚠️ v3: 规划出错 — ${msg.slice(0, 100)}` });
    return null;
  }
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

    const nodes: DAGNode[] = raw.nodes.map((n, i) => ({
      id: String(n.id ?? i + 1),
      title: String(n.title ?? `步骤 ${i + 1}`),
      action: String(n.action ?? ''),
      tools: Array.isArray(n.tools) ? n.tools : [],
      verify: n.verify ? String(n.verify) : undefined,
      parallelizable: n.parallelizable ?? true,
      deps: Array.isArray(n.deps) ? n.deps : [],
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
