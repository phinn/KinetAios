// 技能依赖装配:解析必须宽松(frontmatter 是人写的),检查必须准确(PATH/env/文件三类)。
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseRequires, parseRequirement, checkRequirements, commandExists, formatMissing } from '../../src/main/skill-requires';

test('requires 解析:内联 / 方括号 / YAML block 三种写法', () => {
  assert.deepEqual(parseRequires('name: x\nrequires: git, node, env:FOO'), ['git', 'node', 'env:FOO']);
  assert.deepEqual(parseRequires('requires: [git, "env:OPENAI_API_KEY"]'), ['git', 'env:OPENAI_API_KEY']);
  assert.deepEqual(parseRequires('requires:\n  - cmd:git\n  - env:FOO\n'), ['cmd:git', 'env:FOO']);
  assert.deepEqual(parseRequires('description: 无依赖'), []);
});

test('单项解析:四类依赖各有明确提示', () => {
  assert.equal(parseRequirement('git').kind, 'cmd');
  assert.ok(parseRequirement('cmd:git').hint.includes('PATH'));
  assert.ok(parseRequirement('env:FOO').hint.includes('环境变量 FOO'));
  assert.ok(parseRequirement('file:scripts/run.sh').hint.includes('scripts/run.sh'));
  assert.ok(parseRequirement('skill:pdf').hint.includes('pdf'));
});

test('检查:env 缺失 / file 缺失 / cmd 缺失都被点名,hint 一一对应', () => {
  const report = checkRequirements(['git', 'env:NOT_SET_XYZ', 'file:scripts/run.sh', 'skill:pdf'], {
    cwd: '/skills/demo',
    env: { PATH: '' },
    commandExists: (c) => c === 'git',
    exists: () => false,
    skillExists: () => false,
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing.map((m) => m.raw), ['env:NOT_SET_XYZ', 'file:scripts/run.sh', 'skill:pdf']);
  assert.equal(report.hints.length, 3);
  assert.ok(formatMissing(report, 'demo').includes('技能 demo'));
});

test('检查:全部就绪时为空,且 file 用技能目录解析', () => {
  let probed = '';
  const report = checkRequirements(['git', 'file:scripts/run.sh'], {
    cwd: '/skills/demo',
    env: { PATH: '/bin' },
    commandExists: () => true,
    exists: (p) => { probed = p; return true; },
  });
  assert.equal(report.ok, true);
  assert.equal(report.missing.length, 0);
  assert.equal(formatMissing(report), '');
  assert.equal(probed, path.resolve('/skills/demo', 'scripts/run.sh'));
});

test('commandExists:真实 PATH 扫描命中可执行文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-req-'));
  const bin = 'my-fake-tool';
  fs.writeFileSync(path.join(dir, bin), '#!/bin/sh\n');
  fs.chmodSync(path.join(dir, bin), 0o755);
  assert.equal(commandExists(bin, { PATH: dir }), true);
  assert.equal(commandExists(bin, { PATH: '/definitely/not/here' }), false);
});

run();
