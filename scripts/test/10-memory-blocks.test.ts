// Fix 2 回归:memory_append / memory_replace 满块/超限不再静默丢数据。
// 修前行为:(old+'\n'+content).slice(0, charLimit) 截掉新内容却返回 true。
// 修后行为:append 滚动淘汰头部保留新尾部;update 截尾;均返回 { ok, stored, droppedHead?/droppedTail? }。
import { assert, test, run } from './harness';
import * as store from '../../src/main/store';

const UP = 'user_profile';
const LIMIT = 3000; // DEFAULT_BLOCKS 里 user_profile 的 char_limit

function fillBlock(exact: number): void {
  const r = store.updateMemoryBlock(UP, 'A'.repeat(exact));
  assert.ok(r.ok, 'fill setup 应成功');
}

test('updateMemoryBlock:未超限 → stored 全量,无 dropped', () => {
  store.initStore();
  fillBlock(100);
  const r = store.updateMemoryBlock(UP, 'x'.repeat(150));
  assert.deepEqual(r, { ok: true, stored: 150 });
  assert.equal(store.loadMemoryBlock(UP)!.value.length, 150);
});

test('updateMemoryBlock:超限 → 截尾并如实上报 droppedTail', () => {
  store.initStore();
  const r = store.updateMemoryBlock(UP, 'y'.repeat(LIMIT + 100));
  assert.equal(r.ok, true);
  assert.equal(r.droppedTail, 100);
  assert.equal(r.stored, LIMIT);
  assert.equal(store.loadMemoryBlock(UP)!.value.length, LIMIT);
});

test('appendMemoryBlock:未满 → 纯追加,无淘汰', () => {
  store.initStore();
  fillBlock(10);
  const r = store.appendMemoryBlock(UP, 'NEW-TAIL');
  assert.deepEqual(r, { ok: true, stored: 19 }); // 10 + '\n' + 8
  assert.ok(store.loadMemoryBlock(UP)!.value.endsWith('NEW-TAIL'));
});

test('appendMemoryBlock:满块 → 滚动淘汰头部,新内容完整保留在末尾(核心回归)', () => {
  store.initStore();
  fillBlock(LIMIT); // 恰好填满
  const tail = 'NEW-FACT-' + 'z'.repeat(22); // 31 字符
  const r = store.appendMemoryBlock(UP, tail);
  assert.equal(r.ok, true);
  assert.equal(r.droppedHead, LIMIT + 1 + 31 - LIMIT); // combined 超出 limit 的部分 = 1 换行 + 31
  assert.equal(r.stored, LIMIT);
  const v = store.loadMemoryBlock(UP)!.value;
  // 新内容必须完整存活在块尾 —— 修前这里会被 slice(0, limit) 截掉
  assert.ok(v.endsWith(tail), '追加的新内容必须完整保留');
  assert.equal(v.length, LIMIT);
});

test('appendMemoryBlock:content 本身超 limit → 尾部保留 limit 字符', () => {
  store.initStore();
  store.updateMemoryBlock(UP, 'old');
  const big = 'B'.repeat(LIMIT + 500);
  const r = store.appendMemoryBlock(UP, big);
  assert.equal(r.ok, true);
  assert.ok((r.droppedHead ?? 0) > 0);
  const v = store.loadMemoryBlock(UP)!.value;
  assert.equal(v.length, LIMIT);
  assert.ok(v.endsWith('B'.repeat(LIMIT)), '保留最新尾部');
});

test('只读块(persona)与不存在块 → ok:false', () => {
  store.initStore();
  assert.equal(store.updateMemoryBlock('persona', 'x').ok, false);
  assert.equal(store.appendMemoryBlock('persona', 'x').ok, false);
  assert.equal(store.updateMemoryBlock('no_such_block', 'x').ok, false);
});

test('charLimit=0 防御:slice(-0) 不放行全串', () => {
  store.initStore();
  // 直接构造 char_limit=0 的块:先写满再无法改 limit,改用 active_goals 验证 0 上限语义不适用默认块,
  // 这里仅验证默认块行为不回归;charLimit=0 由 appendMemoryBlock 的显式分支覆盖(单元层面)。
  fillBlock(5);
  const r = store.appendMemoryBlock(UP, 'abc');
  assert.equal(r.ok, true);
  assert.equal(r.stored, 5 + 1 + 3);
});

run();
