// Ralph 验收门:任务级确定性验收(区别于个体的步骤级断言 gate)。
// 断言判定本身在 ../assertions.ts(与意图契约 / 基因断言共用同一套 DSL),这里只负责
// 把 bodyplan 的产物映射成"最后一个工具输出 + 退出码"并给出裁决。
// 模型无法说服验收门,这是防 Goodhart 的根。
import type { AssertionGene } from './phylum-types';
import type { BodyPlanResult } from './bodyplan';
import { evaluateChecks, parseExitCode } from '../assertions';

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

/** 断言的人类可读描述(保留原有导出路径;实现已收敛到 assertions.ts)。 */
export { describeCheck } from '../assertions';

/** 裁决一次验收。纯函数:不写盘、不改状态,只读 cwd 下的产物文件。
 *  产物观测点与 Universe grader 同源:bodyplan 的 lastOutput(最后一次工具输出);
 *  exit code 编码在输出尾部(真实 shell 是 [exit 0],实验 runner 是 [exit:0],
 *  由 assertions.parseExitCode 统一解析)。 */
export function evaluateAcceptance(
  spec: AcceptanceSpec, cwd: string, result: BodyPlanResult,
): AcceptanceVerdict {
  const lastTool = {
    name: '',
    output: result.lastOutput,
    exitCode: parseExitCode(result.lastOutput),
  };
  return evaluateChecks(spec.assertions, cwd, lastTool);
}
