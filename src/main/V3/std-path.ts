// V3 Standard Path — Streaming ReAct,中等复杂度
//
// 适用于:修 bug、写功能、搜索+总结等需要多轮工具调用的任务。
// 与 Fast path 的区别:maxTurns 更多(20),允许更多轮工具调用。
// 注意:maxTurns 必须显式传 20 —— AgentLoop 中 0 = Infinity(std path 不设限会无限烧 token)。
// 与 Deep path 的区别:不生成 DAG plan,直接 ReAct loop。
//
// 取消了 V2 的独立 Judge — 模型在回答中自带完成判断,不需要额外 LLM 调用。

import type { AgentEvent, ChatMsg, ConfigSnapshot, EngineContextPolicy } from '../../shared/types';
import { executeReActLoop, finalizeContext } from './streaming-executor';
import type { Provider } from '../glm';
import type { Tool, ToolCtx } from '../tools';

export interface StdPathOpts {
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

export async function executeStdPath(opts: StdPathOpts): Promise<ChatMsg[]> {
  const { provider, tools, systemPrompt, memoryBlock, snapshot, userInput, history, ctx, signal, policy, onEvent } = opts;

  onEvent({ type: 'status', text: '🔧 v3: 标准执行' });

  const updated = await executeReActLoop({
    provider,
    tools,
    systemPrompt,
    memoryBlock,
    snapshot,
    userInput,
    history,
    ctx,
    signal,
    maxTurns: 20, // H1-fix: 0 在 AgentLoop 中 = Infinity,std path 必须显式限 20 轮
    policy,
    onEvent,
  });

  return updated;
}
