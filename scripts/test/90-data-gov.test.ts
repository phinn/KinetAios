// 数据治理 + 检索质量收尾批次回归:
// A1 排序池只在召回候选集内 / A2 dedup 保留新值 / B1 conv_events 保留策略 + spill 瘦身 / C2 factsAsBlock 数据源
import { assert, test, run } from './harness';
import * as store from '../../src/main/store';
import { compactWithSpill } from '../../src/main/AgentLoop';
import type { ChatMsg } from '../../src/shared/types';

store.initStore();

const DAY = 86_400_000;

// ── A2: dedup 保留新值 ──

test('dedup:相似记忆删旧留新(修前删新留旧)', async () => {
  const oldId = store.addMemory('用户喜欢深色主题', 'conv-gov', 5);
  await new Promise((r) => setTimeout(r, 60)); // created_at 秒级浮点,拉开先后
  const newId = store.addMemory('用户喜欢深色主题界面', 'conv-gov', 5);
  const before = store.loadMemories('conv-gov').length;
  await store.dedupMemories(0.65);
  const ids = new Set(store.loadMemories('conv-gov').map((m) => m.id));
  assert.ok(!ids.has(oldId), '更旧的重复记忆应被删');
  assert.ok(ids.has(newId), '更新的记忆必须存活');
  void before;
});

// ── A1: scoredMemories onlyIds(只在召回候选集内重排)──

test('scoredMemories onlyIds:池外高 importance 记忆不得进入结果', () => {
  // 候选集只有 cand;池外有一批 importance=10 的记忆
  const cand = store.addMemory('候选 记忆甲', 'conv-gov2', 5);
  for (let i = 0; i < 5; i++) store.addMemory(`池外高重要性${i}`, 'conv-gov2', 10);
  const scored = store.scoredMemories('候选', 20, (c) => (c.includes('候选') ? 0.9 : 0), undefined, new Set([cand]));
  assert.equal(scored.length, 1, 'onlyIds 限制下只应返回候选集内的记忆');
  assert.equal(scored[0].id, cand);
  // 不传 onlyIds → 池外高重要性仍会挤进前排(旧行为对照,证明限制生效)
  const unrestricted = store.scoredMemories('候选', 20, (c) => (c.includes('候选') ? 0.9 : 0));
  assert.ok(unrestricted.length > 1);
  assert.equal(unrestricted[0].content.includes('池外'), true, '无限制时高 importance 池外记忆排前(旧行为)');
});

// ── C2 前置: factsAsBlock 数据源 ──

test('factsAsBlock:saveFact 后拼行,deleteFact 后消失', () => {
  store.saveFact('conv-gov3', 'api_base', 'https://api.example.com');
  store.saveFact('conv-gov3', 'build_cmd', 'npm run dist');
  const block = store.factsAsBlock('conv-gov3');
  assert.ok(block.includes('api_base: https://api.example.com'));
  assert.ok(block.includes('build_cmd: npm run dist'));
  store.deleteFact('conv-gov3', 'api_base');
  assert.ok(!store.factsAsBlock('conv-gov3').includes('api_base'));
});

// ── B1: spill 瘦身 ──

test('spill:dropped 全文落库改为前 20 条×500 字符 + droppedTotal', async () => {
  const convId = 'conv-spill-slim';
  const before: ChatMsg[] = Array.from({ length: 30 }, (_, i) => ({
    role: 'user' as const,
    content: `大块内容${i}:${'X'.repeat(2000)}`,
  }));
  const keep: ChatMsg[] = [{ role: 'user', content: '留下的' }];
  await compactWithSpill(before, async () => keep, { convId, turnId: 't-slim' });
  const evt = store.loadEvents(convId).map((e) => e.data as { type: string; dropped?: ChatMsg[]; droppedTotal?: number })
    .find((e) => e.type === 'compaction/spill');
  assert.ok(evt, '应写入 spill 事件');
  assert.equal(evt!.dropped!.length, 20, '存证截断为前 20 条');
  assert.equal(evt!.droppedTotal, 30, 'droppedTotal 记录真实条数');
  assert.ok(evt!.dropped![0]!.content!.length <= 502, '每条 content 截 500 字符内');
});

// ── B1: conv_events 保留策略(goal/* 永不清理)──

test('pruneOldConvEvents:90 天前非 goal 事件删除,goal/* 永不清理', async () => {
  const convId = 'conv-prune';
  store.appendEvent(convId, 't1', { type: 'goal/set', goal: '老目标' });
  store.appendEvent(convId, 't1', { type: 'tool/call', name: 'shell', args: 'x', result: 'y'.repeat(100) });
  // 模拟时间前进 91 天:cutoff = 模拟now − 90d,先插入的两条都过期
  const pruned = store.pruneOldConvEvents(90, Date.now() + 91 * DAY);
  assert.ok(pruned >= 1, '应有旧事件被清');
  const types = store.loadEvents(convId).map((e) => e.data.type);
  assert.ok(!types.includes('tool/call'), '过期的非 goal 事件应被清');
  assert.ok(types.includes('goal/set'), 'goal/* 事件永不清理(投影从头 fold,删了会破坏状态)');
});

test('pruneOldConvEvents:90 天内的事件存活(prune 返回 0)', async () => {
  const convId = 'conv-prune-fresh';
  store.appendEvent(convId, 't9', { type: 'user/message', text: '新消息' });
  const pruned = store.pruneOldConvEvents(90, Date.now()); // 真实 now:刚插入的事件远未过期
  assert.equal(pruned, 0);
  assert.ok(store.loadEvents(convId).some((e) => e.data.type === 'user/message'));
});

run();
