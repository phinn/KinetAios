// V3 Standard Path — Streaming ReAct,中等复杂度
//
// 适用于:修 bug、写功能、搜索+总结等需要多轮工具调用的任务。
// 与 Fast path 的区别:maxTurns 更多(20),允许更多轮工具调用。
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
    maxTurns: 50,
    policy,
    onEvent,
  });

  return updated;
}
