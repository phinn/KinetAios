// V4 Paths — fast/std 路径(V3 路径的 V4 适配层)
//
// fast/std 的执行体与 V3 完全一致(runAgentLoop,轮数跟用户设置),
// 只是 status 前缀和上下文策略包换成 directV4。
// This mirrors V3's fast/std paths with the v4 policy pack and status prefix.

import type { AgentEvent, ChatMsg, ConfigSnapshot, EngineContextPolicy } from '../../shared/types';
import { runAgentLoop } from '../AgentLoop';
import type { Provider } from '../glm';
import type { Tool, ToolCtx } from '../tools';

export interface V4PathOpts {
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

export async function executeFastPath(opts: V4PathOpts): Promise<ChatMsg[]> {
  const { provider, tools, systemPrompt, memoryBlock, snapshot, userInput, history, ctx, signal, policy, onEvent } = opts;
  onEvent({ type: 'status', text: '⚡ v4: 快速执行' });
  return runAgentLoop({
    provider, tools, systemPrompt, memoryBlock, snapshot, userInput, history, ctx, signal, policy, onEvent,
    // maxTurns 不传 → 跟随用户设置(与 V3 fast 相同语义,不硬编码压制)。
  });
}

export async function executeStdPath(opts: V4PathOpts): Promise<ChatMsg[]> {
  const { provider, tools, systemPrompt, memoryBlock, snapshot, userInput, history, ctx, signal, policy, onEvent } = opts;
  onEvent({ type: 'status', text: '🔧 v4: 标准执行' });
  return runAgentLoop({
    provider, tools, systemPrompt, memoryBlock, snapshot, userInput, history, ctx, signal, policy, onEvent,
  });
}
