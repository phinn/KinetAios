// 记忆睡眠期固化:晋升/降权/合并/调度闸的判定必须稳定 —— 这些规则直接改用户的长期记忆。
import { assert, test, run } from './harness';
import { shouldPromote, shouldDemote, mergePromoted, canRunSleep, MIN_GAP_MS } from '../../src/main/memory-sleep';

test('晋升:importance ≥ 8 且被 recall ≥ 3 次才固化', () => {
  assert.equal(shouldPromote({ importance: 8, useCount: 3 }), true);
  assert.equal(shouldPromote({ importance: 7, useCount: 9 }), false, '重要度不够不能晋升');
  assert.equal(shouldPromote({ importance: 9, useCount: 2 }), false, '只命中两次还不算反复有用');
});

test('降权:30 天未用 + 从未召回 + importance > 1', () => {
  assert.equal(shouldDemote({ importance: 5, useCount: 0, ageDays: 30 }), true);
  assert.equal(shouldDemote({ importance: 5, useCount: 1, ageDays: 90 }), false, '用过就不能降');
  assert.equal(shouldDemote({ importance: 1, useCount: 0, ageDays: 90 }), false, '已到底不再降');
  assert.equal(shouldDemote({ importance: 5, useCount: 0, ageDays: 29 }), false, '未满 30 天先不动');
});

test('合并下沉:重复/包含关系不重复写入,超限从头部整行淘汰', () => {
  const current = '- 用户偏好 TypeScript\n- 默认用 pnpm';
  const merged = mergePromoted(current, [
    '用户偏好 TypeScript。', // 标点归一后重复
    '默认用 pnpm 安装依赖', // 包含旧行 → 视为重复
    '项目使用 Electron + React',
  ], 1000);
  assert.equal(merged.added, 1);
  assert.ok(merged.value.includes('Electron + React'));
  assert.equal(merged.value.match(/TypeScript/g)?.length, 1, '不能写两份 TypeScript');

  const shifted = mergePromoted('- 很旧的一条\n- 次旧\n- 新的一条', [], 8);
  assert.ok(shifted.value.length <= 8);
  assert.ok(shifted.value.includes('新的一条'), '超限时保留最新尾部');
  assert.ok(!shifted.value.includes('很旧'));
});

test('调度闸:忙/间隔不足/并发都跳过,force 只绕过前两者', () => {
  const now = 1_000_000_000;
  assert.equal(canRunSleep({ lastRunAt: 0, now }).ok, true);
  assert.equal(canRunSleep({ lastRunAt: now - 1000, now }).ok, false, '30 分钟内不重复跑');
  assert.equal(canRunSleep({ lastRunAt: now - 1000, now, force: true }).ok, true);
  assert.equal(canRunSleep({ lastRunAt: 0, now, busy: true }).ok, false);
  assert.equal(canRunSleep({ lastRunAt: 0, now, busy: true, force: true }).ok, true);
  const conc = canRunSleep({ lastRunAt: 0, now, running: true, force: true });
  assert.ok(!conc.ok && conc.reason === 'already-running', '并发必须挡住,force 也不行');
  assert.ok(MIN_GAP_MS >= 10 * 60_000);
});

run();
