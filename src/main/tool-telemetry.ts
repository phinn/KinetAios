// 工具级遥测 —— 把一次工具执行的结果压成 {outcome, errorKind, errorSummary}。
// 纯函数、零运行时依赖:AgentLoop 在发 tool 事件时调用,事件落库(conv_events.tool/call)
// 后即可按「工具 × 错误类」聚合错误率。此前只有 outcome 三档 —— 能回答"哪个工具失败",
// 回答不了"为什么失败"(2026-11 体检:85% 的工具错误是上游 429,其余才是工具本身的问题)。
import type { ToolErrorKind, ToolOutcome } from '../shared/types';

export interface ToolTelemetry {
  outcome: ToolOutcome;
  /** 仅 outcome='error' 时有值 */
  errorKind?: ToolErrorKind;
  /** 一行可读摘要(已脱敏/截断),仅 error 时有值 */
  errorSummary?: string;
}

// 工具自报失败的前缀 → 错误类。顺序有意义(更具体的在前)。
// 这些前缀就是工具返回的第一句,startsWith 不会误伤正文里引用同款文案的结果。
const FAIL_PREFIXES: Array<[string, ToolErrorKind]> = [
  ['未找到要替换的片段', 'edit_mismatch'],
  ['读不到:', 'not_found'],
  ['文件不存在:', 'not_found'],
  ['文件为空:', 'bad_args'],
  ['缺少 path', 'bad_args'],
  ['缺少 old_string', 'bad_args'],
  ['写入失败:', 'io'],
  ['文件超过 50MB 上限:', 'unsupported'],
  ['不支持的文件类型:', 'unsupported'],
  ['拒绝编辑二进制文件:', 'unsupported'],
  ['拒绝覆盖二进制文件:', 'unsupported'],
  ['该文件是 UTF-16 编码', 'unsupported'],
];

const PERMISSION_RE = /(EACCES|EPERM|permission denied|access denied|权限不足|没有权限)/i;

// 结果头部(shell 以超时文案起头;codemode 包在「✅ 完成。」之后,实测位置 < 60 字符)。
// 全文匹配会误伤「正文引用了这段文案」的成功调用(2026-11-20 17:23 事故)。
const HEAD_LEN = 200;

/**
 * 一次工具执行的遥测判定。判定基于工具返回的**原始**文本(截图伪装/UI 截断不影响)。
 * 只认本仓工具约定的固定前缀;工具把错误当正常业务结果返回时(如 grep 无命中)仍算 ok。
 */
export function toolTelemetryOf(result: string): ToolTelemetry {
  if (result === '[已停止]' || result.startsWith('[已停止]')) return { outcome: 'aborted' };
  const head = result.slice(0, HEAD_LEN);
  const fail = (errorKind: ToolErrorKind): ToolTelemetry => ({
    outcome: 'error',
    errorKind,
    errorSummary: summarizeToolError(result),
  });

  if (result.startsWith('工具出错:')) return fail('exception');
  if (result.startsWith('未知工具:')) return fail('unknown_tool');
  if (result.startsWith('⚠️ 参数')) return fail('bad_args');
  if (head.includes('[超时(') || head.includes('⏳ 超时')) return fail('timeout');
  if (/^\[exit \d+\]/.test(result)) return fail('exit_code');
  for (const [prefix, kind] of FAIL_PREFIXES) {
    if (result.startsWith(prefix)) return fail(kind);
  }
  // 工具自报的 ❌ 里可能混着权限类,先把权限单独归类,便于区分"环境没给权"和"工具逻辑失败"。
  if (PERMISSION_RE.test(head)) return fail('permission');
  if (result.startsWith('❌')) return fail('reported');
  return { outcome: 'ok' };
}

/**
 * 错误摘要:去掉 ANSI 色码与截图 base64 载荷,取第一行有内容的文本,压平空白后截断。
 * 存在的意义是「不看完整 result 也能一眼看出失败原因」,不做语义判断。
 */
export function summarizeToolError(result: string, max = 160): string {
  const text = result
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/__IMAGE_BASE64__:[\s\S]*/, '[image]');
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
