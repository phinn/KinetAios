// DirectV2Engine — Plan · Execute · Verify · Judge 四层架构引擎
//
// 核心思路:不是更快的 ReAct loop,而是像人类工程师一样工作 —— 先规划再执行,执行完验证。
//
// ┌─────────┐     ┌───────────┐     ┌──────────┐     ┌───────┐
// │ Planner │ ──► │ Executor  │ ──► │ Verifier │ ──► │ Judge │
// │ (规划)  │     │ (ReAct)   │     │ (验证)   │     │(裁决) │
// └─────────┘     └───────────┘     └──────────┘     └───────┘
//      ▲                                                 │
//      └────────────── 未完成? 重新规划 ─────────────────┘
//
// 与 v1 DirectEngine 的关键区别:
// 1. Plan-first:第一轮不执行任何工具,只输出结构化 plan(JSON)
// 2. Per-step execution:按 plan 步骤串行执行,每步独立的 ReAct loop
// 3. Verifier:每个步骤完成后自动验证(tsc / lint / test),失败自动重试(MAX_RETRIES)
// 4. Judge:独立 LLM 调用判定目标是否真正完成(不信模型自己说"搞定了")
// 5. Replan:Judge 判定未完成 → 重新规划(MAX_REPLANS 次)
//
// 设计约束:复用现有 runAgentLoop / provider / tools 基础设施,不重新发明轮子。
// 对于简单任务(无需分步),自动退化为 v1 单轮 ReAct + autoVerify。

import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, ChatMsg, Conversation } from '../shared/types';
import { runAgentLoop, compactHistory } from './AgentLoop';
import { currentProvider, priceUSD } from './glm';
import { allTools, readOnlyTools, shellExec, type Tool, type ToolCtx } from './tools';
import { getSettings, snapshot } from './settings';
import { mcp } from './mcp';
import { pluginSystemPrompts } from './plugins';
import {
  baseSystemPrompt,
  personaSection,
  loadProjectRules,
  SUBAGENT_PROMPT,
  type Engine,
  type EngineRunOpts,
} from './engines';

// ════════════════════════════════════════════════════════════════════════
// Plan 数据结构
// ════════════════════════════════════════════════════════════════════════

interface PlanStep {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  verifyCommand?: string; // 验证命令(如 "npx tsc --noEmit")
  result?: string; // 执行后的输出摘要
  retryCount: number;
}

interface Plan {
  goal: string;
  steps: PlanStep[];
  summary: string; // 规划摘要(给用户看的)
}

// ════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════

const MAX_RETRIES = 3; // 每步最多重试 3 次
const MAX_REPLANS = 2; // 最多重新规划 2 次

// v2 引擎追加的 systemPrompt 片段 —— 告诉模型 v2 的工作模式。
const V2_SYSTEM_SUFFIX = `
# 你是 Kaios v2 引擎 — 具备「先规划、再执行、执行完验证」能力

与传统 ReAct agent 不同,你的工作模式:
1. **先规划**:面对复杂任务,先用工具探查现状,在回答中给出 \`<plan>\` JSON 规划
2. **再执行**:按照 plan 逐步执行,每步完成后报告进度
3. **会验证**:写完代码/配置后,主动运行验证命令(类型检查 / 测试 / lint)

## Plan 格式(当你判断任务需要分步时,在回答中输出):
\`\`\`<plan>
{"goal":"任务目标","steps":[{"id":"1","title":"步骤标题","description":"具体做什么","verifyCommand":"验证命令"}]}
</plan>\`\`\`

## 何时输出 plan:
- 任务有 3 个以上子步骤时
- 需要修改多个文件时
- 用户给出了明确的复杂目标(/goal 模式)

## 何时不需要 plan:
- 简单问答、单文件修改、快速查询
- 直接执行即可,不用过度规划

## 中间结果落地(重要):
当任务涉及多文件数据处理时(如 CSV/Excel 分析、跨文件统计):
- **将每步的关键产出写入临时文件**(如 \`_step1_summary.json\`、\`_step2_result.csv\`)
- 后续步骤通过 \`read_file\` 读取这些文件,而非依赖对话上下文中可能被裁剪的文本
- 这样即使上下文压缩(trim/compact),关键数据也能持久保留在磁盘上
`;

// Planner prompt —— 引导模型先探查再规划(只读工具,不执行写操作)。
const PLANNER_PROMPT = `你现在处于 v2 引擎的**规划阶段**。

你的任务:
1. 用只读工具(read_file / grep / glob / shell 只读命令)探查项目现状
2. 理解代码结构、找到需要修改的文件、确认技术方案
3. 在回答末尾输出 \`<plan>\` JSON

**规划阶段禁止调用写工具(write_file / edit_file / shell 写命令)。** 你只探查,不修改。

Plan 格式:
\`\`\`<plan>
{"goal":"任务目标","steps":[{"id":"1","title":"步骤标题","description":"具体做什么(足够详细,包含文件路径和关键逻辑)","verifyCommand":"验证命令(可选,如 npx tsc --noEmit)"}]}
</plan>\`\`\`

如果任务太简单不需要分步(比如单文件修改、快速查询),直接输出答案,不要输出 \`<plan>\`。
引擎会检测到没有 plan 并自动退化为普通模式。`;

// Per-step executor prompt —— 告诉模型当前执行 plan 的哪个步骤。
const STEP_EXECUTOR_PROMPT = (step: PlanStep, allSteps: PlanStep[], planGoal: string) => `你现在处于 v2 引擎的**执行阶段**,正在执行以下 plan 步骤。

**会话目标:** ${planGoal}

**当前步骤 [${step.id}/${allSteps.length}]:** ${step.title}
**具体描述:** ${step.description}
${step.verifyCommand ? `**验证命令:** ${step.verifyCommand}` : ''}

**已完成步骤:**
${allSteps.filter((s) => s.status === 'done').map((s) => `  ✅ [${s.id}] ${s.title}: ${(s.result || '完成').slice(0, 1000)}`).join('\n') || '  (无)'}

> 💡 如果前步有数据需要引用,请用 read_file 读取前步产出的临时文件(如 _step*_summary.json),不要仅依赖上面的摘要文本。

请执行当前步骤。完成后用简洁中文汇报你做了什么。`;

// Judge prompt —— 独立 LLM 调用判定 plan 是否真正完成。
const JUDGE_PROMPT = (planGoal: string, steps: PlanStep[], execEvidence?: string) => `你是独立的验收裁判(Judge)。你的任务是判定以下 plan 的执行结果是否真正完成了目标。

**目标:** ${planGoal}

**步骤执行情况:**
${steps.map((s) => `  [${s.id}] ${s.title} — 状态: ${s.status}${s.result ? `\n    结果: ${s.result.slice(0, 300)}` : ''}`).join('\n')}

${execEvidence ? `**实际执行输出(尾部摘要):**\n${execEvidence}\n` : ''}
请回答一个问题:**目标是否已经完成?**

输出 JSON:
\`\`\`{"completed": true/false, "reason": "简要说明为什么完成/未完成", "nextAction": "如果未完成,建议下一步做什么(可为空)"}
\`\`\``;

// extractBalancedJson — 从文本中提取第一个完整的 `{...}` JSON 对象(brace-counting)。
// 解决非贪婪正则 `\{[\s\S]*?\}` 在嵌套对象中被第一个 `}` 截断的问题。
// 标记: 只在字符串字面量外计数 `{`/`}`，避免 JSON 值中的花括号干扰。
function extractBalancedJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }

    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null; // 括号不平衡 → 返回 null
}

// ════════════════════════════════════════════════════════════════════════
// DirectV2Engine 实现
// ════════════════════════════════════════════════════════════════════════

export class DirectV2Engine implements Engine {
  readonly name = 'directV2' as const;
  private autoVerifyApproved = false; // 一次 run 中 autoVerify 首次 confirm 后记住,避免 replan 反复弹窗
  constructor(private confirm: (cmd: string) => Promise<boolean>) {}

  async run({ conv, memoryBlock, rulesBlock, contextBlock, skillBlock, refBlock, signal, onEvent }: EngineRunOpts): Promise<void> {
    this.autoVerifyApproved = false; // 每次 run 重置:引擎实例在应用生命周期内复用,不能跨会话泄漏
    const prompt = conv.turns[conv.turns.length - 1]?.prompt ?? '';
    const base = snapshot(conv.profileId);
    const snap = { ...base, model: conv.model || base.model };
    const provider = currentProvider(snap);

    // ── 构建 systemPrompt(与 v1 共享 base,追加 v2 能力描述)──
    const goalSection = conv.goal
      ? `\n\n# 🎯 会话目标\n你当前的核心目标是:\n${conv.goal}\n请在每一步操作中都朝这个目标推进。\n**当你确认目标已经完成时,在回答的最末尾输出 \`[GOAL_COMPLETE]\` 标记。**`
      : '';
    const skillSection = skillBlock ? `\n\n# 当前 Skill 指令(用户通过 / 调用,请遵循)\n${skillBlock}` : '';
    const rulesSection = loadProjectRules(conv.cwd);
    const systemPrompt =
      baseSystemPrompt +
      V2_SYSTEM_SUFFIX +
      personaSection() +
      goalSection +
      skillSection +
      rulesSection +
      (rulesBlock ?? '') +
      (contextBlock ?? '') +
      pluginSystemPrompts('directV2', prompt);

    // ── 构建 ToolCtx ──
    const ctx: ToolCtx = this.buildCtx(conv, snap, signal, onEvent);

    // ── 工具集 ──
    const tools = [...allTools(), ...(await mcp.directTools(2000))];

    // ── 构建 user input ──
    const refSection = refBlock ?? '';
    const userInput = refSection ? prompt + refSection : prompt;

    // ── Phase 1: Planner — 探查 + 规划(只读工具)──
    onEvent({ type: 'status', text: '🧠 v2: 规划中...' });

    const plannerTools = [...readOnlyTools(), ...(await mcp.directTools(2000))];
    const plannerMessages = await runAgentLoop({
      provider,
      tools: plannerTools,
      systemPrompt: systemPrompt + '\n\n' + PLANNER_PROMPT,
      memoryBlock,
      snapshot: snap,
      userInput,
      history: conv.directHistory,
      ctx: { ...ctx, sandbox: 'readOnly' }, // planner 强制只读
      signal,
      // maxTurns 不设限 — Planner 需要充分探查复杂项目,使用全局设置值
      contextMode: conv.contextMode,
      hifiContextBudget: getSettings().hifiContextBudget,
      onEvent: (ev) => this.forwardEvent(ev, onEvent),
    });

    if (signal.aborted) {
      conv.directHistory = plannerMessages;
      onEvent({ type: 'done' });
      return;
    }

    // 提取 planner 输出中的 plan JSON
    const plannerAnswer = this.extractLastAssistantText(plannerMessages);
    const plan = this.parsePlan(plannerAnswer);

    // Planner 失败检测:API 报错时 runAgentLoop 返回 [...history, user_input]——
    // extractLastAssistantText 会命中 history 里的旧 assistant 消息(上一轮的过期回答)。
    // 正确检测:如果 messages 尾部不是 assistant 消息(或新 assistant 前面没有新的 user input),
    // 说明本轮没有产生新的 assistant 回复 → API 报错。
    const lastMsg = plannerMessages[plannerMessages.length - 1];
    const hasNewAssistant = lastMsg?.role === 'assistant';
    if (!hasNewAssistant && !signal.aborted) {
      onEvent({ type: 'status', text: '⚠️ v2: 规划阶段未产生有效输出(可能是 API 错误),请重试' });
      onEvent({ type: 'error', message: 'v2 规划阶段失败:模型未返回有效内容。请检查 API 连接后重试。' });
      conv.directHistory = plannerMessages;
      return;
    }

    if (!plan || plan.steps.length === 0) {
      // 简单任务退化为 v1 模式:planner 已经给出了答案,直接走 autoVerify + compact
      onEvent({ type: 'status', text: '⚡ v2: 任务简单,跳过分步执行' });
      await this.autoVerifyFromSteps(conv, ctx, signal, onEvent, plannerMessages);
      this.finalizeContext(conv, plannerMessages, provider, snap, signal);
      onEvent({ type: 'done' });
      return;
    }

    // 有 plan → 进入分步执行模式
    onEvent({ type: 'status', text: `📋 v2: 计划 ${plan.steps.length} 个步骤 — ${plan.summary}` });

    // 用 plan 轮的 messages 作为执行的基础 history
    let execHistory = plannerMessages;

    // ── Phase 2: Executor — 按 plan 步骤串行执行 ──
    for (const step of plan.steps) {
      if (signal.aborted) break;
      step.status = 'running';
      onEvent({ type: 'status', text: `🔨 v2: 执行步骤 [${step.id}] ${step.title}` });

      let stepDone = false;
      let verifyApproved = false; // 同一步骤首次 confirm 后记住,重试不再弹窗
      let goalComplete = false; // [GOAL_COMPLETE] 检测(在 stepAnswer 截断前)
      for (let attempt = 0; attempt < MAX_RETRIES && !stepDone && !signal.aborted; attempt++) {
        const retryNote = attempt > 0 ? `\n\n**⚠️ 这是第 ${attempt + 1} 次尝试。上一次失败,请修正问题后重试。**\n上一次结果: ${step.result ?? '(无)'}` : '';

        const stepMessages = await runAgentLoop({
          provider,
          tools, // 执行阶段:完整工具集(含写工具)
          systemPrompt,
          memoryBlock, // 每步都注入长期记忆:dropTransient 会从返回值里剔除,模型必须在调用时看到
          snapshot: snap,
          userInput: STEP_EXECUTOR_PROMPT(step, plan.steps, plan.goal) + retryNote,
          history: execHistory,
          ctx,
          signal,
          maxTurns: 30, // 单步上限 30 轮:防止模型陷入循环反复 read_file 同一文件烧 token
          contextMode: conv.contextMode,
          hifiContextBudget: getSettings().hifiContextBudget,
          onEvent: (ev) => this.forwardEvent(ev, onEvent),
        });

        execHistory = stepMessages;
        // 检测 maxTurns 截断:runAgentLoop 到达上限时 forwardEvent 吞了 error 事件,
        // 返回值尾部是 tool 消息(非正常完成)。此时模型可能没做完 → 标记失败让重试。
        const truncated = this.wasTruncatedByMaxTurns(stepMessages);
        const stepAnswer = truncated ? '' : this.extractLastAssistantText(stepMessages);
        // 在截断前检测 [GOAL_COMPLETE]:prompt 要求模型放在回答最末尾,
        // step.result 被 slice(0,2000) 截断后会漏掉(长回答场景)
        goalComplete = !truncated && stepAnswer.includes('[GOAL_COMPLETE]');

        if (truncated) {
          // maxTurns 截断 → 视为失败,让重试逻辑接管
          step.status = attempt + 1 < MAX_RETRIES ? 'pending' : 'failed';
          step.result = `步骤执行达到轮次上限(30 轮),可能未完成`;
          step.retryCount = attempt + 1;
          if (attempt + 1 < MAX_RETRIES) {
            onEvent({ type: 'status', text: `⚠️ v2: 步骤 [${step.id}] 达到轮次上限,重试 ${attempt + 1}/${MAX_RETRIES}` });
          }
        } else if (step.verifyCommand) {
          const verifyResult = await this.runVerify(step.verifyCommand, conv.cwd, ctx, signal, onEvent, verifyApproved);
          verifyApproved = true; // 首次 confirm 后,后续重试不再弹窗
          if (verifyResult.ok) {
            step.status = 'done';
            step.result = stepAnswer.slice(0, 2000);
            stepDone = true;
            onEvent({ type: 'status', text: `✅ v2: 步骤 [${step.id}] 验证通过` });
          } else {
            step.status = attempt + 1 < MAX_RETRIES ? 'pending' : 'failed';
            step.result = `验证失败: ${verifyResult.output.slice(0, 2000)}`;
            step.retryCount = attempt + 1;
            if (attempt + 1 < MAX_RETRIES) {
              onEvent({ type: 'status', text: `⚠️ v2: 步骤 [${step.id}] 验证失败,重试 ${attempt + 1}/${MAX_RETRIES}` });
            }
          }
        } else {
          // 无验证命令 → 信任模型输出
          step.status = 'done';
          step.result = stepAnswer.slice(0, 2000);
          stepDone = true;
          onEvent({ type: 'status', text: `✅ v2: 步骤 [${step.id}] 完成` });
        }
      }

      // 步骤最终失败(MAX_RETRIES 耗尽)→ 告知用户,继续下一步
      if (!stepDone && step.status === 'failed') {
        onEvent({ type: 'status', text: `❌ v2: 步骤 [${step.id}] ${step.title} 最终失败,继续下一步` });
      }

      // 检测模型是否声明目标已完成(goal 模式)→ 跳过剩余步骤,直接进 Judge
      if (stepDone && goalComplete) {
        // 标记后续步骤为 skipped
        for (const s of plan.steps) {
          if (s.status === 'pending') s.status = 'skipped';
        }
        onEvent({ type: 'status', text: '🎯 v2: 模型声明目标已完成 [GOAL_COMPLETE],跳过剩余步骤' });
        break;
      }

      // 步骤间上下文压缩:防止多步 plan 的 history 累积爆炸。
      // 步骤间压缩 execHistory,防止后续步骤因上下文膨胀丢失前步产出。
      if (!signal.aborted) {
        execHistory = await this.interStepCompact(execHistory, conv, provider, snap, signal, onEvent);
        // 追加结构化摘要消息,确保下一步 ReAct loop 在 prompt 尾部能看到前步结论。
        execHistory.push({
          role: 'user',
          content: `\n---\n📋 步骤[${step.id}] 完成: ${step.title}\n结果摘要: ${step.result ?? '(无)'}\n---\n`,
        });
      }
    }

    if (signal.aborted) {
      conv.directHistory = execHistory;
      onEvent({ type: 'done' });
      return;
    }

    // ── Phase 3: Verifier — 全局验证(自动检测项目类型)──
    onEvent({ type: 'status', text: '🔬 v2: 全局验证...' });
    await this.autoVerifyFromSteps(conv, ctx, signal, onEvent, execHistory);

    // ── Phase 4: Judge — 独立判定是否完成 ──
    const judgeResult = await this.judge(plan, provider, snap, signal, onEvent, execHistory);

    if (!judgeResult.completed) {
      onEvent({ type: 'status', text: `⚖️ v2: Judge 判定未完成 — ${judgeResult.reason}` });
      // 未完成 → 重新规划(如果还有额度);replan 内部会递归 + judge,返回最终 execHistory
      execHistory = await this.replan(prompt, conv, snap, provider, ctx, tools, systemPrompt, memoryBlock, signal, onEvent, execHistory, plan);
    } else {
      onEvent({ type: 'status', text: `⚖️ v2: Judge 判定已完成 — ${judgeResult.reason}` });
    }

    // ── Phase 5: Context 压缩(与 v1 共享)──
    this.finalizeContext(conv, execHistory, provider, snap, signal);
    onEvent({ type: 'done' });
  }

  // ════════════════════════════════════════════════════════════════════
  // Replan:Judge 判定未完成时,重新规划并执行(递归,最多 MAX_REPLANS 次)
  // ════════════════════════════════════════════════════════════════════

  // Replan:Judge 判定未完成时,重新规划并执行(递归,最多 MAX_REPLANS 次)。
  // 返回最终的 execHistory(可能被 replan 步骤更新过),供 run() 写入 directHistory。
  private async replan(
    originalPrompt: string,
    conv: Conversation,
    snap: ReturnType<typeof snapshot>,
    provider: ReturnType<typeof currentProvider>,
    ctx: ToolCtx,
    tools: Tool[],
    systemPrompt: string,
    memoryBlock: string,
    signal: AbortSignal,
    onEvent: (e: AgentEvent) => void,
    execHistory: ChatMsg[],
    prevPlan: Plan,
    replanCount = 0,
  ): Promise<ChatMsg[]> {
    if (replanCount >= MAX_REPLANS) {
      onEvent({ type: 'status', text: `🛑 v2: 已达最大重规划次数 (${MAX_REPLANS}),停止` });
      return execHistory;
    }
    if (signal.aborted) return execHistory;

    onEvent({ type: 'status', text: `🔄 v2: 重新规划 (${replanCount + 1}/${MAX_REPLANS})...` });

    // 告诉模型上一轮哪里没做好,让它重新出 plan
    const replanInput = `原始任务: ${originalPrompt}\n\n上一轮 plan 的执行结果:\n${prevPlan.steps.map((s) => `  [${s.id}] ${s.title} — ${s.status}: ${(s.result || '').slice(0, 1000)}`).join('\n')}\n\n请根据上次结果修正方案,重新输出 <plan>。`;

    const plannerMessages = await runAgentLoop({
      provider,
      tools: [...readOnlyTools(), ...(await mcp.directTools(2000))],
      systemPrompt: systemPrompt + '\n\n' + PLANNER_PROMPT,
      memoryBlock,
      snapshot: snap,
      userInput: replanInput,
      history: execHistory,
      ctx: { ...ctx, sandbox: 'readOnly' },
      signal,
      // maxTurns 不设限 — Replan 同样需要充分探查
      contextMode: conv.contextMode, // 与 run() 的 planner 保持一致
      hifiContextBudget: getSettings().hifiContextBudget,
      onEvent: (ev) => this.forwardEvent(ev, onEvent),
    });

    execHistory = plannerMessages;

    // Planner 失败检测:同 run()——检查尾部是否有新 assistant 消息
    const replanLastMsg = plannerMessages[plannerMessages.length - 1];
    if (replanLastMsg?.role !== 'assistant' && !signal.aborted) {
      onEvent({ type: 'status', text: '⚠️ v2: 重新规划阶段未产生有效输出(可能是 API 错误)' });
      return execHistory;
    }

    const replanAnswer = this.extractLastAssistantText(plannerMessages);
    if (!replanAnswer.trim() && !signal.aborted) {
      onEvent({ type: 'status', text: '⚠️ v2: 重新规划阶段未产生有效输出(可能是 API 错误)' });
      return execHistory;
    }

    const newPlan = this.parsePlan(replanAnswer);
    if (!newPlan || newPlan.steps.length === 0) {
      // 模型没出新 plan → 说明它觉得可以直接给出答案,走退化模式
      onEvent({ type: 'status', text: '⚠️ v2: 重新规划未产出新 plan — 任务可能未真正完成,请检查输出' });
      return execHistory;
    }

    // ── 执行新 plan 的步骤(与 Phase 2 一致:重试 + 验证)──
    for (const step of newPlan.steps) {
      if (signal.aborted) break;
      step.status = 'running';
      onEvent({ type: 'status', text: `🔨 v2: 重执行步骤 [${step.id}] ${step.title}` });

      let stepDone = false;
      let verifyApproved = false;
      let goalComplete = false; // [GOAL_COMPLETE] 检测(在 stepAnswer 截断前)
      for (let attempt = 0; attempt < MAX_RETRIES && !stepDone && !signal.aborted; attempt++) {
        const retryNote = attempt > 0 ? `\n\n**⚠️ 这是第 ${attempt + 1} 次尝试。上一次失败,请修正问题后重试。**\n上一次结果: ${step.result ?? '(无)'}` : '';
        const stepMessages = await runAgentLoop({
          provider,
          tools,
          systemPrompt,
          memoryBlock, // 每步注入长期记忆(dropTransient 会从返回值剔除,不持久化)
          userInput: STEP_EXECUTOR_PROMPT(step, newPlan.steps, newPlan.goal) + retryNote,
          history: execHistory,
          ctx,
          signal,
          snapshot: snap,
          maxTurns: 30, // 单步上限 30 轮(与主流程一致)
          contextMode: conv.contextMode,
          hifiContextBudget: getSettings().hifiContextBudget,
          onEvent: (ev) => this.forwardEvent(ev, onEvent),
        });

        execHistory = stepMessages;
        const truncated = this.wasTruncatedByMaxTurns(stepMessages);
        const stepAnswer = truncated ? '' : this.extractLastAssistantText(stepMessages);
        goalComplete = !truncated && stepAnswer.includes('[GOAL_COMPLETE]');

        if (truncated) {
          step.status = attempt + 1 < MAX_RETRIES ? 'pending' : 'failed';
          step.result = `步骤执行达到轮次上限(30 轮),可能未完成`;
          step.retryCount = attempt + 1;
          if (attempt + 1 < MAX_RETRIES) {
            onEvent({ type: 'status', text: `⚠️ v2: 步骤 [${step.id}] 达到轮次上限,重试 ${attempt + 1}/${MAX_RETRIES}` });
          }
        } else if (step.verifyCommand) {
          const verifyResult = await this.runVerify(step.verifyCommand, conv.cwd, ctx, signal, onEvent, verifyApproved);
          verifyApproved = true; // 首次 confirm 后,后续重试不再弹窗
          if (verifyResult.ok) {
            step.status = 'done';
            step.result = stepAnswer.slice(0, 2000);
            stepDone = true;
            onEvent({ type: 'status', text: `✅ v2: 步骤 [${step.id}] 验证通过` });
          } else {
            step.status = attempt + 1 < MAX_RETRIES ? 'pending' : 'failed';
            step.result = `验证失败: ${verifyResult.output.slice(0, 2000)}`;
            step.retryCount = attempt + 1;
            if (attempt + 1 < MAX_RETRIES) {
              onEvent({ type: 'status', text: `⚠️ v2: 步骤 [${step.id}] 验证失败,重试 ${attempt + 1}/${MAX_RETRIES}` });
            }
          }
        } else {
          step.status = 'done';
          step.result = stepAnswer.slice(0, 2000);
          stepDone = true;
          onEvent({ type: 'status', text: `✅ v2: 步骤 [${step.id}] 完成` });
        }
      }

      // 步骤最终失败(MAX_RETRIES 耗尽)→ 告知用户,继续下一步
      if (!stepDone && step.status === 'failed') {
        onEvent({ type: 'status', text: `❌ v2: 步骤 [${step.id}] ${step.title} 最终失败,继续下一步` });
      }

      // 检测模型是否声明目标已完成 → 跳过剩余步骤
      if (stepDone && goalComplete) {
        for (const s of newPlan.steps) {
          if (s.status === 'pending') s.status = 'skipped';
        }
        onEvent({ type: 'status', text: '🎯 v2: 模型声明目标已完成 [GOAL_COMPLETE],跳过剩余步骤' });
        break;
      }

      // 步骤间压缩 execHistory,防止后续步骤因上下文膨胀丢失前步产出。
      if (!signal.aborted) {
        execHistory = await this.interStepCompact(execHistory, conv, provider, snap, signal, onEvent);
        // 追加结构化摘要消息,确保下一步 ReAct loop 在 prompt 尾部能看到前步结论。
        execHistory.push({
          role: 'user',
          content: `\n---\n📋 步骤[${step.id}] 完成: ${step.title}\n结果摘要: ${step.result ?? '(无)'}\n---\n`,
        });
      }
    }

    if (signal.aborted) return execHistory;

    // 最终验证
    await this.autoVerifyFromSteps(conv, ctx, signal, onEvent, execHistory);

    // ── Judge 再次判定 ──
    const judgeResult = await this.judge(newPlan, provider, snap, signal, onEvent, execHistory);
    if (!judgeResult.completed && replanCount + 1 < MAX_REPLANS) {
      // 仍未完成 → 递归 replan,传入更新后的 execHistory 和 newPlan
      return this.replan(originalPrompt, conv, snap, provider, ctx, tools, systemPrompt, memoryBlock, signal, onEvent, execHistory, newPlan, replanCount + 1);
    } else if (!judgeResult.completed) {
      onEvent({ type: 'status', text: `🛑 v2: Judge 仍未判定完成,已达最大重规划次数 (${MAX_REPLANS})` });
    } else {
      onEvent({ type: 'status', text: `⚖️ v2: Replan 后 Judge 判定已完成 — ${judgeResult.reason}` });
    }

    return execHistory;
  }

  // ════════════════════════════════════════════════════════════════════
  // Plan 解析:从模型回答中提取 <plan> JSON
  // ════════════════════════════════════════════════════════════════════

  private parsePlan(text: string): Plan | null {
    // 策略 1:提取 <plan>...</plan> 标签内容,然后用 brace-counting 找到完整 JSON 对象。
    // 不再用 \{[\s\S]*?\} 非贪婪匹配 —— 那会在嵌套对象的第一个 `}` 处截断。
    const planTagMatch = text.match(/<plan>\s*([\s\S]*?)<\/plan>/i);
    let jsonStr: string | null = null;

    if (planTagMatch) {
      jsonStr = extractBalancedJson(planTagMatch[1]);
    }

    // 策略 2:fallback —— 无标签时,在全文中搜索裸 JSON（以 {"goal" 开头）。
    if (!jsonStr) {
      jsonStr = extractBalancedJson(text);
    }

    if (!jsonStr) return null;

    try {
      const raw = JSON.parse(jsonStr) as { goal?: string; steps?: unknown[]; summary?: string };
      if (!Array.isArray(raw.steps) || raw.steps.length === 0) return null;

      const steps: PlanStep[] = raw.steps.map((s, i) => {
        const obj = s as Record<string, unknown>;
        return {
          id: String(obj.id ?? i + 1),
          title: String(obj.title ?? `步骤 ${i + 1}`),
          description: String(obj.description ?? ''),
          status: 'pending' as const,
          verifyCommand: obj.verifyCommand ? String(obj.verifyCommand) : undefined,
          retryCount: 0,
        };
      });

      return {
        goal: String(raw.goal ?? ''),
        steps,
        summary: String(raw.summary ?? steps.map((s) => s.title).join(', ')),
      };
    } catch {
      return null; // JSON 解析失败 → 当作无 plan
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Judge:独立 LLM 调用判定目标是否完成
  // ════════════════════════════════════════════════════════════════════

  private async judge(
    plan: Plan,
    provider: ReturnType<typeof currentProvider>,
    snap: ReturnType<typeof snapshot>,
    signal: AbortSignal,
    onEvent: (e: AgentEvent) => void,
    execHistory?: ChatMsg[],
  ): Promise<{ completed: boolean; reason: string }> {
    // 从 execHistory 尾部提取最近的 assistant 文本 + tool 结果,作为执行证据传给 Judge
    const execEvidence = execHistory ? this.extractExecEvidence(execHistory) : undefined;
    try {
      const comp = await provider.streamComplete(
        [
          { role: 'system', content: '你是验收裁判。严格判定,不要因为模型说"完成了"就轻信。只有验证通过且逻辑自洽才算完成。' },
          { role: 'user', content: JUDGE_PROMPT(plan.goal, plan.steps, execEvidence) },
        ],
        [],
        snap,
        signal,
        () => {},
      );

      // 消费 Judge LLM 调用的 cost
      if (comp.tokensIn > 0 || comp.tokensOut > 0) {
        onEvent({ type: 'cost', usd: priceUSD(snap.model, comp.tokensIn, comp.tokensOut), tokens: comp.tokensIn + comp.tokensOut });
      }

      const text = comp.content ?? '';
      // 用 brace-counting 提取 JSON(而非贪婪 \{[\s\S]*\}——会在多段 JSON 时取到最后一个 })
      const jsonStr = extractBalancedJson(text);
      if (jsonStr) {
        try {
          const obj = JSON.parse(jsonStr) as { completed?: boolean; reason?: string };
          return {
            completed: Boolean(obj.completed),
            reason: String(obj.reason ?? '(无说明)'),
          };
        } catch {
          // JSON.parse 失败 → 走默认
        }
      }
      // JSON 解析失败 → 默认判定完成(不阻塞用户)
      return { completed: true, reason: 'Judge 响应解析失败,默认判定完成' };
    } catch {
      // Judge 出错 → 默认判定完成(不因 Judge 故障阻塞流程)
      return { completed: true, reason: 'Judge 调用失败,默认判定完成' };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 验证命令执行:走 confirm/sandbox,不再绕过
  // ════════════════════════════════════════════════════════════════════

  /** 运行指定验证命令(走 confirm 审批 + shellExec 统一执行)。
   *  skipConfirm: 同一步骤的重试不再重复弹窗(首次 confirm 过即可)。
   */
  private async runVerify(
    command: string,
    cwd: string,
    ctx: ToolCtx,
    signal: AbortSignal,
    onEvent: (e: AgentEvent) => void,
    skipConfirm = false,
  ): Promise<{ ok: boolean; output: string }> {
    // 安全:验证命令必须走 confirm(和 shell 工具一致);同一步骤重试时跳过
    if (!skipConfirm) {
      const approved = await ctx.confirm(`[v2 验证] ${command}`);
      if (!approved) {
        return { ok: true, output: '(用户跳过验证)' }; // 用户跳过 → 当作通过
      }
    }

    try {
      const output = await shellExec(command, cwd, 120_000, signal); // 与 shell 工具一致 120s;30s 会误杀 npx tsc 冷启动/大项目
      // shellExec 非零退出码加 [exit N] 前缀;超时返回 [超时(Ns),已终止。] —— 两种都必须判为失败,否则超时会被静默当作验证通过
      const ok = !/\[exit \d+\]/.test(output) && !output.startsWith('[超时');
      return { ok, output: output.slice(0, 3000) };
    } catch {
      return { ok: false, output: '验证命令执行失败' };
    }
  }

  /**
   * 自动验证:从实际工具调用记录(不是文字)检测文件修改,
   * 检测到后运行项目级验证命令(走 confirm)。
   */
  private async autoVerifyFromSteps(
    conv: Conversation,
    ctx: ToolCtx,
    signal: AbortSignal,
    onEvent: (e: AgentEvent) => void,
    messages: ChatMsg[],
  ): Promise<void> {
    // 检查实际工具调用(而非文字描述)是否包含写操作
    const hasFileChange = this.detectFileChangesFromMessages(messages);
    if (!hasFileChange) return;

    const verifyCmd = this.detectVerifyCommand(conv.cwd);
    if (!verifyCmd) return;

    onEvent({ type: 'status', text: `🔬 v2: 自动验证 (${verifyCmd.name})...` });

    // autoVerify 在一次 run 中可能被调用多次(主流程 + replan),记住首次 confirm 即可
    if (!this.autoVerifyApproved) {
      const approved = await ctx.confirm(`[v2 验证] ${verifyCmd.command}`);
      this.autoVerifyApproved = true;
      if (!approved) return; // 用户拒绝 → 跳过全局验证
    }

    const result = await this.runVerify(verifyCmd.command, conv.cwd, ctx, signal, onEvent, true);
    onEvent({
      type: 'tool',
      name: 'verify',
      args: verifyCmd.name,
      result: result.ok
        ? `✅ ${verifyCmd.name} 通过\n${result.output.slice(0, 2000)}`
        : `⚠️ ${verifyCmd.name} 发现问题:\n${result.output}`,
    });
    if (!result.ok) {
      onEvent({ type: 'status', text: `⚠️ v2: 验证发现问题(${verifyCmd.name}),请检查` });
    }
  }

  /**
   * 从 ChatMsg[] 中检测实际工具调用是否包含写操作。
   * 检查 assistant 消息的 tool_calls(而非文字内容)—— 更可靠。
   */
  private detectFileChangesFromMessages(messages: ChatMsg[]): boolean {
    const writeTools = ['write_file', 'edit_file', 'shell'];
    return messages.some((m) => {
      if (!m.tool_calls) return false;
      return m.tool_calls.some((tc) => writeTools.includes(tc.function.name));
    });
  }

  /** 检测项目类型,返回最合适的验证命令。 */
  private detectVerifyCommand(cwd: string): { name: string; command: string } | null {
    try {
      // TypeScript 项目:tsc --noEmit
      if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
        return { name: 'tsc', command: 'npx tsc --noEmit 2>&1' };
      }
      // package.json 但无 tsconfig:npm test(如果有)
      if (fs.existsSync(path.join(cwd, 'package.json'))) {
        const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
        if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
          return { name: 'npm test', command: 'npm test 2>&1' };
        }
      }
      // Python 项目:暂不支持
      if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'setup.py'))) {
        return null;
      }

      // 数据分析场景:检查目录下是否有数据文件或产出文件
      const dataExts = ['.csv', '.xlsx', '.xls', '.json'];
      const outputExts = ['.html', '.xlsx'];
      const pyPattern = /\.(py|ipynb)$/;
      const entries = fs.readdirSync(cwd);
      const hasData = entries.some((f) => dataExts.some((ext) => f.toLowerCase().endsWith(ext)));
      const hasOutput = entries.some((f) => outputExts.some((ext) => f.toLowerCase().endsWith(ext)));
      const hasPy = entries.some((f) => pyPattern.test(f));
      if (hasData || hasOutput || hasPy) {
        return {
          name: 'data-check',
          // 纯 ASCII 输出:emoji/中文在 Windows cmd 默认 GBK 代码页下 print 会 UnicodeEncodeError → 误报失败
          command: `python -c "import os; files=[f for f in os.listdir('.') if f.lower().endswith(('.html','.csv','.xlsx','.xls','.json'))]; print('output files ('+str(len(files))+'): ' + ', '.join(sorted(files)[:20]) if files else '(no output files found)')"`,
        };
      }
    } catch {
      // 检测失败 → 不验证
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════════════
  // 工具方法
  // ════════════════════════════════════════════════════════════════════

  /** 检测 runAgentLoop 返回值是否因 maxTurns 被截断。
   *  runAgentLoop 到达 maxTurns 时发 error 事件(被 forwardEvent 吞掉),然后返回 messages。
   *  此时 messages 尾部是 tool 消息(模型在调工具时被截断)或带 tool_calls 的 assistant(还没执行工具)。
   *  正常完成时尾部是无 tool_calls 的 assistant 消息(模型给了最终文字回答)。 */
  private wasTruncatedByMaxTurns(messages: ChatMsg[]): boolean {
    if (!messages.length) return false;
    const last = messages[messages.length - 1];
    // 正常完成:最后一条是无 tool_calls 的 assistant
    if (last.role === 'assistant' && (!last.tool_calls || last.tool_calls.length === 0)) return false;
    // 被截断:最后一条是 tool 消息,或带 tool_calls 的 assistant(缺 tool result)
    return true;
  }

  /** 从 messages 中提取最后一条有实际文本内容的 assistant 消息。
   *  跳过 content="" 的纯 tool_call assistant 消息 —
   *  模型在最后一步可能只调工具不写文字,用空字符串会导致 Planner 失败误报。 */
  private extractLastAssistantText(messages: ChatMsg[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
        return m.content;
      }
    }
    return '';
  }

  /**
   * 从 execHistory 尾部提取最近的 assistant 文本 + tool 结果,截断为 Judge 可读的证据摘要。
   * 只取尾部 ~30 条消息,tool result 截断到 1000 字符,assistant 截断到 800 字符,总上限 ~8000 字符。
   */
  private extractExecEvidence(messages: ChatMsg[]): string {
    const tail = messages.slice(-30);
    const parts: string[] = [];
    let totalLen = 0;
    for (const m of tail) {
      let line = '';
      if (m.role === 'assistant') {
        const text = typeof m.content === 'string' ? m.content : '';
        const tools = (m.tool_calls ?? []).map((tc) => `${tc.function.name}(${tc.function.arguments.slice(0, 80)})`).join(', ');
        line = `[助手] ${text.slice(0, 800)}${tools ? `  🔧 ${tools}` : ''}`;
      } else if (m.role === 'tool') {
        const text = typeof m.content === 'string' ? m.content : '';
        line = `[工具结果] ${text.slice(0, 1000)}`;
      } else if (m.role === 'user' && !m._memory) {
        const text = typeof m.content === 'string' ? m.content : '';
        line = `[用户] ${text.slice(0, 150)}`;
      }
      if (line) {
        totalLen += line.length;
        if (totalLen > 8000) break;
        parts.push(line);
      }
    }
    return parts.join('\n') || '(无执行记录)';
  }

  /**
   * 转发事件给上层,给 status 事件加 v2 前缀(防重复嵌套)。
   * 如果事件文本已经包含 "v2:" 前缀,直接透传。
   */
  // forwardEvent: 转发中间事件给上层,但拦截 done/error。
  // runAgentLoop 每次调用结束都会发 done/error,而 v2 会连续调多次(planner + 每步 + replan),
  // 如果全部透传,applyEvent 会在每步之间把 conv.status 设成 ready + 触发 extractMemories。
  // 解决:中间的 done/error 被吞掉,只在 run() 的最终退出点手动发一次 done。
  private forwardEvent(ev: AgentEvent, onEvent: (e: AgentEvent) => void): void {
    // done/error 不转发 —— 由 run() 在最终退出时统一发
    if (ev.type === 'done' || ev.type === 'error') return;
    if (ev.type === 'status') {
      const text = ev.text.startsWith('v2:') ? ev.text : `v2: ${ev.text}`;
      onEvent({ type: 'status', text });
    } else {
      onEvent(ev);
    }
  }

  /** Context 压缩(与 v1 共享逻辑)。 */
  // interStepCompact:步骤间压缩 execHistory,防止多步累积导致上下文膨胀。
  // budget 同 finalizeContext(普通 30K / hifi 40% of hifiBudget)。
  // 同时在每个步骤完成后追加一条步骤摘要消息,确保后续步骤即使被 trim 也能看到前步结论。
  private async interStepCompact(
    messages: ChatMsg[],
    conv: Conversation,
    provider: ReturnType<typeof currentProvider>,
    snap: ReturnType<typeof snapshot>,
    signal: AbortSignal,
    onEvent: (e: AgentEvent) => void,
  ): Promise<ChatMsg[]> {
    const hifiBudget = getSettings().hifiContextBudget ?? 80_000;
    const budget = conv.contextMode === 'hifi' ? Math.round(hifiBudget * 0.4) : 30_000;
    return compactHistory(messages, budget, provider, snap, signal, onEvent);
  }

  private async finalizeContext(
    conv: Conversation,
    messages: ChatMsg[],
    provider: ReturnType<typeof currentProvider>,
    snap: ReturnType<typeof snapshot>,
    signal: AbortSignal,
  ): Promise<void> {
    if (!signal.aborted) {
      const hifiBudget = getSettings().hifiContextBudget ?? 80_000;
      conv.directHistory = await compactHistory(
        messages,
        conv.contextMode === 'hifi' ? Math.round(hifiBudget * 0.4) : 30_000,
        provider,
        snap,
        signal,
      );
    } else {
      conv.directHistory = messages;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 构建 ToolCtx(复用 v1 的逻辑,子 agent prompt 引用共享的 SUBAGENT_PROMPT)
  // ════════════════════════════════════════════════════════════════════

  private buildCtx(conv: Conversation, snap: ReturnType<typeof snapshot>, signal: AbortSignal, onEvent: (e: AgentEvent) => void): ToolCtx {
    const provider = currentProvider(snap);
    return {
      cwd: conv.cwd,
      confirm: this.confirm,
      signal,
      convId: conv.id,
      sandbox: getSettings().sandbox,
      spawn: async ({ prompt: sub, signal: childSignal, engine }) => {
        // 跨引擎子任务(v2 也支持调用 claude/codex 一次性任务)
        if (engine === 'claudeCode' || engine === 'codex') {
          const { runCliOneShot } = await import('./engines');
          return await runCliOneShot(engine, sub, conv.cwd, childSignal);
        }
        // Direct 子任务:只读工具、独立上下文。
        // 超时保护:合并主 signal + 3 分钟 timeout,防止 API hang 导致 dispatch_agent 永久阻塞。
        // AbortSignal.any 在 Node 20+ 可用;旧版 fallback 到手动 AbortController。
        const subAc = new AbortController();
        const subTimer = setTimeout(() => subAc.abort(), 3 * 60 * 1000);
        // 主 signal abort 时也 abort 子任务
        if (childSignal.aborted) subAc.abort();
        else childSignal.addEventListener('abort', () => subAc.abort(), { once: true });
        const out = await runAgentLoop({
          provider,
          tools: readOnlyTools(),
          systemPrompt: SUBAGENT_PROMPT,
          snapshot: snap,
          userInput: sub,
          history: [],
          ctx: { cwd: conv.cwd, confirm: this.confirm, convId: conv.id },
          signal: subAc.signal,
          maxTurns: 8,
          onEvent: (e) => {
            if (e.type === 'cost') onEvent(e);
            else if (e.type === 'tool') onEvent({ type: 'status', text: `[子任务] ${e.name}` });
          },
        });
        clearTimeout(subTimer);
        const text = out
          .filter((m) => m.role === 'assistant' && typeof m.content === 'string')
          .map((m) => m.content)
          .join('\n')
          .trim();
        return text || '(子任务无文本输出)';
      },
    };
  }
}
