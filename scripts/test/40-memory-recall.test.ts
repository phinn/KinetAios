// Fix 1 回归:会话限制模式(默认)的记忆注入走完整检索链,不再是"查询盲的最旧 15 条"。
import { assert, test, run } from './harness';
import { recallMemories, buildRecallQuery, type EmbedFn } from '../../src/main/memory-recall';
import * as store from '../../src/main/store';

store.initStore();

const CONV1 = 'conv-fix1-a';
const CONV2 = 'conv-fix1-b';

function addWithVec(content: string, convId: string | null, vec: number[], importance = 5): string {
  const id = store.addMemory(content, convId ?? undefined, importance);
  store.setMemoryEmbedding(id, vec, 'test-model');
  return id;
}

// query 'tailwind 样式' → [1,0];其余 → [0,1]。embedding 故意可注入(生产传 glm.embed)。
const embedOk: EmbedFn = async (texts) => texts.map((t) => (t.includes('tailwind') ? [1, 0] : [0, 1]));
const embedFail: EmbedFn = async () => { throw new Error('embed endpoint down'); };

// 种子:15 条旧垃圾记忆先行插入(修前 listMemoryEmbeddings(conv).slice(0,15) 恰好返回它们)。
const junkIds = Array.from({ length: 15 }, (_, i) => addWithVec(`垃圾记忆第${i}条`, CONV1, [0, 1]));
// A 给 importance 6(其余默认 5):A 与 D/G 的 cosine 同为 1.0 时,加权排序仍严格确定 A 第一,
// 不受插入时间(reckency)微差影响。
const idA = addWithVec('Tailwind 偏好', CONV1, [1, 0], 6);
const idB = addWithVec('无关甲', CONV1, [0.6, 0.8]);
const idC = addWithVec('无关乙', CONV1, [0.8, 0.6]);
const idD = addWithVec('其他项目记忆', CONV2, [1, 0]);
const idG = addWithVec('全局记忆', null, [1, 0]);

test('核心回归:restrict 模式按 cosine 召回,高相关记忆第一(修前是最旧 15 条垃圾)', async () => {
  const out = await recallMemories({ query: 'tailwind 样式', limit: 15, restrictConvId: CONV1, embed: embedOk });
  assert.ok(out.length > 0);
  assert.equal(out[0].id, idA, 'cosine=1.0 的 Tailwind 记忆必须排第一(且 junk cos=0 被过滤)');
  assert.ok(out.some((r) => r.id === idG), '无归属全局记忆参与召回');
  assert.ok(!out.some((r) => r.id === idD), '其它会话的记忆不得出现(restrict)');
  assert.ok(out.every((r) => r.score > 0.2), 'embedding 路径 score 全部为有效 cosine');
});

test('restrict 模式绝不漏跨会话记忆(全域扫描断言)', async () => {
  const out = await recallMemories({ query: 'tailwind 样式', limit: 15, restrictConvId: CONV1, embed: embedOk });
  for (const r of out) {
    assert.notEqual(r.id, idD);
    assert.ok(r.conversationId === null || r.conversationId === CONV1, '只允许本会话或全局归属');
  }
});

test('embedding 挂掉 → FTS/LIKE 兜底(≥2 条命中)', async () => {
  store.addMemory('关键词xyz 独有一号', CONV1);
  store.addMemory('关键词xyz 独有二号', CONV1);
  const out = await recallMemories({ query: '关键词xyz', limit: 15, restrictConvId: CONV1, embed: embedFail });
  const texts = out.map((r) => r.content);
  assert.ok(texts.includes('关键词xyz 独有一号'), 'LIKE 兜底命中一号');
  assert.ok(texts.includes('关键词xyz 独有二号'), 'LIKE 兜底命中二号');
});

test('空 query / 全无命中 → recent-N 兜底且遵守 restrict', async () => {
  const out = await recallMemories({ query: '', limit: 15, restrictConvId: CONV1, embed: embedOk });
  assert.ok(out.length >= 1);
  assert.ok(!out.some((r) => r.id === idD), 'recent-N 也不得混入其它会话记忆');
  assert.ok(out.every((r) => r.conversationId === null || r.conversationId === CONV1));
});

test('scoredMemories restrict:其它会话的高 importance 记忆不得挤入', () => {
  store.addMemory('高重要性其它项目事实', CONV2, 10);
  const restricted = store.scoredMemories('随便什么查询', 50, undefined, CONV1);
  assert.ok(!restricted.some((m) => m.conversation_id === CONV2), 'restrict 下其它会话不得出现');
  const global = store.scoredMemories('随便什么查询', 50, undefined);
  assert.ok(global.some((m) => m.conversation_id === CONV2), '全局模式下应出现');
});

test('全局模式(restrict 未传)与修前行为一致:高相关排前', async () => {
  const out = await recallMemories({ query: 'tailwind 样式', limit: 15, embed: embedOk });
  const idxA = out.findIndex((r) => r.id === idA);
  const idxD = out.findIndex((r) => r.id === idD);
  const idxG = out.findIndex((r) => r.id === idG);
  assert.ok(idxA >= 0, '全局模式应召回 A');
  assert.ok(idxD >= 0, '全局模式包含其它会话记忆(D)');
  // A1 修复后:重排只在召回候选集内 —— importance=10 但 relevance=0 的池外记忆不再可能挤榜
  assert.equal(out[0].id, idA, 'A(cosine 1.0 + importance 6)必须排第一');
  assert.ok(idxA < idxD, 'A 应排在同 relevance 的 D 之前(importance 加权)');
  assert.ok(idxA < idxG, 'A 应排在同 relevance 的 G 之前(importance 加权)');
  const idxJunk = out.findIndex((r) => junkIds.includes(r.id));
  assert.ok(idxJunk < 0 || idxA < idxJunk, 'A 排在垃圾记忆之前');
});

// 收尾:断言 junk 没有被完全依赖(即便 junk 全部在场,高相关仍胜出 —— 排序按 relevance 而非插入序)
test('junk 在场时按 relevance 排序,而非插入顺序', async () => {
  const out = await recallMemories({ query: 'tailwind 样式', limit: 15, restrictConvId: CONV1, embed: embedOk });
  const idxA = out.findIndex((r) => r.id === idA);
  const idxJunk = out.findIndex((r) => junkIds.includes(r.id));
  assert.ok(idxA >= 0);
  assert.ok(idxJunk < 0 || idxA < idxJunk, '高相关记忆必须排在垃圾记忆之前');
});

run();

// ── A3: buildRecallQuery(修前 3 条拼接 500 字符,多主题互相稀释)──

test('buildRecallQuery:以最新消息为主,不拼接历史', () => {
  const q = buildRecallQuery(['帮我分析一下这个项目的架构设计', '顺便看看依赖版本', '看看 context gauge 的实现有没有问题']);
  assert.equal(q, '看看 context gauge 的实现有没有问题');
});

test('buildRecallQuery:最新消息过短 → 并入上一条补语境', () => {
  const q = buildRecallQuery(['帮我分析一下这个项目的架构设计,给出三个改进方向', '继续']);
  assert.ok(q.includes('架构设计'), '应包含上一条语境');
  assert.ok(q.includes('继续'), '应包含最新消息');
});

test('buildRecallQuery:空输入 → 空串(recent-N 兜底接管)', () => {
  assert.equal(buildRecallQuery([]), '');
  assert.equal(buildRecallQuery(['', '   ']), '');
});
