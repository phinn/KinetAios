#!/usr/bin/env node
// 测试 runner:用工程现有 devDependency esbuild 把 scripts/test/*.test.ts 逐个
// bundle 成 CJS 后用 node 执行(electron 走 shim alias;better-sqlite3 等 native/大 SDK 保持 external)。
// 任一测试文件失败 → 退出码 1。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const testDir = path.join(__dirname, 'test');
const outDir = path.join(root, 'tmp-test');
const esbuildBin = path.join(root, 'node_modules', '.bin', 'esbuild');
const shim = path.join(__dirname, 'test', 'shims', 'electron.ts');
const sqliteShim = path.join(__dirname, 'test', 'shims', 'better-sqlite3.ts');
const EXTERNAL = ['@larksuiteoapi/node-sdk', '@wecom/aibot-node-sdk', 'ws'];

const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.ts')).sort();
if (!files.length) {
  console.error('scripts/test/ 下没有 *.test.ts');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

let failed = 0;
for (const f of files) {
  const out = path.join(outDir, f.replace(/\.ts$/, '.cjs'));
  execFileSync(
    esbuildBin,
    [
      path.join(testDir, f),
      '--bundle', '--platform=node', '--format=cjs',
      `--outfile=${out}`,
      `--alias:electron=${shim}`,
      `--alias:better-sqlite3=${sqliteShim}`,
      ...EXTERNAL.map((e) => `--external:${e}`),
      '--log-level=warning',
      '--legal-comments=none',
    ],
    { stdio: 'inherit' },
  );
  console.log(`\n=== ${f} ===`);
  try {
    // better-sqlite3 经 test/shims/better-sqlite3.ts(node:sqlite)适配 → 系统 node 可直接跑。
    execFileSync(process.execPath, [out], { stdio: 'inherit', cwd: root });
  } catch {
    failed++;
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed}/${files.length} test file(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${files.length} test file(s) passed.`);
