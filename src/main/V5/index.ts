// V5 Engine(Phylum)— 种群进化引擎入口
//
// 范式:Agent 不学习,Agent 繁衍。每个用户 prompt 归一化为任务模板 id(签名 v1),
// 从基因库领取活体个体表达执行(硬约束:亲和摘工具/maxSteps 预算/断言 gate);
// 执行结束死亡即结算,死因归因决定子代突变位点(疤痕遗传),替补出生接力。
// 基因库 JSONL 落盘 userData/phylum/,跨会话存活 —— 会话是过客,基因是资产。
//
// The V5 (Phylum) engine: each prompt normalizes to a task-template id (signature v1),
// claims a live genome from the registry, executes under expressed hard constraints
// (affinity-filtered registry / maxSteps / assertion gates); death settles instantly,
// attribution mutates the replacement — scars inherit across turns. The registry
// persists to userData/phylum/ (JSONL): conversations are transient, genes are assets.

import path from 'node:path';
import { app } from 'electron';
import type { AgentEvent, ChatMsg, ToolErrorKind } from '../../shared/types';
import { currentProvider, type Completion, type Provider, type ToolDef } from '../glm';
import { allTools, type Tool, type ToolCtx } from '../tools';
import { getSettings, snapshot } from '../settings';
import { withExecRoute } from '../model-router';
import { pluginSystemPrompts } from '../plugins';
import {
  cwdAnchorSection,
  personaSection,
  sourceHintSection,
  type Engine,
  type EngineRunOpts,
} from '../engines';
import { express } from './express';
import { runBodyPlan } from './bodyplan';
import { runRalphLoop, type RalphOpts } from './ralph';
import {
  INTENT_LEDGER_HINT, assessEvidence, canComplete, evaluateIntentAssertions, recordEvidence, refreshIntentSpend,
} from '../intent-ledger';
import * as store from '../store';
import { settleRalph, acceptanceFromPrompt, ralphToOutcome } from './ralph-settle';
import { signatureOfTemplateWeighted, weightOfPrompt } from './signature';
import { GeneRegistry, isEnvironmentErrorKind, type AttributionFacts } from './registry';
import {
  geneSnapshot, type Genome, type RunOutcome, type TraceTemplate,
  STEP_BUDGET_CEIL, FOSSIL_DEPOSIT_RATE, CONVERGE_MIN_TRIALS, INTENT_TOOL_NAMES,
} from './phylum-types';
import { replay, type ReplayResult } from './replay';
import { runBench, shouldSwap } from './bench';
import { toolTelemetryOf } from '../tool-telemetry';

/** 每 N 次结算做一次体检(离线 bench A/B:活体 vs 最佳配子)。 */
const HEALTH_CHECK_EVERY = 20;

/** 连续未核验达此次数 → 按失败结算。1-2 次只记负样本,"一直不核验"也有选择压力。 */
const UNVERIFIED_DEATH_STREAK = 3;

// ── 任务模板归一化(v1 签名)────────────────────────────────
// 生产化第一步:不做 embedding,不拍指纹 —— 用保守的动词+对象规则归一化。
// 同类任务(读并总结/写并报告)落到同一 templateId → 共享基因池;罕见任务各自成池。
// 归一化宁可"分太细"不可"合错池":合错池 = 用错疤痕,死亡率反而升高。

const TEMPLATE_RULES: Array<{ re: RegExp; id: string }> = [
  { re: /(总结|摘要|summar)/i, id: 'summarize-doc' },
  { re: /(翻译|translate)/i, id: 'translate' },
  { re: /(测试|单测|test).*(修|写|补)|写.*(测试|单测)|(run|跑).*(test|测试)/i, id: 'run-tests' },
  { re: /(修|fix|排查|debug|调试|报错|error)/i, id: 'debug-fix' },
  { re: /(重构|refactor)/i, id: 'refactor' },
  { re: /(查|搜|find|search|调研|research)/i, id: 'research' },
  { re: /(写|生成|create|write|报告|report|文档|doc)/i, id: 'create-artifact' },
];

/** prompt → 任务模板 id。命中第一条规则即返回;不命中 = 'misc'(兜底池,不限进化)。 */
export function templateIdOfPrompt(prompt: string): string {
  for (const { re, id } of TEMPLATE_RULES) {
    if (re.test(prompt)) return id;
  }
  return 'misc';
}

/** V5 任务的必需工具判定:除 misc 外每类任务都有物理必需工具(死因归因要区分"摘错"和"不会用")。 */
const REQUIRED_TOOLS: Record<string, string[]> = {
  'summarize-doc': ['read_file'],
  'run-tests': ['shell'],
  'debug-fix': ['shell', 'read_file'],
  'refactor': ['read_file', 'edit_file'],
  'research': ['web_search'],
  'create-artifact': ['write_file'],
  'translate': [],
  'misc': [],
};

/** 意图账本工具不受基因亲和过滤:提示里让模型调,注册表里就不能把它摘掉。 */
const INTENT_TOOLS = [...INTENT_TOOL_NAMES];
const requiredToolsOf = (templateId: string): string[] => [...(REQUIRED_TOOLS[templateId] ?? []), ...INTENT_TOOLS];

const V5_SYSTEM_SUFFIX = `

# 你是 Kaios v5 引擎(Phylum)的一个个体
- 你是一次性执行者:这个任务结束后你会"死亡",但你的执行结果会决定后代继承什么。
- 你拥有的工具就是全部世界 —— 列表里没有的工具不存在,不要尝试调用。
- 步数预算有限:直接干活,不要漫无目的地探索。
- 完成后用一段话给出最终答案,不要再调用工具。
`;

/** Provider.streamComplete → bodyplan.ChatFn 适配(去 snap 形)。 */
function providerChatFn(provider: Provider, snap: ReturnType<typeof snapshot>, signal: AbortSignal, onEvent?: (e: AgentEvent) => void) {
  return async (messages: ChatMsg[], toolDefs: ToolDef[]): Promise<Completion> =>
    // onToken 透传:个体思考期的流式 token 实时上屏(可见性),不影响工具调用解析。
    provider.streamComplete(messages, toolDefs, snap, signal, onEvent ? (tok) => onEvent({ type: 'token', text: tok }) : () => {});
}

export class DirectV5Engine implements Engine {
  readonly name = 'directV5' as const;

  /** 基因库:进程级单例,跨会话共享(全 app 一个种群,不 per-conv 割裂)。 */
  private static registry: GeneRegistry | null = null;

  /** 已就绪的基因库(未初始化返回 null —— 不触发 electron app 依赖,供外部即时否决入口用)。 */
  static registryIfReady(): GeneRegistry | null {
    return DirectV5Engine.registry;
  }

  constructor(private confirm: (cmd: string) => Promise<boolean>) {}

  /** 进程级基因库(懒加载;落盘 userData/phylum/)。 */
  private reg(): GeneRegistry {
    if (!DirectV5Engine.registry) {
      DirectV5Engine.registry = new GeneRegistry({ dataDir: path.join(app.getPath('userData'), 'phylum') });
    }
    return DirectV5Engine.registry;
  }

  /** 结算计数:每 HEALTH_CHECK_EVERY 次做一次离线体检。 */
  private settleTicks = 0;

  /** 连续未核验次数(genomeId → streak)。1-2 次只记录不结算;3 次按失败结算(给"不核验"一个选择压力)。 */
  private unverifiedStreak = new Map<string, number>();

  /**
   * 体检(离线 A/B):活体 vs 同签名最佳配子各跑一遍 bench。
   * 配子胜出 → 活体退场、冠军配子克隆接力(换血);否则保留。
   * 只在结算后触发,失败不影响本轮交付;bench 全在内存跑,无网络/磁盘写。
   */
  private async runHealthCheck(
    reg: GeneRegistry,
    sig: string,
    cwd: string,
    onEvent: (e: AgentEvent) => void,
  ): Promise<void> {
    if (++this.settleTicks % HEALTH_CHECK_EVERY !== 0) return;
    const live = reg.liveBySignature(sig)[0];
    const gam = reg.bestGamete(sig);
    if (!live || !gam || gam.genome.genomeId === live.genomeId) return;
    // 带疤的活体正在执行定向突变(后代是"被教训过的版本"):此时换血会把它未验证的
    // 修正直接扔掉,退回到同一起点的冠军。跳过换血,只报状态。
    if (reg.scarOf(live.lineage)) {
      onEvent({ type: 'status', text: `🩺 v5·${sig}: 活体带疤痕教训(定向突变中),本次跳过换血。` });
      return;
    }
    try {
      const report = await runBench({
        cwd,
        sides: [{ label: 'live', genome: live }, { label: 'champ', genome: gam.genome }],
      });
      const l = report.summary.find((s) => s.label === 'live');
      const c = report.summary.find((s) => s.label === 'champ');
      if (!l || !c) return;
      if (shouldSwap(l, c)) {
        reg.retire(live.genomeId);
        reg.cloneFrom(gam.genome);
        onEvent({ type: 'status', text: `🩺 v5·${sig}: 体检发现活体落后(活体 ${l.successes}/${l.trials} 步均 ${l.avgSteps.toFixed(1)} vs 冠军配子 ${c.successes}/${c.trials} 步均 ${c.avgSteps.toFixed(1)}),已换血。` });
      } else {
        onEvent({ type: 'status', text: `🩺 v5·${sig}: 体检通过(活体 ${l.successes}/${l.trials},冠军配子 ${c.successes}/${c.trials})。` });
      }
    } catch { /* 体检本身失败不影响交付 */ }
  }

  async run({ conv, memoryBlock, refBlock, signal, onEvent }: EngineRunOpts): Promise<void> {
    const prompt = conv.turns[conv.turns.length - 1]?.prompt ?? '';
    if (!prompt.trim()) {
      onEvent({ type: 'error', message: '(空输入)' });
      return;
    }

    const base = snapshot(conv.profileId);
    const snap = withExecRoute(base, conv.model, conv.profileId);
    const provider = currentProvider(snap);

    // ── 签名 + 出生调度(与 Universe.runTemplateRound 同语义,单任务内联)──
    // 重量进签名:heavy/light 分池(基因/账本/化石隔离),防止 12 步 founder 误领小时级任务。
    const templateId = templateIdOfPrompt(prompt);
    const weight = weightOfPrompt(prompt);
    const reg = this.reg();
    const turnId = conv.turns.length ? conv.turns[conv.turns.length - 1].id : undefined;

    // 追溯选择(2026-11):上一轮交付后用户用「纠正/重问」回来 —— 最真实的适应度信号,
    // 但轮末结算已经完成。这里补一次降权:配子 rejections+1(≥2 出池),化石记一次 miss。
    const prevTurn = conv.turns.length >= 2 ? conv.turns[conv.turns.length - 2] : undefined;
    if (prevTurn?.done) {
      const fb = store.getTurnFeedback(prevTurn.id);
      if (fb && fb.rating < 0 && (fb.tags.includes('correction') || fb.tags.includes('reask'))) {
        const applied = reg.applyUserRejection(prevTurn.id);
        if (applied.applied) {
          onEvent({
            type: 'status',
            text: `↩️ v5: 上一轮被用户否决(${fb.tags.join(',')}),已对该基因/化石降权${applied.retiredGene ? '(连续否决,配子出池)' : ''}。`,
          });
        }
      }
    }
    const tplLabel = `${templateId}@${weight}`;
    const sig = signatureOfTemplateWeighted(templateId, weight);

    // ── 化石重放优先(修正版设计:种群的理想终态是墓园 —— 化石零 token 跑着,LLM 只在边界外开荒)──
    // 命中 → 零 LLM 交付;失败 → 降级开荒(尸体退回出生调度,不浪费这一轮进化信号)。
    // 化石竞争:同签名可有多份模板(不同工具路线/参数风格),按近窗重放口碑排序逐个尝试。
    // 第一份命中即用;未命中的模板计 miss(连续 miss 退役),让更好的路线自然上位。
    const tpls = reg.templatesBySignature(sig);
    if (tpls.length) {
      const replayTools = allTools();
      const replayCtx: ToolCtx = {
        cwd: conv.cwd, confirm: this.confirm, signal,
        convId: conv.id, turnId,
        crossProjectMemory: conv.crossProjectMemory === true, sandbox: getSettings().sandbox,
      };
      const assertions = reg.liveBySignature(sig)[0]?.assertions ?? [];
      // 证据闸(2026-11):化石重放是零 LLM 路径,也是最容易「不发 intent_done 就交付」的角落。
      // 谱系越成熟,这条路径占比越高 —— 若不验收,证据闸形同虚设。
      // 口径与 intent_done 完全一致:事件流证据(assessEvidence)+ 契约断言(读盘 / 最后一次 shell)。
      // 过了才交付并把意图标 done;不过 = 化石 miss(带原因),降级 LLM 开荒。
      const openIntent = store.latestOpenIntent(conv.id);
      const misses: string[] = [];
      let won: { tpl: TraceTemplate; r: ReplayResult } | null = null;
      for (const tpl of tpls) {
        if (signal.aborted) break;
        const r = await replay(tpl, prompt, replayTools, assertions, replayCtx, (i, name, out) => {
          // 不硬编码 outcome:'ok' —— 用与真实工具一致的遥测口径,UI 事件日志不撒谎。
          const tele = toolTelemetryOf(out);
          onEvent({ type: 'tool', name, args: '(化石重放)', result: out,
            outcome: tele.outcome, errorKind: tele.errorKind, errorSummary: tele.errorSummary });
        });
        if (r.hit) { won = { tpl, r }; break; }
        reg.noteReplay(tpl.id, false);
        misses.push(`${tpl.id}:${r.miss?.reason ?? '?'}`);
      }
      let hit = won !== null;
      let gateMiss: string | null = null;
      if (won && openIntent) {
        const fresh = store.getIntent(openIntent.id);
        if (!fresh) {
          hit = false;
          gateMiss = `意图 #${openIntent.id} 已不存在`;
        } else {
          // 重放闸只认本轮事件:loadEventsSince(意图创建时刻)会把旧轮的证据带进来,
          // 让本轮重放的"没跑检查"被历史通过记录掩盖。turnId 缺失时回退旧口径。
          const rows = turnId
            ? store.loadTurnEvents(fresh.convId, turnId)
            : store.loadEventsSince(fresh.convId, fresh.createdAt);
          // D 修复:answer 只认当前轮;编辑/验证证据仍跨轮(口径与 tools.ts intent_done 一致)。
          const report = assessEvidence(rows, turnId);
          recordEvidence(fresh.id, report);
          const spent = refreshIntentSpend(fresh.id);
          const cwd = store.getConversationCwd(fresh.convId) ?? conv.cwd;
          const contract = evaluateIntentAssertions(fresh.assertions, cwd, rows);
          const verdict = canComplete({ ...fresh, spentUSD: spent }, report, contract);
          if (verdict.ok) store.updateIntent(fresh.id, { status: 'done' });
          else {
            hit = false;
            gateMiss = `证据闸未过:${verdict.reasons.join('; ')}`.slice(0, 240);
          }
        }
      }
      if (won) reg.noteReplay(won.tpl.id, hit);
      if (won && hit && won.r.output !== undefined) {
        onEvent({ type: 'status', text: `🦴 v5·${tplLabel} | 化石重放命中(${won.r.steps} 步,0 LLM 调用${openIntent ? ',证据闸通过' : ''})。` });
        // 追溯映射:这一轮由哪份化石交付(用户随后否决 → 该模板记 miss)。
        if (turnId) reg.noteTurnGenome(turnId, { signature: sig, templateId: won.tpl.id });
        const answer = won.r.output.trim() || '(任务完成,无文本产物)';
        conv.directHistory = [
          ...conv.directHistory,
          { role: 'user', content: prompt },
          { role: 'assistant', content: answer },
        ];
        onEvent({ type: 'done' });
        return;
      }
      const reason = gateMiss ?? (misses.length ? misses.join(' | ') : '?');
      onEvent({ type: 'status', text: `🦴→🧬 v5·${tplLabel} | 化石重放未命中(${reason}),回退 LLM 开荒。` });
    }

    // 出生:无活体 → 配子克隆 / founder。仓库级疤痕先于支系疤痕生效?不——支系更具体,
    // 但新签名没有支系疤痕,此时继承本仓库的参数类教训(跨签名横向遗传)。
    if (reg.needsFounder(sig)) {
      const gam = reg.bestGamete(sig);
      const repoScar = reg.repoScarOf(conv.cwd);
      if (gam) {
        const inh = reg.scarOf(gam.genome.lineage) ?? repoScar;
        if (inh) reg.mutateFrom(gam.genome, inh);
        else reg.cloneFrom(gam.genome);
      } else {
        reg.spawnFounder(templateId, weight, repoScar);
      }
    }

    // 公平曝光:取轮转首位活体(单会话单任务;多活体时按出生序轮转)
    const live = reg.liveBySignature(sig);
    if (!live.length) {
      onEvent({ type: 'error', message: 'v5: 基因库无活体(异常状态),已重置 founder' });
      reg.spawnFounder(templateId, weight);
      return;
    }
    const genome: Genome = live[0];

    // ── Ralph 拓扑(conv.loopRalph=true):任务级自迭代,验收不过带反馈重进。
    // 个体结算与普通 run 同一套账(配子/疤痕/替补),只是单次执行变成多轮循环。──
    if (conv.loopRalph === true) {
      await this.runRalph({ conv, prompt, templateId, weight, sig, genome, memoryBlock, refBlock, signal, onEvent, reg });
      return;
    }

    const gene = geneSnapshot(genome);
    // 档①冻结路由:支系近窗达标 → 本能 prompt 注入"路线已验证"指令(软先验,零额外 token)。
    const converged = reg.isConverged(sig);
    // 门级步数护栏跟随宿主 maxTurns 配置(0 = 无限,与 AgentLoop userMax 语义一致);
    // 非 0 时夹紧基因值,无限时基因值就是个体预算(仍受 MAX_STEPS_MAX 进化值域约束)。
    const stepCeil = (getSettings().maxTurns ?? 50) === 0 ? 0 : STEP_BUDGET_CEIL;
    const removed = express(genome, allTools(), requiredToolsOf(templateId), stepCeil).removedTools;
    const genTag = `🧬 v5·${tplLabel} | 个体 ${genome.genomeId} 第 ${genome.generation} 代` +
      (removed.length ? ` | 已摘除: ${removed.join(',')}` : '');
    onEvent({ type: 'status', text: genTag });

    // ── system prompt(Phylum 个体:本能 prompt 短,主系统段不装 V3/V4 全家桶)──
    const systemPrompt =
      V5_SYSTEM_SUFFIX +
      (memoryBlock ? `\n\n# 用户长期记忆\n${memoryBlock}` : '') +
      (refBlock ? `\n\n# 引用上下文\n${refBlock}` : '') +
      pluginSystemPrompts('directV5', prompt);

    // ── 执行(bodyplan 共享循环;工具注册表已被表达过滤)──
    const tools = express(genome, allTools(), requiredToolsOf(templateId), stepCeil).tools;
    // bodyplan 内部自建 ToolCtx(不收完整 ctx):这里只透传身份信息,让 intent_done
    // 能读本会话事件流;confirm/sandbox 维持个体原有语义(一次性执行、自动放行)。
    const toolCtx: Partial<ToolCtx> = {
      convId: conv.id,
      turnId: conv.turns.length ? conv.turns[conv.turns.length - 1].id : undefined,
      crossProjectMemory: conv.crossProjectMemory === true,
    };

    const startedTokens = Date.now();
    let outcome;
    try {
      const body = express(genome, allTools(), requiredToolsOf(templateId), stepCeil);
      if (converged) {
        body.instinctPrompt = (body.instinctPrompt ? body.instinctPrompt + '\n' : '') +
          `这支支系已有连续成功记录(近窗成功率≥${FOSSIL_DEPOSIT_RATE},trials≥${CONVERGE_MIN_TRIALS})。` +
          '沿用已验证的工具路线与参数风格,不要尝试新路线。';
      }
      outcome = await runBodyPlan({
        task: prompt,
        cwd: conv.cwd,
        body,
        genome,
        chat: providerChatFn(provider, snap, signal, onEvent),
        tools,
        signal,
        onEvent,
        systemSuffix: INTENT_LEDGER_HINT,
        toolCtx,
      });
    } catch (e) {
      onEvent({ type: 'error', message: `v5 引擎出错: ${(e as Error)?.message ?? String(e)}` });
      return;
    }
    void startedTokens;

    // ── 结算前的证据闸(2026-11)──
    // 修前 bodyplan 的成功 = "模型交了 final answer + 调过工具",等于让自述直接进 fitness。
    // 这里用与 intent_done 相同的口径复核:
    //   - 改过文件却没有通过的诊断/测试/视觉验收 → 本轮「未核验」:结果照常交付,
    //     但零进化信号(不进配子池、不沉积化石、不留疤,个体留在活体池);
    //   - 有 open 意图且契约断言明确未过 → 明确失败(wrong_answer 疤痕)。
    let unverified: string | null = null;
    if (outcome.success && !outcome.aborted) {
      if (turnId) {
        const rows = store.loadTurnEvents(conv.id, turnId);
        // D 修复:answer 只认当前轮(loadTurnEvents 本身就是本轮事件,双保险)。
        const report = assessEvidence(rows, turnId);
        const openIntent = store.latestOpenIntent(conv.id);
        if (openIntent) {
          const cwd = store.getConversationCwd(conv.id) ?? conv.cwd;
          const contract = evaluateIntentAssertions(openIntent.assertions, cwd, rows);
          if (contract.checks > 0 && !contract.pass) {
            outcome.success = false;
            outcome.cause = 'wrong_answer';
            // finished=false:否则下方「自然完成=success」的兜底会把契约失败重新翻成成功。
            outcome.finished = false;
            outcome.detail = `契约断言未过:${contract.failed.map((f) => f.id).join(',') || '?'}`;
          }
        }
        if (outcome.success && report.hasEdits && !report.ok) {
          unverified = report.reasons[0] ?? '改动了文件但没有任何可核验的通过证据';
        }
      }
    }

    // ── 结算(死亡即结算;用户中止 = 无痕)──
    const runOutcome: RunOutcome = {
      taskId: conv.id,
      signature: sig,
      genomeId: genome.genomeId,
      lineage: genome.lineage,
      generation: genome.generation,
      success: outcome.success,
      aborted: outcome.aborted,
      cause: outcome.cause,
      culpritErrorKind: outcome.culpritErrorKind,
      steps: outcome.steps,
      tokens: outcome.tokens,
      detail: outcome.detail,
      trace: outcome.trace,
      finished: outcome.finished,
    };
    // 生产成功语义:bodyplan 自然完成(有工具轨迹的 final answer)= success。
    // 实验路径(Universe)仍由 grader 终裁,这里不改 runner。
    if (outcome.finished && !outcome.aborted) runOutcome.success = outcome.success || (outcome.trace?.length ?? 0) > 0;
    // ── 结算(死亡即结算)。provider 挂起=世界停摆不是个体过错,不进结算、不留疤、
    // 不计 aborted 次数,同基因原样留在活体池,窗口重置后点继续即同基因续跑。
    if (outcome.cause === 'provider_suspended') {
      onEvent({ type: 'status', text: `⏸ v5: 个体挂起 — ${outcome.detail ?? 'provider 暂不可用'}。个体保留在活体池,恢复后继续,基因无损。` });
      onEvent({ type: 'done' });
      return;
    }
    // 未核验:1-2 次只把结果照常交付 + 记一次负样本(不进配子池/化石);
    // 连续 3 次则按未核验失败正式结算 —— 否则"永远不跑检查、只宣布完成"没有选择压力。
    if (unverified) {
      const streak = (this.unverifiedStreak.get(genome.genomeId) ?? 0) + 1;
      this.unverifiedStreak.set(genome.genomeId, streak);
      if (streak >= UNVERIFIED_DEATH_STREAK) {
        outcome.success = false;
        outcome.cause = 'wrong_answer';
        outcome.detail = `连续 ${streak} 轮未核验:${unverified}`;
        runOutcome.success = false;
        runOutcome.cause = 'wrong_answer';
        runOutcome.detail = outcome.detail;
        onEvent({ type: 'status', text: `⚠️ v5: 连续 ${streak} 轮未通过证据闸(${unverified}),本轮按未核验失败结算。` });
        // 落到下方正常结算路径(失败 → 疤痕/替补出生)。
      } else {
        reg.recordUnverified(genome, runOutcome);
        onEvent({ type: 'status', text: `⚠️ v5: 本轮未通过证据闸(${unverified})。结果照常交付;计一次未核验(${streak}/${UNVERIFIED_DEATH_STREAK}),不进配子池/化石。` });
        const answer = outcome.lastOutput.trim() || '(任务完成,无文本产物)';
        conv.directHistory = [
          ...conv.directHistory,
          { role: 'user', content: prompt },
          { role: 'assistant', content: answer },
        ];
        onEvent({ type: 'done' });
        return;
      }
    }
    const facts: AttributionFacts = this.attribute(runOutcome, outcome, templateId, removed);
    reg.settle(runOutcome, genome, facts);
    this.unverifiedStreak.delete(genome.genomeId);
    // 追溯映射:成功交付的基因(用户随后否决 → 配子降权/出池)。
    if (outcome.success && turnId) {
      reg.noteTurnGenome(turnId, { genomeId: genome.genomeId, lineage: genome.lineage, signature: sig });
    }
    // 疤痕入库(2026-10 持久化:修前引擎层内存 Map,重启即丢,定向突变退化成盲目克隆)。
    // 环境类失败(目标不存在/权限/IO)不是基因能改的事 → 不留疤,后代按克隆+抖动继续探索。
    const envFailure = facts.cause === 'tool_error' && isEnvironmentErrorKind(facts.errorKind);
    if (!outcome.aborted && !outcome.success && !envFailure) reg.recordScar(genome.lineage, facts);
    // 横向遗传:参数类失败写进仓库级疤痕(新签名出生时继承);环境类/其它类不写。
    if (!outcome.aborted && !outcome.success) reg.recordRepoScar(conv.cwd, facts);

    // ── 替补出生:种群永续。按归因定向突变(疤痕遗传)/无归因则克隆冠军 ──
    if (!outcome.aborted && reg.liveBySignature(sig).length === 0) {
      const gam = reg.bestGamete(sig);
      if (gam) {
        const inh = envFailure ? null : reg.scarOf(gam.genome.lineage);
        if (inh) reg.mutateFrom(gam.genome, inh);
        else reg.cloneFrom(gam.genome);
      }
    }

    // ── 终态事件 ──
    if (outcome.aborted) {
      onEvent({ type: 'done' });
      return;
    }
    await this.runHealthCheck(reg, sig, conv.cwd, onEvent);
    if (outcome.success) {
      const answer = outcome.lastOutput.trim() || '(任务完成,无文本产物)';
      onEvent({ type: 'status', text: `✅ v5: ${tplLabel} 完成(${outcome.steps} 步)。个体基因已入配子池。` });
      conv.directHistory = [
        ...conv.directHistory,
        { role: 'user', content: prompt },
        { role: 'assistant', content: answer },
      ];
      onEvent({ type: 'done' });
      return;
    }
    // 失败:如实告知 + 归因可见(进化信号对用户透明)
    const causeLabel: Record<string, string> = {
      tool_error: `工具报错(${facts.toolName ?? '未知'})`,
      assertion_fail: `断言拦截(${facts.assertionId ?? '未知'})`,
      step_budget: `步数超限(${outcome.steps} 步,宿主预算)— 设置里调大「最大循环轮数」可放宽`,
      essential_tool_missing: `必需工具被摘除(${facts.missingTool ?? '未知'})`,
      wrong_answer: '产物未通过判定',
    };
    onEvent({ type: 'error', message: `v5: 个体死亡 — ${causeLabel[outcome.cause] ?? outcome.cause}。归因已写入基因库,该支系后代将规避此路径。` });
  }

  /** 死亡归因(与 Universe.attribute 同语义,culpritTool 走结构化字段而非 detail 反解析)。 */
  private attribute(
    o: RunOutcome,
    raw: { detail: string; culpritTool?: string; culpritErrorKind?: ToolErrorKind; violatedAssertionId?: string },
    templateId: string,
    removedTools: string[],
  ): AttributionFacts {
    if (o.cause === 'tool_error') {
      return {
        cause: 'tool_error',
        toolName: raw.culpritTool ?? /tool '([^']+)'/.exec(raw.detail)?.[1],
        errorKind: raw.culpritErrorKind,
      };
    }
    if (o.cause === 'assertion_fail') {
      return { cause: 'assertion_fail', assertionId: raw.violatedAssertionId ?? /'([^']+)'/.exec(raw.detail)?.[1] };
    }
    if (o.cause === 'essential_tool_missing') {
      const missing = /'([^']+)'/.exec(raw.detail)?.[1];
      return { cause: 'essential_tool_missing', missingTool: missing, removedTools };
    }
    if (o.cause === 'step_budget') {
      return { cause: 'step_budget' };
    }
    return { cause: o.cause === 'none' ? 'none' : o.cause };
  }

  /**
   * Ralph 拓扑入口(conv.loopRalph=true):单次 bodyplan 执行外面包一层任务级验收循环。
   * 与普通 run 的关键差异:
   *   - 轮数熔断不算个体死亡以外的额外惩罚:整条循环编码成一次 RunOutcome 结算
   *     (accepted=success / max_loops=wrong_answer 疤痕 / aborted=零信号)。
   *   - 验收口径:任务文本里的「验收:」段解析为 AssertionDsl(见 parseAcceptance),
     解析不出任何断言 = 没有 Ralph 验收的入口条件,退回普通单轮(防误开启)。
   */
  private async runRalph(a: {
    conv: { id: string; cwd: string; profileId?: string | null; model?: string; directHistory: ChatMsg[]; turns: Array<{ id: string }> };
    prompt: string; templateId: string; weight: 'heavy' | 'light'; sig: string; genome: Genome;
    memoryBlock?: string; refBlock?: string; signal: AbortSignal;
    onEvent: (e: AgentEvent) => void;
    reg: GeneRegistry;
  }): Promise<void> {
    const { conv, prompt, templateId, weight, sig, genome, signal, onEvent, reg } = a;
    const stepCeil = (getSettings().maxTurns ?? 50) === 0 ? 0 : STEP_BUDGET_CEIL;
    const tools = express(genome, allTools(), requiredToolsOf(templateId), stepCeil).tools;
    const genTag = `🔁🧬 v5·ralph@${templateId}@${weight} | 个体 ${genome.genomeId} 第 ${genome.generation} 代(自迭代拓扑)`;
    onEvent({ type: 'status', text: genTag });

    const ralphOpts: RalphOpts = {
      task: prompt,
      cwd: conv.cwd,
      genome,
      acceptance: acceptanceFromPrompt(prompt) ?? { assertions: [] },
      stepBudgetCeil: stepCeil,
      chat: (() => { const snap = snapshot(conv.profileId); return providerChatFn(currentProvider({ ...snap, model: conv.model || snap.model }), snap, signal, onEvent); })(),
      tools,
      signal,
      onEvent,
      systemSuffix: INTENT_LEDGER_HINT,
      toolCtx: {
        convId: conv.id,
        turnId: conv.turns.length ? conv.turns[conv.turns.length - 1].id : undefined,
      },
    };
    let r;
    try {
      r = await runRalphLoop(ralphOpts);
    } catch (e) {
      onEvent({ type: 'error', message: `v5 ralph 出错: ${(e as Error)?.message ?? String(e)}` });
      return;
    }

    const turnId = conv.turns.length ? conv.turns[conv.turns.length - 1].id : undefined;

    // accepted 也必须过证据闸(与普通路径同语义):改过文件却没有可核验的通过检查 →
    // 结果照常交付但不结算(零进化信号)。否则 Ralph 的"验收断言过了"会掩盖没有证据的产物。
    if (r.accepted && turnId) {
      const rows = store.loadTurnEvents(conv.id, turnId);
      const report = assessEvidence(rows, turnId);
      if (report.hasEdits && !report.ok) {
        const unverified = report.reasons[0] ?? '改动了文件但没有任何可核验的通过证据';
        reg.recordUnverified(genome, ralphToOutcome(r, conv.id));
        onEvent({ type: 'status', text: `⚠️ v5·ralph: 本轮未通过证据闸(${unverified})。结果照常交付;本轮零进化信号(不进配子池/化石)。` });
        const answer = r.last?.lastOutput?.trim() || '(任务完成,无文本产物)';
        conv.directHistory = [
          ...conv.directHistory,
          { role: 'user', content: prompt },
          { role: 'assistant', content: answer },
        ];
        onEvent({ type: 'done' });
        return;
      }
    }

    // ── 结算:整条循环 = 一次进化信号(配子/疤痕/替补由 settleRalph 全包)──
    const outcome = settleRalph(reg, r, genome, conv.id, conv.cwd);

    if (outcome.aborted) { onEvent({ type: 'done' }); return; }
    await this.runHealthCheck(reg, sig, conv.cwd, onEvent);
    if (r.accepted) {
      if (turnId) reg.noteTurnGenome(turnId, { genomeId: genome.genomeId, lineage: genome.lineage, signature: sig });
      const answer = r.last?.lastOutput?.trim() || '(任务完成,无文本产物)';
      onEvent({ type: 'status', text: `✅ v5·ralph: 验收通过(${r.loops} 轮 / ${r.totalSteps} 步)。基因已入配子池。` });
      conv.directHistory = [
        ...conv.directHistory,
        { role: 'user', content: prompt },
        { role: 'assistant', content: answer },
      ];
      onEvent({ type: 'done' });
      return;
    }
    onEvent({ type: 'error', message: `v5·ralph: 轮数熔断(${r.loops} 轮)。失败断言: ${r.loopLog[r.loopLog.length - 1]?.verdict.failed.map((f) => f.id).join(', ') || '(无)'}。wrong_answer 疤痕已入库,该支系后代将定向规避。` });
  }

  releaseConv?(convId: string): void {
    void convId; // 基因库是进程级资产,不随会话释放
  }
}

/**
 * 追溯否决的即时入口:TaskManager 在用户下一条消息被判为纠正/重问时立即调用,
 * 不必等下一轮 V5 run 才消费(否则用户纠正后切走/换引擎,这次否决就丢了)。
 * 注册表未就绪 / 无该轮映射 → no-op(下一轮开头消费仍作兜底)。
 */
export function applyV5UserRejection(turnId: string): { applied: boolean; retiredGene: boolean; templateId?: string } {
  const reg = DirectV5Engine.registryIfReady();
  if (!reg || !turnId) return { applied: false, retiredGene: false };
  return reg.applyUserRejection(turnId);
}

export { runRalphLoop } from './ralph';
export type { RalphOpts, RalphResult } from './ralph';
export { evaluateAcceptance, describeCheck } from './ralph-accept';
export type { AcceptanceSpec, AcceptanceVerdict, AcceptanceFail } from './ralph-accept';
