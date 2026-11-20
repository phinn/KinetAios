// 事件读取改造(2026-11-20):分页 + 按轮查询 + 首轮 prompt 冗余列
//
// 背景:补库后事件从 41 万涨到 90 万,最大会话 68,490 条 / 39.7MB,而 UI 里有两处是
// "把整个会话的事件搬过 IPC 再在渲染层 filter"——
//   · 事件流面板:全量拉 + rows.map 建 DOM → 6.8 万个节点
//   · Token 明细浮层:为了显示 3~5 行 cost,把 40MB 搬过去
// 同时 loadConversations 对 394 个会话逐个 json_extract 取首条 prompt(364ms/394 次)。
//
// 本文件钉住四条改动的语义:
//   ① loadEventsTail / loadEventsBefore 的边界与顺序(升序,页与页不重不漏)
//   ② loadTurnEvents 只回该轮,不夹带别的轮
//   ③ first_prompt 冗余列与 turns 首轮一致,且不随第二轮变化
//   ④ loadTurns 的"无洞不重建"不能改变最终结果(缓存完好的会话轮次/内容不变)
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-paging-'));
process.env.HOME = tmpHome;

import * as store from '../../src/main/store';
import { newTurn } from '../../src/shared/types';

store.initStore();

const baseConv = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    engine: 'direct',
    model: '',
    cwd: '/tmp',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    customTitle: null,
    directHistory: [],
    engineSessionId: null,
    turns: [],
    turnsLoaded: false,
    status: 'ready',
    statusNote: null,
    cost: 0,
    tokens: 0,
    tokensIn: 0,
    tokensOut: 0,
    ...extra,
  }) as never;

const CONV = 'c-page';
store.saveConversation(baseConv(CONV));

// 60 条事件:前 30 条属于 t1,后 30 条属于 t2。
// 混入 turn/meta 与 tool/call 两种类型,后者是 Token 浮层要的。
for (let i = 0; i < 60; i++) {
  const turnId = i < 30 ? 't1' : 't2';
  if (i % 3 === 0) {
    store.appendEvent(CONV, turnId, { type: 'turn/meta', costUSD: 0.001, tokensIn: i, tokensOut: 1 });
  } else {
    store.appendEvent(CONV, turnId, { type: 'tool/call', name: 'shell', args: `{"i":${i}}`, result: 'ok' });
  }
}

test('countEvents 返回该会话全部事件数', () => {
  assert.equal(store.countEvents(CONV), 60);
  assert.equal(store.countEvents('不存在的会话'), 0);
});

test('loadEventsTail 取尾部 N 条且升序', () => {
  const tail = store.loadEventsTail(CONV, 10);
  assert.equal(tail.length, 10, '应返回 10 条');
  for (let i = 1; i < tail.length; i++) {
    assert(tail[i].seq > tail[i - 1].seq, `tail 必须按 seq 升序,index ${i}`);
  }
  // 最后一条应是最后写入的那条
  const all = store.loadEvents(CONV);
  assert.equal(tail[tail.length - 1].seq, all[all.length - 1].seq, '尾部最后一条应与全量最后一条相同');
});

test('loadEventsBefore 向前翻页,与上一页首尾相接且不重复', () => {
  const page1 = store.loadEventsTail(CONV, 10);
  const page2 = store.loadEventsBefore(CONV, page1[0].seq, 10);
  assert.equal(page2.length, 10, '第二页应满 10 条');
  assert(page2[page2.length - 1].seq < page1[0].seq, '第二页必须严格早于第一页首条');
  // 拼接后 20 条、无重复、仍升序
  const joined = [...page2, ...page1];
  assert.equal(new Set(joined.map((e) => e.seq)).size, 20, '两页拼接不应有重复');
  for (let i = 1; i < joined.length; i++) assert(joined[i].seq > joined[i - 1].seq, '拼接后仍应升序');
});

test('翻页到顶时返回空数组而不是报错或循环', () => {
  const all = store.loadEvents(CONV);
  const before = store.loadEventsBefore(CONV, all[0].seq, 10);
  assert.deepEqual(before, [], '最早一条之前应无内容');
});

test('loadTurnEvents 只回目标轮,且只含 turn/meta 与 tool/call', () => {
  const rows = store.loadTurnEvents(CONV, 't1');
  assert(rows.length === 30, `t1 应有 30 条,实际 ${rows.length}`);
  assert(rows.every((r) => r.turnId === 't1'), '不得夹带其它轮的事件');
  assert(rows.every((r) => r.type === 'turn/meta' || r.type === 'tool/call'), '只应回浮层需要的两类');
  const t2 = store.loadTurnEvents(CONV, 't2');
  assert.equal(t2.length, 30, 't2 同样 30 条');
  // 两轮互不重叠
  const s1 = new Set(rows.map((r) => r.seq));
  assert(t2.every((r) => !s1.has(r.seq)), '两轮事件不应重叠');
});

test('first_prompt 冗余列:取首轮 prompt,不随后续轮变化', () => {
  const c = 'c-first';
  store.saveConversation(baseConv(c));
  const t1 = newTurn('第一个任务:修登录闪退');
  t1.done = true;
  store.saveTurn(c, t1);
  assert.equal(store.loadConversations().find((x) => x.id === c)?.firstPrompt, '第一个任务:修登录闪退');

  const t2 = newTurn('第二个任务:改配色');
  t2.done = true;
  store.saveTurn(c, t2);
  assert.equal(
    store.loadConversations().find((x) => x.id === c)?.firstPrompt,
    '第一个任务:修登录闪退',
    '首轮 prompt 应保持第一次写入的值',
  );
});

test('first_prompt 截断到 500 字符,不把整段长 prompt 塞进会话表', () => {
  const c = 'c-long';
  store.saveConversation(baseConv(c));
  const t = newTurn('长'.repeat(1200));
  t.done = true;
  store.saveTurn(c, t);
  const fp = store.loadConversations().find((x) => x.id === c)?.firstPrompt ?? '';
  assert.equal(fp.length, 500, `应截断到 500,实际 ${fp.length}`);
});

test('无洞的会话:loadTurns 走快路径后结果与事件流一致', () => {
  // 三轮都正常写进 turns 表,事件流里也有对应 turn → 不重建也必须是完整三轮。
  const c = 'c-nohole';
  store.saveConversation(baseConv(c));
  for (const p of ['第一轮', '第二轮', '第三轮']) {
    const t = newTurn(p);
    t.done = true;
    store.saveTurn(c, t);
    store.appendEvent(c, t.id, { type: 'user/message', text: p });
    store.appendEvent(c, t.id, { type: 'assistant/message', text: `${p}的答复` });
  }
  const conv = store.loadConversationsFull().find((x) => x.id === c)!;
  assert.equal(conv.turns.length, 3, '三轮都要在');
  assert.deepEqual(
    conv.turns.map((t) => t.prompt),
    ['第一轮', '第二轮', '第三轮'],
    '顺序与内容都不能变',
  );
});

test('有洞的会话:缓存缺轮时仍由事件流补回(快路径不能吞掉自愈)', () => {
  // 只写事件流、不写 turns → 缓存为空,必须靠 rebuild 补出来。
  const c = 'c-hole';
  store.saveConversation(baseConv(c));
  store.appendEvent(c, 'h1', { type: 'user/message', text: '只有事件的轮' });
  store.appendEvent(c, 'h1', { type: 'assistant/message', text: '从事件流恢复的答复' });
  const conv = store.loadConversationsFull().find((x) => x.id === c)!;
  assert.equal(conv.turns.length, 1, `事件流里的轮应被补回,实际 ${conv.turns.length}`);
  assert.equal(conv.turns[0].prompt, '只有事件的轮');
  assert.equal(conv.turns[0].answer, '从事件流恢复的答复');
});

run();
