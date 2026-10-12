// V4 Legis — 计划数据结构
//
// LegisPlan 是 V3 DAGPlan 的超集:节点多了 kind(agent/replay)、script(确定性
// 工具链)、asserts(节点级断言);plan 层多了 acceptance(验收断言表,goal 的
// 机器可判版本)。
// 数据依据(2026-10 history.db 挖掘):>80 步 turn 占总成本 80%、同 turn 21%
// 重复调用、goal/supervisor 94% continue —— replay 节点(0 LLM)+ 断言验收
// 正对这三条。
// LegisPlan is a superset of V3's DAGPlan: nodes gain kind (agent/replay),
// script (deterministic tool chains) and asserts; the plan gains acceptance
// assertions (the machine-checkable form of the goal).

import type { ChatMsg } from '../../shared/types';

// ────────────────────────────────────────────────────────────────────────
// 断言:Runtime 可确定性校验的谓词(0 LLM)
// ────────────────────────────────────────────────────────────────────────

export type AssertionType =
  | 'exitZero'      // shell 输出不含 [exit N] / [超时 → 命令成功
  | 'outputContains' // 输出包含子串
  | 'outputNotContains'
  | 'outputEmpty'
  | 'outputNotEmpty'
  | 'jsonParses'   // 整个输出(或 value 指定部分)可 JSON.parse
  | 'fileExists'   // value=文件路径(相对 cwd,支持 * 通配)
  | 'fileNotExists'
  | 'lineCountMin' // 文件行数 ≥ value
  | 'durationMsMax'; // 执行耗时 ≤ value

export interface Assertion {
  type: AssertionType;
  /** 语义随 type:子串 / 文件路径 / 行数 / 毫秒数。 */
  value?: string | number;
  /** 描述(事件流展示用,LLM 生成计划时应填,便于唤回时人读)。 */
  note?: string;
}

// ────────────────────────────────────────────────────────────────────────
// 节点与计划
// ────────────────────────────────────────────────────────────────────────

export interface LegisScriptStep {
  tool: string;                       // 工具名(必须在 REPLAY_ALLOWED 里)
  args: Record<string, unknown>;      // 工具入参
  asserts?: Assertion[];              // 步级断言(校验本步输出)
}

export interface LegisNode {
  id: string;
  title: string;
  action: string;                     // agent 节点的自然语言指令
  tools: string[];                    // agent 节点预期使用的工具名
  deps: string[];
  parallelizable: boolean;
  // ── V4 新增 ──
  /** replay = Runtime 直跑 script,零 LLM;agent = 子 ReAct(runAgentLoop)。 */
  kind: 'agent' | 'replay';
  /** replay 节点的确定性脚本。agent 节点无此字段。 */
  script?: LegisScriptStep[];
  /** 节点级断言:节点全部步骤完成后校验(输出=最后一步输出或 agent 产出的文本)。 */
  asserts?: Assertion[];
  /** agent 节点子 ReAct 步数保险丝(默认 MAX_TURNS_PER_STEP,与 V3 deep 一致)。 */
  maxSteps?: number;
}

export interface LegisPlan {
  goal: string;
  nodes: LegisNode[];
  summary: string;
  /** 验收断言表:整个 plan 跑完后执行(0 LLM)。全过 → GOAL_COMPLETE;失败 → 唤回。 */
  acceptance: Assertion[];
}

// ────────────────────────────────────────────────────────────────────────
// 检查点(断点续跑;对齐 V3 DAGCheckpoint,history 为执行累积消息)
// ────────────────────────────────────────────────────────────────────────

export interface LegisCheckpoint {
  completedNodeIds: string[];
  history: ChatMsg[];
}

// ────────────────────────────────────────────────────────────────────────
// 唤回协议:LLM 出场 #2..n 的输入/输出契约
// ────────────────────────────────────────────────────────────────────────

export interface RecallInput {
  trigger: 'nodeFailed' | 'acceptanceFailed' | 'emptyOutput';
  nodeId?: string;                    // nodeFailed/emptyOutput 时有
  nodeTitle?: string;
  failureDetail: string;              // 失败断言详情 + tail 输出
  planSummary: string;
  /** 已尝试的唤回次数(该节点)。 */
  attempt: number;
}

export interface RecallPatch {
  /** abort = true 表示 LLM 判定不可修,任务终态 failed。 */
  abort: boolean;
  reason?: string;
  /** 修补丁:替换该节点的 action / script / asserts。 */
  nodeId?: string;
  newAction?: string;
  newScript?: LegisScriptStep[];
  newAsserts?: Assertion[];
}

// ────────────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────────────

/**
 * replay script 允许的工具白名单。
 * 只读工具 + shell。写文件动作(edit_file/write_file)一律不允许进 script ——
 * 写操作需要 LLM 判断内容,强制走 agent 节点。shell 里的写命令无法静态判定,
 * 靠步级断言兜底(如写后 fileExists 校验)。
 * Allow-list for replay scripts: read-only tools + shell. File writes must go
 * through agent nodes (content needs LLM judgment); shell write commands are
 * backstopped by step assertions (e.g. fileExists after write).
 */
export const REPLAY_ALLOWED_TOOLS = new Set([
  'shell', 'read_file', 'grep', 'glob', 'web_fetch', 'web_search', 'recall_memory', 'git_diff', 'recall_fact',
]);

/** 节点内(非 429)重试上限 —— 同 args 重试,不换姿势。 */
export const MAX_NODE_RETRIES = 2;
/** 每节点唤回上限(LLM 出场次数)。 */
export const MAX_NODE_RECALLS = 3;
/** 整个 plan 的唤回总上限(防线LLM 自激)。 */
export const MAX_PLAN_RECALLS = 10;
