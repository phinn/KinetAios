// A 类 UI 对接修复回归:
// 1. resolveEnginePolicy 接 hifiBudget(修前 hifiContextBudget 是设置页死选项)
// 2. applyEvent 透传 errorKind(修前 renderer 无法区分可续跑的 maxTurns)
// 3. AgentLoop trim 事件 beforeTokens 真实值(修前恒 0)
import { assert, test, run } from './harness';
import { resolveEnginePolicy, applyEvent, newTurn, type Conversation } from '../../src/shared/types';
import { runAgentLoop } from '../../src/main/AgentLoop';
import type { AgentEvent, ConfigSnapshot } from '../../src/shared/types';
import type { Provider, Completion } from '../../src/main/glm';
import type { Tool } from '../../src/main/tools';

// ── 1. resolveEnginePolicy:hifiBudget 作为 hifi 模式预算下限 ──

test('hifiBudget:standard 模式完全不受影响', () => {
  const p = resolveEnginePolicy('direct', 'standard', undefined, undefined, 200_000);
  assert.equal(p.trimBudget, 15_000, 'standard 不吃 hifi 预算');
});

test('hifiBudget:hifi 无预算 → 翻倍(旧行为);有预算 → max(翻倍, 预算)', () => {
  const noBudget = resolveEnginePolicy('direct', 'hifi');
  assert.equal(noBudget.trimBudget, 30_000);
  const withBudget = resolveEnginePolicy('direct', 'hifi', undefined, undefined, 200_000);
  assert.equal(withBudget.trimBudget, 200_000, '设置页承诺的 200K 必须给足');
  assert.equal(withBudget.interStepCompactBudget, 200_000);
  assert.equal(withBudget.truncateThreshold, 8_000, 'truncate 不跟 hifi 预算(单条工具结果上限是另一码事)');
});

test('hifiBudget:预算 0/负数 → 忽略(视为未设置)', () => {
  assert.equal(resolveEnginePolicy('direct', 'hifi', undefined, undefined, 0).trimBudget, 30_000);
  assert.equal(resolveEnginePolicy('direct', 'hifi', undefined, undefined, -5).trimBudget, 30_000);
});

test('hifiBudget:directV2 动态路径同样吃下限', () => {
  // 1M 窗口 × 8% = 80K;hifi 翻倍 = 160K < 200K → 用 200K
  const p = resolveEnginePolicy('directV2', 'hifi', 1_000_000, 0.08, 200_000);
  assert.equal(p.trimBudget, 200_000);
  // 窗口预算超过 hifiBudget 时不受压制
  const p2 = resolveEnginePolicy('directV2', 'hifi', 4_000_000, 0.08, 200_000); // 320K×2=640K > 200K
  assert.equal(p2.trimBudget, 640_000, 'hifiBudget 是下限,不是上限');
});

// ── 2. applyEvent:errorKind 透传 ──

function mkConv(): Conversation {
  return {
    id: 'c1', engine: 'direct', cwd: '/tmp', createdAt: Date.now(),
    turns: [newTurn('hi')], status: 'running',
  } as unknown as Conversation;
}

test('applyEvent:error kind=maxTurns → turn.errorKind 透传', () => {
  const conv = mkConv();
  applyEvent(conv, { type: 'error', message: '达到最大轮数', kind: 'maxTurns' });
  const t = conv.turns[0]!;
  assert.equal(t.error, '达到最大轮数');
  assert.equal(t.errorKind, 'maxTurns');
  assert.equal(t.done, true);
});

test('applyEvent:无 kind 的旧错误 → errorKind 为 undefined(向后兼容)', () => {
  const conv = mkConv();
  applyEvent(conv, { type: 'error', message: '网络错误' });
  assert.equal(conv.turns[0]!.errorKind, undefined);
});

// ── 3. AgentLoop trim 事件 beforeTokens 真实值 ──

const snap = {
  apiProtocol: 'openai', model: 'test-model', apiKey: 'k', baseURL: 'http://localhost',
} as unknown as ConfigSnapshot;

test('行为:context-too-long trim 事件的 beforeTokens > afterTokens > 0(修前 before 恒 0)', async () => {
  let calls = 0;
  const provider: Provider = {
    async streamComplete(): Promise<Completion> {
      calls++;
      if (calls === 1) throw new Error("This model's maximum context length is 8192 tokens");
      return { content: 'done', toolCalls: [], tokensIn: 0, tokensOut: 0, rawAssistant: { role: 'assistant', content: 'done' } };
    },
  };
  const events: AgentEvent[] = [];
  const big = 'L'.repeat(300);
  const history = Array.from({ length: 8 }, (_, i) => ({ role: 'user' as const, content: `q${i} ${big}` }));
  await runAgentLoop({
    provider, tools: [] as Tool[], systemPrompt: 'sys', snapshot: snap,
    userInput: 'hi', history, ctx: { cwd: '/tmp', confirm: async () => true } as never,
    signal: new AbortController().signal,
    policy: { trimBudget: 300, interStepCompactBudget: 0, truncateThreshold: 100, appendStepSummary: false, stepSummaryMaxChars: 0, stepResultMaxChars: 0, subAgentScope: 'none' },
    onEvent: (e) => events.push(e),
  });
  const ctxEvt = events.find((e) => e.type === 'context') as { beforeTokens?: number; afterTokens?: number } | undefined;
  assert.ok(ctxEvt, '应有 context/trimmed 事件');
  assert.ok((ctxEvt!.beforeTokens ?? 0) > 0, `beforeTokens 应为真实值,得到 ${ctxEvt!.beforeTokens}`);
  assert.ok((ctxEvt!.afterTokens ?? 1) < (ctxEvt!.beforeTokens ?? 0), '裁剪后应小于裁剪前');
});

run();
