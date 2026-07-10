// LLM providers — SSE streaming over OpenAI-compatible and Anthropic protocols.
// Verbatim port of Swift GLMProvider.swift. Node global fetch + a web ReadableStream reader.
import type { ChatMsg, ConfigSnapshot } from '../shared/types';
import { getSettings } from './settings';

export type ToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ToolCall = { id: string; name: string; arguments: string };

export type Completion = {
  content: string;
  toolCalls: ToolCall[];
  rawAssistant: ChatMsg; // OpenAI-format, fed back into AgentLoop history regardless of protocol
  tokensIn: number;
  tokensOut: number;
};

export class GLMError extends Error {
  constructor(public kind: 'noKey' | 'http', public code = 0, public detail = '') {
    super(kind === 'noKey' ? 'no API key' : `HTTP ${code}${detail ? `: ${detail}` : ''}`);
  }
}

// 读 HTTP 错误响应里的可读信息(400 时点明原因 —— max_tokens 过大 / reasoning 不支持 / 模型 id 错 等)。
async function readErr(resp: Response): Promise<string> {
  try {
    const j: any = await resp.json();
    return j?.error?.message || j?.message || (typeof j === 'string' ? j : JSON.stringify(j).slice(0, 300));
  } catch {
    try {
      return (await resp.text()).slice(0, 300);
    } catch {
      return '';
    }
  }
}

// Retry:只覆盖"建连 → 拿到 200 响应"这一段。SSE 流一旦开始就不能重试(会重复 token),
// 所以 stream 解析不在重试范围内。网络异常 / 429 / 5xx 指数退避重试 MAX_RETRY 次。
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_RETRY = 3;

function backoffMs(attempt: number): number {
  const base = 1000 * 2 ** attempt; // 1s / 2s / 4s
  return Math.min(base * (0.75 + Math.random() * 0.5), 30_000); // ±25% jitter(主进程 Math.random 可用)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    let t: ReturnType<typeof setTimeout>;
    const onAbort = (): void => { clearTimeout(t); reject(new Error('aborted')); };
    t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// 建连 + 拿到 200:可重试状态码/网络错退避重试;不可重试(400/401/404 等)或耗尽则抛 GLMError。
async function fetchUntil200(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      if (attempt < MAX_RETRY && !signal.aborted) { await sleep(backoffMs(attempt), signal); continue; }
      throw e;
    }
    if (resp.status === 200) return resp;
    const detail = await readErr(resp);
    if (RETRYABLE_STATUS.has(resp.status) && attempt < MAX_RETRY && !signal.aborted) {
      await sleep(backoffMs(attempt), signal);
      continue;
    }
    throw new GLMError('http', resp.status, detail);
  }
}

export interface Provider {
  streamComplete(
    messages: ChatMsg[],
    tools: ToolDef[],
    snap: ConfigSnapshot,
    signal: AbortSignal,
    onToken: (t: string) => void,
  ): Promise<Completion>;
}

export function currentProvider(snap: ConfigSnapshot): Provider {
  return snap.apiProtocol === 'anthropic' ? new AnthropicProvider() : new OpenAICompatibleProvider();
}

// MARK: cost — rough USD price table. Same logic as Swift AgentLoop.priceUSD.
export function priceUSD(model: string, tokensIn: number, tokensOut: number): number {
  const s = getSettings();
  const m = model.toLowerCase();
  const isGLM = m.startsWith('glm');
  const defIn = isGLM ? 0.00000007 : 0.000003; // per-token (= per-1M / 1e6)
  const defOut = isGLM ? 0.00000021 : 0.000015;
  const inRate = s.priceInPerMTok > 0 ? s.priceInPerMTok / 1_000_000 : defIn;
  const outRate = s.priceOutPerMTok > 0 ? s.priceOutPerMTok / 1_000_000 : defOut;
  return tokensIn * inRate + tokensOut * outRate;
}

// Output cap by model family. GLM-4.6 supports 16K; most OpenAI-compatible endpoints
// (DeepSeek / Qwen-max 8192) 400 on larger. Unknown → 8192 (safe default). GLM keeps 16K.
function maxTokensFor(model: string): number {
  return model.toLowerCase().startsWith('glm') ? 16384 : 8192;
}

// Split a streamed response body into SSE data lines.
async function* sseLines(resp: Response): AsyncGenerator<string> {
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf;
}

function intFrom(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseInt(v, 10) || 0;
  return 0;
}

// OpenAI-format assistant history entry (shared by both providers → consistent AgentLoop history).
function rawAssistant(content: string, toolCalls: ToolCall[]): ChatMsg {
  const raw: ChatMsg = { role: 'assistant', content };
  if (toolCalls.length) {
    raw.content = content || null;
    raw.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return raw;
}

// MARK: OpenAI-compatible (/chat/completions, Bearer)
class OpenAICompatibleProvider implements Provider {
  async streamComplete(
    messages: ChatMsg[],
    tools: ToolDef[],
    snap: ConfigSnapshot,
    signal: AbortSignal,
    onToken: (t: string) => void,
  ): Promise<Completion> {
    if (!snap.apiKey) throw new GLMError('noKey');

    // OpenAI 兼容端点(GLM 智谱 / DeepSeek / Qwen / OpenAI)均为自动前缀缓存:messages 开头的
    // system + 早期 history 每轮不变 → 命中缓存、低价计费。无需额外参数(只有 Anthropic 要 cache_control)。
    const body: Record<string, unknown> = { model: snap.model, messages, stream: true };
    body.max_tokens = maxTokensFor(snap.model);
    // Streaming usually omits usage unless include_usage is set (final chunk then carries it).
    body.stream_options = { include_usage: true };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (snap.reasoning !== 'none') body.reasoning_effort = snap.reasoning;

    const resp = await fetchUntil200(`${snap.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${snap.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    },
      signal,
    );

    let content = '';
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let tokensIn = 0;
    let tokensOut = 0;

    for await (const line of sseLines(resp)) {
      const payload = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!payload || payload === '[DONE]') {
        if (payload === '[DONE]') break;
        continue;
      }
      let obj: any;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      if (obj.usage) {
        tokensIn = intFrom(obj.usage.prompt_tokens) || tokensIn;
        tokensOut = intFrom(obj.usage.completion_tokens) || tokensOut;
      }
      const delta = obj.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        onToken(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const fn = tc.function ?? {};
          const entry = calls.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) entry.id = tc.id;
          if (fn.name) entry.name = fn.name;
          // args: OpenAI standard = streamed String fragments; some GLM endpoints = whole dict once.
          if (typeof fn.arguments === 'string') entry.args += fn.arguments;
          else if (fn.arguments && typeof fn.arguments === 'object') entry.args = JSON.stringify(fn.arguments);
          calls.set(idx, entry);
        }
      }
    }

    const toolCalls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((v) => v.name)
      .map((v) => ({ id: v.id, name: v.name, arguments: v.args }));
    return { content, toolCalls, rawAssistant: rawAssistant(content, toolCalls), tokensIn, tokensOut };
  }
}

// MARK: Anthropic protocol (/v1/messages, x-api-key + anthropic-version). Bidirectional OpenAI↔Anthropic.
class AnthropicProvider implements Provider {
  async streamComplete(
    messages: ChatMsg[],
    tools: ToolDef[],
    snap: ConfigSnapshot,
    signal: AbortSignal,
    onToken: (t: string) => void,
  ): Promise<Completion> {
    if (!snap.apiKey) throw new GLMError('noKey');

    // 1) OpenAI messages → Anthropic (system separate; consecutive tool msgs merge into one user tool_result block)
    const systemParts: string[] = [];
    const anth: any[] = [];
    for (const m of messages) {
      const role = m.role;
      const content = (typeof m.content === 'string' ? m.content : '') ?? '';
      if (role === 'system') systemParts.push(content);
      else if (role === 'user') anth.push({ role: 'user', content });
      else if (role === 'assistant') {
        const blocks: any[] = [];
        if (content) blocks.push({ type: 'text', text: content });
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            let input: unknown = {};
            try {
              input = JSON.parse(tc.function.arguments || '{}');
            } catch {
              /* leave {} */
            }
            blocks.push({ type: 'tool_use', id: tc.id || '', name: tc.function.name || '', input });
          }
        }
        anth.push({ role: 'assistant', content: blocks });
      } else if (role === 'tool') {
        const result = {
          type: 'tool_result',
          tool_use_id: (m.tool_call_id as string) ?? '',
          content,
        };
        const last = anth[anth.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
          last.content.push(result);
        } else {
          anth.push({ role: 'user', content: [result] });
        }
      }
    }

    const body: Record<string, unknown> = { model: snap.model, messages: anth, max_tokens: maxTokensFor(snap.model), stream: true };
    // Anthropic prompt cache:system + tools 是每轮稳定重复的大块 → 标 cache_control 命中缓存(读 ~10% 价)。
    // messages 动态变化不缓存。免费 4 断点,这里用 2 个(system + 末个 tool 覆盖整个 tools 数组)。
    const system = systemParts.join('\n');
    if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    if (tools.length) {
      const tt = tools.map((t) => this.anthTool(t));
      tt[tt.length - 1].cache_control = { type: 'ephemeral' }; // 标在最后一个 tool → 整个 tools 数组进缓存
      body.tools = tt;
    }

    const resp = await fetchUntil200(`${snap.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': snap.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    },
      signal,
    );

    // 2) parse Anthropic SSE: text_delta → onToken; input_json_delta → stitch tool args
    let content = '';
    const blocks = new Map<number, { id: string; name: string; args: string }>();
    let tokensIn = 0;
    let tokensOut = 0;

    for await (const line of sseLines(resp)) {
      if (!line.startsWith('data:')) continue;
      let obj: any;
      try {
        obj = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      const type = obj.type as string | undefined;
      if (!type) continue;
      if (type === 'message_start') {
        // input_tokens 不含缓存;cache_read(读,~10% 价)/ cache_creation(写,~125% 价)单列。
        // 全计入 tokensIn(按 input 价统计 → cache_read 高估,但不漏算,比漏掉缓存消耗更接近真实)。
        const u = obj.message?.usage ?? {};
        tokensIn = intFrom(u.input_tokens) + intFrom(u.cache_creation_input_tokens) + intFrom(u.cache_read_input_tokens);
      } else if (type === 'message_delta') {
        tokensOut = intFrom(obj.usage?.output_tokens) || tokensOut;
      } else if (type === 'content_block_start') {
        const idx = obj.index ?? 0;
        blocks.set(idx, {
          id: obj.content_block?.id ?? '',
          name: obj.content_block?.name ?? '',
          args: '',
        });
      } else if (type === 'content_block_delta') {
        const idx = obj.index ?? 0;
        const delta = obj.delta ?? {};
        if (delta.type === 'text_delta' && delta.text) {
          content += delta.text;
          onToken(delta.text);
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const b = blocks.get(idx);
          if (b) {
            b.args += delta.partial_json;
            blocks.set(idx, b);
          }
        }
      }
    }

    const toolCalls = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((v) => v.name)
      .map((v) => ({ id: v.id, name: v.name, arguments: v.args || '{}' }));
    return { content, toolCalls, rawAssistant: rawAssistant(content, toolCalls), tokensIn, tokensOut };
  }

  // OpenAI tool def → Anthropic (function/parameters → name/input_schema)
  private anthTool(t: ToolDef): Record<string, unknown> {
    const fn = t.function;
    return {
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters ?? { type: 'object', properties: {} },
    };
  }
}
