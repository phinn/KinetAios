// 仓库语义地图:符号提取、依赖边、目录过滤、缓存失效、体系提示开关。
// 这些用例锁住的是「地图可信」:不能把 node_modules 扫进来,不能被注释骗,
// 改了文件必须重扫(否则 agent 看到过期结构比没有更糟)。
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanRepo, renderRepoMap, repoMapText, repoMapHint } from '../../src/main/repo-map';

function mkRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-test-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}');
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), [
    "import { helper } from './b';",
    '// class FakeInComment {}',
    'export function alpha() {}',
    'export class Beta {}',
    'export interface Gamma { x: number }',
    'const internal = 1;',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export function helper() {}\nexport type Shape = string;\n');
  fs.writeFileSync(path.join(root, 'src', 'c.py'), 'class Worker:\n    pass\n\ndef run_task():\n    pass\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'noise.ts'), 'export function noise() {}\n');
  fs.writeFileSync(path.join(root, 'dist', 'bundle.ts'), 'export function bundled() {}\n');
  return root;
}

test('扫描:只收源码目录,提取顶层符号与相对依赖边', () => {
  const root = mkRepo();
  const index = scanRepo(root, { cacheDir: null });
  const paths = index.files.map((f) => f.path);
  assert.ok(paths.includes('src/a.ts'), '应索引 src/a.ts');
  assert.ok(!paths.some((p) => p.includes('node_modules')), 'node_modules 必须排除');
  assert.ok(!paths.some((p) => p.startsWith('dist/')), 'dist 必须排除');

  const a = index.files.find((f) => f.path === 'src/a.ts')!;
  const names = a.symbols.map((s) => s.name);
  assert.deepEqual(names, ['alpha', 'Beta', 'Gamma'], '只收顶层导出声明;未导出 const 与注释内容不收');
  assert.deepEqual(a.deps, ['src/b.ts'], '相对 import 应解析成仓库内路径');

  const c = index.files.find((f) => f.path === 'src/c.py')!;
  assert.deepEqual(c.symbols.map((s) => `${s.kind} ${s.name}`), ['class Worker', 'def run_task'], 'Python 类/函数应识别');
});

test('渲染:预算内截断,filter 只看指定目录', () => {
  const root = mkRepo();
  const onlyTs = repoMapText(root, { cacheDir: null, filter: 'a.ts' });
  assert.ok(onlyTs.includes('src/a.ts'), 'filter 命中的文件要在');
  assert.ok(!onlyTs.includes('src/c.py'), 'filter 未命中的文件不要');

  // 40 个文件 × 3 符号 → 默认预算装不下,必须给出省略提示
  const big = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-big-'));
  fs.mkdirSync(path.join(big, 'src'), { recursive: true });
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(path.join(big, 'src', `f${i}.ts`), `export function fn${i}a() {}\nexport function fn${i}b() {}\nexport class C${i} {}\n`);
  }
  const tiny = repoMapText(big, { cacheDir: null, maxChars: 500 });
  assert.ok(/省略/.test(tiny), '预算不够时必须明确说省略了多少文件');
  assert.ok(tiny.length < 900, `截断后不应继续膨胀,实际 ${tiny.length} 字符`);
});

test('缓存:指纹不变复用,文件变化后重扫', () => {
  const root = mkRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-cache-'));
  const first = scanRepo(root, { cacheDir: dir });
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.json')), '索引应落盘');
  const again = scanRepo(root, { cacheDir: dir });
  assert.equal(again.fingerprint, first.fingerprint, '未改动 → 同指纹');

  fs.appendFileSync(path.join(root, 'src', 'b.ts'), '\nexport function delta() {}\n');
  const third = scanRepo(root, { cacheDir: dir });
  assert.notEqual(third.fingerprint, first.fingerprint, '文件变化 → 指纹必须变');
  assert.ok(third.files.find((f) => f.path === 'src/b.ts')!.symbols.some((s) => s.name === 'delta'), '新增符号应出现');
});

test('体系提示只在代码仓库里出现', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-plain-'));
  assert.equal(repoMapHint(plain), '', '非仓库目录不注入');
  const repo = mkRepo();
  assert.ok(repoMapHint(repo).includes('repo_map'), '仓库目录应提示先调 repo_map');
});

run();
