// mcp-server run_agent cwd 授权边界测试。
// 验收口径(HOL Guard 对齐):越界 cwd 的 run_agent 被拒绝,零执行 —— 不起 AgentLoop、不动文件系统。
// 直接测 resolveGrantedCwd / cwdWithinRoots 两个纯函数(经 esbuild bundle 后走内部导出)。
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';

// esbuild bundle 的 mcp-server.ts 会启动 http server?—— 不会:模块顶层只定义常量与类,
// server 由 main.ts 显式 startMcpServer 启动。导入是安全的。
import { mcpAllowedCwdRoots, cwdWithinRoots, resolveGrantedCwd } from '../../src/main/mcp-server';

const HOME = os.homedir();
const TSEP = path.delimiter;

function withEnv(raw: string | undefined, fn: () => void): void {
  const prev = process.env.KINET_MCP_CWD;
  if (raw === undefined) delete process.env.KINET_MCP_CWD;
  else process.env.KINET_MCP_CWD = raw;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.KINET_MCP_CWD;
    else process.env.KINET_MCP_CWD = prev;
  }
}

let passed = 0;
function t(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

console.log('mcp cwd grant boundary:');

t('未声明 KINET_MCP_CWD → 默认根 = homedir', () => {
  withEnv(undefined, () => {
    const roots = mcpAllowedCwdRoots();
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0], path.resolve(HOME));
  });
});

t('多路径声明(:分隔)→ 解析为多个根', () => {
  withEnv(`/Users/x/projA${TSEP}/Users/x/projB`, () => {
    const roots = mcpAllowedCwdRoots();
    assert.deepStrictEqual(roots, ['/Users/x/projA', '/Users/x/projB'].map((p) => path.resolve(p)));
  });
});

t('根内子目录 → 允许', () => {
  withEnv(HOME, () => {
    assert.ok(cwdWithinRoots(path.join(HOME, 'Documents', 'kinet'), [path.resolve(HOME)]));
  });
});

t('根本身 → 允许', () => {
  withEnv(HOME, () => assert.ok(cwdWithinRoots(HOME, [path.resolve(HOME)])));
});

t('根外目录(../ 逃逸)→ 拒绝', () => {
  withEnv(path.join(HOME, 'work'), () => {
    assert.ok(!cwdWithinRoots(path.join(HOME, 'secret'), [path.join(HOME, 'work')]));
  });
});

t('前缀相似但非包含(/work vs /worker)→ 拒绝', () => {
  assert.ok(!cwdWithinRoots('/tmp/worker', ['/tmp/work']));
});

t('resolveGrantedCwd:未传 cwd → 返回授权根', () => {
  withEnv(`/Users/x/projA`, () => {
    assert.strictEqual(resolveGrantedCwd({ prompt: 'hi' }), path.resolve('/Users/x/projA'));
  });
});

t('resolveGrantedCwd:cwd 在根内 → 返回规范化路径', () => {
  withEnv(HOME, () => {
    const got = resolveGrantedCwd({ prompt: 'hi', cwd: path.join(HOME, 'docs', '..', 'docs') });
    assert.strictEqual(got, path.resolve(HOME, 'docs'));
  });
});

t('resolveGrantedCwd:cwd 越界 → 抛错拒绝(零执行)', () => {
  withEnv(path.join(HOME, 'work'), () => {
    assert.throws(
      () => resolveGrantedCwd({ prompt: 'hi', cwd: '/etc' }),
      /越界|not/i,
    );
  });
});

t('resolveGrantedCwd:cwd 为空串 → 视同未传', () => {
  withEnv(HOME, () => {
    assert.strictEqual(resolveGrantedCwd({ prompt: 'hi', cwd: '   ' }), path.resolve(HOME));
  });
});

console.log(passed === 10 ? `全部通过 (${passed}/10)` : `有失败 (${passed}/10)`);
