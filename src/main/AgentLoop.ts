// ReAct loop: model ↔ tools until the model answers without a tool_call, or max turns hit.
// Verbatim port of Swift AgentLoop.run. DirectEngine's trim-history logic lives here too.
import type { AgentEvent, ChatMsg } from '../shared/types';
import { priceUSD, type Completion, type Provider, type ToolDef } from './glm';
import { toolDef, type Tool, type ToolCtx } from './tools';

export interface RunOpts {
  provider: Provider;
  tools: Tool[];
  systemPrompt: string;
  snapshot: import('../shared/types').ConfigSnapshot;
  userInput: string;
  history: ChatMsg[]; // prior turns (already without the system prompt)
  ctx: ToolCtx;
  signal: AbortSignal;
  maxTurns?: number;
  onEvent: (e: AgentEvent) => void;
}

// Runs one turn. Returns the accumulated messages (minus the system prompt) for next-turn history.
export async function runAgentLoop(opts: RunOpts): Promise<ChatMsg[]> {
  const { provider, tools, systemPrompt, snapshot, userInput, history, ctx, signal, onEvent } = opts;
  const maxTurns = opts.maxTurns ?? 50;
  const defs: ToolDef[] = tools.map(toolDef);

  let messages: ChatMsg[] = [{ role: 'system', content: systemPrompt }, ...history];
  messages.push({ role: 'user', content: userInput });

  for (let i = 0; i < maxTurns; i++) {
    let completion: Completion;
    try {
      completion = await provider.streamComplete(messages, defs, snapshot, signal, (tok) =>
        onEvent({ type: 'token', text: tok }),
      );
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'AbortError' || signal.aborted) return dropSystem(messages); // user hit stop
      onEvent({ type: 'error', message: errMsg(e) });
      return dropSystem(messages);
    }

    // Report cost each LLM call — multi-turn tool-calling totals sum across calls.
    if (completion.tokensIn + completion.tokensOut > 0) {
      const usd = priceUSD(snapshot.model, completion.tokensIn, completion.tokensOut);
      onEvent({
        type: 'cost',
        usd,
        tokens: completion.tokensIn + completion.tokensOut,
        tokensIn: completion.tokensIn,
        tokensOut: completion.tokensOut,
      });
    }

    messages.push(completion.rawAssistant);
    if (completion.toolCalls.length === 0) {
      onEvent({ type: 'done' });
      return dropSystem(messages);
    }

    for (const tc of completion.toolCalls) {
      const result = await execute(tc, tools, ctx);
      onEvent({ type: 'tool', name: tc.name, args: tc.arguments, result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
  onEvent({ type: 'error', message: `达到最大轮数(${maxTurns}),停止 — 任务太复杂,可拆分后继续。` });
  return dropSystem(messages);
}

async function execute(tc: { name: string; arguments: string }, tools: Tool[], ctx: ToolCtx): Promise<string> {
  const tool = tools.find((t) => t.name === tc.name);
  if (!tool) return `未知工具: ${tc.name}`;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.arguments || '{}');
  } catch {
    console.error(`[AgentLoop] ${tc.name} args 不是合法 JSON: ${tc.arguments.slice(0, 400)}`);
  }
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    return `工具出错: ${e}`;
  }
}

function dropSystem(messages: ChatMsg[]): ChatMsg[] {
  return messages.filter((m) => m.role !== 'system');
}

function errMsg(e: unknown): string {
  const err = e as { kind?: string; code?: number; message?: string; detail?: string };
  if (err && err.kind === 'noKey') return '未设置 API Key — 打开设置填入 key。';
  if (err && err.kind === 'http') return `HTTP ${err.code}${err.detail ? ` — ${err.detail}` : ''} — 检查 API key / 模型 id / 网络。`;
  return `出错: ${(e as Error)?.message ?? e}`;
}

// Keep the tail of history within a token budget (chars × 0.6 estimate). Mirrors Swift DirectEngine.
export function trimHistoryToTokenBudget(msgs: ChatMsg[], budget: number): ChatMsg[] {
  if (!msgs.length) return [];
  let total = 0;
  const kept: ChatMsg[] = [];
  for (const m of [...msgs].reverse()) {
    const content = typeof m.content === 'string' ? m.content : '';
    const tokens = Math.floor(content.length * 0.6) + 20; // +20 per-message overhead
    if (total + tokens > budget && kept.length) break;
    total += tokens;
    kept.push(m);
  }
  return kept.reverse();
}
