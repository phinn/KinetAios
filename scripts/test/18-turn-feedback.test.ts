// 隐式反馈账本 + 信号判定(2026-11-18 新增写入路径的回归)
// 背景:turn_feedback 表建了 4 个月、代码里零引用,永远是 0 行 —— 能力进化没有成败标签。
// 现在由 TaskManager 两处写入:①用户下一轮话术(correction/reask)②turn 终态(error/aborted)。
// 本文件钉死两件事:账本的合并语义(负分只升不降)和重问判定的阈值(别把「继续」当返工)。
import { assert, test, run } from './harness';
import * as store from '../../src/main/store';
import { CORRECTION_RE, isReask } from '../../src/main/turn-signal';

store.initStore();

test('recordTurnFeedback:首次写入落库,tags 数组转逗号串', () => {
  store.recordTurnFeedback('t1', -1, ['correction']);
  const rows = store.listTurnFeedback({ limit: 10 });
  const hit = rows.find((r) => r.turnId === 't1');
  assert.ok(hit, '应能读回刚写的反馈');
  assert.equal(hit!.rating, -1);
  assert.deepEqual(hit!.tags, ['correction']);
  assert.ok(hit!.ts > 0, 'ts 应被填上(旧库该列由 ALTER 补出)');
});

test('recordTurnFeedback:同一 turn 多次触发 → tags 合并去重', () => {
  store.recordTurnFeedback('t2', -1, ['reask']);
  store.recordTurnFeedback('t2', -1, ['correction', 'reask']);
  const hit = store.listTurnFeedback({ limit: 50 }).find((r) => r.turnId === 't2')!;
  assert.deepEqual(hit.tags.sort(), ['correction', 'reask'], '两个原因都要留下,不能互相覆盖');
});

test('recordTurnFeedback:rating 只升不降(先被纠正后点赞仍是 -1)', () => {
  store.recordTurnFeedback('t3', -1, ['correction']);
  store.recordTurnFeedback('t3', 1, ['liked']);
  const hit = store.listTurnFeedback({ limit: 50 }).find((r) => r.turnId === 't3')!;
  assert.equal(hit.rating, -1, '用户已经返工过的轮次不能被后来的好评洗白');
  assert.ok(hit.tags.includes('liked'), 'tags 仍然要记录');
});

test('recordTurnFeedback:空 turnId 直接忽略', () => {
  const before = store.listTurnFeedback({ limit: 5000 }).length;
  store.recordTurnFeedback('', -1, ['x']);
  assert.equal(store.listTurnFeedback({ limit: 5000 }).length, before);
});

test('listTurnFeedback:since 过滤 + 按时间倒序', () => {
  const all = store.listTurnFeedback({ limit: 5000 });
  assert.ok(all.length >= 3);
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i - 1].ts >= all[i].ts, '应按 ts 倒序');
  }
  const future = store.listTurnFeedback({ since: Date.now() + 60_000, limit: 100 });
  assert.equal(future.length, 0, 'since 指向未来应过滤掉全部');
});

test('CORRECTION_RE:典型返工话术命中,正常需求不命中', () => {
  for (const s of ['你又搞错了', '我说过多少次了', '还是不行', '不是让你改这个吗', '怎么又跳过了']) {
    assert.ok(CORRECTION_RE.test(s), `应命中:${s}`);
  }
  for (const s of ['帮我加个导出按钮', '再看看这个文件', '继续']) {
    assert.ok(!CORRECTION_RE.test(s), `不应命中:${s}`);
  }
});

test('isReask:几乎同一句话重问 → true', () => {
  assert.ok(isReask('把桌面上的截图整理到 downloads 目录里', '把桌面上的截图整理到 Downloads 目录'));
  assert.ok(isReask('分析一下这个 CSv 文件的销售趋势', '分析一下这个 csv 文件的销售趋势'));
});

test('isReask:短承接词不算返工(「继续」「再试一次」)', () => {
  assert.ok(!isReask('继续', '把桌面上的截图整理到 downloads 目录里'));
  assert.ok(!isReask('再试一次', '分析一下这个 csv 文件的销售趋势'));
  assert.ok(!isReask('好的', '写一个 python 脚本批量重命名文件'));
});

test('isReask:无关的新任务不算返工', () => {
  assert.ok(!isReask('帮我把这个项目推送到 gitee 镜像仓库', '分析一下这个 csv 文件的销售趋势'));
  assert.ok(!isReask('任意新内容', undefined));
});

run();
