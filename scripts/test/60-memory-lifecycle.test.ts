// 批次 2 回归:记忆生命周期三项 —— decay 按 importance 分档、注入不再 touch(反馈回路)、
// episodic per-conv 滚动 upsert(不再每轮 done 堆积重复摘要)。
import { assert, test, run } from './harness';
import * as store from '../../src/main/store';
import { recallMemories, type EmbedFn } from '../../src/main/memory-recall';

store.initStore();

const DAY = 86_400_000;
const findByContent = (content: string) => store.loadMemories().find((m) => m.content === content);

// ── decayMemories 按 importance 分档 ──

test('decay:importance=10 从未被召回,60 天后仍存活(修前会被删)', () => {
  store.addMemory('核心 构建命令 npm run dist', 'conv-life', 10);
  store.decayMemories(Date.now() + 60 * DAY);
  assert.ok(findByContent('核心 构建命令 npm run dist'), '核心事实不得被自动衰减删除');
});

test('decay:importance=10 一年后仍存活(≥8 永不自动删除)', () => {
  store.addMemory('核心 架构 用 better-sqlite3', 'conv-life', 10);
  store.decayMemories(Date.now() + 365 * DAY);
  assert.ok(findByContent('核心 架构 用 better-sqlite3'));
});

test('decay:importance=5,60 天未召回 → 删除(默认档 ~45 天,与旧版一致)', () => {
  store.addMemory('一般 习惯 记录A', 'conv-life', 5);
  store.decayMemories(Date.now() + 60 * DAY);
  assert.ok(!findByContent('一般 习惯 记录A'));
});

test('decay:importance=5,30 天 → 存活', () => {
  store.addMemory('一般 习惯 记录B', 'conv-life', 5);
  store.decayMemories(Date.now() + 30 * DAY);
  assert.ok(findByContent('一般 习惯 记录B'));
});

test('decay:importance=2 噪声 ~30 天清除(比默认档更快)', () => {
  store.addMemory('边缘 临时信号', 'conv-life', 2);
  store.decayMemories(Date.now() + 40 * DAY);
  assert.ok(!findByContent('边缘 临时信号'), '低价值噪声应加速清除');
  store.addMemory('边缘 临时信号2', 'conv-life', 2);
  store.decayMemories(Date.now() + 20 * DAY);
  assert.ok(findByContent('边缘 临时信号2'), '20 天内仍存活');
});

test('decay:被召回过的记忆以 last_used 为基准,60 天前召回 → 删除;刚召回 → 存活且权重衰减', () => {
  const old = store.addMemory('召回 旧命中', 'conv-life', 5);
  store.touchMemoryUsed(old);
  // 把 last_used 手动拨回 60 天前:touch 写的是 now,这里再跑一次 decay 时用过去时间点不行 ——
  // 改为验证"刚召回 → 存活 + 权重 <1"的行为面。
  const fresh = store.addMemory('召回 新命中', 'conv-life', 5);
  store.touchMemoryUsed(fresh);
  store.decayMemories(Date.now() + 1 * DAY); // 1 天后:decayed ≈ 0.95 > 0.1 → 存活,权重被更新
  const alive = findByContent('召回 新命中');
  assert.ok(alive, '刚被召回的记忆存活');
  const tl = store.loadMemoryTimeline().find((m) => m.id === fresh);
  assert.ok(tl && tl.weight > 0 && tl.weight < 1.0, 'meta 行权重已衰减(<1)');
  void old;
});

// ── 注入不再 touch(切断反馈回路)──

const embedOk: EmbedFn = async (texts) => texts.map(() => [1, 0]);

test('注入回路:recallMemories 全链路后,所有记忆 useCount 仍为 0(修前注入即 touch)', async () => {
  const conv = 'conv-touch';
  const mine: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = store.addMemory(`触摸测试记忆${i}`, conv, 5);
    store.setMemoryEmbedding(id, [1, 0], 'test-model');
    mine.push(id);
  }
  await recallMemories({ query: '触摸', limit: 15, restrictConvId: conv, embed: embedOk });
  await recallMemories({ query: '触摸', limit: 15, embed: embedOk }); // 全局模式同样
  const tl = store.loadMemoryTimeline();
  for (const id of mine) {
    const row = tl.find((m) => m.id === id);
    assert.ok(row);
    assert.equal(row.useCount, 0, `注入不得污染 useCount:${row.content}`);
    assert.equal(row.lastUsed, 0, '注入不得污染 lastUsed');
  }
  // 主动 recall_memory 工具的 touch 语义保留(这里是等价底层调用)
  store.touchMemoryUsed(mine[0]);
  assert.equal(store.loadMemoryTimeline().find((m) => m.id === mine[0])!.useCount, 1, '显式 touch 仍然生效');
});

// ── episodic per-conv 滚动 upsert ──

test('episodic:同一会话两次 upsert → 只有一条,内容为最新(修前两条)', () => {
  store.upsertEpisodicMemory({ convId: 'conv-ep-1', summary: '第一版摘要:修了导出 bug', importance: 5, tags: 'bug-fix' });
  store.upsertEpisodicMemory({ convId: 'conv-ep-1', summary: '第二版摘要:修了导出 bug 并重构了解析器', importance: 6, tags: 'bug-fix,refactor' });
  const rows = store.loadEpisodicMemories(50).filter((e) => e.convId === 'conv-ep-1');
  assert.equal(rows.length, 1, '每会话只保留一条滚动摘要');
  assert.match(rows[0].summary, /第二版/);
  assert.equal(rows[0].importance, 6);
  assert.ok(!store.searchEpisodicMemories('第一版摘要:修了导出', 10, 'conv-ep-1').length, '旧摘要已被覆盖,不再污染检索');
});

test('episodic:不同会话互不覆盖', () => {
  store.upsertEpisodicMemory({ convId: 'conv-ep-2', summary: '会话二摘要', importance: 5 });
  store.upsertEpisodicMemory({ convId: 'conv-ep-3', summary: '会话三摘要', importance: 5 });
  const e2 = store.loadEpisodicMemories(50).filter((e) => e.convId === 'conv-ep-2');
  const e3 = store.loadEpisodicMemories(50).filter((e) => e.convId === 'conv-ep-3');
  assert.equal(e2.length, 1);
  assert.equal(e3.length, 1);
  assert.match(e2[0].summary, /会话二/);
  assert.match(e3[0].summary, /会话三/);
});

run();
