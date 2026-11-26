// 诊断自验证:计划选择(项目类型 → 检查器)、各工具输出解析、回灌筛选(只报本文件 + 新增)。
// 不 spawn 真编译器:执行入口用注入探针,解析用真实输出样本。
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  planDiagnostics,
  planProjectDiagnostics,
  parseDiagnostics,
  selectFeedback,
  formatDiagFindings,
  diagnoseAfterEdit,
  runPlan,
  type DiagProbe,
} from '../../src/main/diagnostics';

function mkProject(markers: Record<string, string>, dirs: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-test-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const f of Object.keys(markers)) fs.writeFileSync(path.join(root, f), markers[f]);
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

function fakeProbe(exists: string[], which: string[]): DiagProbe {
  return {
    exists: (p) => exists.includes(path.normalize(p)),
    which: (c) => which.includes(c),
  };
}

test('计划:tsconfig + 本地 tsc → 项目级 tsc', () => {
  const root = mkProject({ 'tsconfig.json': '{}' }, ['node_modules/.bin']);
  const file = path.join(root, 'src', 'a.ts');
  fs.writeFileSync(file, 'export const a = 1;\n');
  const tsc = path.normalize(path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'));
  const plan = planDiagnostics(file, root, fakeProbe([path.normalize(path.join(root, 'tsconfig.json')), tsc], []));
  assert.ok(plan);
  assert.equal(plan!.kind, 'tsc');
  assert.equal(plan!.root, root);
  assert.ok(plan!.args.includes('-p'));
  assert.equal(plan!.file, file);
});

test('计划:多 tsconfig 仓库按 include 覆盖选配置(tsconfig.main.json / tsconfig.renderer.json)', () => {
  const root = mkProject(
    {
      'tsconfig.main.json': '{ "include": ["src/main/**/*"] }',
      'tsconfig.renderer.json': '{ "include": ["src/renderer/**/*"] }',
    },
    ['node_modules/.bin', 'src/main', 'src/renderer'],
  );
  const mainFile = path.join(root, 'src', 'main', 'a.ts');
  const rendererFile = path.join(root, 'src', 'renderer', 'b.ts');
  fs.writeFileSync(mainFile, 'export const a = 1;\n');
  fs.writeFileSync(rendererFile, 'export const b = 1;\n');
  const tsc = path.normalize(path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'));
  const probe = fakeProbe([tsc], []);
  const mainPlan = planDiagnostics(mainFile, root, probe);
  assert.equal(mainPlan?.kind, 'tsc');
  assert.ok(mainPlan!.args[mainPlan!.args.length - 1].endsWith('tsconfig.main.json'), `应选 main 配置,实际 ${mainPlan!.args.slice(-1)}`);
  const rendererPlan = planDiagnostics(rendererFile, root, probe);
  assert.ok(rendererPlan!.args[rendererPlan!.args.length - 1].endsWith('tsconfig.renderer.json'), '应选 renderer 配置');
});

test('计划:无 tsconfig 但有 eslint 配置 → 单文件 eslint', () => {
  const root = mkProject({ 'eslint.config.js': 'export default []' }, ['node_modules/.bin']);
  const file = path.join(root, 'src', 'a.js');
  fs.writeFileSync(file, 'var a = 1;\n');
  const eslint = path.normalize(path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint'));
  const plan = planDiagnostics(file, root, fakeProbe([path.normalize(path.join(root, 'eslint.config.js')), eslint], []));
  assert.ok(plan);
  assert.equal(plan!.kind, 'eslint');
  assert.ok(plan!.args.includes('--format'));
});

test('计划:Python 优先 pyright,没有则语法编译;Go 优先 gopls,没有则 go vet', () => {
  const root = mkProject({ 'pyproject.toml': '' }, ['node_modules/.bin']);
  const py = path.join(root, 'src', 'a.py');
  fs.writeFileSync(py, 'x = 1\n');
  const withPyright = planDiagnostics(py, root, fakeProbe([path.normalize(path.join(root, 'pyproject.toml')), path.normalize(path.join(root, 'node_modules/.bin', process.platform === 'win32' ? 'pyright.cmd' : 'pyright'))], []));
  assert.equal(withPyright?.kind, 'pyright');
  const pyc = planDiagnostics(py, root, fakeProbe([path.normalize(path.join(root, 'pyproject.toml'))], ['python3']));
  assert.equal(pyc?.kind, 'pycompile');

  const goRoot = mkProject({ 'go.mod': 'module x' });
  const go = path.join(goRoot, 'src', 'a.go');
  fs.writeFileSync(go, 'package a\n');
  const gopls = planDiagnostics(go, goRoot, fakeProbe([path.normalize(path.join(goRoot, 'go.mod'))], ['gopls', 'go']));
  assert.equal(gopls?.kind, 'gopls');
  const vet = planDiagnostics(go, goRoot, fakeProbe([path.normalize(path.join(goRoot, 'go.mod'))], ['go']));
  assert.equal(vet?.kind, 'govet');
  assert.deepEqual(vet?.args, ['vet', './src']);
});

test('计划:不支持的文件/没有项目标记 → null(静默跳过)', () => {
  const root = mkProject({});
  const md = path.join(root, 'README.md');
  fs.writeFileSync(md, '# hi');
  assert.equal(planDiagnostics(md, root, fakeProbe([], ['tsc'])), null);
  const ts = path.join(root, 'a.ts');
  fs.writeFileSync(ts, 'export const a = 1;\n');
  assert.equal(planDiagnostics(ts, root, fakeProbe([], ['tsc'])), null, '没有 tsconfig 不该硬跑 tsc');
});

test('目录计划:tsconfig 优先,其次 pyproject/go.mod', () => {
  const tsRoot = mkProject({ 'tsconfig.json': '{}' }, ['node_modules/.bin']);
  const tsc = path.normalize(path.join(tsRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'));
  assert.equal(planProjectDiagnostics(tsRoot, tsRoot, fakeProbe([path.normalize(path.join(tsRoot, 'tsconfig.json')), tsc], []))?.kind, 'tsc');
  const pyRoot = mkProject({ 'requirements.txt': '' });
  assert.equal(planProjectDiagnostics(pyRoot, pyRoot, fakeProbe([path.normalize(path.join(pyRoot, 'requirements.txt'))], ['pyright']))?.kind, 'pyright');
  const goRoot = mkProject({ 'go.mod': 'module x' });
  assert.equal(planProjectDiagnostics(goRoot, goRoot, fakeProbe([path.normalize(path.join(goRoot, 'go.mod'))], ['go']))?.kind, 'govet');
});

test('解析:tsc / eslint unix / go vet', () => {
  const tsc = parseDiagnostics('tsc', "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n", '/p');
  assert.deepEqual(tsc[0], { file: 'src/a.ts', line: 12, col: 5, text: "TS2322 Type 'string' is not assignable to type 'number'." });

  const es = parseDiagnostics('eslint', '/p/src/a.js:3:1: Unexpected var, use let or const instead. [no-var]\n', '/p');
  assert.equal(es[0].file, 'src/a.js');
  assert.equal(es[0].line, 3);
  assert.ok(!es[0].text.includes('[no-var]'), '规则名不该混进消息');

  const vet = parseDiagnostics('govet', '/p/src/a.go:7:2: unused variable x\n', '/p');
  assert.equal(vet[0].file, 'src/a.go');
  assert.equal(vet[0].line, 7);
});

test('解析:pyright JSON 与 python 语法编译', () => {
  const json = JSON.stringify({ generalDiagnostics: [
    { file: '/p/src/a.py', severity: 'error', message: 'Type "int" is not assignable', range: { start: { line: 4, character: 2 } } },
    { file: '/p/src/a.py', severity: 'information', message: 'noise', range: { start: { line: 0, character: 0 } } },
  ] });
  const py = parseDiagnostics('pyright', json, '/p');
  assert.equal(py.length, 1);
  assert.deepEqual(py[0], { file: 'src/a.py', line: 5, col: 3, text: 'Type "int" is not assignable' });

  const pyc = parseDiagnostics('pycompile', '*** Error compiling \'a.py\'...\n  File "/p/src/a.py", line 3\n    def f(\n          ^\nSyntaxError: \'(\' was never closed\n', '/p');
  assert.equal(pyc[0].file, 'src/a.py');
  assert.equal(pyc[0].line, 3);
  assert.ok(pyc[0].text.includes('SyntaxError'));
});

test('回灌筛选:首次只报本文件;之后报本文件 + 新增到别处的问题(按文件|消息去重,抗行号漂移)', () => {
  const findings = [
    { file: 'src/a.ts', line: 10, text: 'TS2322 x' },
    { file: 'src/a.ts', line: 99, text: 'TS2322 x' }, // 同行消息 → 去重
    { file: 'src/b.ts', line: 5, text: 'TS2304 y' },
  ];
  const first = selectFeedback(findings, null, '/p/src/a.ts', '/p');
  assert.deepEqual(first.map((f) => `${f.file}:${f.line}`), ['src/a.ts:10']);
  // 下一次:b 里同一消息不算新;b 里换一条才算
  const prev = new Set(findings.map((f) => `${f.file}|${f.text}`));
  const second = selectFeedback([
    { file: 'src/a.ts', line: 12, text: 'TS2322 x' },
    { file: 'src/b.ts', line: 6, text: 'TS2304 y' },
    { file: 'src/c.ts', line: 1, text: 'TS7006 z' },
  ], prev, '/p/src/a.ts', '/p');
  assert.deepEqual(second.map((f) => f.file), ['src/a.ts', 'src/c.ts']);
});

test('回灌格式:通过/有问题/隐藏计数', () => {
  assert.ok(formatDiagFindings('tsc', []).startsWith('✅'));
  const msg = formatDiagFindings('tsc', [{ file: 'a.ts', line: 1, col: 2, text: 'err' }], { hidden: 3 });
  assert.ok(msg.startsWith('⚠️'));
  assert.ok(msg.includes('a.ts:1:2  err'));
  assert.ok(msg.includes('另有 3 个'));
});

test('自动诊断:没有项目标记时不 spawn、不产生噪声', async () => {
  const root = mkProject({});
  const file = path.join(root, 'src', 'a.ts');
  fs.writeFileSync(file, 'export const a = 1;\n');
  assert.equal(await diagnoseAfterEdit({ cwd: root, file }), '');
});

test('执行:检查器不存在 → null(调用方静默跳过,不报错)', async () => {
  const res = await runPlan({ kind: 'tsc', root: os.tmpdir(), cmd: 'definitely-not-a-real-diag-binary-xyz', args: [], timeoutMs: 5000 });
  assert.equal(res, null);
});

run();
