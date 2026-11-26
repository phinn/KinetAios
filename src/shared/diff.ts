// 行级 unified diff(零依赖),用于快照预览:告诉用户"回滚会改掉什么"。
// 大文件不做完整 LCS(内存/耗时不可控):超过阈值就退化成"改动过大"摘要,
// 只展示首尾各若干行 —— 预览宁可粗略,不能把主进程卡住。
export interface DiffResult {
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
}

const MAX_MIDDLE_PRODUCT = 4_000_000; // LCS 表规模上限(约 2000×2000)
const MAX_OUTPUT_LINES = 400;

function splitLines(s: string): string[] {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function lcsOps(a: string[], b: string[]): Array<{ op: ' ' | '-' | '+'; line: string }> {
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  const ops: Array<{ op: ' ' | '-' | '+'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ op: ' ', line: a[i] }); i++; j++; }
    else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) { ops.push({ op: '-', line: a[i] }); i++; }
    else { ops.push({ op: '+', line: b[j] }); j++; }
  }
  while (i < n) ops.push({ op: '-', line: a[i++] });
  while (j < m) ops.push({ op: '+', line: b[j++] });
  return ops;
}

/** 生成 a→b 的 unified diff(context=3)。文件名参数只用于 hunk 头展示。 */
export function unifiedDiff(before: string, after: string, opts?: { label?: string; context?: number }): DiffResult {
  const label = opts?.label ?? 'file';
  const ctx = opts?.context ?? 3;
  const a = splitLines(before);
  const b = splitLines(after);

  // 相同前缀/后缀先剪掉,像"改了几行"的常见情况就只剩很小的中间段。
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  if ((midA.length + 1) * (midB.length + 1) > MAX_MIDDLE_PRODUCT) {
    return {
      text: `--- a/${label}\n+++ b/${label}\n改动过大(${a.length} → ${b.length} 行),不展开逐行 diff。\n`
        + `前 ${Math.min(20, a.length)} 行(改动前):\n${a.slice(0, 20).map((l) => `  ${l}`).join('\n')}\n…\n`
        + `当前文件:${b.length} 行。建议直接用编辑器对比,或确认回滚。`,
      added: 0,
      removed: 0,
      truncated: true,
    };
  }

  const mid = lcsOps(midA, midB);
  // 拼回"上下文 + 中间段 + 上下文"的原始操作序列
  const ops: Array<{ op: ' ' | '-' | '+'; line: string }> = [
    ...a.slice(0, pre).map((line) => ({ op: ' ' as const, line })),
    ...mid,
    ...a.slice(a.length - suf).map((line) => ({ op: ' ' as const, line })),
  ];

  const changes = ops.filter((o) => o.op !== ' ').length;
  if (!changes) return { text: '（内容相同,回滚不会改变文件）', added: 0, removed: 0, truncated: false };

  // 只输出有改动的 hunk(前后各 ctx 行上下文)
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op !== ' ') {
      for (let k = Math.max(0, i - ctx); k <= Math.min(ops.length - 1, i + ctx); k++) keep[k] = true;
    }
  });

  const out: string[] = [`--- a/${label}`, `+++ b/${label}`];
  let added = 0;
  let removed = 0;
  let truncated = false;
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) { i++; continue; }
    const start = i;
    while (i < ops.length && keep[i]) i++;
    const hunk = ops.slice(start, i);
    // hunk 头里用近似行号:两侧各自的起始行号
    const beforeStart = ops.slice(0, start).filter((o) => o.op !== '+').length + 1;
    const afterStart = ops.slice(0, start).filter((o) => o.op !== '-').length + 1;
    out.push(`@@ -${beforeStart},${hunk.filter((o) => o.op !== '+').length} +${afterStart},${hunk.filter((o) => o.op !== '-').length} @@`);
    for (const o of hunk) {
      if (o.op === '+') added++;
      else if (o.op === '-') removed++;
      out.push(`${o.op}${o.line}`);
    }
    if (out.length > MAX_OUTPUT_LINES) { truncated = true; break; }
  }
  if (truncated) out.push('…(diff 过长,已截断)');
  return { text: out.join('\n'), added, removed, truncated };
}
