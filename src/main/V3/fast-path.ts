// V3 Fast Path — 单轮 ReAct,零开销
//
// 适用于:读文件、查文档、grep、简单问答。
// 本质就是 V1 Direct 的 runAgentLoop — 轮数上限跟随用户设置(maxTurns),
// 由 router 保证只有简单任务进这条路径(轻上下文策略)。
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
    // maxTurns 不传 → 跟随用户设置(settings.maxTurns)。
    // 旧实现硬编码 5 会经 AgentLoop 的 min(internal, userMax) 永远压制用户设置,
    // 用户调高轮数对 fast path 从不生效 — 主循环轮数必须尊重用户配置。
    // fast 的"快"来自 router 分流 + 轻上下文策略,不来自砍轮数。
    policy,
    onEvent,
  });

  return updated;
}
