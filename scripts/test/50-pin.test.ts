// Fix 4 回归:pinTurn 把 turn 级锁定映射到 directHistory 消息的 _pinned 标记,
// trim/compact 的保护逻辑(读 _pinned)从此真正生效;映射不可靠时明确拒绝而非假装生效。
import { assert, test, run } from './harness';
import { applyPin, type PinTarget } from '../../src/main/pin-history';
import { trimHistoryToTokenBudget, runAgentLoop } from '../../src/main/AgentLoop';
import type { ChatMsg, AgentEvent, ConfigSnapshot } from '../../src/shared/types';
import type { Provider, Completion } from '../../src/main/glm';

function mkHist(): ChatMsg[] {
  return [
    { role: 'user', content: 'turn1 问题' },
    { role: 'assistant', content: 'turn1 回答' },
    { role: 'user', content: 'turn2 问题(要锁定的)' },
    { role: 'assistant', content: 'turn2 回答' },
    { role: 'user', content: 'turn3 问题' },
    { role: 'assistant', content: 'turn3 回答' },
  ];
}
const turns: PinTarget[] = [
  { id: 't1', histStart: 0 },
  { id: 't2', histStart: 2 },
  { id: 't3', histStart: 4 },
];

test('applyPin:pin 中间 turn → 恰好标记该轮区间', () => {
  const hist = mkHist();
  const r = applyPin(hist, turns, 't2', true);
  assert.equal(r.ok, true);
  assert.ok((hist[2] as { _pinned?: boolean })._pinned === true);
  assert.ok((hist[3] as { _pinned?: boolean })._pinned === true);
  assert.ok(!(hist[0] as { _pinned?: boolean })._pinned, '其它轮不受影响');
  assert.ok(!(hist[5] as { _pinned?: boolean })._pinned, '其它轮不受影响');
});

test('applyPin:最后一个 turn → 区间到末尾', () => {
  const hist = mkHist();
  assert.equal(applyPin(hist, turns, 't3', true).ok, true);
  assert.ok((hist[4] as { _pinned?: boolean })._pinned === true);
  assert.ok((hist[5] as { _pinned?: boolean })._pinned === true);
});

test('applyPin:unpin 清除标记', () => {
  const hist = mkHist();
  applyPin(hist, turns, 't2', true);
  const r = applyPin(hist, turns, 't2', false);
  assert.equal(r.ok, true);
  assert.ok(!hist.some((m) => (m as { _pinned?: boolean })._pinned));
});

test('applyPin:无 histStart(旧数据)→ 拒绝并说明', () => {
  const r = applyPin(mkHist(), [{ id: 'old' }], 'old', true);
  assert.equal(r.ok, false);
  assert.match(r.reason, /早于本版本/);
});

test('applyPin:histStart 越界 → 拒绝', () => {
  const r = applyPin(mkHist(), [{ id: 'x', histStart: 99 }], 'x', true);
  assert.equal(r.ok, false);
});

test('applyPin:区间为空 → 拒绝', () => {
  // 下一 turn 的 histStart 与本 turn 相同 → 空区间
  const r = applyPin(mkHist(), [{ id: 'a', histStart: 2 }, { id: 'b', histStart: 2 }], 'a', true);
  assert.equal(r.ok, false);
});

test('applyPin:历史被重排(首条非 user)→ 拒绝', () => {
  const compacted = mkHist();
  // 模拟压缩后重排:摘要消息被挪到 turn2 原起点
  compacted.splice(2, 0, { role: 'user', content: '[早期对话摘要]\n压缩产生的摘要' });
  compacted.splice(3, 1); // 挪走原 user
  const r = applyPin(compacted, turns, 't2', true);
  assert.equal(r.ok, false);
  assert.match(r.reason, /重排|重新锁定/);
});

test('联动:_pinned turn 在极小预算 trim 下存活,其它轮被裁', () => {
  const big = 'L'.repeat(400);
  const hist: ChatMsg[] = [
    { role: 'user', content: `turn1 ${big}` },
    { role: 'assistant', content: `ans1 ${big}` },
    { role: 'user', content: 'turn2 关键结论:决策A' },
    { role: 'assistant', content: 'turn2 ans' },
    { role: 'user', content: `turn3 ${big}` },
    { role: 'assistant', content: `ans3 ${big}` },
  ];
  const r = applyPin(hist, [{ id: 't1', histStart: 0 }, { id: 't2', histStart: 2 }, { id: 't3', histStart: 4 }], 't2', true);
  assert.equal(r.ok, true);
  // 预算只够 ~1 条短消息:pinned 的 user+assistant + 全部受保护消息必须存活
  const out = trimHistoryToTokenBudget(hist, 120, 'openai');
  const texts = out.map((m) => String(m.content));
  assert.ok(texts.some((t) => t.includes('决策A')), '锁定轮内容必须保留(修前整体失效)');
  assert.ok(!texts.some((t) => t.includes('turn1 ')), '未锁定的旧轮可以被裁掉');
});

test('行为:trim 时受保护头部(记忆块)超预算 → status 告警', async () => {
  const snap = {
    apiProtocol: 'openai', model: 'test-model', apiKey: 'k', baseURL: 'http://localhost',
  } as unknown as ConfigSnapshot;
  let calls = 0;
  const provider: Provider = {
    async streamComplete(): Promise<Completion> {
      calls++;
      if (calls === 1) throw new Error('This model\'s maximum context length is 8192 tokens');
      return { content: 'done', toolCalls: [], tokensIn: 0, tokensOut: 0, rawAssistant: { role: 'assistant', content: 'done' } };
    },
  };
  const events: AgentEvent[] = [];
  await runAgentLoop({
    provider, tools: [], systemPrompt: 'sys',
    // 记忆块 ~2000 字符 ≈ 1500 token,远超 trimBudget 1000 → 触发告警
    memoryBlock: 'M'.repeat(2000),
    snapshot: snap, userInput: 'hi', history: [],
    ctx: { cwd: process.cwd(), confirm: async () => true } as never,
    signal: new AbortController().signal,
    policy: { trimBudget: 1000, interStepCompactBudget: 0, truncateThreshold: 100, appendStepSummary: false, stepSummaryMaxChars: 0, stepResultMaxChars: 0, subAgentScope: 'none' },
    onEvent: (e) => events.push(e),
  });
  const warn = events.find((e) => e.type === 'status' && /受保护上下文/.test(e.text ?? ''));
  assert.ok(warn, '应发出受保护上下文告警');
});
run();
