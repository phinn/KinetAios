// ReAct loop: model ↔ tools until the model answers without a tool_call, or max turns hit.
// Verbatim port of Swift AgentLoop.run. DirectEngine's trim-history logic lives here too.
import type { AgentEvent, ChatMsg, ConfigSnapshot } from '../shared/types';
import { priceUSD, type Completion, type Provider, type ToolDef } from './glm';
import { toolDef, type Tool, type ToolCtx } from './tools';
import { t } from '../shared/i18n';
import { getSettings } from './settings';

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
  // 默认不限制轮数(原来是 50)。模型不收敛(一直 tool_call)会持续消耗 token,需手动点停止。
  const maxTurns = opts.maxTurns ?? Infinity;
  const defs: ToolDef[] = tools.map(toolDef);

  let messages: ChatMsg[] = [{ role: 'system', content: systemPrompt }, ...history];
  messages.push({ role: 'user', content: userInput });

  // reactive trim 用:上下文超长报错时砍半预算重试本轮一次(见下方 catch)。ponytail:错误格式不统一,best-effort。
  let retriedAfterShrink = false;
  for (let i = 0; i < maxTurns; i++) {
    let completion: Completion;
    try {
      completion = await provider.streamComplete(messages, defs, snapshot, signal, (tok) =>
        onEvent({ type: 'token', text: tok }),
      );
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'AbortError' || signal.aborted) return dropSystem(messages); // user hit stop
      // 超长兜底:API 报上下文过长时,更激进 trim(预算砍半)后重试本轮一次。
      if (!retriedAfterShrink && isContextTooLong(e)) {
        retriedAfterShrink = true;
        messages = [{ role: 'system', content: systemPrompt }, ...trimHistoryToTokenBudget(dropSystem(messages), 15_000)];
        onEvent({ type: 'status', text: t(getSettings().lang, 'al.ctxTooLong') });
        i--; // 本轮重试(抵消 for 的 i++)
        continue;
      }
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

    // 工具执行:同轮里只读工具(readOnly)并发,写工具串行。结果按原序回填(tool_call_id 配对)。
    messages.push(...(await runToolBatch(completion.toolCalls, tools, ctx, signal, onEvent)));
  }
  onEvent({ type: 'error', message: t(getSettings().lang, 'al.maxTurns', { max: maxTurns }) });
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
  const lang = getSettings().lang;
  if (err && err.kind === 'noKey') return t(lang, 'al.noKey');
  if (err && err.kind === 'http') return t(lang, 'al.httpErr', { code: err.code ?? 0, detail: err.detail ? ` — ${err.detail}` : '' });
  return t(lang, 'al.err', { msg: (e as Error)?.message ?? String(e) });
}

// Keep the tail of history within a token budget (chars × 0.6 estimate). Mirrors Swift DirectEngine.
// Sanitize after trimming: a hard byte-cut can split an assistant(tool_calls) ↔ tool pair, leaving
// an "orphan" tool message whose assistant was dropped — both OpenAI and Anthropic reject that.
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
  return sanitizeToolPairs(kept.reverse());
}

// Drop orphan tool messages (their caller assistant was trimmed away) so the next API call is valid.
function sanitizeToolPairs(msgs: ChatMsg[]): ChatMsg[] {
  const visible = new Set<string>();
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) visible.add(tc.id);
    }
  }
  return msgs.filter((m) => m.role !== 'tool' || visible.has((m.tool_call_id as string) ?? ''));
}

// 摘要压缩:历史超 budget 时,把将被丢弃的头部调一次 LLM 压成一条摘要,保留尾部完整轮次。
// 长 conversation 不再丢早期上下文。失败 → 回退纯尾部 trim(不丢功能)。
// ponytail: ① 每 turn 末尾按需摘一次,未做摘要缓存;② token 估算仍 length*0.6。
export async function compactHistory(
  msgs: ChatMsg[],
  budget: number,
  provider: Provider,
  snap: ConfigSnapshot,
  signal: AbortSignal,
): Promise<ChatMsg[]> {
  const tail = trimHistoryToTokenBudget(msgs, budget);
  if (tail.length === msgs.length) return tail; // 没超预算,无需摘要
  const head = msgs.slice(0, msgs.length - tail.length);
  if (!head.length) return tail;
  try {
    const sys =
      '你是对话摘要器。把下面这段早期对话压成一段简洁中文摘要,保留:任务目标、关键决策、已确定的结论、重要的文件路径/命令/技术栈。丢掉寒暄与一次性细节。直接输出摘要正文,不要标题。';
    const transcript = head
      .map((m) => {
        const role = m.role === 'tool' ? '工具结果' : m.role;
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.tool_calls ?? '');
        return `[${role}] ${text}`;
      })
      .join('\n')
      .slice(0, 12_000);
    const comp = await provider.streamComplete(
      [{ role: 'system', content: sys }, { role: 'user', content: transcript }],
      [],
      snap,
      signal,
      () => {},
    );
    const summary = comp.content.trim();
    if (!summary) return tail;
    return [{ role: 'user', content: `[早期对话摘要]\n${summary}` }, ...tail];
  } catch {
    return tail; // 摘要失败 → 纯尾部,不丢功能
  }
}

// Run a turn's tool calls:连续的只读(readOnly)工具并发执行,含写的工具串行。
// 结果按原 toolCalls 顺序回填 messages(配对靠 tool_call_id)。abort 时补"已停止"占位以维持配对。
async function runToolBatch(
  calls: { id: string; name: string; arguments: string }[],
  tools: Tool[],
  ctx: ToolCtx,
  signal: AbortSignal,
  onEvent: (e: AgentEvent) => void,
): Promise<ChatMsg[]> {
  const results: ChatMsg[] = [];
  let i = 0;
  while (i < calls.length) {
    if (signal.aborted) {
      while (i < calls.length) {
        const c = calls[i];
        onEvent({ type: 'tool', name: c.name, args: c.arguments, result: '[已停止]' });
        results.push({ role: 'tool', tool_call_id: c.id, content: '[已停止]' });
        i++;
      }
      break;
    }
    const call = calls[i];
    const tool = tools.find((t) => t.name === call.name);
    if (tool?.readOnly) {
      // 收集连续只读段,一起并发。
      const start = i;
      while (i < calls.length && tools.find((t) => t.name === calls[i].name)?.readOnly) i++;
      const batch = calls.slice(start, i);
      const outs = await Promise.all(
        batch.map(async (c) => {
          if (signal.aborted) return { c, result: '[已停止]' as string };
          const result = await execute(c, tools, ctx);
          onEvent({ type: 'tool', name: c.name, args: c.arguments, result });
          return { c, result };
        }),
      );
      for (const { c, result } of outs) results.push({ role: 'tool', tool_call_id: c.id, content: result });
    } else {
      // 写工具:串行单个执行。
      const result = signal.aborted ? '[已停止]' : await execute(call, tools, ctx);
      onEvent({ type: 'tool', name: call.name, args: call.arguments, result });
      results.push({ role: 'tool', tool_call_id: call.id, content: result });
      i++;
    }
  }
  return results;
}

// Detect "context too long" from a provider error (GLMError or raw). ponytail: OpenAI-compatible
// error wording varies by endpoint — match loosely, best-effort.
function isContextTooLong(e: unknown): boolean {
  const err = e as { kind?: string; code?: number; detail?: string; message?: string };
  if (err?.code === 413) return true;
  const text = `${err?.detail ?? ''} ${err?.message ?? ''}`.toLowerCase();
  return /context length|too long|maximum context|上下文|exceed|prompt is too/.test(text);
}
