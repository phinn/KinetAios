// Fix 5 回归:压缩摘要条数有界(≤3)+ 超限合并 + spill 审计记录最新摘要。
// 修前:每轮压缩新增一条 [早期对话摘要],旧摘要永不二次压缩且不占预算 → 长会话保护头部无界膨胀。
import { assert, test, run } from './harness';
import { compactHistory, compactWithSpill, trimHistoryToTokenBudget } from '../../src/main/AgentLoop';
import * as store from '../../src/main/store';
import type { ChatMsg, ConfigSnapshot } from '../../src/shared/types';
import type { Provider, Completion } from '../../src/main/glm';

const snap = {
  apiProtocol: 'openai', model: 'test-model', apiKey: 'k', baseURL: 'http://localhost',
} as unknown as ConfigSnapshot;
const signal = new AbortController().signal;

const WRITER_TEXT = '【任务目标】修好了导出功能\n【重要结论】决策C(新)';
const MERGED_TEXT = '【任务目标】合并后的摘要\n【关键决策】决策A/B/C 合并保留';

type Call = { sys: string; user: string };
function mkProvider(opts: { failMerge?: boolean; capture?: Call[] }): Provider {
  return {
    async streamComplete(messages): Promise<Completion> {
      const sys = typeof messages[0]?.content === 'string' ? messages[0].content : '';
      const user = typeof messages[1]?.content === 'string' ? messages[1].content : '';
      if (sys.includes('对话摘要合并器')) {
        opts.capture?.push({ sys, user });
        if (opts.failMerge) throw new Error('merge llm down');
        return { content: MERGED_TEXT, toolCalls: [], tokensIn: 0, tokensOut: 0, rawAssistant: { role: 'assistant', content: MERGED_TEXT } };
      }
      return { content: WRITER_TEXT, toolCalls: [], tokensIn: 0, tokensOut: 0, rawAssistant: { role: 'assistant', content: WRITER_TEXT } };
    },
  };
}

// 每条 ~300 字符 → ~245 token(系数 0.75),budget=500 时 tail 只能留 ~2 条。
function bigMsgs(tag: string, n: number): ChatMsg[] {
  return Array.from({ length: n }, (_, i) => ({
    role: 'user' as const,
    content: `${tag}-消息${i}:${('细节内容'.repeat(40))}`,
  }));
}
const countSummaries = (msgs: ChatMsg[]): number =>
  msgs.filter((m) => typeof m.content === 'string' && m.content.startsWith('[早期对话摘要]')).length;

test('A: 连续 10 轮压缩(每轮追加新历史)→ 摘要条数恒 ≤3', async () => {
  let msgs: ChatMsg[] = bigMsgs('r0', 8);
  for (let i = 1; i <= 10; i++) {
    msgs = [...msgs, ...bigMsgs(`r${i}`, 8)];
    msgs = await compactHistory(msgs, 500, mkProvider({}), snap, signal);
    const n = countSummaries(msgs);
    assert.ok(n <= 3, `第 ${i} 轮:摘要条数 ${n} 超过上限 3(修前会无限累加)`);
    assert.ok(n >= 1, `第 ${i} 轮:至少应有一条摘要`);
  }
});

test('B: 触发合并时,合并输入包含旧摘要与新摘要,产物为单条', async () => {
  const captured: Call[] = [];
  // 3 条旧摘要 + 本轮新摘要 = 4 > 上限 3 → 必须触发合并
  const oldSummaries: ChatMsg[] = ['【关键决策】决策A(旧)', '【重要结论】决策B(旧)', '【待办事项】决策B2(旧)']
    .map((t) => ({ role: 'user', content: `[早期对话摘要]\n${t}` }) as ChatMsg);
  const msgs = [...oldSummaries, ...bigMsgs('head', 8)];
  const out = await compactHistory(msgs, 500, mkProvider({ capture: captured }), snap, signal);
  const mergeCalls = captured.filter((c) => c.sys.includes('对话摘要合并器'));
  assert.equal(mergeCalls.length, 1, '应恰好触发一次 LLM 合并');
  assert.ok(mergeCalls[0].user.includes('决策A'), '合并输入应包含旧摘要内容');
  assert.ok(mergeCalls[0].user.includes(WRITER_TEXT.slice(-10)), '合并输入应包含新生成的摘要');
  assert.equal(countSummaries(out), 1, '合并后旧摘要应被单条替代');
  const s = out.find((m) => typeof m.content === 'string' && m.content.startsWith('[早期对话摘要]'));
  assert.ok(String(s!.content).includes(MERGED_TEXT), '摘要正文为合并产物');
});

test('C: LLM 合并失败 → 退化拼接截断,条数仍收敛为 1,不抛错', async () => {
  const oldSummaries: ChatMsg[] = ['【关键决策】决策A(旧)', '【重要结论】决策B(旧)', '【待办事项】决策B2(旧)']
    .map((t) => ({ role: 'user', content: `[早期对话摘要]\n${t}` }) as ChatMsg);
  const msgs = [...oldSummaries, ...bigMsgs('head', 8)];
  const out = await compactHistory(msgs, 500, mkProvider({ failMerge: true }), snap, signal);
  assert.equal(countSummaries(out), 1);
  const s = out.find((m) => typeof m.content === 'string' && m.content.startsWith('[早期对话摘要]'));
  const text = String(s!.content);
  assert.ok(text.includes('决策A(旧)'), '退化合并保留旧摘要内容');
  assert.ok(text.includes('决策C(新)'), '退化合并保留新摘要内容');
});

test('D: trim 联动 — 3 条摘要在极小预算下全部保留', () => {
  const summaries: ChatMsg[] = [1, 2, 3].map((i) => ({ role: 'user', content: `[早期对话摘要]\n摘要${i}` }));
  const msgs = [...summaries, ...bigMsgs('tail', 10)];
  const out = trimHistoryToTokenBudget(msgs, 300, 'openai');
  assert.equal(countSummaries(out), 3, '受保护摘要不得被 trim 丢弃');
});

test('E: compactWithSpill 记录的是最新一条摘要(修前取最旧)', async () => {
  store.initStore();
  const convId = 'conv-spill-test';
  const turnId = 'turn-spill-test';
  const before = [bigMsgs('x', 2)[0]];
  const oldSum: ChatMsg = { role: 'user', content: '[早期对话摘要]\n旧摘要内容' };
  const newSum: ChatMsg = { role: 'user', content: '[早期对话摘要]\n新摘要内容' };
  await compactWithSpill(before, async () => [oldSum, newSum], { convId, turnId });
  const events = store.loadEvents(convId).map((e) => e.data as { type: string; summary?: string });
  const spill = events.find((e) => e.type === 'compaction/spill');
  assert.ok(spill, '应写入 spill 事件');
  assert.equal(spill!.summary, '新摘要内容', '审计摘要应取最新一条(修前取最旧)');
});

run();
