// 历史 turn_feedback 回填(2026-11-19)
// 由来:turn_feedback 是技能淘汰/基因选择的唯一真信号,但 11-18 才接上通道 —— 8766 轮里只
// 有 5 条反馈,淘汰只能退化成"14 天 0 加载"这种时间弱信号。数据其实都在:prompt 序列能读出
// "带着不满回来"和"重问一遍",turns.data 里有 error/done。
//
// 钉住四条:① 各类标签的判定口径;② 跨会话不串(按 conv 分组、按 ts 排序);
// ③ 落账用原轮次时间戳(否则几千条历史全堆在"今天",把近7天统计冲垮);
// ④ 完成标记存在 app_meta,重复启动不重跑。
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-backfill-'));
process.env.HOME = tmpHome;

import * as store from '../../src/main/store';
import { newTurn } from '../../src/shared/types';
import { labelTurns, tagsForTurn, startTurnFeedbackBackfill } from '../../src/main/turn-backfill';

store.initStore();

const conv = {
  id: 'c-bf', engine: 'direct', model: '', cwd: '/tmp',
  createdAt: Date.now(), updatedAt: Date.now(), customTitle: null,
  directHistory: [], engineSessionId: null, turns: [], turnsLoaded: false,
  status: 'ready' as const, statusNote: null, cost: 0, tokens: 0,
};
store.saveConversation(conv as never);

function mkTurn(prompt: string, over: Partial<ReturnType<typeof newTurn>> = {}): ReturnType<typeof newTurn> {
  const t = newTurn(prompt);
  t.done = true;
  t.answer = 'ok';
  return Object.assign(t, over);
}

const t1 = mkTurn('帮我抓一下 App Store Connect 的截图,压缩到 200KB 以内', { ts: 1_700_000_000_000 });
const t2 = mkTurn('还是不行,图还是 400KB', { ts: 1_700_000_100_000 });
const t3 = mkTurn('把 config.json 里的 timeout 改成 30', { ts: 1_700_000_200_000, done: false, answer: '' });
const t4 = mkTurn('跑一下全量测试', { ts: 1_700_000_300_000, error: 'engine crashed' });
for (const t of [t1, t2, t3, t4]) store.saveTurn('c-bf', t);

test('tagsForTurn:纠正话术 / error / 未完成且有下一轮', () => {
  assert(tagsForTurn({ id: 'a', ts: 0, prompt: 'p', error: null, done: true }, { prompt: '还是不行' }).includes('correction'), '应识别纠正');
  assert(tagsForTurn({ id: 'a', ts: 0, prompt: 'p', error: 'x', done: true }, undefined).includes('error'), '应识别 error');
  assert(tagsForTurn({ id: 'a', ts: 0, prompt: 'p', error: null, done: false }, { prompt: '下一件事' }).includes('aborted'), '未完成且有下一轮应判 aborted');
  // 最后一条未完成 = 可能还在跑,不能算中止(冤案)
  assert(tagsForTurn({ id: 'a', ts: 0, prompt: 'p', error: null, done: false }, undefined).length === 0, '末轮未完成不该判 aborted');
});

test('labelTurns:按会话分组、按 ts 排序(输入乱序也不串)', () => {
  const out = labelTurns([
    { id: 'b2', convId: 'c2', ts: 200, prompt: 'X 方案不行,还是报错', error: null, done: true },
    { id: 'a1', convId: 'c1', ts: 100, prompt: '抓一下截图', error: null, done: true },
    { id: 'a2', convId: 'c1', ts: 200, prompt: '还是不行,图还是 400KB', error: null, done: true },
  ]);
  const a1 = out.find((x) => x.id === 'a1');
  assert(a1?.tags.includes('correction'), `a1 应被判纠正,实际 ${JSON.stringify(a1)}`);
  assert(!out.some((x) => x.id === 'b2'), 'b2 是末轮,不该有标签(避免把跨会话的话术算进来)');
});

test('回填:t1 记纠正、t3 记 abort(有下一轮=被顶掉)、t4 记 error,t2 不冤判', async () => {
  startTurnFeedbackBackfill({ delayMs: 0, batch: 2 });
  await new Promise((r) => setTimeout(r, 600));
  const rows = store.listTurnFeedback({ limit: 500 });
  const byId = new Map(rows.map((r) => [r.turnId, r]));
  assert(byId.get(t1.id)?.tags.includes('correction'), `t1 应记 correction,实际 ${JSON.stringify([...byId.keys()])}`);
  assert(byId.get(t4.id)?.tags.includes('error'), 't4 应记 error');
  assert(!byId.has(t2.id), 't2 没被用户否定,不该记账');
  // t3 没跑完就有下一轮(t4)= 用户等不及换了话题 → 这轮确实没交付,判 aborted 是对的。
  assert(byId.get(t3.id)?.tags.includes('aborted'), 't3 后面有新一轮,应判 aborted');
  assert(rows.every((r) => r.rating === -1), '只写负样本(rating=-1)');
});

test('回填:落账用原轮次时间戳,不是"现在"', () => {
  const t1row = store.listTurnFeedback({ limit: 500 }).find((r) => r.turnId === t1.id)!;
  assert(t1row.ts === 1_700_000_000_000, `ts 应为轮次时间戳,实际 ${t1row.ts}`);
});

test('回填:完成标记写进 app_meta,再跑是 no-op', async () => {
  assert(store.getMeta('turn_feedback_backfill_v1') === 'done', '应置位完成标记');
  const before = store.listTurnFeedback({ limit: 500 }).length;
  startTurnFeedbackBackfill({ delayMs: 0, batch: 2 });
  await new Promise((r) => setTimeout(r, 200));
  assert(store.listTurnFeedback({ limit: 500 }).length === before, '守标记后不该重复跑');
});

void tmpHome;
run();
