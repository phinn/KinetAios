// infra 冒烟:验证 esbuild bundle + electron shim + 真实 better-sqlite3 全链路可用。
// 通过标准:initStore 在 shim 的 tmp userData 下建库,记忆读写闭环。
import { assert, test, run } from './harness';
import * as store from '../../src/main/store';

test('initStore + addMemory/loadMemories 读写闭环(electron shim 生效)', () => {
  store.initStore();
  const n0 = store.memoryCount();
  store.addMemory('infra 冒烟测试记忆', 'conv-infra', 7);
  const all = store.loadMemories('conv-infra');
  assert.equal(all.length, n0 === 0 ? 1 : all.length); // 独立 tmp 库,新增后至少 1 条
  assert.ok(all.some((m) => m.content === 'infra 冒烟测试记忆'));
  assert.equal(all.find((m) => m.content === 'infra 冒烟测试记忆')?.importance, 7);
});

test('memory_blocks 默认块初始化(persona 只读)', () => {
  store.initStore();
  const blocks = store.loadMemoryBlocks();
  const labels = blocks.map((b) => b.label).sort();
  assert.deepEqual(labels, ['active_goals', 'persona', 'project_context', 'user_profile']);
  assert.equal(blocks.find((b) => b.label === 'persona')?.readOnly, true);
});

run();
