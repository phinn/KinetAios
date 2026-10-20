// Ralph 验收门:任务级确定性验收(区别于个体的步骤级断言 gate)。
// 断言全走 AssertionDsl(与 V5 基因断言同一套 DSL),不经 LLM —— 模型无法说服验收门,
// 这是防 Goodhart 的根。文件类断言(file_exists/regex_file_contains)显式带 cwd 解析,
// 供「验收写产物到磁盘」类任务用;输出类断言看 bodyplan 最后一次工具输出。
import fs from 'node:fs';
import path from 'node:path';
import type { AssertionGene, Genome } from './phylum-types';
import type { BodyPlanResult } from './bodyplan';

export interface AcceptanceSpec {
  /** 全部通过才算验收过(AND 语义;OR 用多条 spec 分多次跑表达)。 */
  assertions: ReadonlyArray<AssertionGene['check']>;
}

export interface AcceptanceFail {
  id: string;
  describe: string;
}

export interface AcceptanceVerdict {
  pass: boolean;
  failed: AcceptanceFail[];
}

/** 断言的人类可读描述(注入下一轮反馈用,短句、指向明确)。 */
export function describeCheck(c: AssertionGene['check'], cwd: string): string {
  switch (c.type) {
    case 'exit_code_eq': return `最后一个 shell 工具退出码应为 ${c.value}`;
    case 'regex_contains': return `最后工具输出应匹配正则 /${c.pattern}/`;
    case 'output_not_empty': return '最后工具输出不能为空';
    case 'line_count_gt': return `最后工具输出应多于 ${c.value} 行`;
    case 'file_exists': return `文件必须存在:${path.isAbsolute(c.path) ? c.path : path.join(cwd, c.path)}`;
    case 'file_line_count_gt': return `文件 ${c.path} 行数应多于 ${c.value}`;
    case 'regex_file_contains': return `文件 ${c.path} 内容应匹配 /${c.pattern}/`;
  }
}

/** 裁决一次验收。纯函数:不写盘、不改状态,只读 cwd 下的产物文件。
 *  产物观测点与 Universe grader 同源:bodyplan 的 lastOutput(最后一次工具输出);
 *  exit code 编码在输出尾部的 [exit:N](bodyplan.exitCodeOf 同款解析)。 */
export function evaluateAcceptance(
  spec: AcceptanceSpec, cwd: string, result: BodyPlanResult,
): AcceptanceVerdict {
  const failed: AcceptanceFail[] = [];
  const m = /\[exit:(-?\d+)\]\s*$/.exec(result.lastOutput);
  const lastTool = { name: '', output: result.lastOutput, exitCode: m ? parseInt(m[1], 10) : undefined };

  for (let i = 0; i < spec.assertions.length; i++) {
    const c = spec.assertions[i];
    const id = `A${i + 1}`;
    const ok = checkOne(c, cwd, lastTool);
    if (!ok) failed.push({ id, describe: describeCheck(c, cwd) });
  }
  return { pass: failed.length === 0, failed };
}

function checkOne(
  c: AssertionGene['check'], cwd: string,
  lastTool: { name: string; output: string; exitCode?: number },
): boolean {
  switch (c.type) {
    case 'exit_code_eq':
      return lastTool.exitCode !== undefined && lastTool.exitCode === c.value;
    case 'regex_contains':
      return new RegExp(c.pattern).test(lastTool.output);
    case 'output_not_empty':
      return !!lastTool.output.trim();
    case 'line_count_gt':
      return lastTool.output.split('\n').length > c.value;
    case 'file_exists': {
      const p = path.isAbsolute(c.path) ? c.path : path.resolve(cwd, c.path);
      return fs.existsSync(p);
    }
    case 'file_line_count_gt': {
      const p = path.isAbsolute(c.path) ? c.path : path.resolve(cwd, c.path);
      try {
        return fs.readFileSync(p, 'utf8').split('\n').length > c.value;
      } catch {
        return false;
      }
    }
    case 'regex_file_contains': {
      const p = path.isAbsolute(c.path) ? c.path : path.resolve(cwd, c.path);
      try {
        return new RegExp(c.pattern).test(fs.readFileSync(p, 'utf8'));
      } catch {
        return false;
      }
    }
  }
}
