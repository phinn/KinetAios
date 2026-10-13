// V4 Engine(Legis)— 立法者引擎入口
//
// 架构(设计文档 docs/V4-Legis-引擎设计.md §3):
//   Router(V3 照搬) → fast/std 复用 V3 路径;deep → Legis 流水线:
//   编译(LLM #1)→ Runtime(replay 0 LLM + agent + 缓存 + 429 park)→ 验收断言 → 唤回(LLM #2..n)
// V4 相对 V3 的本质差异:LLM 出场权 —— 从"每步一次"改为"每程序一次"。
// Router/Job 化/断点恢复全部复用 V3 基建。
// The V4 engine: router (from V3) + Legis pipeline for deep tasks —
// compile once (LLM #1), run replay nodes with zero LLM, assert, recall on failure.

import type { AgentEvent, ChatMsg, Conversation, SandboxMode } from '../../shared/types';
import { resolveEnginePolicy } from '../../shared/types';
import { currentProvider, type Provider } from '../glm';
import { allTools, readOnlyTools, type ToolCtx } from '../tools';
import { getSettings, snapshot } from '../settings';
import * as store from '../store';
import { mcp } from '../mcp';
import { pluginSystemPrompts } from '../plugins';
import { skillCatalogText } from '../skills';
import {
  baseSystemPrompt,
  cwdAnchorSection,
  personaSection,
  sourceHintSection,
  loadProjectRules,
  resolveSpawnHistory,
  SUBAGENT_PROMPT,
  type Engine,
  type EngineRunOpts,
} from '../engines';
import { runAgentLoop, compactWithSpill } from '../AgentLoop';
import { routeTask, isAnalysisTask } from '../V3/router';
import { executeFastPath, executeStdPath } from './paths';
import { compileLegisPlan } from './legis-compiler';
import { executeLegis } from './legis-executor';
import { recall } from './recall';
import { jobManager } from '../JobManager';
import { taskManager } from '../main-instance';
import { finalizeContext } from '../V3/streaming-executor';
import type { LegisPlan } from './plan';

// 终态事件闸门(与 V3 同款):拦截内层 done,防双发;error 透传可见。
function terminalGate(onEvent: (e: AgentEvent) => void): (e: AgentEvent) => void {
  return (e) => {
    if (e.type === 'done') return;
    if (e.type === 'error') {
      onEvent({ type: 'status', text: `⚠️ ${e.message}` });
      return;
    }
    onEvent(e);
  };
}

const V4_SYSTEM_SUFFIX = `

# 你是 Kaios v4 引擎(Legis)
你的执行模型与以往不同:**你是一次性的立法者**。
- 复杂任务:系统会要求你调用 submit_legis_plan 提交计划图;提交后你退场,系统零 LLM 执行(replay 节点),断言失败才唤回你。
- 简单任务:直接用工具执行(与 v3 相同)。
- 唤回时你会收到"最小故障现场"(失败断言 + tail 输出),只裁决修复,不重读全部历史。

## 工作原则
1. 立法时把确定性动作(验证命令、读文件、产物检查)写成 replay 节点 —— 省 LLM 成本
2. acceptance 是任务完成的机器判定标准,必须可验证(命令成功 + 产物存在)
3. agent 节点的 action 要写到可独立执行的详细程度(执行时看不到完整对话)
`;

export class DirectV4Engine implements Engine {
  readonly name = 'directV4' as const;

  constructor(private confirm: (cmd: string) => Promise<boolean>) {}

  async run({ conv, memoryBlock, rulesBlock, contextBlock, skillBlock, refBlock, signal, onEvent }: EngineRunOpts): Promise<void> {
    const prompt = conv.turns[conv.turns.length - 1]?.prompt ?? '';
    const base = snapshot(conv.profileId);
    const snap = { ...base, model: conv.model || base.model };
    const provider = currentProvider(snap);

    // ── 构建 systemPrompt(与 V3 对齐的组装顺序)──
    const goalSection = conv.goal
      ? `\n\n# 🎯 会话目标\n你当前的核心目标是:\n${conv.goal}\nacceptance 断言表将作为该目标完成的机器判定标准。`
      : '';
    const skillSection = skillBlock ? `\n\n# 当前 Skill 指令(用户通过 / 调用,请遵循)\n${skillBlock}` : '';
    const skillCatalog = getSettings().autoLoadSkills ? skillCatalogText() : null;
    const skillCatalogSection = skillCatalog
      ? `\n\n# 可用 Skills(按需加载)\n${skillCatalog}\n`
      : '';
    const rulesSection = loadProjectRules(conv.cwd);

    const systemPrompt =
      baseSystemPrompt +
      cwdAnchorSection(conv) +
      V4_SYSTEM_SUFFIX +
      personaSection(conv) +
      sourceHintSection(conv) +
      goalSection +
      skillSection + skillCatalogSection +
      rulesSection +
      (rulesBlock ?? '') +
      (contextBlock ?? '') +
      pluginSystemPrompts('directV4', prompt);

    // ── ToolCtx(与 V3 对齐)──
    const ctx: ToolCtx = {
      cwd: conv.cwd,
      confirm: this.confirm,
      signal,
      convId: conv.id,
      turnId: conv.turns.length ? conv.turns[conv.turns.length - 1].id : undefined,
      crossProjectMemory: conv.crossProjectMemory === true,
      sandbox: getSettings().sandbox,
      emit: onEvent,
      spawn: async ({ prompt: sub, signal: childSignal, engine }) => {
        const subAc = new AbortController();
        const subTimer = setTimeout(() => subAc.abort(), 5 * 60 * 1000);
        const onParentAbort = (): void => subAc.abort();
        if (childSignal.aborted) subAc.abort();
        else childSignal.addEventListener('abort', onParentAbort, { once: true });
        try {
          if (engine === 'claudeCode' || engine === 'codex') {
            const { runCliOneShot } = await import('../engines');
            return await runCliOneShot(engine, sub, conv.cwd, subAc.signal);
          }
          const out = await runAgentLoop({
            provider, tools: readOnlyTools(), systemPrompt: SUBAGENT_PROMPT,
            snapshot: snap, userInput: sub, history: [],
            ctx: { cwd: conv.cwd, confirm: this.confirm, convId: conv.id, crossProjectMemory: conv.crossProjectMemory === true, sandbox: 'readOnly' as const },
            signal: subAc.signal,
            onEvent: (e) => {
              if (e.type === 'cost') onEvent(e);
              else if (e.type === 'tool') onEvent({ type: 'tool', name: `[子任务] ${e.name}`, args: e.args, result: e.result, durationMs: e.durationMs, images: e.images });
            },
          });
          const text = out.filter((m) => m.role === 'assistant' && typeof m.content === 'string').map((m) => (m as { content: string }).content).join('\n').trim();
          return text || '(子任务无文本输出)';
        } finally {
          clearTimeout(subTimer);
          childSignal.removeEventListener('abort', onParentAbort);
        }
      },
    };

    // ── 上下文策略(V4 独立策略包,起步值与 V3 相同)──
    const policy = resolveEnginePolicy('directV4', conv.contextMode, getSettings().v2ModelWindow, getSettings().v2BudgetRatio, getSettings().hifiContextBudget);

    const tools = [...allTools(), ...(await mcp.directTools(2000))];

    const refSection = refBlock ?? '';
    const crossCtx = conv.crossEngineContext;
    if (crossCtx) conv.crossEngineContext = null;
    const userInput = [prompt, refSection || null, crossCtx || null].filter(Boolean).join('\n\n');

    if (!prompt.trim()) {
      onEvent({ type: 'error', message: '(空输入)' });
      return;
    }

    // ── 路由(V3 router)+ V4 Legis 语义修正 ──
    // V4 语义:用户显式选择了 Legis 引擎,期望的就是"意图编译为计划图"范式;
    // 只有 fast(秒答)保持原路径;std/deep 一律进 Legis 编译执行(编译失败内部自动退化 std,兜底安全)。
    // isAnalysisTask 的 std 钉死在 V4 放宽:排障/修复类任务句句带 .log/.json/"数据",
    // 会被分析正则误拦 — 带 修复/排查/调试/验证/引导 信号的照常进 Legis。
    // (事故:2026-10-12 通宵 UEFI 排障 14 turn 全走裸 std,Legis 0 次触发,单 turn 294 步。)
    // 延续指令感知:"继续/可以,你做/看看为什么X修掉" 单看文本会落 fast(轻上下文),
    // 但前 2 turn 工具步数 ≥8 说明多步任务进行中 — 一律不允许 fast(轻上下文会丢任务现场)。
    const repairSignal = /修复|修掉|修好|排查|调试|排障|验证|重试|引导|装机|装系统|卡在|卡住|boot|install|build|编译|烧录|burst/i.test(prompt);
    const route = routeTask(prompt, conv.directHistory, { hasGoal: !!conv.goal });
    const analysisPin = route === 'std' && isAnalysisTask(prompt) && !repairSignal;
    const recentSteps = conv.turns.slice(-2).reduce((n, t) => n + (t.steps?.length ?? 0), 0);
    const v4Route: 'fast' | 'std' | 'legis' = route === 'fast' && recentSteps < 8 && !repairSignal
      ? 'fast'
      : analysisPin ? 'std' : 'legis';
    const skillTag = skillBlock ? `📦 ${prompt.match(/^\/([\w-]+)/)?.[1] ?? 'skill'} | ` : '';
    onEvent({ type: 'status', text: `${skillTag}🧭 v4: 路由 → ${v4Route.toUpperCase()}${isAnalysisTask(prompt) ? ' · 📊 分析模式(std)' : ''}` });

    let updatedHistory: ChatMsg[] = conv.directHistory;

    // 立法编译结果存证(2026-10):成功 N 节点 / 退化 std + 原因,落 conv_events(legis/compile),
    // 复盘"立法成功还是静默降级"不再靠猜。
    const legisT0 = Date.now();
    const legisCompileEvent = (degraded: boolean, reason?: string, nodes = 0, edges = 0): void => {
      onEvent({ type: 'legis/compile', nodes, edges, durationMs: Date.now() - legisT0, degraded, reason });
    };

    try {
      if (v4Route === 'fast') {
        updatedHistory = await executeFastPath({ provider, tools, systemPrompt, memoryBlock, snapshot: snap, userInput, history: conv.directHistory, ctx, signal, policy, onEvent: terminalGate(onEvent) });
      } else if (v4Route === 'std') {
        updatedHistory = await executeStdPath({ provider, tools, systemPrompt, memoryBlock, snapshot: snap, userInput, history: conv.directHistory, ctx, signal, policy, onEvent: terminalGate(onEvent) });
      } else {
        // ── deep → Legis 流水线 ──
        const { plan, probedHistory } = await compileLegisPlan({
          userInput, history: conv.directHistory, systemPrompt, provider, snap, signal,
          onEvent: terminalGate(onEvent), ctx, policy, memoryBlock, goal: conv.goal ?? undefined,
        });
        if (!plan) {
          // 编译失败 → 退化 std。关键:继承 planner 的探查现场(12 轮只读探查 history),
          // 否则 std 从零重探,双倍烧钱烧步(2026-10-13 事故:planner 白跑 12 轮 + std 重跑 104 步)。
          legisCompileEvent(true, 'submit_legis_plan 未提交/解析失败');
          onEvent({ type: 'status', text: '🔄 v4: 立法失败,退化为标准执行(已继承立法期探查现场)' });
          updatedHistory = await executeStdPath({ provider, tools, systemPrompt, memoryBlock, snapshot: snap, userInput, history: probedHistory, ctx, signal, policy, onEvent: terminalGate(onEvent) });
        } else {
          // 广播计划
          legisCompileEvent(false, undefined, plan.nodes.length, plan.nodes.reduce((n, x) => n + x.deps.length, 0));
          onEvent({
            type: 'status',
            text: `📜 v4: ${plan.summary}\n${plan.nodes.map((n) => `  [${n.id}] ${n.kind === 'replay' ? '⚙️' : '🤖'} ${n.title} (deps: [${n.deps.join(',')}])`).join('\n')}\n验收: ${plan.acceptance.length} 条断言`,
          });
          // Legis 后台 Job 化(复用 v3DeepBackground 设置)
          if (getSettings().v3DeepBackground) {
            const jobId = submitLegisJob({ conv, provider, tools, systemPrompt, memoryBlock, snap, userInput, ctx, policy, plan });
            if (jobId) {
              onEvent({ type: 'status', text: `🚀 v4: 已转入后台执行(Job ${jobId.slice(0, 8)})。完成后结果自动回贴本会话。` });
              onEvent({ type: 'status', text: '⏳ v4: 后台执行中 — 完成后自动回贴' });
              // handoff done:turn 不落终态、conv 保持 running —— 后台 job 期间侧栏呼吸点/状态条持续,
              // 真正终局由 appendJobResult 的回贴 turn 承载(AgentDoneEvent.handoff 扩展位)。
              onEvent({ type: 'done', handoff: true });
              return;
            }
          }
          onEvent({ type: 'status', text: '⚙️ v4: Legis 图执行中(Runtime 零 LLM replay)' });
          const result = await executeLegis({
            plan, provider, tools, systemPrompt, memoryBlock, snapshot: snap, ctx, signal, policy,
            history: conv.directHistory,
            recall: (input) => recall({ provider, snap, signal, plan, input, onEvent }),
            onEvent: terminalGate(onEvent),
          });
          updatedHistory = result.history;
          // 验收结论进 history(goal 模式的 [GOAL_COMPLETE] 语义由 acceptance 替代)
          if (result.acceptancePassed === true) {
            updatedHistory.push({ role: 'assistant', content: `[GOAL_COMPLETE] 验收断言表全过(${result.acceptanceSummary})` });
          }
        }
      }
    } catch (e) {
      const errMsg = (e as Error)?.message ?? String(e);
      if (signal.aborted) {
        conv.directHistory = updatedHistory;
        onEvent({ type: 'done' });
        return;
      }
      onEvent({ type: 'error', message: `v4 引擎出错: ${errMsg}` });
      conv.directHistory = updatedHistory;
      return;
    }

    if (signal.aborted) {
      conv.directHistory = updatedHistory;
      onEvent({ type: 'done' });
      return;
    }

    // ── 收尾压缩(与 V3 同 seam)──
    try {
      const compacted = await compactWithSpill(updatedHistory, () =>
        finalizeContext(updatedHistory, policy, provider, snap, signal, onEvent, conv.id),
      { convId: conv.id, turnId: conv.turns.length ? conv.turns[conv.turns.length - 1].id : undefined });
      conv.directHistory = compacted;
    } catch {
      conv.directHistory = updatedHistory;
    }

    onEvent({ type: 'done' });
  }

  releaseConv?(convId: string): void {
    void convId;
  }
}

// Legis deep 后台 Job(结构对齐 V3 submitDeepJob)
function submitLegisJob(args: {
  conv: Conversation; provider: Provider; tools: ReturnType<typeof allTools>;
  systemPrompt: string; memoryBlock?: string; snap: ReturnType<typeof snapshot>;
  userInput: string; ctx: ToolCtx; policy: ReturnType<typeof resolveEnginePolicy>; plan: LegisPlan;
}): string | null {
  const { conv, provider, tools, systemPrompt, memoryBlock, snap, userInput, ctx, policy, plan } = args;
  const title = (conv.turns[conv.turns.length - 1]?.prompt ?? 'legis 任务').slice(0, 60);
  const historySnapshot = [...conv.directHistory];
  const turnId = conv.turns.length ? conv.turns[conv.turns.length - 1].id : null;
  const submit = jobManager().submit({
    convId: conv.id,
    turnId,
    kind: 'v4-legis',
    title,
    payload: { model: snap.model, cwd: conv.cwd },
    worker: async ({ signal, onEvent, checkpointSink, initialCheckpoint }) => {
      const jobCtx: ToolCtx = { ...ctx, signal };
      try {
        const result = await executeLegis({
          plan, provider, tools, systemPrompt, memoryBlock, snapshot: snap,
          ctx: jobCtx, signal, policy, history: historySnapshot,
          recall: (input) => recall({ provider, snap, signal, plan, input, onEvent }),
          onEvent,
          initialCheckpoint: initialCheckpoint as { completedNodeIds: string[]; history: ChatMsg[] } | undefined,
          onCheckpoint: checkpointSink as (cp: { completedNodeIds: string[]; history: ChatMsg[] }) => void,
        });
        let answer = '';
        for (let i = result.history.length - 1; i >= 0; i--) {
          const m = result.history[i];
          if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) { answer = m.content; break; }
        }
        if (!answer) answer = `(legis 任务完成 — ${result.completedNodeIds.length}/${plan.nodes.length} 节点,验收: ${result.acceptanceSummary})`;
        taskManager.appendJobResult(conv.id, { title, answer, updatedHistory: result.history, ok: !signal.aborted });
        return { result: { answer } };
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        taskManager.appendJobResult(conv.id, { title, answer: `后台 legis 任务失败: ${msg}`, updatedHistory: null, ok: false });
        throw e;
      }
    },
  });
  return submit.ok ? submit.id : null;
}

// 未使用 import 消除(tsc noUnusedLocals)
void store;
