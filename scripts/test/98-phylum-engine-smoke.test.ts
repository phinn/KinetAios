// 98-phylum-engine-smoke.test.ts — V5 插件引擎接线烟囱
// 走真实启动路径:loadPlugins(dev 模式扫 repo plugins/)→ buildEngines → 断言 directV5 已注册且能出 label。
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { loadPlugins } from '../../src/main/plugins';
import { buildEngines } from '../../src/main/engines';

test('phylum-engine 插件解析出 directV5 并注册进引擎表', () => {
  // 1) 真实 loader(dev 模式:__dirname 在 dist,会扫 <repo>/plugins/)
  const plugins = loadPlugins();
  const phylum = plugins.find((p) => p.manifest.name === 'phylum-engine');
  assert.ok(phylum, 'phylum-engine 应被 loader 发现');
  assert.ok(!phylum.error, `插件不应有加载错误: ${phylum.error ?? ''}`);
  const eng = phylum.manifest.engine as { id: string; builtin: boolean } | undefined;
  assert.equal(eng?.id, 'directV5');
  assert.equal(eng?.builtin, true);

  // 1.5) 引擎合法性(与 pluginList 同判据:bin-less 内置开关型,有 id 即合法)
  assert.ok(eng && typeof eng.id === 'string' && eng.id.trim(), 'bin-less 内置开关型 spec 必须有 id');

  // 2) 真实引擎表(directV5 仅在插件在场时注册,与 legis 同模式)
  const engines = buildEngines(async () => true);
  const v5 = engines.get('directV5');
  assert.ok(v5, 'directV5 应注册进引擎表');
  assert.equal(v5!.name, 'directV5');

  // 3) releaseConv 可选契约存在(会话级基因账本回收)
  assert.equal(typeof (v5 as { releaseConv?: unknown }).releaseConv, 'function');
});

run();
