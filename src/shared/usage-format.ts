// 使用统计的人话渲染(纯函数,main 工具与设置页共用)。数据来源 store.usageStats。
// 文案走注入的 tr(与界面同一套 i18n),不在数据层硬编码中文。
import type { UsageStats } from './types';

type Tr = (key: string, params?: Record<string, string | number>) => string;

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

export function formatUsageStats(s: UsageStats, tr: Tr): string {
  const lines: string[] = [];
  lines.push(tr('usage.summary', {
    days: s.days,
    calls: s.toolCalls,
    measured: s.toolCallsMeasured,
    errors: s.toolErrors,
    rate: pct(s.toolErrorRate),
    turnErrors: s.turnErrors,
    limited: s.rateLimited,
    cost: s.costUSD.toFixed(2),
  }));
  if (!s.tools.length) {
    lines.push(tr('usage.empty'));
    return lines.join('\n');
  }
  lines.push('');
  lines.push(tr('usage.topTools'));
  s.tools.forEach((t, i) => {
    const kinds = Object.entries(t.kinds)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, n]) => `${k}×${n}`)
      .join(', ');
    lines.push(`${i + 1}. ${t.name}  ${t.errors}/${t.measured}  ${pct(t.rate)}  ${tr('usage.totalCalls', { n: t.calls })}${kinds ? `  [${kinds}]` : ''}`);
  });
  const edit = s.tools.find((t) => t.name === 'edit_file');
  if (edit) {
    const p = { rate: pct(edit.rate), errors: edit.errors, measured: edit.measured };
    lines.push('');
    lines.push(tr(edit.rate <= 0.01 ? 'usage.editLow' : edit.rate > 0.03 ? 'usage.editHigh' : 'usage.editRate', p));
  }
  lines.push('');
  lines.push(tr('usage.note'));
  return lines.join('\n');
}
