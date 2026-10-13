// bodyplan:共享执行循环(赛制,不是选手)。
// Phylum 不发明新循环 —— 内部就是极简 ReAct:模型给出 tool_calls → 执行 → 断言 gate →
// 结束条件判定。基因全部作用在循环的**参数**上:工具注册表(亲和过滤)、maxSteps、
// 断言 gate、instinct prompt。循环本身任何个体都一样。
//
// 断言失败处理(设计预演定的):带失败信息重试 1 次 → 仍失败 → 死(assertion_fail)。
// 这让断言有修复机会而不只是停机条件;归因仍然精确(死因=违反的那条断言)。

import type { AgentEvent, ChatMsg } from '../../shared/types';
import type { Completion } from '../glm';
import type { Tool, ToolCtx } from '../tools';
import { type Genome, type DeathCause, type ExpressedBody, cloneGenome } from './phylum-types';
import { checkAssertions } from './express';
import type { AssertionGene } from './phylum-types';

export interface BodyPlanResult {
  success: boolean;
  aborted: boolean;
  cause: DeathCause;
  steps: number;
  tokens: number;
  /** 最后一次工具输出(任务 grader 判语义对错用) */
  lastOutput: string;
  /** 断言违规时:违规断言 id */
  violatedAssertionId?: string;
  /** 归因:肇事工具(cause=tool_error) */
  culpritTool?: string;
  detail: string;
}

/** 最简 chat 模型接口(实验注入确定性 mock;生产化时包一层 Provider)。 */
/** 工具定义(OpenAI function-calling 形,名字在 .function.name)。 */
export interface ToolDefLike { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type ChatFn = (messages: ChatMsg[], toolDefs: ToolDefLike[]) => Promise<Completion>;

export interface BodyPlanOpts {
  task: string;
  cwd: string;
  body: ExpressedBody;
  genome: Genome;
  /** 聊天模型(参数即 Provider.streamComplete 的去 snap 形;Phylum 不关心配置快照) */
  chat: ChatFn;
  tools: readonly Tool[];
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

const MAX_TOOL_OUTPUT_CHARS = 4000;

export async function runBodyPlan(opts: BodyPlanOpts): Promise<BodyPlanResult> {
  const { task, body, chat, tools, signal, onEvent } = opts;
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const toolDefs: ToolDefLike[] = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const messages: ChatMsg[] = [
    { role: 'system', content: `你是任务执行者。\n${body.instinctPrompt}` },
    { role: 'user', content: task },
  ];

  let steps = 0;
  let tokens = 0;
  let lastOutput = '';
  let retryAfterAssertion = false; // 每个个体一生只许断言重试一次(防重试黑洞)

  while (steps < body.maxSteps) {
    if (signal?.aborted) return { success: false, aborted: true, cause: 'aborted', steps, tokens, lastOutput, detail: 'aborted by signal' };
    steps++;

    let comp: Completion;
    try {
      comp = await chat(messages, toolDefs);
    } catch (err) {
      if (signal?.aborted) return { success: false, aborted: true, cause: 'aborted', steps, tokens, lastOutput, detail: 'aborted during LLM call' };
      return { success: false, aborted: false, cause: 'tool_error', steps, tokens, lastOutput, detail: `chat error: ${(err as Error).message}` };
    }
    tokens += (comp.tokensIn ?? 0) + (comp.tokensOut ?? 0);

    // 无工具调用 = 个体认为任务完成,交最后陈述
    if (!comp.toolCalls?.length) {
      lastOutput = comp.content || lastOutput;
      return { success: false, aborted: false, cause: 'wrong_answer', steps, tokens, lastOutput,
        detail: 'finished without tool use — grader decides' };
    }

    // 顺序执行本步全部工具调用(写工具本来就串行;v1 不做并发)
    for (const call of comp.toolCalls) {
      if (signal?.aborted) return { success: false, aborted: true, cause: 'aborted', steps, tokens, lastOutput, detail: 'aborted between tools' };
      const tool = toolMap.get(call.name);
      if (!tool) {
        // 模型选了不存在的工具:最大概率 = 该工具被亲和过滤摘除了。直接判死(essential_tool_missing)。
        return { success: false, aborted: false, cause: 'essential_tool_missing', steps, tokens, lastOutput,
          detail: `model called removed tool '${call.name}'` };
      }
      let args: Record<string, unknown>;
      try { args = call.arguments ? JSON.parse(call.arguments) : {}; }
      catch { return { success: false, aborted: false, cause: 'tool_error', steps, tokens, lastOutput, culpritTool: call.name, detail: `bad JSON args for '${call.name}'` }; }

      let output: string;
      try {
        const ctx: ToolCtx = { cwd: opts.cwd, confirm: async () => true, signal };
        output = await tool.run(args, ctx);
      } catch (err) {
        return { success: false, aborted: false, cause: 'tool_error', steps, tokens, lastOutput, culpritTool: call.name,
          detail: `tool '${call.name}' threw: ${(err as Error).message}` };
      }
      if (output.startsWith('[aborted')) {
        return { success: false, aborted: true, cause: 'aborted', steps, tokens, lastOutput, detail: `tool '${call.name}' aborted` };
      }
      lastOutput = output;
      onEvent?.({ type: 'tool', name: call.name, args: call.arguments ?? '', result: output.slice(0, MAX_TOOL_OUTPUT_CHARS), outcome: 'ok' });

      // 断言 gate
      const violated: AssertionGene | null = checkAssertions(body.assertions, { name: call.name, output, exitCode: exitCodeOf(output) });
      if (violated) {
        if (!retryAfterAssertion) {
          retryAfterAssertion = true;
          messages.push(assistantToolMsg(call));
          messages.push({ role: 'user', content: `[断言失败] ${violated.id}:工具输出未通过检查 "${assertDescribe(violated)}"。请修正后重试一次。` });
          break; // 跳出工具循环,回模型重试
        }
        return { success: false, aborted: false, cause: 'assertion_fail', steps, tokens, lastOutput,
          violatedAssertionId: violated.id, detail: `assertion '${violated.id}' violated after retry on '${call.name}'` };
      }

      messages.push(assistantToolMsg(call));
      messages.push({ role: 'user', content: `[tool:${call.name}] ${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}` });
    }
  }

  // 步数预算耗尽
  return { success: false, aborted: false, cause: 'step_budget', steps, tokens, lastOutput,
    detail: `exceeded maxSteps=${body.maxSteps}` };
}

/** assistant 消息里回放 tool_call(OpenAI wire 格式)。 */
function assistantToolMsg(call: { id?: string; name: string; arguments?: string }): ChatMsg {
  return {
    role: 'assistant', content: '',
    tool_calls: [{ id: call.id ?? 'x', type: 'function', function: { name: call.name, arguments: call.arguments ?? '{}' } }],
  };
}

/** shell 类工具的输出协议:成功尾行 [exit:N](与 tools.ts shell 工具一致);非 shell 工具返回 undefined。 */
function exitCodeOf(output: string): number | undefined {
  const m = /\[exit:(-?\d+)\]\s*$/.exec(output);
  return m ? parseInt(m[1], 10) : undefined;
}

function assertDescribe(a: AssertionGene): string {
  const c = a.check;
  switch (c.type) {
    case 'exit_code_eq': return `exit code == ${c.value}`;
    case 'regex_contains': return `output matches /${c.pattern}/`;
    case 'output_not_empty': return 'output is not empty';
    case 'line_count_gt': return `output lines > ${c.value}`;
    default: return 'unknown assertion';
  }
}

/** 供测试断言基因未被执行路径污染(纯数据纪律)。 */
export function genomeUnchanged(a: Genome, b: Genome): boolean {
  return JSON.stringify(cloneGenome(a)) === JSON.stringify(cloneGenome(b));
}
