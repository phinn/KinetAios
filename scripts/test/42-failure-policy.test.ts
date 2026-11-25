// 归因 → 策略:每类失败必须有明确、可执行的下一步;没有可动作的失败不许乱加指令。
import { assert, test, run } from './harness';
import {
  decideFailureResponse, pushFailureDirective, pullFailureDirective,
  cooldownTool, isToolCoolingDown, clearFailureState,
} from '../../src/main/failure-policy';

test('单点工具失败 → 避坑指令,不冷却(偶发失败很常见)', () => {
  const d = decideFailureResponse({ tags: ['fail:tool:shell'] });
  assert.ok(d.directive?.includes('shell'), '指令要点名失败的工具');
  assert.equal(d.cooldown, null);
  assert.equal(d.retry, null);
});

test('规划发散 / retry-storm → 收敛指令 + 停用问题工具', () => {
  const storm = decideFailureResponse({ tags: ['fail:plan:max-turns', 'fail:tool:retry-storm'] });
  assert.ok(storm.directive?.includes('3 步'), '要有收敛动作');
  assert.equal(storm.cooldown, null, 'retry-storm 是合成标记,不是可停用的真实工具');

  const plain = decideFailureResponse({ tags: ['fail:plan:max-turns', 'fail:tool:shell'] });
  assert.equal(plain.cooldown?.tool, 'shell', 'retry-storm 应停用真实的失败工具');
});

test('上游抖动 → 有限自动重试,用完后明确收手', () => {
  const a1 = decideFailureResponse({ tags: ['fail:env:transient'], transientAttempt: 0 });
  assert.equal(a1.retry?.attempt, 1);
  assert.equal(a1.retry?.delayMs, 2000);

  const a2 = decideFailureResponse({ tags: ['fail:env:transient'], transientAttempt: 1 });
  assert.equal(a2.retry?.delayMs, 4000, '退避要翻倍');

  const done = decideFailureResponse({ tags: ['fail:env:transient'], transientAttempt: 2 });
  assert.equal(done.retry, null, '达到上限必须停,不能无限重试');
  assert.ok(done.directive?.includes('重试已用完'));
});

test('鉴权失败不重试,指向配置而不是任务', () => {
  const d = decideFailureResponse({ tags: ['fail:env:auth'] });
  assert.equal(d.retry, null);
  assert.ok(/API Key|baseURL/.test(d.directive ?? ''));
});

test('上下文溢出 → 压缩式工作指令', () => {
  const d = decideFailureResponse({ tags: ['fail:context:overflow'] });
  assert.ok(/start_line|压缩/.test(d.directive ?? ''));
  assert.equal(d.retry, null);
});

test('没调工具就报错 → 强制取证', () => {
  const d = decideFailureResponse({ tags: ['fail:model:no-tool'] });
  assert.ok(d.directive?.includes('工具'));
});

test('用户停止 / unmet 不自动应对', () => {
  for (const tags of [['fail:user:stop'], ['fail:unknown:unmet'], []]) {
    const d = decideFailureResponse({ tags });
    assert.equal(d.directive, null);
    assert.equal(d.retry, null);
    assert.equal(d.cooldown, null);
  }
});

test('复盘指令一次性消费;工具冷却到点自动解除', () => {
  const id = 'conv-test';
  pushFailureDirective(id, '复盘 A');
  pushFailureDirective(id, '复盘 B'); // latest-wins
  assert.equal(pullFailureDirective(id), '复盘 B');
  assert.equal(pullFailureDirective(id), null, '取走即清除');

  cooldownTool(id, 'shell', 1000, 10_000);
  assert.equal(isToolCoolingDown(id, 'shell', 10_500), true);
  assert.equal(isToolCoolingDown(id, 'shell', 11_001), false, '到期必须自动解除');
  assert.equal(isToolCoolingDown(id, 'read_file', 10_500), false);

  cooldownTool(id, 'shell', 1000, 10_000);
  pushFailureDirective(id, '残留');
  clearFailureState(id);
  assert.equal(isToolCoolingDown(id, 'shell', 10_500), false);
  assert.equal(pullFailureDirective(id), null);
});

run();
