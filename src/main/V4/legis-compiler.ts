// V4 Legis Compiler — 计划编译器(LLM 出场 #1)
//
// 与 V3 dag-planner 同模式:forced tool_use。定义 submit_legis_plan 工具,
// 模型必须经它提交结构化计划。差异(V4 的"立法"本质):
//   - 节点带 kind: replay(纯工具链,Runtime 0 LLM 直跑)/ agent(子 ReAct)
//   - 节点/计划带断言: 确定性验收,替代 goal/supervisor 的 94% continue 复读
//   - acceptance: goal 的机器可判版本,Runtime 全过才 GOAL_COMPLETE
// 编译期校验:script 白名单(REPLAY_ALLOWED_TOOLS)、写操作强制 agent 节点、
// DAG 无环、节点 id 唯一。
// Same forced-tool_use pattern as V3's planner, but the plan is a *law*:
// replay nodes run with zero LLM, assertions verify deterministically.

import type { ChatMsg, ConfigSnapshot, EngineContextPolicy, AgentEvent } from '../../shared/types';
import { runAgentLoop } from '../AgentLoop';
import type { Provider, ToolDef } from '../glm';
import type { Tool, ToolCtx } from '../tools';
import { readOnlyTools } from '../tools';
import { REPLAY_ALLOWED_TOOLS, type Assertion, type LegisNode, type LegisPlan, type LegisScriptStep } from './plan';

// ────────────────────────────────────────────────────────────────────────
// forced tool_use: submit_legis_plan 工具定义
// ────────────────────────────────────────────────────────────────────────

const ASSERTION_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['exitZero', 'outputContains', 'outputNotContains', 'outputEmpty', 'outputNotEmpty', 'jsonParses', 'fileExists', 'fileNotExists', 'lineCountMin', 'durationMsMax'],
      description: '断言类型: exitZero=shell成功 | outputContains/notContains=输出含/不含子串 | fileExists/NotExists=文件存在性(相对cwd,支持*) | lineCountMin=文件行数下限',
    },
    value: { type: 'string', description: '断言参数: 子串/文件路径/行数等(type 决定语义)' },
    note: { type: 'string', description: '这条断言在检查什么(人读)' },
  },
  required: ['type'],
} as const;

const SCRIPT_STEP_SCHEMA = {
  type: 'object',
  properties: {
    tool: { type: 'string', enum: [...REPLAY_ALLOWED_TOOLS], description: '只读工具 + shell。写文件必须走 agent 节点' },
    args: { type: 'object', description: '工具入参(如 {"command":"npm run typecheck"})' },
    asserts: { type: 'array', items: ASSERTION_SCHEMA, description: '本步输出断言(如 exitZero)' },
  },
  required: ['tool', 'args'],
} as const;

export const SUBMIT_LEGIS_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'submit_legis_plan',
    description: '提交 Legis 执行计划(立法)。系统将按计划零 LLM 执行 replay 节点,断言失败才唤回你。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '任务目标(一句话)' },
        summary: { type: 'string', description: '计划摘要(给用户看)' },
        nodes: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '节点 id(短,如 s1/s2;被 deps 引用)' },
              title: { type: 'string', description: '节点标题' },
              kind: { type: 'string', enum: ['agent', 'replay'], description: 'replay=确定性工具链(0 LLM,系统直跑);agent=需要 LLM 判断的子任务' },
              action: { type: 'string', description: 'agent 节点:自然语言执行指令(详细到可独立执行);replay 节点:用途说明' },
              tools: { type: 'array', items: { type: 'string' }, description: 'agent 节点预期工具名' },
              script: { type: 'array', items: SCRIPT_STEP_SCHEMA, description: 'replay 节点必填:确定性工具链' },
              asserts: { type: 'array', items: ASSERTION_SCHEMA, description: '节点级断言(节点完成后校验)' },
              parallelizable: { type: 'boolean', description: '可与同层无依赖节点并行(只读探查=true,写操作=false)' },
              deps: { type: 'array', items: { type: 'string' }, description: '依赖节点 id' },
            },
            required: ['id', 'title', 'kind', 'action', 'deps', 'parallelizable'],
          },
        },
        acceptance: { type: 'array', items: ASSERTION_SCHEMA, description: '验收断言表:整个计划完成后必须全部通过(如 exitZero 的 typecheck 命令 + fileExists 的产物检查)。这是任务完成的机器判定标准' },
      },
      required: ['goal', 'summary', 'nodes'],
    },
  },
};

export const LEGIS_PLAN_SYSTEM_SUFFIX = `

# 你是 Kaios v4 引擎(Legis)— 立法者
你的职责是一次性把任务意图编译成可执行的计划图(立法),之后由系统零 LLM 执行。
**你只在两种情况出场:现在(编译)和断言失败时(唤回修复)。**

## 立法原则
1. **能 replay 不 agent**:确定性动作(跑 typecheck、读文件、grep 验证、检查产物存在)一律写 replay 节点的 script —— 系统直跑,不花 LLM。只有需要判断/写内容的才用 agent 节点。
2. **每个 agent 节点必须有节点级断言**:做完怎么知道做对了?如 fileExists(产物路径)、outputContains(关键标志)、lineCountMin。
3. **acceptance 是任务完成的机器判定**:目标达成的可验证证据(命令成功 + 产物存在)。不要写"看起来完成"这类无法机器判定的标准。
4. **依赖显式**:deps 引用节点 id;无互相依赖的只读节点标 parallelizable=true。
5. **粒度**:2-8 节点。每个 agent 节点是逻辑完整单元;replay 节点可以只装一条命令。

## 编译期强校验(违反会被拒绝)
- replay 的 script.tool 只允许: ${[...REPLAY_ALLOWED_TOOLS].join(', ')}。写文件(edit_file/write_file)禁止进 script —— 写内容必须 agent 节点。
- 节点 id 唯一;deps 引用必须存在;DAG 不能有环。

## ⏱ 探查预算(硬纪律)
**至多 3 轮只读探查,然后必须调用 submit_legis_plan。**
- 已有上下文(history 里的近期工具结果)先读,能不探就不探。
- 探查的目的是"够写计划",不是"找到答案"—— 答案在执行阶段找。
- 未提交计划而烧到轮数上限 = 立法失败,系统会退化 std 并丢弃你的全部工作,这是最差结局。
- 不确定的信息写进 agent 节点的 action 让执行时现场判断,不要试图现在就查清。
- 长任务/继续型任务:计划图可以拆阶段,先立当前阶段(acceptance 写本阶段验收),完成后再立下一阶段。

## 完整示例(照此结构与粒度)
用户:"修复 ESP32 无法编译的问题,然后烧录验证"
\`\`\`json
{
  "goal": "修复编译错误并烧录验证",
  "summary": "先复现错误定位根因,修复后 typecheck,再烧录+串口验证",
  "nodes": [
    { "id": "s1", "title": "复现编译错误", "kind": "replay",
      "action": "跑编译拿到原始报错",
      "script": [{ "tool": "shell", "args": { "command": "npm run build 2>&1 | tail -40" } }],
      "asserts": [{ "type": "exitZero" }], "deps": [], "parallelizable": false },
    { "id": "a1", "title": "定位并修复根因", "kind": "agent",
      "action": "读 s1 输出的报错,定位对应源文件,修复根因(注意同类隐患一起修)。禁止只修表象。",
      "tools": ["read_file", "grep", "edit_file"],
      "asserts": [{ "type": "outputNotEmpty", "note": "修复报告(改了什么文件、为什么)" }], "deps": ["s1"], "parallelizable": false },
    { "id": "s2", "title": "编译验证", "kind": "replay",
      "action": "修复后必须编译通过",
      "script": [{ "tool": "shell", "args": { "command": "npm run build" } }],
      "asserts": [{ "type": "exitZero" }], "deps": ["a1"], "parallelizable": false },
    { "id": "a2", "title": "烧录并串口验证", "kind": "agent",
      "action": "烧录固件到设备,采串口输出确认无 boot loop、预期日志出现。",
      "tools": ["shell", "serial_monitor"],
      "asserts": [{ "type": "outputContains", "value": "预期启动日志关键词" }], "deps": ["s2"], "parallelizable": false }
  ],
  "acceptance": [
    { "type": "exitZero", "value": "npm run build" },
    { "type": "outputContains", "value": "预期启动日志关键词" }
  ]
}
\`\`\`

先探查(至多 3 轮),想清楚后**立即**调用 submit_legis_plan。
`;

// submit_legis_plan 伪工具(与 V3 submitPlanPseudoTool 同款:run 返回占位,真解析在 history 尾部)
const submitLegisPseudoTool: Tool = {
  name: 'submit_legis_plan',
  description: SUBMIT_LEGIS_TOOL.function.description,
  parameters: SUBMIT_LEGIS_TOOL.function.parameters as Record<string, unknown>,
  readOnly: true,
  run: async () => 'PLAN_SUBMITTED',
};

// ────────────────────────────────────────────────────────────────────────
// 编译: plan 生成 + 校验
// ────────────────────────────────────────────────────────────────────────

export interface CompileOpts {
  userInput: string;
  history: ChatMsg[];
  systemPrompt: string;
  provider: Provider;
  snap: ConfigSnapshot;
  signal: AbortSignal;
  onEvent: (e: AgentEvent) => void;
  ctx: ToolCtx;
  policy?: EngineContextPolicy;
  memoryBlock?: string;
  /** goal 模式(无人值守)时传入,编译器把验收要求编进 acceptance。 */
  goal?: string;
}

export async function compileLegisPlan(opts: CompileOpts): Promise<{ plan: LegisPlan | null; probedHistory: ChatMsg[] }> {
  const { userInput, history, systemPrompt, provider, snap, signal, onEvent, ctx, policy, memoryBlock, goal } = opts;
  onEvent({ type: 'status', text: '📜 v4: 立法中(编译计划)...' });

  // 规划工具集 = 只读探查工具 + submit_legis_plan(写入工具不在 planner 手,防越权写)
  const planTools = [...readOnlyTools(), submitLegisPseudoTool];

  const suffix = LEGIS_PLAN_SYSTEM_SUFFIX + (goal
    ? `\n\n## 本会话有既定目标(无人值守)\ngoal: ${goal}\nacceptance 必须直接针对该目标的可验证完成证据设计。`
    : '');

  const updated = await runAgentLoop({
    provider,
    tools: planTools,
    systemPrompt: systemPrompt + suffix,
    memoryBlock,
    snapshot: snap,
    userInput,
    history,
    ctx,
    signal,
    maxTurns: 12, // 编译保险丝:探查+提交,12 轮足够;防 planner 无限探查
    policy,
    onEvent,
  });

  // 从 history 尾部提取 submit_legis_plan 的 tool call
  // 探查成果不丢弃:planner 12 轮的只读探查 history 返回给调用方,退化 std 时继承(2026-10-13:两次白烧事故)。
  // 尾部是本轮 userInput 的 user 消息(runAgentLoop 收到 history+userInput 分体),去掉防 std 重复追加。
  const probedHistory = updated.filter((m) => !m._memory && m.role !== 'system');
  while (probedHistory.length && probedHistory[probedHistory.length - 1].role === 'user'
    && probedHistory[probedHistory.length - 1].content === userInput) {
    probedHistory.pop(); // 恰好是本轮 userInput 的尾部 user 消息(可能是多条同文,全剥)
  }
  const planCall = extractPlanCall(updated);
  if (!planCall) {
    onEvent({ type: 'status', text: '⚠️ v4: 模型未提交立法计划,退化 std(继承立法探查现场)' });
    return { plan: null, probedHistory };
  }

  const plan = parseLegisPlan(planCall.arguments);
  if (!plan) {
    onEvent({ type: 'status', text: '⚠️ v4: 立法计划解析失败,退化 std(继承立法探查现场)' });
    return { plan: null, probedHistory };
  }

  const validation = validateLegisPlan(plan);
  if (!validation.ok) {
    onEvent({ type: 'status', text: `⚠️ v4: 立法计划被编译器拒绝(${validation.reason}),退化 std(继承立法探查现场)` });
    return { plan: null, probedHistory };
  }

  const replayCount = plan.nodes.filter((n) => n.kind === 'replay').length;
  onEvent({
    type: 'status',
    text: `📜 v4: 立法完成 — ${plan.nodes.length} 节点(${replayCount} replay 零LLM / ${plan.nodes.length - replayCount} agent),验收断言 ${plan.acceptance.length} 条`,
  });
  return { plan, probedHistory };
}

/** 从 planner history 尾部提取 submit_legis_plan 的 arguments。 */
function extractPlanCall(history: ChatMsg[]): { arguments: string } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const calls = (m as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls;
    if (!calls) continue;
    for (let j = calls.length - 1; j >= 0; j--) {
      const tc = calls[j];
      if (tc?.function?.name === 'submit_legis_plan' && tc.function.arguments) {
        return { arguments: tc.function.arguments };
      }
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// 解析 + 校验(编译期)
// ────────────────────────────────────────────────────────────────────────

function parseLegisPlan(argsJson: string): LegisPlan | null {
  try {
    const raw = JSON.parse(argsJson) as {
      goal?: unknown; summary?: unknown; nodes?: unknown[]; acceptance?: unknown[];
    };
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) return null;

    const nodes: LegisNode[] = (raw.nodes as Record<string, unknown>[]).map((n, idx) => ({
      id: String(n.id ?? `s${idx + 1}`),
      title: String(n.title ?? `节点${idx + 1}`),
      kind: n.kind === 'replay' ? 'replay' : 'agent',
      action: String(n.action ?? ''),
      tools: Array.isArray(n.tools) ? (n.tools as unknown[]).map(String) : [],
      deps: Array.isArray(n.deps) ? (n.deps as unknown[]).map(String) : [],
      parallelizable: n.parallelizable === true,
      script: parseScript(n.script),
      asserts: parseAsserts(n.asserts),
      maxSteps: typeof n.maxSteps === 'number' ? n.maxSteps : undefined,
    }));

    const acceptance = parseAsserts(raw.acceptance) ?? [];

    return {
      goal: String(raw.goal ?? ''),
      summary: String(raw.summary ?? nodes.map((n) => n.title).join(', ')),
      nodes,
      acceptance,
    };
  } catch {
    return null;
  }
}

function parseScript(script: unknown): LegisScriptStep[] | undefined {
  if (!Array.isArray(script) || script.length === 0) return undefined;
  const steps: LegisScriptStep[] = [];
  for (const s of script as Record<string, unknown>[]) {
    if (!s || typeof s.tool !== 'string') continue;
    steps.push({
      tool: s.tool,
      args: (s.args && typeof s.args === 'object' ? s.args : {}) as Record<string, unknown>,
      asserts: parseAsserts(s.asserts),
    });
  }
  return steps.length ? steps : undefined;
}

function parseAsserts(a: unknown): Assertion[] | undefined {
  if (!Array.isArray(a) || a.length === 0) return undefined;
  const out: Assertion[] = [];
  for (const x of a as Record<string, unknown>[]) {
    if (!x || typeof x.type !== 'string') continue;
    out.push({
      type: x.type as Assertion['type'],
      value: typeof x.value === 'string' || typeof x.value === 'number' ? x.value : undefined,
      note: typeof x.note === 'string' ? x.note : undefined,
    });
  }
  return out.length ? out : undefined;
}

/** 编译期强校验 —— 违规计划整体拒绝(退化 std),不做静默修补。 */
export function validateLegisPlan(plan: LegisPlan): { ok: boolean; reason?: string } {
  const ids = new Set<string>();
  for (const n of plan.nodes) {
    if (!n.id) return { ok: false, reason: '存在无 id 节点' };
    if (ids.has(n.id)) return { ok: false, reason: `节点 id 重复: ${n.id}` };
    ids.add(n.id);
  }
  for (const n of plan.nodes) {
    for (const d of n.deps) {
      if (!ids.has(d)) return { ok: false, reason: `[${n.id}] deps 引用不存在的节点: ${d}` };
    }
    if (n.kind === 'replay') {
      if (!n.script || n.script.length === 0) {
        return { ok: false, reason: `[${n.id}] replay 节点缺 script` };
      }
      for (const step of n.script) {
        if (!REPLAY_ALLOWED_TOOLS.has(step.tool)) {
          return { ok: false, reason: `[${n.id}] script 工具 "${step.tool}" 不在白名单(写操作必须走 agent 节点)` };
        }
        if (step.tool === 'shell' && typeof step.args?.command !== 'string') {
          return { ok: false, reason: `[${n.id}] shell 步缺 command 参数` };
        }
      }
    }
  }
  // 环检测(DFS)
  const nodeMap = new Map(plan.nodes.map((n) => [n.id, n]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const node = nodeMap.get(id);
    if (node) {
      for (const d of node.deps) if (dfs(d)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (plan.nodes.some((n) => dfs(n.id))) {
    return { ok: false, reason: 'DAG 有环' };
  }
  return { ok: true };
}

export { submitLegisPseudoTool };
