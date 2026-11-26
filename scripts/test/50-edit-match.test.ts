// 编辑精度内核:归一化匹配、唯一性判定、缩进重排、失配候选。
import { assert, test, run } from './harness';
import { fuzzyEdit, normalizeLine, suggestSimilar, lineSimilarity, blockIndent } from '../../src/main/edit-match';

const src = [
  'export function a() {',
  '    doA();',
  '    return 1;',
  '}',
  '',
  'export function b() {',
  '    doB();',
  '    return 2;',
  '}',
].join('\n');

test('归一化:只用于比较,不改变原文', () => {
  assert.equal(normalizeLine('   const   x =   1;  '), 'const x = 1;');
  assert.equal(normalizeLine('\t\treturn  1'), 'return 1');
});

test('模糊匹配:缩进不同也能命中,并把新代码重排到实际缩进', () => {
  const oldS = 'export function b() {\n  doB();\n  return 2;\n}';
  const newS = 'export function b() {\n  doB(9);\n  if (ok) {\n    return 3;\n  }\n  return 2;\n}';
  const r = fuzzyEdit(src, oldS, newS);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.count, 1);
  assert.deepEqual(r.lines, [6]);
  assert.equal(r.reindented, true);
  assert.ok(r.text.includes('    doB(9);'), '应使用文件实际的 4 空格缩进');
  assert.ok(r.text.includes('      return 3;'), '嵌套层应保留相对缩进');
  assert.ok(r.text.includes('    if (ok) {'));
  const doBLine = r.text.split('\n').find((l) => l.includes('doB(9)'));
  assert.equal(doBLine, '    doB(9);', '不应保留模型给的 2 空格');
});

test('两行块:第二行也要按自己的缩进差重排(不能被首行基准带偏)', () => {
  const body = ['function f() {', '    return 1;', '}'].join('\n');
  const r = fuzzyEdit(body, 'function f() {\n  return 1;\n}', 'function f() {\n  return 2;\n}');
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.ok(r.text.includes('    return 2;'), r.text);
});

test('唯一性:多处模糊命中且未开 replace_all → 拒绝并给出候选行', () => {
  const body = ['x();', 'y();', 'z();', '', 'x();', 'y();', 'z();'].join('\n');
  const r = fuzzyEdit(body, 'x();\n  y();\n  z();', 'w();\n  y();\n  z();', false);
  assert.equal(r.kind, 'ambiguous');
  if (r.kind !== 'ambiguous') return;
  assert.deepEqual(r.lines, [1, 5]);
});

test('replace_all:归一化后全部替换', () => {
  const body = ['if (a) {', '  run();', '}', 'if (b) {', '    run();', '}'].join('\n');
  const r = fuzzyEdit(body, 'run();', 'run(1);', true);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.count, 2);
  assert.equal((r.text.match(/run\(1\);/g) ?? []).length, 2);
});

test('失配:给出最接近的片段(带行号与相似度),首行仍是"未找到"前缀', () => {
  const body = ['const total = compute(a, c);', 'const other = 1;'].join('\n');
  const r = fuzzyEdit(body, 'const total = compute(a, b);', 'const total = compute(a, c);');
  assert.equal(r.kind, 'none');
  if (r.kind !== 'none') return;
  assert.ok(r.suggestions.length >= 1);
  assert.equal(r.suggestions[0].line, 1);
  assert.ok(r.suggestions[0].score >= 0.45);
});

test('相似度与缩进基准:排序可用,空白行不计入', () => {
  assert.equal(lineSimilarity('abc', 'abc'), 1);
  assert.ok(lineSimilarity('const a = 1', 'const a = 2') > 0.5);
  assert.equal(lineSimilarity('', 'abc'), 0);
  assert.equal(blockIndent(['', '    foo();', 'bar();']), '    ');
  assert.deepEqual(suggestSimilar('a\nb\nc', 'x\ny', 3), []);
});

run();
