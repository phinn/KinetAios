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
import type { AgentEvent, ChatMsg } from '../../shared/types';
import { currentProvider, type Completion, type Provider, type ToolDef } from '../glm';
import { allTools, type Tool, type ToolCtx } from '../tools';
import { getSettings, snapshot } from '../settings';
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
import { signatureOfTemplate } from './signature';
import { GeneRegistry, type AttributionFacts } from './registry';
import { geneSnapshot, type Genome, type RunOutcome, STEP_BUDGET_CEIL } from './phylum-types';

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

const V5_SYSTEM_SUFFIX = `

# 你是 Kaios v5 引擎(Phylum)的一个个体
- 你是一次性执行者:这个任务结束后你会"死亡",但你的执行结果会决定后代继承什么。
- 你拥有的工具就是全部世界 —— 列表里没有的工具不存在,不要尝试调用。
- 步数预算有限:直接干活,不要漫无目的地探索。
- 完成后用一段话给出最终答案,不要再调用工具。
`;

/** Provider.streamComplete → bodyplan.ChatFn 适配(去 snap 形)。 */
function providerChatFn(provider: Provider, snap: ReturnType<typeof snapshot>, signal: AbortSignal) {
  return async (messages: ChatMsg[], toolDefs: ToolDef[]): Promise<Completion> =>
    provider.streamComplete(messages, toolDefs, snap, signal, () => {});
}

export class DirectV5Engine implements Engine {
  readonly name = 'directV5' as const;

  /** 基因库:进程级单例,跨会话共享(全 app 一个种群,不 per-conv 割裂)。 */
  private static registry: GeneRegistry | null = null;
  /** lineage → 最近一次死亡归因(疤痕遗传的权威通路,内存即生命周期)。 */
  private lastAttribution = new Map<string, AttributionFacts>();

  constructor(private confirm: (cmd: string) => Promise<boolean>) {}

  /** 进程级基因库(懒加载;落盘 userData/phylum/)。 */
  private reg(): GeneRegistry {
    if (!DirectV5Engine.registry) {
      DirectV5Engine.registry = new GeneRegistry({ dataDir: path.join(app.getPath('userData'), 'phylum') });
    }
    return DirectV5Engine.registry;
  }

  async run({ conv, memoryBlock, refBlock, signal, onEvent }: EngineRunOpts): Promise<void> {
    const prompt = conv.turns[conv.turns.length - 1]?.prompt ?? '';
    if (!prompt.trim()) {
      onEvent({ type: 'error', message: '(空输入)' });
      return;
    }

    const base = snapshot(conv.profileId);
    const snap = { ...base, model: conv.model || base.model };
    const provider = currentProvider(snap);

    // ── 签名 + 出生调度(与 Universe.runTemplateRound 同语义,单任务内联)──
    const templateId = templateIdOfPrompt(prompt);
    const reg = this.reg();
    const tplLabel = templateId;

    // 出生:无活体 → 配子克隆 / founder
    if (reg.needsFounder(signatureOfTemplate(templateId))) {
      const gam = reg.bestGamete(signatureOfTemplate(templateId));
      if (gam) reg.cloneFrom(gam.genome);
      else reg.spawnFounder(templateId);
    }

    // 公平曝光:取轮转首位活体(单会话单任务;多活体时按出生序轮转)
    const live = reg.liveBySignature(signatureOfTemplate(templateId));
    if (!live.length) {
      onEvent({ type: 'error', message: 'v5: 基因库无活体(异常状态),已重置 founder' });
      reg.spawnFounder(templateId);
      return;
    }
    const genome: Genome = live[0];
    const gene = geneSnapshot(genome);
    // 门级步数护栏跟随宿主 maxTurns 配置(0 = 无限,与 AgentLoop userMax 语义一致);
    // 非 0 时夹紧基因值,无限时基因值就是个体预算(仍受 MAX_STEPS_MAX 进化值域约束)。
    const stepCeil = (getSettings().maxTurns ?? 50) === 0 ? 0 : STEP_BUDGET_CEIL;
    const removed = express(genome, allTools(), REQUIRED_TOOLS[templateId] ?? [], stepCeil).removedTools;
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
    const tools = express(genome, allTools(), REQUIRED_TOOLS[templateId] ?? [], stepCeil).tools;
    const ctx: ToolCtx = {
      cwd: conv.cwd,
      confirm: this.confirm,
      signal,
      convId: conv.id,
      turnId: conv.turns.length ? conv.turns[conv.turns.length - 1].id : undefined,
      crossProjectMemory: conv.crossProjectMemory === true,
      sandbox: getSettings().sandbox,
    };
    // bodyplan 内部自建 ToolCtx(不收外部 ctx)—— 传 cwd/confirm 需经 opts;
    // 这里 opts.cwd 就是 conv.cwd,confirm 走 this.confirm,与 V4 对齐。

    const startedTokens = Date.now();
    let outcome;
    try {
      outcome = await runBodyPlan({
        task: prompt,
        cwd: conv.cwd,
        body: express(genome, allTools(), REQUIRED_TOOLS[templateId] ?? [], stepCeil),
        genome,
        chat: providerChatFn(provider, snap, signal),
        tools,
        signal,
        onEvent,
      });
    } catch (e) {
      onEvent({ type: 'error', message: `v5 引擎出错: ${(e as Error)?.message ?? String(e)}` });
      return;
    }
    void startedTokens;

    // ── 结算(死亡即结算;用户中止 = 无痕)──
    const runOutcome: RunOutcome = {
      taskId: conv.id,
      signature: signatureOfTemplate(templateId),
      genomeId: genome.genomeId,
      lineage: genome.lineage,
      generation: genome.generation,
      success: outcome.success,
      aborted: outcome.aborted,
      cause: outcome.cause,
      steps: outcome.steps,
      tokens: outcome.tokens,
      detail: outcome.detail,
    };
    const facts: AttributionFacts = this.attribute(runOutcome, outcome, templateId, removed);
    reg.settle(runOutcome, genome, facts);
    if (!outcome.aborted && !outcome.success) this.lastAttribution.set(genome.lineage, facts);

    // ── 替补出生:种群永续。按归因定向突变(疤痕遗传)/无归因则克隆冠军 ──
    if (!outcome.aborted && reg.liveBySignature(signatureOfTemplate(templateId)).length === 0) {
      const gam = reg.bestGamete(signatureOfTemplate(templateId));
      if (gam) {
        const inh = this.lastAttribution.get(gam.genome.lineage);
        if (inh) reg.mutateFrom(gam.genome, inh);
        else reg.cloneFrom(gam.genome);
      }
    }

    // ── 终态事件 ──
    if (outcome.aborted) {
      onEvent({ type: 'done' });
      return;
    }
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
      step_budget: `步数超限(${outcome.steps}/${gene.maxSteps})`,
      essential_tool_missing: `必需工具被摘除(${facts.missingTool ?? '未知'})`,
      wrong_answer: '产物未通过判定',
    };
    onEvent({ type: 'error', message: `v5: 个体死亡 — ${causeLabel[outcome.cause] ?? outcome.cause}。归因已写入基因库,该支系后代将规避此路径。` });
  }

  /** 死亡归因(与 Universe.attribute 同语义,culpritTool 走结构化字段而非 detail 反解析)。 */
  private attribute(
    o: RunOutcome,
    raw: { detail: string; culpritTool?: string; violatedAssertionId?: string },
    templateId: string,
    removedTools: string[],
  ): AttributionFacts {
    if (o.cause === 'tool_error') {
      return { cause: 'tool_error', toolName: raw.culpritTool ?? /tool '([^']+)'/.exec(raw.detail)?.[1] };
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

  releaseConv?(convId: string): void {
    void convId; // 基因库是进程级资产,不随会话释放
  }
}
