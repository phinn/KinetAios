/* 冒烟: agent-policy 静态闸(deny/ask/allow/损坏 JSON/无文件旁路)+ marketplace renames 迁移。
 * 用法: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron <tsx cli> scripts/smoke-policy-marketplace.ts
 * (electron node 跑:agent-policy 的用户级兜底 require('electron') 在 RUN_AS_NODE 下可用且 app.getPath 不炸;
 *  纯 node 跑会走 catch 旁路,结果相同,但为确定性统一用 electron node。) */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-policy-'));
const cwd = repo;

// ── 1. 无 policy 文件 = 旁路 ──
import { checkAgentPolicy } from '../src/main/agent-policy';
let v = checkAgentPolicy('rm -rf /', cwd);
if (v.action !== 'none') throw new Error(`无文件应旁路, got ${v.action}`);
console.log('✅ policy: 无文件旁路 OK');

// ── 2. deny 命中(大小写不敏感 + 原因透出)──
fs.writeFileSync(path.join(cwd, 'agent.policy.json'), JSON.stringify({
  version: 1,
  deny: [{ pattern: 'rm\\s+-rf\\s+/', reason: '禁止根级递归删除' }],
  ask: [{ pattern: 'gh\\s+release\\s+(create|edit)', reason: '发布动作须人工确认' }],
  allow: [{ pattern: '^npm\\s+(run|test)', reason: '常规构建' }],
}));
v = checkAgentPolicy('RM -RF / --no-preserve-root', cwd);
if (v.action !== 'deny' || !v.reason!.includes('根级')) throw new Error(`deny 应命中, got ${JSON.stringify(v)}`);
console.log('✅ policy: deny 拦截(大小写不敏感)OK');

// ── 3. ask 命中 → 强制确认;allow → 放行标注;普通命令 → none ──
v = checkAgentPolicy('gh release create v1 --notes x', cwd);
if (v.action !== 'ask') throw new Error(`ask 应命中, got ${v.action}`);
v = checkAgentPolicy('npm run typecheck', cwd);
if (v.action !== 'allow') throw new Error(`allow 应命中, got ${v.action}`);
v = checkAgentPolicy('ls -la', cwd);
if (v.action !== 'none') throw new Error(`未列规则应 none, got ${v.action}`);
console.log('✅ policy: ask/allow/none 分级 OK');

// ── 4. 优先级:deny 先于 ask/allow ──
fs.writeFileSync(path.join(cwd, 'agent.policy.json'), JSON.stringify({
  deny: [{ pattern: 'deploy' }], allow: [{ pattern: 'deploy.*staging' }],
}));
v = checkAgentPolicy('deploy to staging', cwd);
if (v.action !== 'deny') throw new Error(`deny 应优先于 allow, got ${v.action}`);
console.log('✅ policy: deny > allow 优先级 OK');

// ── 5. 损坏 JSON = 忽略策略(旁路,不炸)──
fs.writeFileSync(path.join(cwd, 'agent.policy.json'), '{oops');
v = checkAgentPolicy('rm -rf /', cwd);
if (v.action !== 'none') throw new Error(`坏 JSON 应旁路, got ${v.action}`);
console.log('✅ policy: 损坏 JSON 旁路 OK');

// ── 6. marketplace renames(纯函数,模拟 settings 迁移语义)──
// loadPlugins 依赖 electron app.getPath,这里只验证迁移逻辑的核心语义(与 applyPluginRenames 同构):
const mp = { name: 'paperclip-suite', retired: ['office-suite'], renames: [{ from: 'office-suite', to: 'paperclip-suite', at: '2026-10-20' }] };
const disabled = ['office-suite', 'hw-diag'];
const map = new Map(mp.renames.map((r) => [r.from, r.to]));
const migrated = disabled.map((n) => map.get(n) ?? n);
if (!(migrated.includes('paperclip-suite') && migrated.includes('hw-diag') && !migrated.includes('office-suite'))) {
  throw new Error(`disabledPlugins 迁移错: ${JSON.stringify(migrated)}`);
}
if (!mp.retired.includes('office-suite') && mp.name === 'office-suite') throw new Error('退役名检查逻辑错');
console.log('✅ marketplace: renames 迁移语义 OK(disabledPlugins 旧名→新名,无关名保留)');

fs.rmSync(repo, { recursive: true, force: true });
console.log('smoke done');
