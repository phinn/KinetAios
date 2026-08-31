// LLM providers — SSE streaming over OpenAI-compatible and Anthropic protocols.
// Verbatim port of Swift GLMProvider.swift. Node global fetch + a web ReadableStream reader.
import type { ChatMsg, ConfigSnapshot, EmbedSnapshot } from '../shared/types';
import { getSettings } from './settings';

// Sanitize orphan surrogates from strings before JSON serialization.
// Node JSON.stringify turns lone surrogates (e.g. \uD83D from a truncated emoji) into literal
// "\ud83d" escapes — Python's json.loads faithfully restores them, then utf-8 encoding blows up
// with "surrogates not allowed". Replace them with U+FFFD at the source.
// 清洗孤儿 surrogate:截断的 emoji 半截字符(\uD83D 等)会导致 GLM 服务端 Python utf-8 编码崩溃。
function sanitizeStr(s: string): string {
  // TextEncoder.encode() replaces lone surrogates with U+FFFD, then decode back to string.
  // Valid surrogate pairs (full emoji) are preserved. Zero allocations beyond the encode/decode.
  return new TextDecoder().decode(new TextEncoder().encode(s));
}

function sanitizeMsgs(msgs: ChatMsg[]): ChatMsg[] {
  return msgs.map(m => {
    if (typeof m.content === 'string') return { ...m, content: sanitizeStr(m.content) };
    if (Array.isArray(m.content)) return { ...m, content: m.content.map(p => p.type === 'text' ? { ...p, text: sanitizeStr(p.text ?? '') } : p) };
    return m;
  });
}

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
  constructor(public kind: 'noKey' | 'http' | 'noBody', public code = 0, public detail = '') {
    super(kind === 'noKey' ? 'no API key' : kind === 'noBody' ? 'no response body' : `HTTP ${code}${detail ? `: ${detail}` : ''}`);
  }
}

// 读 HTTP 错误响应里的可读信息(400 时点明原因 —— max_tokens 过大 / reasoning 不支持 / 模型 id 错 等)。
async function readErr(resp: Response): Promise<string> {
  try {
    const j = await resp.json() as Record<string, any>;
    const err = j?.error as Record<string, unknown> | undefined;
    return (err?.message as string) || (j?.message as string) || (typeof j === 'string' ? j : JSON.stringify(j).slice(0, 300));
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
async function fetchUntil200(url: string, init: RequestInit): Promise<Response> {
  // signal 从 init.signal 提取,用于重试逻辑判断(不重复传参)。
  const signal = init.signal as AbortSignal | undefined;
  for (let attempt = 0; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      if (attempt < MAX_RETRY && !signal?.aborted) { await sleep(backoffMs(attempt), signal); continue; }
      throw e;
    }
    if (resp.status === 200) return resp;
    const detail = await readErr(resp);
    if (RETRYABLE_STATUS.has(resp.status) && attempt < MAX_RETRY && !signal?.aborted) {
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

// MARK: embeddings —— OpenAI 兼容 /v1/embeddings。走独立的 EmbedSnapshot(embedBaseURL/embedApiKey/embedModel)。
// 默认:留空时自动跟随主接口,model=embedding-3(GLM 智谱),Ollama 自动切 nomic-embed-text。
// Anthropic 协议无 embedding 端点 → 抛错。失败时上层(TaskManager / recall_memory)兜底走 FTS5,不阻塞主流程。
export async function embed(texts: string[], snap: ConfigSnapshot, signal?: AbortSignal): Promise<number[][]> {
  // 读独立 embedding 配置
  const { embedSnapshot } = await import('./settings');
  const esnap: EmbedSnapshot = embedSnapshot();
  // Anthropic 主协议:如果 embedding 也指向 anthropic 端点则不支持
  if (snap.apiProtocol === 'anthropic' && !esnap.baseURL.includes('/v1') && !esnap.baseURL.includes(':11434')) {
    throw new Error('Anthropic 协议不支持 embeddings,请在设置中配置独立的 Embedding 接口');
  }
  const resp = await fetch(`${esnap.baseURL}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${esnap.apiKey || 'ollama'}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: esnap.model, input: texts }),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`embeddings HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const json = (await resp.json()) as { data: Array<{ embedding: number[] }> };
  return json.data.map((d) => d.embedding);
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
  // 流静默看门狗:连接建立后对端长时间既不发数据也不断开(网络半死/网关吞流)时,
  // reader.read() 会永远挂起 → AgentLoop 永挂 → 三进程全闲、UI 永远 running。
  // 每收到一个 chunk 重置计时;超过 STALL_MS 无任何字节则抛错,交给上层重试/终止。
  // / Stall watchdog: if the stream goes silent (no bytes at all) for STALL_MS,
  // abort the read instead of awaiting forever. Thinking 模型静默期也远小于此值
  // (SSE 有 keep-alive 注释或心跳 chunk)。
  const STALL_MS = 300_000; // 5 分钟无字节 = 判死
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const stall = new Promise<never>((_, reject) => {
    stallTimer = setTimeout(() => reject(new Error(`流静默 ${STALL_MS / 1000}s(连接半死,已中断)`)), STALL_MS);
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), stall]);
      if (done) break;
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } // 收到数据 → 撤 watchdog(整流读完后无需再计时)
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line) yield line;
      }
    }
    if (buf.trim()) yield buf;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    // 确保释放 reader(abort/异常/break 时也清理,避免 TCP 连接泄漏)。
    // 先 releaseLock(让 body 可被再次获取或 GC),cancel 的 Promise fire-and-forget。
    // Node 16+ 的 releaseLock 在 cancel 未完成时调用是安全的(generator 即将终结)。
    try { reader.releaseLock(); } catch { /* already released */ }
    reader.cancel().catch(() => {});
  }
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
    // ponytail: 允许空 key —— Ollama(localhost:11434)不需 auth,其它服务会 401 自报错。
    // if (!snap.apiKey) throw new GLMError('noKey');

    // OpenAI 兼容端点(GLM 智谱 / DeepSeek / Qwen / OpenAI)均为自动前缀缓存:messages 开头的
    // system + 早期 history 每轮不变 → 命中缓存、低价计费。无需额外参数(只有 Anthropic 要 cache_control)。
    // 剥掉内部用的 _memory 标记字段 —— 它是 AgentLoop 用来保护记忆消息不被 trim 的标记,不该发到 API。
    const wireMsgs = sanitizeMsgs(messages.map(({ _memory, ...rest }) => rest));
    const body: Record<string, unknown> = { model: snap.model, messages: wireMsgs, stream: true };
    body.max_tokens = maxTokensFor(snap.model);
    // Streaming usually omits usage unless include_usage is set (final chunk then carries it).
    body.stream_options = { include_usage: true };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (snap.reasoning !== 'none') body.reasoning_effort = snap.reasoning;

    // Ollama 默认 num_ctx 只有 4096,系统提示 + 历史很容易超限报 400。
    // ⚠ Ollama 的 /v1/chat/completions (OpenAI 兼容层) 不透传 options.num_ctx,
    //    只能走原生 /api/chat 端点才能设置上下文窗口大小。
    const isOllama = /:11434\b/i.test(snap.baseURL) || /\/ollama\b/i.test(snap.baseURL);
    if (isOllama) {
      return ollamaStream(messages, tools, snap, signal, onToken, wireMsgs);
    }

    const resp = await fetchUntil200(`${snap.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        // Ollama(11434)不需要 key;留空就发 dummy,服务器忽略。其它服务一律 Bearer。
        Authorization: `Bearer ${snap.apiKey || 'ollama'}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    },
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
      try {
        const obj = JSON.parse(payload) as Record<string, any>;
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
      } catch {
        continue;
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

// Ollama 原生 /api/chat 流式:每行一个 JSON(非 SSE),字段 message.content 做 token,
// tool_calls 在 message.tool_calls 里(非 streaming 时一次性返回)。
// 只有走原生端点才能设 options.num_ctx(OpenAI 兼容层 /v1/ 不透传 options)。

// ── 同模型并发闸(可配并发数信号量) / Per-model semaphore gate ────────────────
// Ollama 单 runner 多 slot(OLLAMA_NUM_PARALLEL),KV cache 按 slot×num_ctx 预分配;
// 客户端在途请求数一旦超过服务端 slot 数,Ollama 会【再加载一份同模型】挤爆 VRAM。
// 这里按 baseURL+model 做信号量:同模型最多 N 个在途请求(N=settings.ollamaParallel,
// 默认 1=串行;设成服务端 OLLAMA_NUM_PARALLEL 的值即可真并发,如 96GB Studio = 6)。
// 闸粒度 = 单次 HTTP 流(发起到读完),请求从不嵌套,无死锁;
// 排队中收到 abort 的请求从等待队列摘除,直接跳过不再发出。Map 按 distinct model 数有界。
// / Per-(baseURL, model) semaphore: cap in-flight requests at settings.
// ollamaParallel (default 1) to match server-side OLLAMA_NUM_PARALLEL slots —
// exceeding it makes Ollama load a second copy of the model. Aborted waiters are
// removed from the queue and skip their turn. Bounded by distinct model count.
const ollamaGates = new Map<string, { active: number; waiters: Array<{ grant: () => void; dead: boolean }> }>();
async function withOllamaGate<T>(key: string, limit: number, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  let gate = ollamaGates.get(key);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    ollamaGates.set(key, gate);
  }
  const g = gate;
  // held = 我占着一个闸位(active 已为我 +1,或由前手移交)。
  // / held = I own a slot (counted in active, or handed off by a predecessor).
  let held = false;
  // 默认 no-op:闭包内赋值不会被 TS CFA 追踪,non-null 默认值保证 finally 总可调用。
  // / Default no-op: closure assignment isn't tracked by TS CFA; a non-null
  // default keeps the finally-call always typed callable.
  let detach: () => void = () => {};
  await new Promise<void>((resolve) => {
    if (g.active < limit) { g.active++; held = true; resolve(); return; }
    const waiter = {
      dead: false,
      grant: (): void => { held = true; resolve(); },
    };
    g.waiters.push(waiter);
    // 排队中被 abort → 自摘出队并醒来;未持闸位,finally 不做移交/归还。
    // / Aborted while queued → unqueue self and wake; no slot owned → no handoff.
    const onAbort = (): void => {
      if (held) return; // 已在跑:abort 由 fetch(signal) 自然传导 / already running
      waiter.dead = true;
      const i = g.waiters.indexOf(waiter);
      if (i >= 0) g.waiters.splice(i, 1);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    detach = (): void => signal.removeEventListener('abort', onAbort);
  });
  try {
    if (signal.aborted || !held) throw new Error('aborted');
    return await fn();
  } finally {
    detach();
    if (held) {
      // 释放:优先把闸位移交队首等待者(active 不变);无人接手则归还计数,全空删 key。
      // / Release: hand the slot to the head waiter (active unchanged); else
      // decrement; drop the key when fully idle so the Map stays bounded.
      const next = g.waiters.shift();
      if (next) next.grant();
      else {
        g.active--;
        if (g.active === 0 && g.waiters.length === 0) ollamaGates.delete(key);
      }
    }
  }
}

async function ollamaStream(
  _messages: ChatMsg[],
  tools: ToolDef[],
  snap: ConfigSnapshot,
  signal: AbortSignal,
  onToken: (t: string) => void,
  wireMsgs: Record<string, unknown>[],
): Promise<Completion> {
  // Ollama 原生端点要求 tool_calls[].function.arguments 是 JSON **对象**,不接受
  // OpenAI 格式的字符串 —— 原样回灌会在第二轮(带工具往返历史)报
  // HTTP 400 "Value looks like object, but can't find closing '}' symbol"
  // (服务端 buger/jsonparser 把 string 当 object 扫描)。发送前统一转成对象。
  // Ollama's native endpoint demands object-typed tool arguments, unlike the
  // OpenAI wire format — convert string arguments back to parsed objects.
  const ollamaMsgs = wireMsgs.map((m) => {
    if (!Array.isArray((m as { tool_calls?: unknown[] }).tool_calls)) return m;
    return {
      ...m,
      tool_calls: ((m as { tool_calls: Array<Record<string, unknown>> }).tool_calls).map((tc) => {
        const fn = (tc.function ?? {}) as { name?: string; arguments?: unknown };
        if (typeof fn.arguments !== 'string') return tc;
        let parsed: unknown = {};
        try { parsed = JSON.parse(fn.arguments); } catch { /* 非法 JSON → 空对象,宁可丢参不可 400 */ }
        if (parsed === null || typeof parsed !== 'object') parsed = {};
        return { ...tc, function: { ...fn, arguments: parsed } };
      }),
    };
  });
  const body: Record<string, unknown> = {
    model: snap.model,
    messages: ollamaMsgs,
    stream: true,
    keep_alive: '30m',
    // num_ctx 与并发数联动:KV cache 按 slot×num_ctx 预分配,
    // ollamaParallel × num_ctx 过大时服务端会 OOM/杀 runner。
    // / num_ctx scales with parallelism: KV cache is pre-allocated per
    // slot×num_ctx; a too-large product OOMs the server and kills the runner.
    options: { num_ctx: getSettings().ollamaNumCtx || 32768 },
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters },
    }));
  }

  // /api/chat 端点:从 baseURL 去掉 /v1 后缀,加上 /api/chat。
  const base = snap.baseURL.replace(/\/v1\/?$/, '');
  const gateKey = `${base}|${snap.model}`;
  // 并发上限对齐服务端 OLLAMA_NUM_PARALLEL(设置里可调,默认 1=串行)。
  // / Concurrency cap mirrors server-side OLLAMA_NUM_PARALLEL (setting, default 1).
  const limit = Math.max(1, getSettings().ollamaParallel || 1);
  return withOllamaGate(gateKey, limit, signal, () => ollamaStreamInner(base, body, signal, onToken));
}

// 闸内实际执行:fetch + NDJSON 流解析(原 ollamaStream 主体)。
// / Inner body: fetch + NDJSON stream parsing (runs inside the serialization gate).
async function ollamaStreamInner(
  base: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onToken: (t: string) => void,
): Promise<Completion> {
  const resp = await fetchUntil200(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
    signal,
  });

  let content = '';
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let tokensIn = 0;
  let tokensOut = 0;

  const reader = resp.body?.getReader();
  if (!reader) throw new GLMError('noBody');
  const decoder = new TextDecoder();
  let buf = '';
  // 流静默看门狗(同 sseLines):连接半死时 reader.read() 永挂。
  const STALL_MS = 300_000;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const stall = new Promise<never>((_, reject) => {
      stallTimer = setTimeout(() => reject(new Error(`流静默 ${STALL_MS / 1000}s(连接半死,已中断)`)), STALL_MS);
    });
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stall]);
      if (done) break;
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, any>;
          if (obj.done && obj.total_duration !== undefined) {
            // 最终统计行
            tokensIn = intFrom(obj.prompt_eval_count) || tokensIn;
            tokensOut = intFrom(obj.eval_count) || tokensOut;
            break;
          }
          const msg = obj.message;
          if (!msg) continue;
          if (typeof msg.content === 'string' && msg.content) {
            content += msg.content;
            onToken(msg.content);
          }
          if (Array.isArray(msg.tool_calls)) {
            for (let i = 0; i < msg.tool_calls.length; i++) {
              const tc = msg.tool_calls[i];
              const fn = tc.function ?? {};
              calls.set(i, {
                id: tc.id ?? '',
                name: fn.name ?? '',
                args: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
              });
            }
          }
        } catch { /* skip malformed line */ }
      }
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    // 必须释放 reader:否则底层 TCP 连接挂着,abort 后流不真正关闭。
    // Must release+cancel reader — otherwise TCP connection leaks and abort doesn't close the stream.
    try { reader.releaseLock(); } catch { /* already released */ }
    await reader.cancel().catch(() => {});
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((v) => v.name)
    .map((v) => ({ id: v.id, name: v.name, arguments: v.args }));
  return { content, toolCalls, rawAssistant: rawAssistant(content, toolCalls), tokensIn, tokensOut };
}

// image_url → Anthropic image block。data: URL 的 payload 必须是纯 base64 才转 base64 source;
// 畸形 data: URL(含换行/非 base64 字符)降级丢弃 —— GLM 会把它映射成缺 file_url 的 file 块 → 400 [1214]。
function anthImagePart(p: { image_url?: { url: string } }): { type: 'image'; source: Record<string, string> } | null {
  const url = p.image_url?.url ?? '';
  const m = url.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2].replace(/\s+/g, '') } };
  if (/^data:/.test(url)) return null; // 畸形 data: URL → 丢弃图片,保留文本
  return { type: 'image', source: { type: 'url', url } };
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
    const cleanMessages = sanitizeMsgs(messages);
    const systemParts: string[] = [];
    const anth: any[] = [];
    for (const m of cleanMessages) {
      const role = m.role;
      const content = (typeof m.content === 'string' ? m.content : '') ?? '';
      if (role === 'system') systemParts.push(content);
      else if (role === 'user') {
        // 多模态:content 可能是 ContentPart[](含 image_url)。转 Anthropic 格式(image_url→image,source)。
        let anthContent: any[];
        if (Array.isArray(m.content)) {
          anthContent = (m.content as Array<{ type: string; text?: string; image_url?: { url: string } }>).map((p) => {
            if (p.type === 'text') return { type: 'text', text: p.text ?? '' };
            if (p.type === 'image_url' && p.image_url) return anthImagePart(p) ?? { type: 'text', text: '' };
            return { type: 'text', text: '' };
          });
        } else {
          anthContent = [{ type: 'text', text: content }];
        }
        // Anthropic 要求 user/assistant 严格交替。memoryBlock 头部消息(_memory)紧跟 history[0]
        // 的首个用户输入会构成连续 user —— 合并进上一条 user。
        // 安全:合并时保留 last 已有的 content blocks(含图片),只追加新 blocks。
        // Security: preserve existing content blocks (including images) when merging.
        const last = anth[anth.length - 1];
        if (last && last.role === 'user') {
          if (Array.isArray(last.content)) {
            // 已是数组(可能含图片)→ 直接追加新 blocks
            last.content.push(...anthContent);
          } else if (typeof last.content === 'string' && last.content) {
            // 字符串 content → 转为数组保留原文,再追加新 blocks(图片不丢失)
            last.content = [{ type: 'text', text: last.content }, ...anthContent];
          } else {
            // content 为空/null → 直接用新 blocks
            last.content = anthContent;
          }
        } else {
          anth.push({ role: 'user', content: anthContent });
        }
      }
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
        // Computer Use: tool result 可能是 ContentPart[](含截图 image_url)→ 转 Anthropic 格式。
        let toolResultContent: string | any[];
        if (Array.isArray(m.content)) {
          toolResultContent = (m.content as Array<{ type: string; text?: string; image_url?: { url: string } }>).map((p) => {
            if (p.type === 'text') return { type: 'text', text: p.text ?? '' };
            if (p.type === 'image_url' && p.image_url) return anthImagePart(p) ?? { type: 'text', text: '' };
            return { type: 'text', text: '' };
          });
        } else {
          toolResultContent = content;
        }
        const result = {
          type: 'tool_result',
          tool_use_id: (m.tool_call_id as string) ?? '',
          content: toolResultContent,
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
    );

    // 2) parse Anthropic SSE: text_delta → onToken; input_json_delta → stitch tool args
    let content = '';
    const blocks = new Map<number, { id: string; name: string; args: string }>();
    let tokensIn = 0;
    let tokensOut = 0;

    for await (const line of sseLines(resp)) {
      if (!line.startsWith('data:')) continue;
      let obj: Record<string, any>;
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
