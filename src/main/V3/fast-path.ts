// V3 Fast Path — 单轮 ReAct,零开销
//
// 适用于:读文件、查文档、grep、简单问答。
// 本质就是 V1 Direct 的 runAgentLoop,但 maxTurns 限制更紧(5 轮)。
// 没有 Plan、没有 Judge、没有 Verify。

import type { AgentEvent, ChatMsg, ConfigSnapshot, EngineContextPolicy } from '../../shared/types';
import { executeReActLoop, finalizeContext, type StreamingExecOpts } from './streaming-executor';
import type { Provider } from '../glm';
import type { Tool, ToolCtx } from '../tools';

export interface FastPathOpts {
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

export async function executeFastPath(opts: FastPathOpts): Promise<ChatMsg[]> {
  const { provider, tools, systemPrompt, memoryBlock, snapshot, userInput, history, ctx, signal, policy, onEvent } = opts;

  onEvent({ type: 'status', text: '⚡ v3: 快速执行' });

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
    maxTurns: 50,  // 不人为限制 — 让模型自然完成
    policy,
    onEvent,
  });

  return updated;
}
