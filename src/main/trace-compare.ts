// 轨迹反事实对比(2026-11)。
//
// 同一个任务,两次运行(A/B)到底差在哪:谁少走了几步、谁多调了哪些工具、
// 哪一步开始分叉、失败次数与成本差多少。这不是"看起来更好",而是可复算的差异。
//
// 纯函数 + 只做 type-only 依赖(不引 store 运行时),因此可以被 scripts/trace-diff.mjs
// 用 esbuild 单独打包运行,也能直接单测。
import type { EventRow } from './store';
import type { ConvEvent } from '../shared/types';

export interface TraceStep {
  tool: string;
  ok: boolean;
  argsChars?: number;
  resultChars?: number;
  durationMs?: number;
}

export interface TraceLike {
  id?: string;
  steps: TraceStep[];
  tokensIn: number;
  tokensOut: number;
  costUSD: number;
  answerChars: number;
  turnErrors: number;
  durationMs: number;
}

export interface TraceSummary {
  id: string;
  steps: number;
  toolCalls: number;
  failures: number;
  tokensIn: number;
  tokensOut: number;
  costUSD: number;
  answerChars: number;
  turnErrors: number;
  durationMs: number;
  distinctTools: string[];
}

export interface TraceDiff {
  a: TraceSummary;
  b: TraceSummary;
  /** b - a */
  stepDelta: number;
  failureDelta: number;
  costDelta: number;
  tokenDelta: number;
  answerCharsDelta: number;
  /** 只在 A 里出现过的工具(按出现次数扣减) */
  toolsOnlyA: string[];
  toolsOnlyB: string[];
  /** 逐步对齐的差异(长度 = max(steps)) */
  sequence: Array<{ index: number; a: string | null; b: string | null; same: boolean }>;
  /** 第一次分叉的下标(null = 工具序列完全一致) */
  firstDivergence: number | null;
  verdict: 'same' | 'better' | 'worse' | 'mixed';
  notes: string[];
}

function summary(t: TraceLike): TraceSummary {
  const steps = t.steps ?? [];
  const tools = steps.map((s) => s.tool);
  return {
    id: t.id ?? '',
    steps: steps.length,
    toolCalls: steps.length,
    failures: steps.filter((s) => s.ok === false).length,
    tokensIn: t.tokensIn || 0,
    tokensOut: t.tokensOut || 0,
    costUSD: t.costUSD || 0,
    answerChars: t.answerChars || 0,
    turnErrors: t.turnErrors || 0,
    durationMs: t.durationMs || 0,
    distinctTools: [...new Set(tools)],
  };
}

/** conv_events → 可对比轨迹。 */
export function traceFromEvents(rows: EventRow[], id?: string): TraceLike {
  const steps: TraceStep[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let costUSD = 0;
  let answerChars = 0;
  let turnErrors = 0;
  let first = 0;
  let last = 0;
  for (const row of rows) {
    if (!first || row.ts < first) first = row.ts;
    if (row.ts > last) last = row.ts;
    const ev = row.data as ConvEvent;
    switch (ev.type) {
      case 'tool/call':
        steps.push({
          tool: String(ev.name ?? 'unknown'),
          ok: ev.outcome !== 'error',
          argsChars: String(ev.args ?? '').length,
          resultChars: String(ev.result ?? '').length,
          durationMs: ev.durationMs,
        });
        break;
      case 'turn/meta':
        costUSD += Number(ev.costUSD) || 0;
        tokensIn += Number(ev.tokensIn) || 0;
        tokensOut += Number(ev.tokensOut) || 0;
        break;
      case 'assistant/message':
        answerChars = Math.max(answerChars, String(ev.text ?? '').length);
        break;
      case 'turn/error':
        turnErrors++;
        break;
      default:
        break;
    }
  }
  return { id, steps, tokensIn, tokensOut, costUSD, answerChars, turnErrors, durationMs: first && last ? last - first : 0 };
}

/** 多集合差:counts(a) - counts(b)。 */
function multisetDiff(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = counts.get(x) ?? 0;
    if (n > 0) counts.set(x, n - 1);
    else if (!out.includes(x)) out.push(x);
  }
  return out;
}

export function compareTraces(a: TraceLike, b: TraceLike): TraceDiff {
  const sa = summary(a);
  const sb = summary(b);
  const seqA = (a.steps ?? []).map((s) => s.tool);
  const seqB = (b.steps ?? []).map((s) => s.tool);
  const len = Math.max(seqA.length, seqB.length);
  const sequence: TraceDiff['sequence'] = [];
  let firstDivergence: number | null = null;
  for (let i = 0; i < len; i++) {
    const ta = seqA[i] ?? null;
    const tb = seqB[i] ?? null;
    const same = ta === tb;
    if (!same && firstDivergence === null) firstDivergence = i;
    sequence.push({ index: i, a: ta, b: tb, same });
  }

  const notes: string[] = [];
  if (firstDivergence === null) notes.push('工具序列完全一致(逐项同名)。');
  else notes.push(`第 ${firstDivergence + 1} 步开始分叉:${seqA[firstDivergence] ?? '(无)'} → ${seqB[firstDivergence] ?? '(无)'}。`);
  if (sa.failures !== sb.failures) notes.push(`失败工具调用: ${sa.failures} → ${sb.failures}(${sb.failures < sa.failures ? '减少' : '增加'})。`);
  if (sa.steps !== sb.steps) notes.push(`步数: ${sa.steps} → ${sb.steps}。`);
  if (Math.abs(sb.costUSD - sa.costUSD) > 1e-9) notes.push(`成本: $${sa.costUSD.toFixed(4)} → $${sb.costUSD.toFixed(4)}。`);
  const onlyA = multisetDiff(seqA, seqB);
  const onlyB = multisetDiff(seqB, seqA);
  if (onlyA.length) notes.push(`仅 A 使用的工具: ${onlyA.join(', ')}。`);
  if (onlyB.length) notes.push(`仅 B 使用的工具: ${onlyB.join(', ')}。`);
  if (sa.answerChars !== sb.answerChars) notes.push(`最终答复长度: ${sa.answerChars} → ${sb.answerChars} 字符。`);

  let verdict: TraceDiff['verdict'] = 'mixed';
  if (firstDivergence === null && sa.failures === sb.failures && Math.abs(sb.costUSD - sa.costUSD) < 1e-9) {
    verdict = 'same';
  } else if (sb.failures < sa.failures) {
    verdict = 'better';
  } else if (sb.failures > sa.failures) {
    verdict = 'worse';
  } else if (sb.steps < sa.steps && sb.costUSD <= sa.costUSD + 1e-9) {
    verdict = 'better';
  } else if (sb.steps > sa.steps || sb.costUSD > sa.costUSD + 1e-9) {
    verdict = 'worse';
  }

  return {
    a: sa,
    b: sb,
    stepDelta: sb.steps - sa.steps,
    failureDelta: sb.failures - sa.failures,
    costDelta: sb.costUSD - sa.costUSD,
    tokenDelta: (sb.tokensIn + sb.tokensOut) - (sa.tokensIn + sa.tokensOut),
    answerCharsDelta: sb.answerChars - sa.answerChars,
    toolsOnlyA: onlyA,
    toolsOnlyB: onlyB,
    sequence,
    firstDivergence,
    verdict,
    notes,
  };
}

const VERDICT_LABEL: Record<TraceDiff['verdict'], string> = {
  same: '一致',
  better: 'B 更好',
  worse: 'B 更差',
  mixed: '各有取舍',
};

export function formatTraceDiff(d: TraceDiff): string {
  const lines = [
    `A: ${d.a.id || '(未命名)'} · ${d.a.steps} 步 · ${d.a.failures} 次失败 · $${d.a.costUSD.toFixed(4)} · 答复 ${d.a.answerChars} 字符`,
    `B: ${d.b.id || '(未命名)'} · ${d.b.steps} 步 · ${d.b.failures} 次失败 · $${d.b.costUSD.toFixed(4)} · 答复 ${d.b.answerChars} 字符`,
    `结论: ${VERDICT_LABEL[d.verdict]}`,
    `Δ步数 ${d.stepDelta >= 0 ? '+' : ''}${d.stepDelta} · Δ失败 ${d.failureDelta >= 0 ? '+' : ''}${d.failureDelta} · Δ成本 ${d.costDelta >= 0 ? '+' : ''}$${d.costDelta.toFixed(4)} · Δtokens ${d.tokenDelta >= 0 ? '+' : ''}${d.tokenDelta}`,
    '',
    ...d.notes.map((n) => `- ${n}`),
  ];
  if (d.firstDivergence !== null) {
    lines.push('', '分叉点附近:');
    const start = Math.max(0, d.firstDivergence - 1);
    for (const row of d.sequence.slice(start, start + 6)) {
      lines.push(`  ${String(row.index + 1).padStart(2)}. ${row.same ? '  ' : '≠ '}A=${row.a ?? '—'}  B=${row.b ?? '—'}`);
    }
  }
  return lines.join('\n');
}
