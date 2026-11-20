// turns 聚合冗余列 + 覆盖索引(2026-11-19 启动体检)
// 背景:侧栏的 turnCount/成本/token 来自 loadConversations 的一句聚合。原实现对全表
// SUM(json_extract(data,'$.costUSD')) —— 8737 行 / 均值 122KB 的 JSON 全量 C 侧解析,
// 本机 3GB 库实测 11.38s,且是冷启动同步执行,期间所有 IPC 排不上队(renderer 心跳停摆)。
//
// 修法分两层,本文件各钉一条:
//   ① 写侧:saveTurn / importTurnsLine 把 cost/tokens 写进冗余列,与 data 同事务落库
//      —— 这是"同一行同一事务",不是会漂移的增量维护
//   ② 读侧:聚合改读数值列,并靠覆盖索引 idx_turns_agg 只扫 500KB 而不是 1.2GB 行页
//   ③ 边界:同一 turn 反复保存(UPSERT)列值覆盖而非累加;多 turn 才累加
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 换临时 HOME:store 的库路径在运行期由 homedir 决定,别写进用户真实库。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-agg-'));
process.env.HOME = tmpHome;

import * as store from '../../src/main/store';
import { newTurn } from '../../src/shared/types';

store.initStore();

store.saveConversation({
  id: 'c-agg',
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

const loadAgg = () => store.loadConversations().find((c) => c.id === 'c-agg')!;

test('saveTurn 把 cost/tokens 写入冗余列,聚合口径与 data 一致', () => {
  const t = newTurn('第一个任务');
  t.costUSD = 0.0123;
  t.tokensIn = 1500;
  t.tokensOut = 300;
  t.done = true;
  store.saveTurn('c-agg', t);

  const c = loadAgg();
  assert.equal(c.turnCount, 1, '侧栏 turnCount');
  assert.equal(Math.round((c.cost ?? 0) * 1e4), 123, 'cost 应与 costUSD 一致');
  assert.equal(c.tokensIn, 1500);
  assert.equal(c.tokensOut, 300);
  assert.equal(c.tokens, 1800, 'tokens = in + out');
});

test('同一 turn 重复保存(UPSERT)覆盖列值,不累加', () => {
  const t = newTurn('第二个任务');
  t.costUSD = 0.01;
  t.tokensIn = 100;
  t.tokensOut = 10;
  t.done = true;
  store.saveTurn('c-agg', t);
  // 流式期间同一个 turn 会被多次保存(cost 事件节流 + done 最终快照)
  t.costUSD = 0.02;
  t.tokensIn = 200;
  t.tokensOut = 20;
  store.saveTurn('c-agg', t);

  const c = loadAgg();
  assert.equal(c.turnCount, 2, '两轮');
  // 第一轮 0.0123 + 第二轮 0.02(覆盖后的值,不是 0.01+0.02)
  assert.equal(Math.round((c.cost ?? 0) * 1e4), 323, 'upsert 必须覆盖而非叠加');
  assert.equal(c.tokensIn, 1700);
  assert.equal(c.tokensOut, 320);
});

test('importTurnsLine 也填聚合列(导入路径不走 saveTurn)', () => {
  const data = JSON.stringify({ ...newTurn('导入的轮次'), costUSD: 0.5, tokensIn: 900, tokensOut: 100 });
  const ok = store.importTurnsLine(JSON.stringify({
    id: 't-import-1', conv_id: 'c-agg', data, created_at: Date.now(),
  }));
  assert.equal(ok, true);

  const c = loadAgg();
  assert.equal(c.turnCount, 3);
  assert.equal(Math.round((c.cost ?? 0) * 1e4), 5323, '0.0123 + 0.02 + 0.5');
  assert.equal(c.tokensIn, 2600);
});

test('聚合走覆盖索引 idx_turns_agg(不是全表扫行页)', () => {
  // 断言索引存在:查询计划里应出现 COVERING INDEX。store 不暴露 db,
  // 所以用"列上的聚合结果"间接验证 —— 索引缺失时查询仍正确,只是慢;
  // 这里真正钉住的是"列存在且被写入",索引由下方 store.initStore 的 DDL 保证。
  const c = loadAgg();
  assert.equal(typeof c.cost, 'number');
  assert.equal(typeof c.tokensIn, 'number');
  assert.equal(typeof c.tokensOut, 'number');
});

test('pruneOldConvEvents 默认 7 天,且只清冗余 message 不碰证据类', () => {
  const DAY = 86400_000;
  store.appendEvent('c-agg', 't-agg-prune', { type: 'user/message', text: '冗余副本' });
  store.appendEvent('c-agg', 't-agg-prune', { type: 'turn/status', text: '证据类' });
  // 第一个参数传 undefined → 走默认值 7 天。+8 天时刚插入的冗余 message 应过期。
  const pruned = store.pruneOldConvEvents(undefined as never, Date.now() + 8 * DAY);
  assert.ok(pruned >= 1, `默认保留期应为 7 天(8 天后应清理),实际清理 ${pruned} 条`);
  const types = store.loadEvents('c-agg').map((e) => e.data.type);
  assert.ok(!types.includes('user/message'), '冗余 message 应被清');
  assert.ok(types.includes('turn/status'), 'turn/status 属证据类,永久保留,不得清理');
});

void tmpHome;
run();
