// bodyplan:共享执行循环(赛制,不是选手)。
// Phylum 不发明新循环 —— 内部就是极简 ReAct:模型给出 tool_calls → 执行 → 断言 gate →
// 结束条件判定。基因全部作用在循环的**参数**上:工具注册表(亲和过滤)、maxSteps、
// 断言 gate、instinct prompt。循环本身任何个体都一样。
//
// 断言失败处理(设计预演定的):带失败信息重试 1 次 → 仍失败 → 死(assertion_fail)。
// 这让断言有修复机会而不只是停机条件;归因仍然精确(死因=违反的那条断言)。

import type { AgentEvent, ChatMsg, ToolErrorKind } from '../../shared/types';
import type { Completion } from '../glm';
import type { Tool, ToolCtx } from '../tools';
import { GLMError } from '../glm';
import { type Genome, type DeathCause, type ExpressedBody, cloneGenome } from './phylum-types';
import { toolTelemetryOf } from '../tool-telemetry';
import type { TraceStep } from './phylum-types';
import { checkAssertions } from './express';
import { parseExitCode } from '../assertions';
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
  /** 归因:肇事工具的错误类型(参数类失败不该惩罚工具亲和) */
  culpritErrorKind?: ToolErrorKind;
  /** 全程工具调用轨迹(成功时被 registry 沉积为化石模板;死亡时只留墓志铭不留轨迹) */
  trace?: TraceStep[];
  /** 自然完成:模型交了 final answer(生产路径的成功语义;实验路径仍由 grader 终裁) */
  finished?: boolean;
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
  /** 固定追加到个体 system 的体系段(如意图账本提示):不进基因、不随进化变化。 */
  systemSuffix?: string;
  /** 工具执行上下文(convId/turnId 等身份信息)。confirm 仍走个体语义(默认自动放行)。 */
  toolCtx?: Partial<ToolCtx>;
}

const MAX_TOOL_OUTPUT_CHARS = 4000;
/** 重复动作熔断阈值:连续 N 次完全相同调用判死(step_budget)。 */
const REPEAT_BREAK_LIMIT = 3;
/** 上下文预算:messages 总字符超此值 → 折叠最旧的中间工具输出(保 system/首条任务/最近窗口)。 */
const CONTEXT_BUDGET_CHARS = 60_000;
/** 折叠后保留的最近消息对数(留足眼前上下文)。 */
const CONTEXT_KEEP_RECENT = 8;
/** 步数墙硬上限:基因再怎么进化也不能越过(宿主 maxTurns=0 时基因自主预算的天花板)。 */
export const MAX_STEPS_HARD_CAP = 200;

export async function runBodyPlan(opts: BodyPlanOpts): Promise<BodyPlanResult> {
  const { task, body, chat, tools, signal, onEvent } = opts;
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const toolDefs: ToolDefLike[] = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const messages: ChatMsg[] = [
    { role: 'system', content: `你是任务执行者。\n${body.instinctPrompt}${opts.systemSuffix ?? ''}` },
    { role: 'user', content: task },
  ];

  let steps = 0;
  let tokens = 0;
  let lastOutput = '';
  let retryAfterAssertion = false; // 每个个体一生只许断言重试一次(防重试黑洞)
  const trace: TraceStep[] = [];   // 全程轨迹:每次成功执行的工具调用(成功时沉积为化石)
  let lastActionKey = '';          // 重复动作熔断:连续完全相同 (tool+args) 计数
  let repeatCount = 0;

  // 步数墙只来自宿主表达(用户 maxTurns 天花板,0 = 无限 → 硬墙兜底)。
  // 2026-11-19 修法:基因自主预算(founder 12)与"宿主 0 = 信任基因"退出生产 ——
  // 用户开无限模式就是要跑长任务,墙必须由用户控制;进化自由度移交基因其它维度。
  // 停止条件:宿主墙 / abort / 重复熔断(同调用×3,409 次 shell 事故的短路兜底)/
  // 断言 gate / 上下文超限折叠。旧"进度门"(连续 24 步无 final 即死)已删除:
  // 它从不重置,等价于总长 24 步必死,长任务全体冤死(12/12 事故同源);
  // 而断言 gate 限重试 1 次、重复熔断盯同调用,"纯空转"路径实际不可达,门=死代码。
  while (steps < body.maxSteps) {
    if (signal?.aborted) return { success: false, aborted: true, cause: 'aborted', steps, tokens, lastOutput, detail: 'aborted by signal' };
    steps++;

    let comp: Completion;
    // 每步 status:个体思考期间 UI 状态条有心跳(否则长时间 LLM 调用看起来像死了)。
    onEvent?.({ type: 'status', text: `⚙️ v5 个体第 ${steps}/${body.maxSteps} 步 — 推理中…` });
    try {
      comp = await chat(messages, toolDefs);
    } catch (err) {
      if (signal?.aborted) return { success: false, aborted: true, cause: 'aborted', steps, tokens, lastOutput, detail: 'aborted during LLM call' };
      // provider 侧错误(quota 429/5h 窗口满、network 断连、auth)= 世界停了,不是个体的错。
      // quota/network/auth → 挂起退出:不结算、不留疤、不突变,个体原样留在活体池,
      // 窗口重置/链路恢复后同基因续跑(进化零污染)。工具自身的错才配叫 tool_error。
      const cls = GLMError.classify(err);
      if (cls === 'quota' || cls === 'network' || cls === 'auth') {
        return { success: false, aborted: true, cause: 'provider_suspended', steps, tokens, lastOutput,
          detail: `provider ${cls}: ${(err as Error).message}` };
      }
      return { success: false, aborted: false, cause: 'tool_error', steps, tokens, lastOutput, detail: `chat error: ${(err as Error).message}` };
    }
    tokens += (comp.tokensIn ?? 0) + (comp.tokensOut ?? 0);

    // 无工具调用 = 个体认为任务完成,交最后陈述
    // finished=true 是"自然完成"信号:生产路径 = 成功(有工具轨迹背书);
    // 实验路径 grader 仍终裁(0 步 finished = 空谈,grader 判 wrong_answer)。
    if (!comp.toolCalls?.length) {
      lastOutput = comp.content || lastOutput;
      const finished = trace.length > 0;
      return finished
        ? { success: true, aborted: false, cause: 'none', steps, tokens, lastOutput, trace, finished: true, detail: 'final answer with tool trace' }
        : { success: false, aborted: false, cause: 'wrong_answer', steps, tokens, lastOutput, finished: true,
            detail: 'finished without any tool use — nothing was done' };
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
      catch { return { success: false, aborted: false, cause: 'tool_error', steps, tokens, lastOutput, culpritTool: call.name, culpritErrorKind: 'bad_args', detail: `bad JSON args for '${call.name}'` }; }

      let output: string;
      // tool_start 先挂"运行中"spinner 卡(与 AgentLoop 同协议,startId 配对原位替换)。
      // 没有它,个体思考+执行期间 UI 完全静默 → "状态在动但不知道在干嘛"(2026-10-14 用户反馈)。
      const startId = `bp${steps}-${call.name}`;
      onEvent?.({ type: 'tool_start', name: call.name, args: call.arguments ?? '', startId });
      try {
        const ctx: ToolCtx = { ...opts.toolCtx, cwd: opts.cwd, confirm: opts.toolCtx?.confirm ?? (async () => true), signal };
        const t0 = Date.now();
        output = await tool.run(args, ctx);
        const tel = toolTelemetryOf(output);
        onEvent?.({ type: 'tool', name: call.name, args: call.arguments ?? '', result: output.slice(0, MAX_TOOL_OUTPUT_CHARS), durationMs: Date.now() - t0, outcome: tel.outcome, errorKind: tel.errorKind, errorSummary: tel.errorSummary, startId });
      } catch (err) {
        const msg = `tool '${call.name}' threw: ${(err as Error).message}`;
        onEvent?.({ type: 'tool', name: call.name, args: call.arguments ?? '', result: msg, outcome: 'error', errorKind: 'exception', errorSummary: msg.slice(0, 200), startId });
        return { success: false, aborted: false, cause: 'tool_error', steps, tokens, lastOutput, culpritTool: call.name,
          culpritErrorKind: 'exception', detail: msg };
      }
      if (output.startsWith('[aborted')) {
        return { success: false, aborted: true, cause: 'aborted', steps, tokens, lastOutput, detail: `tool '${call.name}' aborted` };
      }

      // ── 重复动作熔断(机制级,2026-10-13 事故):连续 REPEAT_BREAK_LIMIT 次
      // 完全相同的 (tool + args) → 判死。这不是策略问题,是电路短路,交给进化解决。
      {
        const key = `${call.name}:${(call.arguments ?? '').trim()}`;
        if (key === lastActionKey) {
          repeatCount++;
          if (repeatCount >= REPEAT_BREAK_LIMIT) {
            return { success: false, aborted: false, cause: 'step_budget', steps, tokens, lastOutput, culpritTool: call.name,
              detail: `重复熔断: same call '${call.name}' x${repeatCount}` };
          }
        } else {
          lastActionKey = key;
          repeatCount = 1;
        }
      }

      lastOutput = output;

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

      trace.push({ tool: call.name, args: safeParseArgs(call.arguments) });
      messages.push(assistantToolMsg(call));
      messages.push({ role: 'user', content: `[tool:${call.name}] ${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}` });
    }

    // 进度门已删(2026-11-19):见循环头部注释。

    // ── 上下文折叠(机制级):messages 总字符超预算 → 把最旧的中间工具输出
    // 替换为一行摘要,保 system、首条任务和最近 CONTEXT_KEEP_RECENT 条。
    // (443 步事故的另一半:4000 字/步 × 数百步从不清,后段模型只见得旧回声。)
    const totalChars = () => messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
    if (totalChars() > CONTEXT_BUDGET_CHARS && messages.length > CONTEXT_KEEP_RECENT + 2) {
      const foldEnd = messages.length - CONTEXT_KEEP_RECENT;
      for (let i = 1; i < foldEnd; i++) {
        const c = messages[i].content;
        if (messages[i].role === 'user' && typeof c === 'string' && c.startsWith('[tool:')) {
          messages[i] = { role: 'user', content: `[tool 输出已折叠] (超上下文预算,历史已归档)` };
        }
      }
    }
  }

  // 步数预算耗尽
  return { success: false, aborted: false, cause: 'step_budget', steps, tokens, lastOutput,
    detail: `exceeded maxSteps=${body.maxSteps}` };
}

/** 工具参数解析(轨迹记录用;坏 JSON 记空参,不炸执行)。 */
function safeParseArgs(raw?: string): Record<string, unknown> {
  try { return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; }
  catch { return {}; }
}

/** assistant 消息里回放 tool_call(OpenAI wire 格式)。 */
function assistantToolMsg(call: { id?: string; name: string; arguments?: string }): ChatMsg {
  return {
    role: 'assistant', content: '',
    tool_calls: [{ id: call.id ?? 'x', type: 'function', function: { name: call.name, arguments: call.arguments ?? '{}' } }],
  };
}

/** shell 类工具的输出协议:成功尾行 [exit:N] / [exit N](以 tools.ts 为准);非 shell 工具返回 undefined。
 *  统一走 assertions.parseExitCode:此前只认冒号形式,真实 shell 的 `[exit 0]` 永远解析成 undefined
 *  → 基因断言 exit_code_eq 在 V5 里从未生效(与 Ralph 验收修过的是同一类)。 */
function exitCodeOf(output: string): number | undefined {
  return parseExitCode(output);
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
