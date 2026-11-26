// 快照预览用的行级 diff:统计、hunk 头、CRLF 归一化、大文件降级。
import { assert, test, run } from './harness';
import { unifiedDiff } from '../../src/shared/diff';

test('内容相同 → 明确说不会改变', () => {
  const r = unifiedDiff('a\nb\n', 'a\nb\n', { label: 'x.ts' });
  assert.equal(r.added, 0);
  assert.equal(r.removed, 0);
  assert.ok(r.text.includes('相同'));
});

test('单行替换:一个 hunk,+/− 计数正确', () => {
  const before = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
  const after = ['line1', 'line2', 'CHANGED', 'line4', 'line5'].join('\n');
  const r = unifiedDiff(before, after, { label: 'a.ts' });
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
  assert.ok(r.text.includes('--- a/a.ts'));
  assert.ok(r.text.includes('-line3'));
  assert.ok(r.text.includes('+CHANGED'));
  assert.ok(r.text.includes('@@'));
});

test('CRLF 与 LF 不产生虚假 diff', () => {
  const r = unifiedDiff('a\r\nb\r\n', 'a\nb\n');
  assert.equal(r.added, 0);
  assert.equal(r.removed, 0);
});

test('大改动降级为摘要,不展开逐行', () => {
  const before = Array.from({ length: 4000 }, (_, i) => `before-${i}`).join('\n');
  const after = Array.from({ length: 4000 }, (_, i) => `after-${i}`).join('\n');
  const r = unifiedDiff(before, after, { label: 'big.ts' });
  assert.equal(r.truncated, true);
  assert.ok(r.text.includes('改动过大'));
});
