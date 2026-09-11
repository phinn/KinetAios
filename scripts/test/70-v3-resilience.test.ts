// V3 韧性回归:瞬时错误退避重试 / 空回复 2 次推促 / deep 节点轮次上限续跑。
// 修前"任务到一半停止"的三大根因:① 一次 429/网络错误就把整轮 ReAct 砍掉;
// ② 节点 >8 轮未收尾 → 失败 → 重试 2 次(仍 8 轮撞顶)→ 下游 blocked,deep 任务到一半停;
// ③ 思考模型偶发空回复,只推促一次就报错退出。
import { assert, test, run } from './harness';
import { runAgentLoop, isTransientError } from '../../src/main/AgentLoop';
import { executeNode, MAX_TURNS_PER_STEP, MAX_STEP_SEGMENTS } from '../../src/main/V3/dag-executor';
import type { ChatMsg, AgentEvent, ConfigSnapshot, EngineContextPolicy } from '../../src/shared/types';
import type { Provider, Completion, ToolDef, ToolCall } from '../../src/main/glm';
import type { Tool, ToolCtx } from '../../src/main/tools';
import type { DAGNode } from '../../src/main/V3/dag-planner';

const snap = {
  apiProtocol: 'openai', model: 'test-model', apiKey: 'k', baseURL: 'http://localhost',
} as unknown as ConfigSnapshot;
const noopCtx = { cwd: process.cwd(), confirm: async () => true } as unknown as ToolCtx;
const EMPTY_TOOLS: Tool[] = [];
const POLICY: EngineContextPolicy = {
  trimBudget: 1000, interStepCompactBudget: 0, truncateThreshold: 100,
  appendStepSummary: false, stepSummaryMaxChars: 0, stepResultMaxChars: 4000, subAgentScope: 'none',
};
const noBackoff = () => 0; // 测试跳过真实退避等待

function textComp(text: string): Completion {
  return { content: text, toolCalls: [], tokensIn: 0, tokensOut: 0, rawAssistant: { role: 'assistant', content: text } };
}
function toolComp(name: string): Completion {
  const tc: ToolCall = { id: `c${Math.random()}`, name, arguments: '{}' };
  return { content: '', toolCalls: [tc], tokensIn: 0, tokensOut: 0, rawAssistant: { role: 'assistant', content: '', tool_calls: [tc] } as ChatMsg };
}

// ── isTransientError 分类 ──

test('isTransientError:限流/网络/5xx → true', () => {
  assert.equal(isTransientError(new Error('rate limit exceeded, retry later')), true);
  assert.equal(isTransientError(new Error('fetch failed: ECONNRESET')), true);
  assert.equal(isTransientError({ code: 502, message: 'Bad Gateway' }), true);
  assert.equal(isTransientError({ code: 429, message: 'Too Many Requests' }), true);
  assert.equal(isTransientError(new Error('Request timed out')), true);
});
test('isTransientError:鉴权/参数类 → false', () => {
  assert.equal(isTransientError(new Error('invalid api key')), false);
  assert.equal(isTransientError({ code: 400, message: 'bad request' }), false);
  assert.equal(isTransientError({ code: 401, message: 'unauthorized' }), false);
  assert.equal(isTransientError({ kind: 'noKey' }), false);
  assert.equal(isTransientError(new Error('Max retries exceeded')), false); // 与 maxTurns 无关,非瞬时
});

// ── AgentLoop:瞬时错误退避重试后成功 ──

test('AgentLoop:瞬时错误 2 次后第 3 次成功 → done,无 error 事件', async () => {
  let calls = 0;
  const provider: Provider = {
    async streamComplete(): Promise<Completion> {
      calls++;
      if (calls <= 2) throw new Error('rate limit exceeded, retry later');
      return textComp('done');
    },
  };
  const events: AgentEvent[] = [];
  const out = await runAgentLoop({
    provider, tools: EMPTY_TOOLS, systemPrompt: 'sys', snapshot: snap,
    userInput: 'hi', history: [], ctx: noopCtx, signal: new AbortController().signal,
    policy: POLICY, retryBackoffMs: noBackoff, onEvent: (e) => events.push(e),
  });
  assert.equal(calls, 3, '应该重试到第 3 次成功');
  assert.ok(events.some((e) => e.type === 'done'), '应完成');
  assert.ok(!events.some((e) => e.type === 'error'), '不应有 error 事件(瞬时错误已恢复)');
  assert.ok(events.some((e) => e.type === 'status' && /重试 1\/3/.test(e.text)), '应有第 1 次重试提示');
});

test('AgentLoop:非瞬时错误(鉴权)→ 立即 error 退出,不重试', async () => {
  let calls = 0;
  const provider: Provider = {
    async streamComplete(): Promise<Completion> { calls++; throw new Error('invalid api key'); },
  };
  const events: AgentEvent[] = [];
  await runAgentLoop({
    provider, tools: EMPTY_TOOLS, systemPrompt: 'sys', snapshot: snap,
    userInput: 'hi', history: [], ctx: noopCtx, signal: new AbortController().signal,
    policy: POLICY, retryBackoffMs: noBackoff, onEvent: (e) => events.push(e),
  });
  assert.equal(calls, 1, '鉴权类错误不重试');
  assert.ok(events.some((e) => e.type === 'error'), '应上报 error');
});

test('AgentLoop:瞬时错误重试耗尽(>MAX_API_RETRIES)→ 报 transient error', async () => {
  let calls = 0;
  const provider: Provider = {
    async streamComplete(): Promise<Completion> { calls++; throw new Error('rate limit exceeded'); },
  };
  const events: AgentEvent[] = [];
  await runAgentLoop({
    provider, tools: EMPTY_TOOLS, systemPrompt: 'sys', snapshot: snap,
    userInput: 'hi', history: [], ctx: noopCtx, signal: new AbortController().signal,
    policy: POLICY, retryBackoffMs: noBackoff, onEvent: (e) => events.push(e),
  });
  // 1 次原始 + MAX_API_RETRIES 次重试
  assert.equal(calls, 1 + 3);
  const err = events.find((e) => e.type === 'error') as { kind?: string };
  assert.ok(err, '应上报 error');
  assert.equal(err.kind, 'transient', '最终失败应标 transient kind');
});

// ── AgentLoop:空回复推促 2 次 ──

test('AgentLoop:空回复推促 2 次后成功 → done(修前只推 1 次)', async () => {
  let calls = 0;
  const provider: Provider = {
    async streamComplete(): Promise<Completion> {
      calls++;
      if (calls <= 2) return { content: '', toolCalls: [], tokensIn: 0, tokensOut: 10, rawAssistant: { role: 'assistant', content: '' } };
      return textComp('done');
    },
  };
  const events: AgentEvent[] = [];
  await runAgentLoop({
    provider, tools: EMPTY_TOOLS, systemPrompt: 'sys', snapshot: snap,
    userInput: 'hi', history: [], ctx: noopCtx, signal: new AbortController().signal,
    policy: POLICY, retryBackoffMs: noBackoff, onEvent: (e) => events.push(e),
  });
  assert.equal(calls, 3, '第 3 次(第 2 次推促后)成功');
  assert.ok(events.some((e) => e.type === 'done'));
});

// ── deep 节点轮次上限续跑 ──

// 模拟工具:被调用返回 'ok',不产生副作用(让模型连续调用直到轮次耗尽)。
const dummyTool: Tool = {
  name: 'dummy_read',
  description: '测试用只读工具',
  parameters: { type: 'object', properties: {} },
  readOnly: true,
  run: async () => 'ok',
};
const dummyNode: DAGNode = {
  id: 'n1', title: '探查', action: '探查项目结构',
  tools: ['dummy_read'], parallelizable: false, deps: [],
  status: 'pending', retryCount: 0,
};

test('executeNode:前 MAX_TURNS_PER_STEP 轮全是 tool_call(轮次上限),续跑段输出文字 → 成功', async () => {
  let calls = 0;
  const provider: Provider = {
    async streamComplete(): Promise<Completion> {
      calls++;
      // 第 1 段:8 轮全 tool_call(撞轮次上限)→ 续跑段第 9 轮给文字结论
      if (calls <= MAX_TURNS_PER_STEP) return toolComp('dummy_read');
      return textComp('步骤完成:探查到 3 个模块');
    },
  };
  const events: AgentEvent[] = [];
  const r = await executeNode(dummyNode, {
    provider, tools: [dummyTool], systemPrompt: 'sys', snapshot: snap,
    ctx: noopCtx, signal: new AbortController().signal, policy: POLICY,
    history: [], onEvent: (e) => events.push(e), approved: new Set(),
  });
  assert.equal(r.success, true, '续跑后应成功(修前:8 轮撞顶 → 失败 → 下游 blocked → 任务到一半停)');
  assert.equal(calls, MAX_TURNS_PER_STEP + 1, '应该有续跑段的第 9 次调用');
  assert.ok(r.summary!.includes('探查到 3 个模块'), '摘要应含续跑段的结论');
  assert.ok(events.some((e) => e.type === 'status' && /续跑/.test(e.text)), '应有续跑提示');
});

test('executeNode:续跑 MAX_STEP_SEGMENTS 段仍全是 tool_call → 失败(有界,不无限烧)', async () => {
  let calls = 0;
  const provider: Provider = {
    async streamComplete(): Promise<Completion> { calls++; return toolComp('dummy_read'); },
  };
  const r = await executeNode(dummyNode, {
    provider, tools: [dummyTool], systemPrompt: 'sys', snapshot: snap,
    ctx: noopCtx, signal: new AbortController().signal, policy: POLICY,
    history: [], onEvent: () => {}, approved: new Set(),
  });
  assert.equal(r.success, false, '所有段都撞轮次上限 → 失败(有界)');
  assert.equal(calls, MAX_TURNS_PER_STEP * MAX_STEP_SEGMENTS, '恰好烧满 3 段 × 8 轮');
  assert.match(r.error!, /轮内完成/, '失败原因应说明轮次耗尽而非"出错"');
});

test('executeNode:中途非瞬时错误(鉴权)→ 不续跑,标记出错', async () => {
  let calls = 0;
  const provider: Provider = {
    async streamComplete(): Promise<Completion> {
      calls++;
      throw new Error('invalid api key');
    },
  };
  const r = await executeNode(dummyNode, {
    provider, tools: [dummyTool], systemPrompt: 'sys', snapshot: snap,
    ctx: noopCtx, signal: new AbortController().signal, policy: POLICY,
    history: [], onEvent: () => {}, approved: new Set(),
  });
  assert.equal(r.success, false);
  assert.equal(calls, 1, '鉴权错误不续跑、不重试');
  assert.match(r.error!, /出错/, '失败原因应说明出错(而非轮次耗尽)');
});

run();
