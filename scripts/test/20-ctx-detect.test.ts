// Fix 3 回归:isContextTooLong 不再误判限流/配额错误;超长判定仍然有效。
// 修前:裸 `exceed|too long|上下文` → "rate limit exceeded" 命中 → 三级 fallback 砍历史到 1/4。
import { assert, test, run } from './harness';
import { isContextTooLong, runAgentLoop } from '../../src/main/AgentLoop';
import type { ChatMsg, ConfigSnapshot } from '../../src/shared/types';
import type { Provider, Completion } from '../../src/main/glm';
import type { Tool, ToolCtx } from '../../src/main/tools';
import type { AgentEvent } from '../../src/shared/types';

// ── 措辞表:正向 = 上下文超长,true ──
const TRUE_CASES: Array<[string, string]> = [
  ['openai max-context', "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens."],
  ['anthropic prompt-too-long', 'prompt is too long: 200000 tokens > 128000 maximum'],
  ['glm 中文超长', '错误:输入的上下文长度超出模型限制'],
  ['context_window', 'context_window exceeded by request'],
  ['generic too-long', 'messages too long for this model'],
];
for (const [name, msg] of TRUE_CASES) {
  test(`true: ${name}`, () => assert.equal(isContextTooLong(new Error(msg)), true));
}
test('true: HTTP 413', () => assert.equal(isContextTooLong({ code: 413, message: 'Payload Too Large' }), true));

// ── 措辞表:负向 = 限流/配额/计费,false(核心回归:修前全是 true)──
const FALSE_CASES: Array<[string, string]> = [
  ['rate limit', 'rate limit exceeded, retry after 30s'],
  ['ratelimit 无分隔', 'ratelimit hit for model'],
  ['quota', 'quota exceeded for this model'],
  ['429', '429 Too Many Requests'],
  ['max retries', 'Max retries exceeded'],
  ['insufficient balance', 'insufficient balance, please top up'],
  ['billing', 'billing error: card declined'],
];
for (const [name, msg] of FALSE_CASES) {
  test(`false: ${name}`, () => assert.equal(isContextTooLong(new Error(msg)), false));
}
test('false: 普通网络错误', () =>
  assert.equal(isContextTooLong(new Error('getaddrinfo ENOTFOUND api.example.com')), false));

// ── 行为级:限流错误不得触发破坏性 trim ──
const snap = {
  apiProtocol: 'openai', model: 'test-model', apiKey: 'k', baseURL: 'http://localhost',
} as unknown as ConfigSnapshot;
const noopCtx = { cwd: process.cwd(), confirm: async () => true } as unknown as ToolCtx;
const EMPTY_TOOLS: Tool[] = [];

function mkHistory(pairs: number): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (let i = 0; i < pairs; i++) {
    out.push({ role: 'user', content: `旧问题 ${i} ${'hist'.repeat(60)}` });
    out.push({ role: 'assistant', content: `旧回答 ${i} ${'ans'.repeat(60)}` });
  }
  return out;
}

test('行为:限流错误 → 直接报错退出,历史不被裁剪,无 context/trimmed 事件', async () => {
  const provider: Provider = {
    async streamComplete(): Promise<Completion> {
      throw new Error('rate limit exceeded, retry after 30s');
    },
  };
  const events: AgentEvent[] = [];
  const history = mkHistory(5); // 远小于任何预算
  const out = await runAgentLoop({
    provider, tools: EMPTY_TOOLS, systemPrompt: 'sys', snapshot: snap,
    userInput: 'hi', history, ctx: noopCtx, signal: new AbortController().signal,
    policy: { trimBudget: 100, interStepCompactBudget: 0, truncateThreshold: 100, appendStepSummary: false, stepSummaryMaxChars: 0, stepResultMaxChars: 0, subAgentScope: 'none' },
    onEvent: (e) => events.push(e),
  });
  const trimmedEvt = events.find((e) => (e as { type: string }).type === 'context');
  assert.equal(trimmedEvt, undefined, '限流错误不得发 context/trimmed 事件');
  assert.ok(events.some((e) => e.type === 'error'), '应上报错误');
  // 历史原样保留(5 对 user/assistant + 本轮 user + 补充内容)
  assert.equal(out.length, 11, '历史消息数量不变(未被裁剪)');
});

test('行为:真实超长错误 → 第一级 trim 触发并重试成功', async () => {
  let calls = 0;
  const provider: Provider = {
    async streamComplete(): Promise<Completion> {
      calls++;
      if (calls === 1) throw new Error("This model's maximum context length is 8192 tokens");
      return {
        content: 'done', toolCalls: [], tokensIn: 0, tokensOut: 0,
        rawAssistant: { role: 'assistant', content: 'done' },
      };
    },
  };
  const events: AgentEvent[] = [];
  const out = await runAgentLoop({
    provider, tools: EMPTY_TOOLS, systemPrompt: 'sys', snapshot: snap,
    userInput: 'hi', history: mkHistory(5), ctx: noopCtx,
    signal: new AbortController().signal,
    policy: { trimBudget: 150, interStepCompactBudget: 0, truncateThreshold: 100, appendStepSummary: false, stepSummaryMaxChars: 0, stepResultMaxChars: 0, subAgentScope: 'none' },
    onEvent: (e) => events.push(e),
  });
  const trimmedEvt = events.find((e) => (e as { type?: string; action?: string }).type === 'context') as { action?: string } | undefined;
  assert.ok(trimmedEvt, '超长错误应触发 context/trimmed 事件');
  assert.equal(trimmedEvt?.action, 'trimmed');
  assert.ok(out.length >= 1 && out.length < 11, '历史被裁剪到预算内');
  assert.ok(events.some((e) => e.type === 'done'), 'trim 后重试成功完成');
});

run();
