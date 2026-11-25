// 分布式派发:节点选择必须给出可执行的错误(离线/歧义/不存在),而不是把网络异常抛给模型。
import { assert, test, run } from './harness';
import { pickNode, formatNodeList, remoteJobTitle } from '../../src/main/distributed';

const nodes = [
  { name: 'mac-mini', online: true, toolCount: 30 },
  { name: 'mac-studio', online: false, toolCount: 0 },
  { name: 'linux-box', online: true, toolCount: 30 },
];

test('节点选择:全名 / 大小写 / 唯一子串都能命中', () => {
  assert.deepEqual(pickNode(nodes, 'mac-mini'), { ok: true, name: 'mac-mini' });
  assert.deepEqual(pickNode(nodes, 'MAC-MINI'), { ok: true, name: 'mac-mini' });
  assert.deepEqual(pickNode(nodes, 'studio'), { ok: false, error: '远程节点「mac-studio」当前离线(检查对方应用与 MCP Server 是否在跑)。' });
});

test('节点选择:不存在 / 歧义 / 空列表都给中文可执行错误', () => {
  const missing = pickNode(nodes, 'windows');
  assert.equal(missing.ok, false);
  assert.ok(!missing.ok && missing.error.includes('mac-mini'), '要列出可选节点');

  const ambiguous = pickNode(nodes, 'mac');
  assert.ok(!ambiguous.ok && ambiguous.error.includes('不唯一'));

  const empty = pickNode([], 'any');
  assert.ok(!empty.ok && empty.error.includes('设置'), '空列表要指向配置入口');

  const noArg = pickNode(nodes, '  ');
  assert.ok(!noArg.ok && noArg.error.includes('node'));
});

test('节点列表与 Job 标题:一行可读、长 prompt 截断', () => {
  assert.equal(formatNodeList(nodes), 'mac-mini, mac-studio(离线), linux-box');
  const title = remoteJobTitle('mac-mini', '请把  src/main/JobManager.ts  里的若干个很长很长很长很长很长很长很长的函数重构一下');
  assert.ok(title.startsWith('[@mac-mini] '));
  assert.ok(title.length <= 56, `标题应截断,实际 ${title.length}`);
  assert.ok(!title.includes('  '), '连续空白要归一');
});

run();
