// 使用统计的人话渲染(纯函数,main 工具与设置页共用)。数据来源 store.usageStats。
import type { UsageStats } from './types';

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

export function formatUsageStats(s: UsageStats): string {
  const lines: string[] = [];
  lines.push(`近 ${s.days} 天:工具 ${s.toolCalls} 次(有结论 ${s.toolCallsMeasured})· 错误 ${s.toolErrors} 次(${pct(s.toolErrorRate)})· 轮错误 ${s.turnErrors}(限流 ${s.rateLimited})· 成本 $${s.costUSD.toFixed(2)}`);
  if (!s.tools.length) {
    lines.push('还没有工具调用记录。');
    return lines.join('\n');
  }
  lines.push('\n错误最多的工具(错误数/有结论调用数):');
  s.tools.forEach((t, i) => {
    const kinds = Object.entries(t.kinds)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, n]) => `${k}×${n}`)
      .join(', ');
    lines.push(`${i + 1}. ${t.name}  ${t.errors}/${t.measured}  ${pct(t.rate)}  总调用 ${t.calls}${kinds ? `  [${kinds}]` : ''}`);
  });
  const edit = s.tools.find((t) => t.name === 'edit_file');
  if (edit) {
    lines.push(`\nedit_file 返工率:${pct(edit.rate)}(${edit.errors}/${edit.measured})${edit.rate <= 0.01 ? ' — 模糊匹配生效,已低于 1%' : edit.rate > 0.03 ? ' — 仍偏高,考虑补上下文或改用 patch 模式' : ''}`);
  }
  lines.push('\n口径:只统计有 outcome 的调用(遥测上线后的数据);老事件没有结论,不计入错误率分母。');
  return lines.join('\n');
}
