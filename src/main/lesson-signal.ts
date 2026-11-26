// 失败信号 → lesson 抽取的结构化输入(2026-11)。
//
// 问题:lesson 抽取原先只看「用户 prompt + 助手答复」,模型只能凭叙述自由总结;
// 而真实失败(工具遥测 errorKind、证据闸 / 契约断言的拒绝原因)明明就躺在 turn.steps 里,
// 却没进抽取管道 —— 结果是教训靠编,噪声进记忆。
//
// 这里把一轮的失败压成一段确定性的证据文本,交给既有抽取 prompt:
//   - 只给真实发生过的失败(无失败 → 返回 '',不硬凑);
//   - 同类失败按 errorKind 聚合,细节去重并限条数,防止长日志撑爆 prompt;
//   - 落库仍走 store.addLesson 的内容精确去重,这里不写库。
import type { TaskStep, ToolErrorKind, Turn } from '../shared/types';

const MAX_DIGEST_CHARS = 1_500;
const MAX_FAILED_EXAMPLES = 4;
const MAX_REJECTIONS = 2;
const MAX_LINE = 160;

export type FailureSignalInput = {
  steps?: ReadonlyArray<Pick<TaskStep, 'name' | 'result' | 'outcome' | 'errorKind' | 'errorSummary'>>;
  errorMsg?: string | null;
  errorKind?: Turn['errorKind'];
};

/** 取第一条有信息量的行(跳过纯 [exit N] 标记),截断防刷屏。 */
function firstMeaningfulLine(text: string): string {
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || /^\[exit[: ]?-?\d+\]$/.test(line)) continue;
    return line.slice(0, MAX_LINE);
  }
  return '';
}

/**
 * 汇总一轮的失败信号。返回 '' 表示没有可沉淀的失败 —— 抽取器不应被空信号诱导。
 */
export function failureDigest(input: FailureSignalInput): string {
  const steps = input.steps ?? [];
  const lines: string[] = [];
  const failed = steps.filter((s) => s.outcome === 'error');

  if (failed.length) {
    const byKind = new Map<ToolErrorKind | 'unknown', number>();
    for (const s of failed) {
      const k = s.errorKind ?? 'unknown';
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
    }
    const kinds = [...byKind.entries()].map(([k, n]) => `${k}×${n}`).join(',');
    lines.push(`工具失败 ${failed.length} 次(${kinds});涉及:${[...new Set(failed.map((s) => s.name))].join(',')}`);
    const seen = new Set<string>();
    let shown = 0;
    for (const s of failed) {
      const detail = (s.errorSummary || firstMeaningfulLine(s.result)).trim();
      if (!detail) continue;
      const key = `${s.name}|${detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${s.name}: ${detail.slice(0, MAX_LINE)}`);
      if (++shown >= MAX_FAILED_EXAMPLES) break;
    }
  }

  // 意图完成被拒:模型本以为「做完了」但证据/断言不足 —— 这类 fail 最有教学价值。
  const rejections = steps.filter((s) => s.name === 'intent_done' && /❌|不能完成/.test(s.result ?? ''));
  for (const r of rejections.slice(0, MAX_REJECTIONS)) {
    const reason = (r.result ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- ') || l.startsWith('❌'))
      .slice(0, 3)
      .join(' / ');
    if (reason) lines.push(`- intent_done 被拒绝: ${reason.slice(0, 240)}`);
  }

  const msg = (input.errorMsg ?? '').trim();
  if (msg) lines.push(`- 轮次错误${input.errorKind ? `(${input.errorKind})` : ''}: ${msg.slice(0, 200)}`);

  return lines.join('\n').slice(0, MAX_DIGEST_CHARS);
}
