// 使用统计格式化:文案必须走 tr(不再硬编码中文),阈值提示正确。
import { assert, test, run } from './harness';
import { formatUsageStats } from '../../src/shared/usage-format';
import type { UsageStats } from '../../src/shared/types';

const tr = (k: string, p?: Record<string, string | number>) => `${k}${p ? JSON.stringify(p) : ''}`;

function stats(editRate: number, withTools = true): UsageStats {
  return {
    days: 7,
    turnErrors: 3,
    rateLimited: 2,
    costUSD: 1.5,
    toolCalls: 10,
    toolCallsMeasured: 8,
    toolErrors: 2,
    toolErrorRate: 0.25,
    tools: withTools
      ? [{ name: 'edit_file', calls: 5, measured: 4, errors: 1, rate: editRate, kinds: { edit_mismatch: 1 } }]
      : [],
  };
}

test('所有文案都来自 tr 键(无硬编码中文)', () => {
  const out = formatUsageStats(stats(0.02), tr);
  assert.ok(out.includes('usage.summary'), out);
  assert.ok(out.includes('usage.topTools'));
  assert.ok(out.includes('usage.totalCalls'));
  assert.ok(out.includes('usage.note'));
  assert.ok(!/错误最多|口径:/.test(out), '不应残留中文硬编码');
});

test('edit_file 阈值提示:<=1% / 中间 / >3%', () => {
  assert.ok(formatUsageStats(stats(0.005), tr).includes('usage.editLow'));
  assert.ok(formatUsageStats(stats(0.02), tr).includes('usage.editRate'));
  assert.ok(formatUsageStats(stats(0.05), tr).includes('usage.editHigh'));
});

test('无工具记录时走 empty 文案', () => {
  const out = formatUsageStats(stats(0, false), tr);
  assert.ok(out.includes('usage.empty'));
  assert.ok(!out.includes('usage.topTools'));
});

run();
