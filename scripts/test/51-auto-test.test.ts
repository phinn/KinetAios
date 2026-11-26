// 自动测试的计划选择与失败解析:不 spawn 真测试,只验证"该跑哪些 / 怎么判失败"。
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planAffectedTests, parseTestFailures, testAfterEdit } from '../../src/main/auto-test';

function mkRepo(files: Record<string, string>, bins: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  for (const b of bins) {
    const abs = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${b}.cmd` : b);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
  }
  return root;
}

const probeStub = { which: () => false };

test('JS:只跑同目录 / 直接 import 了该模块的测试', () => {
  const root = mkRepo({
    'package.json': '{"scripts":{"test":"vitest run"}}',
    'src/util.ts': 'export const x = 1;\n',
    'src/util.test.ts': 'import { x } from "./util";\n',
    'src/other.ts': 'export const y = 2;\n',
    'src/other.test.ts': 'import { y } from "./other";\n',
    'tests/deep.test.ts': 'import { x } from "../src/util";\n',
    'tests/unrelated.test.ts': 'import { z } from "lodash";\n',
  }, ['vitest']);
  const plan = planAffectedTests(path.join(root, 'src/util.ts'), root, probeStub);
  assert.ok(plan, '应识别出 vitest');
  assert.equal(plan!.runner, 'vitest');
  assert.deepEqual(plan!.files, ['src/util.test.ts', 'tests/deep.test.ts']);
  assert.deepEqual(plan!.args.slice(0, 1), ['run']);
});

test('改的就是测试文件 → 只跑它自己', () => {
  const root = mkRepo({
    'package.json': '{}',
    'src/a.ts': 'export const a = 1;\n',
    'src/a.test.ts': 'import "./a";\n',
    'src/b.test.ts': 'it("b", () => {});\n',
  }, ['jest']);
  const plan = planAffectedTests(path.join(root, 'src/a.test.ts'), root, probeStub);
  assert.ok(plan);
  assert.deepEqual(plan!.files, ['src/a.test.ts']);
  assert.equal(plan!.runner, 'jest');
  assert.ok(plan!.args.includes('--runTestsByPath'));
});

test('没有测试运行器 / 没有受影响测试 → null(静默跳过)', () => {
  const root = mkRepo({ 'package.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
  assert.equal(planAffectedTests(path.join(root, 'src/a.ts'), root, probeStub), null);
  const root2 = mkRepo({ 'package.json': '{}', 'src/a.ts': 'export const a = 1;\n', 'tests/b.test.ts': 'it("b",()=>{})' }, ['mocha']);
  assert.equal(planAffectedTests(path.join(root2, 'src/a.ts'), root2, probeStub), null, '无关测试不该触发');
});

test('Python:按 import 选测试;没有 pytest 就跳过', () => {
  const root = mkRepo({
    'pyproject.toml': '',
    '.venv/bin/pytest': '',
    'pkg/util.py': 'def f(): pass\n',
    'pkg/test_util.py': 'from pkg.util import f\n',
    'pkg/test_other.py': 'from pkg.other import g\n',
  });
  const plan = planAffectedTests(path.join(root, 'pkg/util.py'), root, { which: () => false });
  assert.ok(plan);
  assert.equal(plan!.runner, 'pytest');
  assert.deepEqual(plan!.files, ['pkg/test_util.py']);
});

test('Go:同包有 _test.go 才跑该包', () => {
  const root = mkRepo({
    'go.mod': 'module x\n',
    'svc/a.go': 'package svc\n',
    'svc/a_test.go': 'package svc\n',
  });
  const plan = planAffectedTests(path.join(root, 'svc/a.go'), root, { which: () => true });
  assert.ok(plan);
  assert.equal(plan!.runner, 'go');
  assert.deepEqual(plan!.args, ['test', './svc']);
});

test('失败解析:跨 runner 的常见形态,去 ANSI/耗时/重复', () => {
  const vitest = '\u001b[31mFAIL\u001b[0m  src/a.test.ts > adds\n  AssertionError: expected 1 to be 2\nTests  1 failed | 2 passed (350ms)';
  const f1 = parseTestFailures(vitest, 1);
  assert.ok(f1.some((x) => x.startsWith('FAIL')), f1.join('|'));
  assert.ok(f1.some((x) => x.includes('AssertionError')));
  // 去掉耗时后,两次不同耗时的同一失败签名应一致
  assert.deepEqual(parseTestFailures(vitest, 1), parseTestFailures(vitest.replace('350ms', '1.2s'), 1));

  const pytest = 'FAILED tests/test_a.py::test_x - assert 1 == 2\nE   assert 1 == 2';
  const f2 = parseTestFailures(pytest, 1);
  assert.ok(f2.some((x) => x.startsWith('FAILED')));

  const go = '--- FAIL: TestAdd (0.00s)\n    a_test.go:9: got 1\nFAIL\tsvc\t0.003s';
  const f3 = parseTestFailures(go, 1);
  assert.ok(f3.length >= 1);
  // 退出码非 0 但无标记 → 取尾部输出兜底
  assert.ok(parseTestFailures('boom happened', 2).some((x) => x.includes('boom')));
});

test('KINET_TEST_CMD:自研 runner 也能按受影响文件跑', () => {
  const prev = process.env.KINET_TEST_CMD;
  process.env.KINET_TEST_CMD = 'node scripts/run-tests.js --only {files}';
  try {
    const root = mkRepo({
      'package.json': '{}',
      'src/util.ts': 'export const x = 1;\n',
      'src/util.test.ts': 'import "./util";\n',
    });
    const plan = planAffectedTests(path.join(root, 'src/util.ts'), root, probeStub);
    assert.ok(plan, '有自定义命令时应能规划');
    assert.equal(plan!.runner, 'shell');
    assert.ok(plan!.args.join(' ').includes('src/util.test.ts'), plan!.args.join(' '));
    assert.ok(plan!.args.join(' ').includes('--only'));
  } finally {
    if (prev === undefined) delete process.env.KINET_TEST_CMD;
    else process.env.KINET_TEST_CMD = prev;
  }
});

test('入口:没有可用计划时不 spawn、不产生文本', async () => {
  const root = mkRepo({ 'README.md': '# hi' });
  assert.equal(await testAfterEdit({ cwd: root, file: path.join(root, 'README.md'), probe: probeStub }), '');
});

run();
