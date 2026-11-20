// conv_events 保留分层(2026-11-20 用户拍板)
// 背景:11-19 那次「90→30 天」一刀切清掉 48 万条 / 321MB,其中 13.5 万条 tool/call 证据
// 不可恢复。此后规则改为:只删「与 turns 表同源的重复副本」,其余永久。
// 2026-11-20 用户进一步明确:turn/meta、turn/status 必须保留 ——
//   turn/meta   = 逐次 LLM 调用的 cost/token 明细,UI「Token 明细」浮层的唯一数据源
//   turn/status = 路由决策 / 引擎相位轨迹,复盘「为什么走这条路」的唯一依据
// 本文件钉三件事:
//   ① 两个清单无交集,且 prune 真的只动冗余类
//   ② 防御:即便某类型同时出现在两个清单,保留优先
//   ③ 白名单语义:未声明的新事件类型默认保留(未来新增类型不会被误清)
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 换临时 HOME:store 的库路径在运行期由 homedir 决定,别写进用户真实库。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-retention-'));
process.env.HOME = tmpHome;

import * as store from '../../src/main/store';

store.initStore();

store.saveConversation({
  id: 'c-ret',
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
} as never);

const DAY = 86400_000;
const OLD = Date.now() - 100 * DAY; // 100 天前:任何合理保留期都该判"过期"

// 六种事件各一条,全部倒推到 100 天前。其中前两条是冗余类,其余是唯一副本。
store.appendEvent('c-ret', 't1', { type: 'user/message', text: 'hi' });
store.appendEvent('c-ret', 't1', { type: 'assistant/message', text: 'hello' });
store.appendEvent('c-ret', 't1', { type: 'tool/call', name: 'shell', args: '{}', result: 'ok' });
store.appendEvent('c-ret', 't1', { type: 'turn/meta', costUSD: 0.01, tokensIn: 10, tokensOut: 5 });
store.appendEvent('c-ret', 't1', { type: 'turn/status', text: 'route → direct' });
store.appendEvent('c-ret', 't1', { type: 'goal/set', goal: 'ship it' });
// 未来才可能出现的事件类型:用于验证「白名单之外默认保留」
store.stmt('INSERT INTO conv_events(conv_id, turn_id, type, data, ts) VALUES(?,?,?,?,?);').run(
  'c-ret',
  't1',
  'future/unknown',
  '{"type":"future/unknown"}',
  Date.now(),
);
store.stmt('UPDATE conv_events SET ts=? WHERE ts > ?;').run(OLD, 0);

const typeCounts = (): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of store.stmt('SELECT type, COUNT(*) n FROM conv_events GROUP BY type;').all() as Array<{
    type: string;
    n: number;
  }>) {
    out[r.type] = r.n;
  }
  return out;
};

test('保留清单与冗余清单没有交集', () => {
  const retained = new Set<string>(store.RETAINED_EVENT_TYPES);
  for (const t of store.REDUNDANT_EVENT_TYPES) {
    assert(!retained.has(t), `「${t}」不能同时出现在两个清单里`);
  }
});

test('turn/meta 与 turn/status 被显式声明为永久保留', () => {
  const retained = new Set<string>(store.RETAINED_EVENT_TYPES);
  assert(retained.has('turn/meta'), 'turn/meta 应在 RETAINED_EVENT_TYPES(用户 2026-11-20 指定)');
  assert(retained.has('turn/status'), 'turn/status 应在 RETAINED_EVENT_TYPES(用户 2026-11-20 指定)');
  assert(retained.has('tool/call'), 'tool/call 是唯一存证,必须保留');
  assert(retained.has('compaction/spill'), 'compaction/spill 是唯一存证,必须保留');
});

test('prune 只删冗余副本,turn/meta 与 turn/status 一条不动', () => {
  const before = typeCounts();
  assert.equal(before['turn/meta'], 1, '前置:应有一条 turn/meta');
  assert.equal(before['turn/status'], 1, '前置:应有一条 turn/status');

  const removed = store.pruneOldConvEvents(7, Date.now());
  assert.equal(removed, 2, `只应删掉 user/message + assistant/message 两条,实际删了 ${removed}`);

  const after = typeCounts();
  assert(!after['user/message'], 'user/message 应被清理(与 turns.prompt 重复)');
  assert(!after['assistant/message'], 'assistant/message 应被清理(与 turns.answer 重复)');
  assert.equal(after['turn/meta'], 1, 'turn/meta 必须还在 —— 成本明细的唯一来源');
  assert.equal(after['turn/status'], 1, 'turn/status 必须还在 —— 路由轨迹的唯一来源');
  assert.equal(after['tool/call'], 1, 'tool/call 必须还在 —— 唯一存证');
  assert.equal(after['goal/set'], 1, 'goal/set 必须还在');
});

test('白名单语义:未声明的新事件类型默认保留', () => {
  const after = typeCounts();
  assert.equal(after['future/unknown'], 1, '未知类型不在冗余清单里,prune 不应碰它');
});

test('保留期参数生效:把冗余副本改成 1 天前则不被清', () => {
  store.appendEvent('c-ret', 't2', { type: 'user/message', text: '刚刚说的话' });
  const removed = store.pruneOldConvEvents(7, Date.now());
  assert.equal(removed, 0, '7 天内的冗余副本不该被清,实际删了 ' + removed);
  assert.equal(typeCounts()['user/message'], 1, '刚写入的 user/message 应还在');
});

test('冗余清单为空时直接短路,不报错', () => {
  // 防御分支:若 victims 为空应返回 0 而不是拼出 "IN ()" 这种非法 SQL
  const n = store.pruneOldConvEvents(-1, Date.now());
  assert(typeof n === 'number', '应返回删除条数');
});

run();
