// V3 Engine — 自适应流水线引擎入口
//
// 架构:
//   User Input → Router(fast/std/deep) → 各路径执行 → Unified Output
//
// 三条路径:
//   Fast: 单轮 ReAct(5 turns),零开销 — 简单问答、读文件、grep
//   Std:  Streaming ReAct(20 turns)— 修 bug、写功能
//   Deep: DAG Plan + 并行执行 + 嵌入式验证 — 跨文件重构
//
// V3 相对 V2 的核心改进:
// 1. 自适应路由 — 60%+ 任务走零开销 Fast path
// 2. 取消独立 Judge — 省 1 次 LLM 调用
// 3. DAG 并行 — 同层无依赖步骤自动并行
// 4. 结构化 Plan — forced tool_use 替代 <plan> 标签解析
// 5. 嵌入式验证 — 写完自动 tsc/lint,结果作为 tool result 返回

import type { AgentEvent, ChatMsg, Conversation, SandboxMode } from '../../shared/types';
import { resolveEnginePolicy } from '../../shared/types';
import { currentProvider, priceUSD, type Provider } from '../glm';
import { allTools, readOnlyTools, type ToolCtx } from '../tools';
import { getSettings, snapshot } from '../settings';
import * as store from '../store';
import { mcp } from '../mcp';
import { pluginSystemPrompts } from '../plugins';
import {
  baseSystemPrompt,
  personaSection,
  sourceHintSection,
  loadProjectRules,
  resolveSpawnHistory,
  SUBAGENT_PROMPT,
  type Engine,
  type EngineRunOpts,
} from '../engines';
import { runAgentLoop, compactHistory } from '../AgentLoop';

import { routeTask } from './router';
import { executeFastPath } from './fast-path';
import { executeStdPath } from './std-path';
import { executeDeepPath } from './deep-path';
import { finalizeContext } from './streaming-executor';

export class DirectV3Engine implements Engine {
  readonly name = 'directV3' as const;

  constructor(private confirm: (cmd: string) => Promise<boolean>) {}

  async run({ conv, memoryBlock, rulesBlock, contextBlock, skillBlock, refBlock, signal, onEvent }: EngineRunOpts): Promise<void> {
    const prompt = conv.turns[conv.turns.length - 1]?.prompt ?? '';
    const base = snapshot(conv.profileId);
    const snap = { ...base, model: conv.model || base.model };
    const provider = currentProvider(snap);

    // ── 构建 systemPrompt ──
    const goalSection = conv.goal
      ? `\n\n# 🎯 会话目标\n你当前的核心目标是:\n${conv.goal}\n请在每一步操作中都朝这个目标推进。**当你确认目标已经完成时,在回答的最末尾输出 \`[GOAL_COMPLETE]\` 标记。**`
      : '';
    const skillSection = skillBlock ? `\n\n# 当前 Skill 指令(用户通过 / 调用,请遵循)\n${skillBlock}` : '';
    const rulesSection = loadProjectRules(conv.cwd);

    const systemPrompt =
      baseSystemPrompt +
      V3_SYSTEM_SUFFIX +
      personaSection(conv) +
      sourceHintSection(conv) +
      goalSection +
      skillSection +
      rulesSection +
      (rulesBlock ?? '') +
      (contextBlock ?? '') +
      pluginSystemPrompts('directV3', prompt);

    // ── 构建 ToolCtx(与 V2 完全对齐)──
    const ctx: ToolCtx = {
      cwd: conv.cwd,
      confirm: this.confirm,
      signal,
      convId: conv.id,
      sandbox: getSettings().sandbox,
      spawn: async ({ prompt: sub, signal: childSignal, engine, model, scope }) => {
        // 跨引擎子任务(V3 也支持调用 claude/codex 一次性任务)
        if (engine === 'claudeCode' || engine === 'codex') {
          const { runCliOneShot } = await import('../engines'); return runCliOneShot(engine, sub, conv.cwd, signal);
        }
        // 子 agent model 覆盖:优先级 = LLM 传参 > 频道配置(conv.subAgentModel) > 全局设置 > 主 agent。
        // / Sub-agent model: LLM param > channel config > global setting > main agent.
        const effectiveModel = model || conv.subAgentModel || getSettings().subAgentModel || undefined;
        const subSnap = effectiveModel ? { ...snap, model: effectiveModel } : snap;
        const subProvider = effectiveModel ? currentProvider(subSnap) : provider;
        // Direct sub-agent:独立 ReAct loop(只读工具)
        const scopeResolved = scope ?? { mode: 'none' as const };
        const subAc = new AbortController();
        const subTimer = setTimeout(() => subAc.abort(), 5 * 60 * 1000);
        const onParentAbort = (): void => subAc.abort();
        if (signal.aborted) subAc.abort();
        else signal.addEventListener('abort', onParentAbort, { once: true });

        const { historyText } = await resolveSpawnHistory({
          scope: scopeResolved,
          parentHistory: conv.directHistory,
          provider: subProvider,
          snap: subSnap,
          signal: subAc.signal,
          onEvent,
        });
        const finalPrompt = historyText
          ? `${sub}\n\n---\n# 父会话上下文(只读参考,不要修改或依赖)\n${historyText}\n---`
          : sub;
        const out = await runAgentLoop({
          provider: subProvider,
          tools: readOnlyTools(),
          systemPrompt: SUBAGENT_PROMPT,
          snapshot: subSnap,
          userInput: finalPrompt,
          history: [],
          ctx: { cwd: conv.cwd, confirm: this.confirm, convId: conv.id, sandbox: 'readOnly' as const },
          signal: subAc.signal,
          maxTurns: 8,
          onEvent: (e) => {
            if (e.type === 'cost') onEvent(e);
            else if (e.type === 'tool') onEvent({ type: 'status', text: `[子任务] ${e.name}` });
          },
        });
        clearTimeout(subTimer);
        signal.removeEventListener('abort', onParentAbort); // 清理 parent signal listener
        const text = out
          .filter((m) => m.role === 'assistant' && typeof m.content === 'string')
          .map((m) => m.content)
          .join('\n')
          .trim();
        return text || '(子任务无文本输出)';
      },
      teamRun: async ({ teamId, memberNames, message }) => {
        const { runMember, runMembersParallel, memberCostUSD } = await import('../teams');
        const { emitTeamEvent } = await import('../main');

        const runOpts = {
          provider, snap, signal,
          cwd: conv.cwd,
          confirm: this.confirm,
          convId: conv.id,
          onTeamEvent: (memberName: string, ev: import('../../shared/types').TeamEvent) => {
            emitTeamEvent(teamId, ev);
          },
        };

        if (memberNames.length <= 1) {
          const name = memberNames[0];
          if (!name) return '';
          const m = store.loadTeamMember(teamId, name);
          if (!m) return `[${name}] (member 不存在)`;
          try {
            emitTeamEvent(teamId, { type: 'memberStatus', memberName: name, status: 'running' });
            const r = await runMember({ member: m, userMessage: message, runOpts });
            store.upsertTeamMember({ ...m, history: JSON.stringify(r.newHistory), last_message: message, last_result: r.answer, status: 'done', updated_at: Date.now() / 1000 });
            const usd = memberCostUSD(snap, r.tokensIn, r.tokensOut);
            onEvent({ type: 'cost', usd, tokens: r.tokensIn + r.tokensOut });
            emitTeamEvent(teamId, { type: 'memberDone', memberName: name, answer: r.answer });
            emitTeamEvent(teamId, { type: 'memberStatus', memberName: name, status: 'done' });
            return `### ${m.name} (${m.role})\n${r.answer || '(无回答)'}\n`;
          } catch (e) {
            store.upsertTeamMember({ ...m, last_message: message, last_result: `错误: ${(e as Error)?.message}`, status: 'failed', updated_at: Date.now() / 1000 });
            emitTeamEvent(teamId, { type: 'memberStatus', memberName: name, status: 'failed' });
            return `### ${m.name}\n错误: ${(e as Error)?.message}\n`;
          }
        }

        // 多 member broadcast:并行
        const members = memberNames.map(n => store.loadTeamMember(teamId, n)).filter((m): m is NonNullable<typeof m> => m !== null);
        const results = await runMembersParallel({ members, message, runOpts });
        const parts: string[] = [];
        let totalUsd = 0;
        let totalTokens = 0;
        for (const m of members) {
          const r = results.get(m.name);
          if (!r) { parts.push(`### ${m.name}\n(无结果)\n`); continue; }
          store.upsertTeamMember({ ...m, history: JSON.stringify(r.newHistory), last_message: message, last_result: r.answer, status: r.error ? 'failed' : 'done', updated_at: Date.now() / 1000 });
          totalUsd += memberCostUSD(snap, r.tokensIn, r.tokensOut);
          totalTokens += r.tokensIn + r.tokensOut;
          parts.push(`### ${m.name} (${m.role})\n${r.answer || '(无回答)'}\n`);
        }
        if (totalUsd > 0) onEvent({ type: 'cost', usd: totalUsd, tokens: totalTokens });
        return parts.join('\n');
      },
    };

    // ── 上下文策略 ──
    const policy = resolveEnginePolicy('directV3', conv.contextMode, getSettings().v2ModelWindow, getSettings().v2BudgetRatio);

    // ── 工具集 ──
    const tools = [...allTools(), ...(await mcp.directTools(2000))];

    // ── 构建 user input ──
    const refSection = refBlock ?? '';
    const crossCtx = conv.crossEngineContext;
    if (crossCtx) conv.crossEngineContext = null;
    const userInput = [prompt, refSection || null, crossCtx || null].filter(Boolean).join('\n\n');

    if (!prompt.trim()) {
      onEvent({ type: 'error', message: '(空输入)' });
      return;
    }

    // ── 路由分类 ──
    const route = routeTask(prompt, conv.directHistory, { hasGoal: !!conv.goal });
    onEvent({ type: 'status', text: `🧭 v3: 路由 → ${route.toUpperCase()}` });

    // ── 执行 ──
    let updatedHistory: ChatMsg[] = conv.directHistory;

    try {
      if (route === 'fast') {
        updatedHistory = await executeFastPath({
          provider, tools, systemPrompt, memoryBlock, snapshot: snap,
          userInput, history: conv.directHistory, ctx, signal, policy, onEvent,
        });
      } else if (route === 'std') {
        updatedHistory = await executeStdPath({
          provider, tools, systemPrompt, memoryBlock, snapshot: snap,
          userInput, history: conv.directHistory, ctx, signal, policy, onEvent,
        });
      } else {
        updatedHistory = await executeDeepPath({
          provider, tools, systemPrompt, memoryBlock, snapshot: snap,
          userInput, history: conv.directHistory, ctx, signal, policy, onEvent,
        });
      }
    } catch (e) {
      const errMsg = (e as Error)?.message ?? String(e);
      if (signal.aborted) {
        conv.directHistory = updatedHistory;
        onEvent({ type: 'done' });
        return;
      }
      onEvent({ type: 'error', message: `v3 引擎出错: ${errMsg}` });
      conv.directHistory = updatedHistory;
      onEvent({ type: 'done' });
      return;
    }

    if (signal.aborted) {
      conv.directHistory = updatedHistory;
      onEvent({ type: 'done' });
      return;
    }

    // ── 最终上下文压缩 ──
    try {
      conv.directHistory = await finalizeContext(updatedHistory, policy, provider, snap, signal, onEvent, conv.id);
    } catch {
      conv.directHistory = updatedHistory;
    }

    onEvent({ type: 'done' });
  }
}

// V3 系统提示后缀(比 V2 简洁 — 不需要 <plan> 标签说明)
const V3_SYSTEM_SUFFIX = `

# 你是 Kaios v3 引擎 — 自适应流水线
系统会根据任务复杂度自动选择执行策略:
- **简单任务**(问答、读文件):直接用工具执行,快速响应
- **中等任务**(修 bug、写功能):多轮工具调用,自动验证
- **复杂任务**(跨文件重构):系统会提示你提交结构化规划

## 工作原则
1. 该用工具就果断用,不要只给步骤
2. 写完代码后主动用 shell 运行验证命令(tsc/lint/test)
3. 遇到报错要追踪根因,不要只修表象
4. 简洁高效,少说废话多写代码
`;
