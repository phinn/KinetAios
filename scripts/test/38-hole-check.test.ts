// 缺口判断只认「有内容的轮」(2026-11-23)
//
// 由来(实测):补库把 9-04 以来的事件全部补回后,有 42 个"轮"只存在于事件流里 ——
// 33 个只有 turn/error、6 个只有 turn/status、3 个只有 tool/call,散在 24 个会话里。
// 它们的 turn_id 在 turns 表里从来没有过(那一轮在早期就报错/未落库),但
// loadTurns 的缺口判断用的是 `COUNT(DISTINCT turn_id)`,于是这 24 个会话永远"有洞":
//
//   · 每次打开都全量重放事件(最贵的一个 27,145 条,100ms+),重建结果里只有
//     这几轮是新东西,其余全被 merged 丢弃 —— 等于白干
//   · 多出来的轮 prompt 为空,UI 里就是一张没有提问内容的报错卡,连「重试」
//     按钮都被 `!t.prompt.trim()` 挡掉,点不动
//
// 判定改为只数 user/message・assistant/message・tool/call・turn/meta 这四类事件;
// 事件本身仍永久保留在 conv_events,复盘随时可查。
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-hole-'));
process.env.HOME = tmpHome;

import * as store from '../../src/main/store';
import { newTurn } from '../../src/shared/types';

store.initStore();

const baseConv = (id: string) =>
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
  }) as never;

test('只有 turn/error 的事件轮不再被算成缺口(不凭空多出一轮)', () => {
  const c = 'c-err-only';
  store.saveConversation(baseConv(c));
  const t = newTurn('正常的一轮');
  t.done = true;
  t.answer = '答复';
  store.saveTurn(c, t);
  store.appendEvent(c, t.id, { type: 'user/message', text: '正常的一轮' });
  store.appendEvent(c, t.id, { type: 'assistant/message', text: '答复' });
  // 一个只报错、从未落 turns 表的轮
  store.appendEvent(c, 'dead-turn', { type: 'turn/error', message: 'HTTP 429 限额' } as never);
  store.appendEvent(c, 'dead-turn', { type: 'turn/status', text: '路由:direct' } as never);

  const conv = store.loadConversationsFull().find((x) => x.id === c)!;
  assert.equal(conv.turns.length, 1, `只应有缓存那一轮,实际 ${conv.turns.length}`);
  assert.equal(conv.turns[0].prompt, '正常的一轮');
  assert(!conv.turns.some((x) => x.id === 'dead-turn'), '纯报错轮不应被重建进来');
});

test('只有 tool/call 的事件轮同样不算缺口', () => {
  const c = 'c-tool-only';
  store.saveConversation(baseConv(c));
  const t = newTurn('有内容的一轮');
  t.done = true;
  t.answer = 'ok';
  store.saveTurn(c, t);
  store.appendEvent(c, t.id, { type: 'user/message', text: '有内容的一轮' });
  store.appendEvent(c, t.id, { type: 'assistant/message', text: 'ok' });
  store.appendEvent(c, 'orphan-tools', { type: 'tool/call', name: 'shell', args: '{}', result: 'x' });
  const conv = store.loadConversationsFull().find((x) => x.id === c)!;
  assert.equal(conv.turns.length, 1, `只有 tool/call 的轮不该算轮,实际 ${conv.turns.length}`);
});

test('不回归:缓存里缺的有内容轮仍由事件流补回', () => {
  const c = 'c-real-hole';
  store.saveConversation(baseConv(c));
  store.appendEvent(c, 'h1', { type: 'user/message', text: '只有事件的轮' });
  store.appendEvent(c, 'h1', { type: 'assistant/message', text: '从事件流恢复的答复' });
  const conv = store.loadConversationsFull().find((x) => x.id === c)!;
  assert.equal(conv.turns.length, 1, `真缺轮必须补回,实际 ${conv.turns.length}`);
  assert.equal(conv.turns[0].prompt, '只有事件的轮');
});

test('不回归:缓存里的纯报错轮(prompt 为空)必须保留', () => {
  // 这类轮是启动即失败、没来得及写 user/message 的,只活在 turns 表的 data 里。
  const c = 'c-cached-error';
  store.saveConversation(baseConv(c));
  const t = newTurn('');
  t.error = '金钥无效';
  t.errorKind = 'auth';
  t.done = true;
  store.saveTurn(c, t);
  store.appendEvent(c, t.id, { type: 'turn/error', message: '金钥无效' } as never);

  const conv = store.loadConversationsFull().find((x) => x.id === c)!;
  assert.equal(conv.turns.length, 1, `缓存里的报错轮不能消失,实际 ${conv.turns.length}`);
  assert.equal(conv.turns[0].error, '金钥无效');
});

run();
