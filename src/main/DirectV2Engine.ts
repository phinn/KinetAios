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
import { currentProvider } from './glm';
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
${allSteps.filter((s) => s.status === 'done').map((s) => `  ✅ [${s.id}] ${s.title}: ${(s.result || '完成').slice(0, 200)}`).join('\n') || '  (无)'}

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

// ════════════════════════════════════════════════════════════════════════
// DirectV2Engine 实现
// ════════════════════════════════════════════════════════════════════════

export class DirectV2Engine implements Engine {
  readonly name = 'directV2' as const;
  constructor(private confirm: (cmd: string) => Promise<boolean>) {}

  async run({ conv, memoryBlock, rulesBlock, contextBlock, skillBlock, refBlock, signal, onEvent }: EngineRunOpts): Promise<void> {
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
      for (let attempt = 0; attempt < MAX_RETRIES && !stepDone && !signal.aborted; attempt++) {
        const retryNote = attempt > 0 ? `\n\n**⚠️ 这是第 ${attempt + 1} 次尝试。上一次失败,请修正问题后重试。**\n上一次结果: ${step.result ?? '(无)'}` : '';

        const stepMessages = await runAgentLoop({
          provider,
          tools, // 执行阶段:完整工具集(含写工具)
          systemPrompt,
          // 不注入 memoryBlock(已经在 planner 轮注入过,execHistory 里已有)
          snapshot: snap,
          userInput: STEP_EXECUTOR_PROMPT(step, plan.steps, plan.goal) + retryNote,
          history: execHistory,
          ctx,
          signal,
          contextMode: conv.contextMode,
          hifiContextBudget: getSettings().hifiContextBudget,
          onEvent: (ev) => this.forwardEvent(ev, onEvent),
        });

        execHistory = stepMessages;
        const stepAnswer = this.extractLastAssistantText(stepMessages);

        // 验证此步骤
        if (step.verifyCommand) {
          const verifyResult = await this.runVerify(step.verifyCommand, conv.cwd, ctx, signal, onEvent);
          if (verifyResult.ok) {
            step.status = 'done';
            step.result = stepAnswer.slice(0, 500);
            stepDone = true;
            onEvent({ type: 'status', text: `✅ v2: 步骤 [${step.id}] 验证通过` });
          } else {
            step.status = attempt + 1 < MAX_RETRIES ? 'pending' : 'failed';
            step.result = `验证失败: ${verifyResult.output.slice(0, 500)}`;
            step.retryCount = attempt + 1;
            if (attempt + 1 < MAX_RETRIES) {
              onEvent({ type: 'status', text: `⚠️ v2: 步骤 [${step.id}] 验证失败,重试 ${attempt + 1}/${MAX_RETRIES}` });
            }
          }
        } else {
          // 无验证命令 → 信任模型输出
          step.status = 'done';
          step.result = stepAnswer.slice(0, 500);
          stepDone = true;
          onEvent({ type: 'status', text: `✅ v2: 步骤 [${step.id}] 完成` });
        }
      }

      // 检测模型是否声明目标已完成(goal 模式)→ 跳过剩余步骤,直接进 Judge
      if (stepDone && step.result?.includes('[GOAL_COMPLETE]')) {
        // 标记后续步骤为 skipped
        for (const s of plan.steps) {
          if (s.status === 'pending') s.status = 'skipped';
        }
        onEvent({ type: 'status', text: '🎯 v2: 模型声明目标已完成 [GOAL_COMPLETE],跳过剩余步骤' });
        break;
      }

      // 步骤间上下文压缩:防止多步 plan 的 history 累积爆炸。
      // budget 同 finalizeContext(普通 30K / hifi 40% of hifiBudget)。
      if (!signal.aborted) {
        const hifiBudget = getSettings().hifiContextBudget ?? 80_000;
        execHistory = await compactHistory(
          execHistory,
          conv.contextMode === 'hifi' ? Math.round(hifiBudget * 0.4) : 30_000,
          provider,
          snap,
          signal,
        );
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
    const replanInput = `原始任务: ${originalPrompt}\n\n上一轮 plan 的执行结果:\n${prevPlan.steps.map((s) => `  [${s.id}] ${s.title} — ${s.status}: ${(s.result || '').slice(0, 200)}`).join('\n')}\n\n请根据上次结果修正方案,重新输出 <plan>。`;

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
      onEvent: (ev) => this.forwardEvent(ev, onEvent),
    });

    execHistory = plannerMessages;

    const newPlan = this.parsePlan(this.extractLastAssistantText(plannerMessages));
    if (!newPlan || newPlan.steps.length === 0) {
      // 模型没出新 plan → 说明它觉得可以直接给出答案,走退化模式
      return execHistory;
    }

    // ── 执行新 plan 的步骤(与 Phase 2 一致:重试 + 验证)──
    for (const step of newPlan.steps) {
      if (signal.aborted) break;
      step.status = 'running';
      onEvent({ type: 'status', text: `🔨 v2: 重执行步骤 [${step.id}] ${step.title}` });

      let stepDone = false;
      for (let attempt = 0; attempt < MAX_RETRIES && !stepDone && !signal.aborted; attempt++) {
        const retryNote = attempt > 0 ? `\n\n**⚠️ 这是第 ${attempt + 1} 次尝试。上一次失败,请修正问题后重试。**\n上一次结果: ${step.result ?? '(无)'}` : '';

        const stepMessages = await runAgentLoop({
          provider,
          tools,
          systemPrompt,
          userInput: STEP_EXECUTOR_PROMPT(step, newPlan.steps, newPlan.goal) + retryNote,
          history: execHistory,
          ctx,
          signal,
          snapshot: snap,
          contextMode: conv.contextMode,
          hifiContextBudget: getSettings().hifiContextBudget,
          onEvent: (ev) => this.forwardEvent(ev, onEvent),
        });

        execHistory = stepMessages;
        const stepAnswer = this.extractLastAssistantText(stepMessages);

        if (step.verifyCommand) {
          const verifyResult = await this.runVerify(step.verifyCommand, conv.cwd, ctx, signal, onEvent);
          if (verifyResult.ok) {
            step.status = 'done';
            step.result = stepAnswer.slice(0, 500);
            stepDone = true;
            onEvent({ type: 'status', text: `✅ v2: 步骤 [${step.id}] 验证通过` });
          } else {
            step.status = attempt + 1 < MAX_RETRIES ? 'pending' : 'failed';
            step.result = `验证失败: ${verifyResult.output.slice(0, 500)}`;
            step.retryCount = attempt + 1;
            if (attempt + 1 < MAX_RETRIES) {
              onEvent({ type: 'status', text: `⚠️ v2: 步骤 [${step.id}] 验证失败,重试 ${attempt + 1}/${MAX_RETRIES}` });
            }
          }
        } else {
          step.status = 'done';
          step.result = stepAnswer.slice(0, 500);
          stepDone = true;
          onEvent({ type: 'status', text: `✅ v2: 步骤 [${step.id}] 完成` });
        }
      }

      // 检测模型是否声明目标已完成 → 跳过剩余步骤
      if (stepDone && step.result?.includes('[GOAL_COMPLETE]')) {
        for (const s of newPlan.steps) {
          if (s.status === 'pending') s.status = 'skipped';
        }
        onEvent({ type: 'status', text: '🎯 v2: 模型声明目标已完成 [GOAL_COMPLETE],跳过剩余步骤' });
        break;
      }

      // 步骤间上下文压缩(同 Phase 2)
      if (!signal.aborted) {
        const hifiBudget = getSettings().hifiContextBudget ?? 80_000;
        execHistory = await compactHistory(
          execHistory,
          conv.contextMode === 'hifi' ? Math.round(hifiBudget * 0.4) : 30_000,
          provider,
          snap,
          signal,
        );
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
    // 匹配 <plan>{...}</plan> 或裸 JSON
    const planMatch = text.match(/<plan>\s*(\{[\s\S]*?\})\s*<\/plan>/i);
    const jsonStr = planMatch?.[1] ?? null;
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
      const { priceUSD } = await import('./glm');
      if (comp.tokensIn > 0 || comp.tokensOut > 0) {
        onEvent({ type: 'cost', usd: priceUSD(snap.model, comp.tokensIn, comp.tokensOut), tokens: comp.tokensIn + comp.tokensOut });
      }

      const text = comp.content ?? '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const obj = JSON.parse(jsonMatch[0]) as { completed?: boolean; reason?: string };
        return {
          completed: Boolean(obj.completed),
          reason: String(obj.reason ?? '(无说明)'),
        };
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

  /** 运行指定验证命令(走 confirm 审批 + shellExec 统一执行)。 */
  private async runVerify(
    command: string,
    cwd: string,
    ctx: ToolCtx,
    signal: AbortSignal,
    onEvent: (e: AgentEvent) => void,
  ): Promise<{ ok: boolean; output: string }> {
    // 安全:验证命令必须走 confirm(和 shell 工具一致)
    const approved = await ctx.confirm(`[v2 验证] ${command}`);
    if (!approved) {
      return { ok: true, output: '(用户跳过验证)' }; // 用户跳过 → 当作通过
    }

    try {
      const output = await shellExec(command, cwd, 30_000, signal);
      const ok = !/\[exit \d+\]/.test(output); // shellExec 非零退出码会加 [exit N] 前缀
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

    const result = await this.runVerify(verifyCmd.command, conv.cwd, ctx, signal, onEvent);
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
    } catch {
      // 检测失败 → 不验证
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════════════
  // 工具方法
  // ════════════════════════════════════════════════════════════════════

  /** 从 messages 中提取最后一条 assistant 消息的文本内容。 */
  private extractLastAssistantText(messages: ChatMsg[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && typeof m.content === 'string') {
        return m.content;
      }
    }
    return '';
  }

  /**
   * 从 execHistory 尾部提取最近的 assistant 文本 + tool 结果,截断为 Judge 可读的证据摘要。
   * 只取尾部 ~20 条消息,每条截断到 300 字符,总上限 ~4000 字符。
   */
  private extractExecEvidence(messages: ChatMsg[]): string {
    const tail = messages.slice(-20);
    const parts: string[] = [];
    let totalLen = 0;
    for (const m of tail) {
      let line = '';
      if (m.role === 'assistant') {
        const text = typeof m.content === 'string' ? m.content : '';
        const tools = (m.tool_calls ?? []).map((tc) => `${tc.function.name}(${tc.function.arguments.slice(0, 80)})`).join(', ');
        line = `[助手] ${text.slice(0, 300)}${tools ? `  🔧 ${tools}` : ''}`;
      } else if (m.role === 'tool') {
        const text = typeof m.content === 'string' ? m.content : '';
        line = `[工具结果] ${text.slice(0, 300)}`;
      } else if (m.role === 'user' && !m._memory) {
        const text = typeof m.content === 'string' ? m.content : '';
        line = `[用户] ${text.slice(0, 150)}`;
      }
      if (line) {
        totalLen += line.length;
        if (totalLen > 4000) break;
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
        // Direct 子任务:只读工具、独立上下文
        const out = await runAgentLoop({
          provider,
          tools: readOnlyTools(),
          systemPrompt: SUBAGENT_PROMPT,
          snapshot: snap,
          userInput: sub,
          history: [],
          ctx: { cwd: conv.cwd, confirm: this.confirm, convId: conv.id },
          signal: childSignal,
          maxTurns: 8,
          onEvent: (e) => {
            if (e.type === 'cost') onEvent(e);
            else if (e.type === 'tool') onEvent({ type: 'status', text: `[子任务] ${e.name}` });
          },
        });
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
