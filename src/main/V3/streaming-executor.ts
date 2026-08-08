// V3 Streaming Tool Executor — 核心执行引擎
//
// 改进 vs V2 的 runAgentLoop:
// 1. 复用 runAgentLoop 的 ReAct loop,但按 path 调整 maxTurns 和上下文策略
// 2. Fast path: maxTurns=5,轻量 trim
// 3. Std path: maxTurns=20,标准 trim,带 embedded verify
// 4. Deep path: 每步 maxTurns=8,步骤间压缩
//
// 不重新发明 runAgentLoop(它已经处理了 SSE 解析、工具执行、上下文压缩、
// abort、error recovery),而是用不同的策略包配置它。

import type { AgentEvent, ChatMsg, ConfigSnapshot, EngineContextPolicy } from '../../shared/types';
import { resolveEnginePolicy } from '../../shared/types';
import { runAgentLoop, compactHistory } from '../AgentLoop';
import type { Provider, ToolDef } from '../glm';
import { priceUSD } from '../glm';
import type { Tool, ToolCtx } from '../tools';
import { getSettings } from '../settings';

export interface StreamingExecOpts {
  provider: Provider;
  tools: Tool[];
  systemPrompt: string;
  memoryBlock?: string;
  snapshot: ConfigSnapshot;
  userInput: string;
  history: ChatMsg[];
  ctx: ToolCtx;
  signal: AbortSignal;
  maxTurns?: number;
  contextMode?: 'standard' | 'hifi';
  policy: EngineContextPolicy;
  onEvent: (e: AgentEvent) => void;
}

/**
 * 执行一个 ReAct loop(复用 runAgentLoop),返回更新后的 history。
 * 不同 path 的差异通过 maxTurns 和 policy 参数控制。
 */
export async function executeReActLoop(opts: StreamingExecOpts): Promise<ChatMsg[]> {
  const { provider, tools, systemPrompt, memoryBlock, snapshot, userInput, history, ctx, signal,
    maxTurns, contextMode, policy, onEvent } = opts;

  const updated = await runAgentLoop({
    provider,
    tools,
    systemPrompt,
    memoryBlock,
    snapshot,
    userInput,
    history,
    ctx,
    signal,
    maxTurns: maxTurns ?? 0,
    contextMode,
    hifiContextBudget: getSettings().hifiContextBudget,
    policy,
    onEvent,
  });

  return updated;
}

/**
 * 最终上下文压缩 — 复用 compactHistory,但用 V3 策略包的预算。
 */
export async function finalizeContext(
  messages: ChatMsg[],
  policy: EngineContextPolicy,
  provider: Provider,
  snap: ConfigSnapshot,
  signal: AbortSignal,
  onEvent: (e: AgentEvent) => void,
): Promise<ChatMsg[]> {
  if (signal.aborted) return messages;
  return compactHistory(messages, policy.interStepCompactBudget, provider, snap, signal, onEvent);
}
