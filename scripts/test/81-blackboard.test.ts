// 团队共享黑板(blackboard)测试 — 笔记增删/缓存命中与 mtime 失效/close 清理。
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Blackboard, ensureBoard, getBoard, closeBoard } from '../../src/main/blackboard';

test('writeNote + renderDigest:标题索引可读回', () => {
  const b = new Blackboard();
  b.writeNote('alice', '入口在 src/main/main.ts', '详细信息...', 'artifact');
  b.writeNote('bob', '测试用例在 scripts/test', '细节');
  const digest = b.renderDigest();
  assert.ok(digest.includes('main.ts'));
  const n = b.readNote(1);
  assert.equal(n?.title, '测试用例在 scripts/test');
});

test('探查缓存:第二次读命中,mtime 变化后失效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-bb-'));
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'hello v1');
  const b = new Blackboard();
  assert.equal(b.getCachedRead(f), undefined, '未回填时无缓存');
  b.putCache(f, 'hello v1', 'alice');
  const hit = b.getCachedRead(f);
  assert.equal(hit?.content, 'hello v1');
  assert.equal(hit?.by, 'alice');
  assert.equal(b.cacheHits, 1);
  // mtime 变化 → 失效
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(f, future, future);
  assert.equal(b.getCachedRead(f), undefined, 'mtime 变了应失效');
});

test('缓存上限 60:挤掉最旧', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-bb2-'));
  const b = new Blackboard();
  for (let i = 0; i < 65; i++) {
    const f = path.join(dir, `f${i}.txt`);
    fs.writeFileSync(f, 'x');
    b.putCache(f, 'x', 'a');
  }
  assert.ok(b.stats().cachedFiles <= 60);
});

test('ensureBoard/closeBoard:注册表生命周期', () => {
  const id = 'conv:t:team:123';
  const b1 = ensureBoard(id);
  assert.equal(getBoard(id), b1);
  b1.writeNote('a', 't', 'b');
  closeBoard(id);
  assert.equal(getBoard(id), undefined, 'close 后注册表已清(防泄漏)');
  // 旧引用仍可读(close 不炸进行中的成员,只断共享)
  assert.equal(b1.listNotes().length, 1);
});

test('readNote 越界 → undefined', () => {
  const b = new Blackboard();
  assert.equal(b.readNote(99), undefined);
  assert.equal(b.readNote(-1), undefined);
});

run();
