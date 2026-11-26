// grep 相关性排序:同样的命中集合,顺序决定模型下一步能不能直接命中目标。
// 锁三件事:大小写精确 > 忽略大小写;源码 > 测试/文档;同文件条数有上限(避免单文件刷屏)。
import { assert, test, run } from './harness';
import { scoreGrepHit, rankGrepHits } from '../../src/main/search-rank';

const hit = (file: string, line: number, text: string) => ({ file, line, text });

test('打分:大小写精确 > 忽略大小写', () => {
  const exact = scoreGrepHit(hit('src/a.ts', 1, 'runToolBatch(x)'), 'runToolBatch');
  const loose = scoreGrepHit(hit('src/a.ts', 1, 'RUNTOOLBATCH(x)'), 'runToolBatch');
  assert.ok(exact > loose, `精确 ${exact} 应高于忽略大小写 ${loose}`);
});

test('打分:词边界 > 长标识符子串;源码目录 > 测试/文档;生成文件最低', () => {
  const word = scoreGrepHit(hit('src/a.ts', 1, 'const x = runToolBatch;'), 'runToolBatch');
  const sub = scoreGrepHit(hit('src/a.ts', 1, 'const x = prunToolBatchx;'), 'runToolBatch');
  assert.ok(word > sub);
  const src = scoreGrepHit(hit('src/core/a.ts', 1, 'runToolBatch'), 'runToolBatch');
  const test = scoreGrepHit(hit('src/__tests__/a.test.ts', 1, 'runToolBatch'), 'runToolBatch');
  const docs = scoreGrepHit(hit('docs/a.md', 1, 'runToolBatch'), 'runToolBatch');
  assert.ok(src > test, '源码应排在测试前');
  assert.ok(test >= 0 && docs < src);
  const gen = scoreGrepHit(hit('src/a.min.js', 1, 'runToolBatch'), 'runToolBatch');
  assert.ok(gen < src);
});

test('排序:分数降序 + 同文件最多 8 条 + 总数上限', () => {
  const many = Array.from({ length: 20 }, (_, i) => hit('src/big.ts', i + 1, `runToolBatch call ${i}`));
  const ranked = rankGrepHits([
    ...many,
    hit('src/target.ts', 3, 'runToolBatch(target)'),
    hit('src/target.ts', 4, 'something else runToolBatch'),
  ], 'runToolBatch', { max: 10, perFile: 8 });
  assert.equal(ranked.length, 10);
  assert.equal(ranked.filter((h) => h.file === 'src/big.ts').length, 8, '同文件最多 8 条');
  assert.ok(ranked.some((h) => h.file === 'src/target.ts'), '小文件也要有机会出现');
});

test('排序:同分时浅路径优先,结果稳定', () => {
  const hits = [hit('src/deep/nested/a.ts', 2, 'alpha'), hit('src/a.ts', 9, 'alpha')];
  const ranked = rankGrepHits(hits, 'alpha');
  assert.equal(ranked[0].file, 'src/a.ts');
  const again = rankGrepHits(hits, 'alpha');
  assert.deepEqual(again, ranked);
});

run();
