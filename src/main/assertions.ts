// 可执行断言(2026-11):同一套确定性 DSL 服务三个场景 ——
//   ① V5 基因断言(每步工具输出)② V5 Ralph 任务验收 ③ 意图契约(intent_done)
// 全部是确定性检查,不经 LLM;文件类按 cwd 解析。抽到中性模块是因为意图账本
// 不该依赖 V5 引擎内部实现(V5 通过 re-export 保持原有 import 不变)。
import fs from 'node:fs';
import path from 'node:path';

/** 断言类型 DSL:全是确定性检查,不经 LLM 之手(防幻觉遗传的第一道闸)。
 *  file_* 三个类型会读磁盘(每步读盘成本不可控,目前在验收/意图完成时才用)。 */
export type AssertionDsl =
  | { type: 'exit_code_eq'; value: number }                              // 最后一个 shell 的退出码
  | { type: 'regex_contains'; pattern: string }                          // 对最后一个 shell 的输出
  | { type: 'output_not_empty' }                                         // 最后一个 shell 的输出非空
  | { type: 'line_count_gt'; value: number }                             // 最后一个 shell 的输出行数
  | { type: 'file_exists'; path: string }                                // cwd 内相对/绝对路径
  | { type: 'regex_file_contains'; path: string; pattern: string }        // 文件内容
  | { type: 'file_line_count_gt'; path: string; value: number };          // 文件行数

/** 一次判定最多接受的断言条数:契约是"完成定义",不是测试套件。 */
export const ASSERTION_MAX = 6;
const MAX_PATTERN = 500;
const MAX_PATH = 400;

/** 被判定对象:最后一个 shell 类工具的输出 + 退出码(非 shell 场景退出码为 undefined)。 */
export interface LastToolOutput {
  name: string;
  output: string;
  exitCode?: number;
}

export interface CheckFailure {
  id: string;
  describe: string;
  /** 实际观测值(拒绝文案里给模型看,避免它猜"到底差在哪") */
  actual: string;
}

export interface CheckVerdict {
  pass: boolean;
  failed: CheckFailure[];
}

/**
 * 从 shell 类工具输出尾部解析退出码。两种历史格式并存:
 *   tools.ts 的 shell → "[exit 0]" / V5 实验 runner → "[exit:0]"。
 * 曾经两边各写一份正则且只认冒号格式,导致真实 shell 的验收永远失败。
 */
export function parseExitCode(output: string): number | undefined {
  const m = /\[exit[:\s]\s*(-?\d+)\]\s*$/.exec(output.trimEnd());
  return m ? parseInt(m[1], 10) : undefined;
}

/** 断言的人类可读描述(注入拒绝文案/反馈用,短句、指向明确)。 */
export function describeCheck(c: AssertionDsl, cwd: string): string {
  switch (c.type) {
    case 'exit_code_eq': return `最后一个 shell 退出码应为 ${c.value}`;
    case 'regex_contains': return `最后 shell 输出应匹配正则 /${c.pattern}/`;
    case 'output_not_empty': return '最后 shell 输出不能为空';
    case 'line_count_gt': return `最后 shell 输出应多于 ${c.value} 行`;
    case 'file_exists': return `文件必须存在:${resolvePath(cwd, c.path)}`;
    case 'file_line_count_gt': return `文件 ${c.path} 行数应多于 ${c.value}`;
    case 'regex_file_contains': return `文件 ${c.path} 内容应匹配 /${c.pattern}/`;
  }
}

function resolvePath(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 单条断言判定。纯函数(read-only 磁盘访问),失败时给出实际观测值。 */
export function checkOne(
  c: AssertionDsl,
  cwd: string,
  last: LastToolOutput,
): { ok: boolean; actual: string } {
  switch (c.type) {
    case 'exit_code_eq': {
      const actual = last.exitCode === undefined ? '未观测到退出码' : `退出码 ${last.exitCode}`;
      return { ok: last.exitCode !== undefined && last.exitCode === c.value, actual };
    }
    case 'regex_contains': {
      let ok = false;
      try {
        ok = new RegExp(c.pattern).test(last.output);
      } catch {
        return { ok: false, actual: `正则无效 /${c.pattern}/` };
      }
      return { ok, actual: `输出 ${last.output.length} 字符` };
    }
    case 'output_not_empty':
      return { ok: !!last.output.trim(), actual: last.output.trim() ? `输出 ${last.output.length} 字符` : '输出为空' };
    case 'line_count_gt': {
      const lines = last.output.split('\n').length;
      return { ok: lines > c.value, actual: `${lines} 行` };
    }
    case 'file_exists': {
      const p = resolvePath(cwd, c.path);
      const exists = fs.existsSync(p);
      return { ok: exists, actual: exists ? '文件存在' : `文件不存在:${p}` };
    }
    case 'file_line_count_gt': {
      const p = resolvePath(cwd, c.path);
      const text = readText(p);
      if (text === null) return { ok: false, actual: `文件不存在/不可读:${p}` };
      const lines = text.split('\n').length;
      return { ok: lines > c.value, actual: `${lines} 行` };
    }
    case 'regex_file_contains': {
      const p = resolvePath(cwd, c.path);
      const text = readText(p);
      if (text === null) return { ok: false, actual: `文件不存在/不可读:${p}` };
      let ok = false;
      try {
        ok = new RegExp(c.pattern).test(text);
      } catch {
        return { ok: false, actual: `正则无效 /${c.pattern}/` };
      }
      return { ok, actual: ok ? '内容匹配' : `内容不匹配(${text.length} 字符)` };
    }
  }
}

/** 逐条判定(AND 语义)。 */
export function evaluateChecks(
  checks: ReadonlyArray<AssertionDsl>,
  cwd: string,
  last: LastToolOutput,
): CheckVerdict {
  const failed: CheckFailure[] = [];
  checks.forEach((c, i) => {
    const r = checkOne(c, cwd, last);
    if (!r.ok) failed.push({ id: `A${i + 1}`, describe: describeCheck(c, cwd), actual: r.actual });
  });
  return { pass: failed.length === 0, failed };
}

/** 校验来自模型的 assertions 参数。严格:未知类型/缺字段/超限一律拒绝并说明原因。 */
export function parseAssertions(input: unknown):
  | { ok: true; assertions: AssertionDsl[] }
  | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, assertions: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'assertions 必须是数组' };
  if (input.length === 0) return { ok: true, assertions: [] };
  if (input.length > ASSERTION_MAX) {
    return { ok: false, error: `断言最多 ${ASSERTION_MAX} 条(收到 ${input.length} 条):契约是完成定义,不是测试套件` };
  }

  const out: AssertionDsl[] = [];
  for (let i = 0; i < input.length; i++) {
    const at = `assertions[${i}]`;
    const raw = input[i];
    if (!raw || typeof raw !== 'object') return { ok: false, error: `${at} 必须是对象` };
    const o = raw as Record<string, unknown>;
    const type = String(o.type ?? '');
    const str = (key: string): string | null => {
      const v = o[key];
      if (typeof v !== 'string' || !v.trim()) return null;
      return v.trim();
    };
    const num = (key: string): number | null => {
      const v = Number(o[key]);
      return Number.isFinite(v) ? v : null;
    };

    switch (type) {
      case 'exit_code_eq': {
        const value = num('value');
        if (value === null) return { ok: false, error: `${at}.value 必须是数字` };
        out.push({ type, value });
        break;
      }
      case 'line_count_gt':
      case 'file_line_count_gt': {
        const value = num('value');
        if (value === null) return { ok: false, error: `${at}.value 必须是数字` };
        if (type === 'line_count_gt') { out.push({ type, value }); break; }
        const p = str('path');
        if (!p) return { ok: false, error: `${at}.path 必须是非空字符串` };
        if (p.length > MAX_PATH) return { ok: false, error: `${at}.path 过长` };
        out.push({ type, value, path: p });
        break;
      }
      case 'regex_contains':
      case 'regex_file_contains': {
        const pattern = str('pattern');
        if (!pattern) return { ok: false, error: `${at}.pattern 必须是非空字符串` };
        if (pattern.length > MAX_PATTERN) return { ok: false, error: `${at}.pattern 过长` };
        try {
          new RegExp(pattern);
        } catch {
          return { ok: false, error: `${at}.pattern 不是合法正则` };
        }
        if (type === 'regex_contains') { out.push({ type, pattern }); break; }
        const p = str('path');
        if (!p) return { ok: false, error: `${at}.path 必须是非空字符串` };
        if (p.length > MAX_PATH) return { ok: false, error: `${at}.path 过长` };
        out.push({ type, pattern, path: p });
        break;
      }
      case 'output_not_empty':
        out.push({ type });
        break;
      case 'file_exists': {
        const p = str('path');
        if (!p) return { ok: false, error: `${at}.path 必须是非空字符串` };
        if (p.length > MAX_PATH) return { ok: false, error: `${at}.path 过长` };
        out.push({ type, path: p });
        break;
      }
      default:
        return {
          ok: false,
          error: `${at}.type 未知: ${type || '(缺失)'}(支持 file_exists / regex_file_contains / file_line_count_gt / exit_code_eq / regex_contains / output_not_empty / line_count_gt)`,
        };
    }
  }
  return { ok: true, assertions: out };
}

/** 从库里的 JSON 还原断言(坏数据不炸库:忽略并返回空)。 */
export function parseStoredAssertions(raw: string | null | undefined): AssertionDsl[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const r = parseAssertions(parsed);
    return r.ok ? r.assertions : [];
  } catch {
    return [];
  }
}
