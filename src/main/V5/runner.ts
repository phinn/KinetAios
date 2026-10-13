// 种群 runner:出生 → 表达 → 执行(bodyplan)→ grader → 归因结算 → 繁殖。
// 公平性三规则(设计预演定):
//   1. 公平曝光:副本 round-robin 派给活体,冠军不霸占任务;
//   2. 确定性:seeded RNG + 脚本化 mock 模型 → 进化链可复现、测试可精确断言;
//   3. 死亡即结算:立即记账/进化石/配子,替补从冠军配子池出生(接力不断)。
// mkUniverse 把 8 条验收标准需要的观测点全部导出(基因快照/账本/事件流/结果行)。

import { GeneRegistry, type AttributionFacts } from './registry';
import { express } from './express';
import { runBodyPlan, type ChatFn } from './bodyplan';
import { signatureOfTemplate } from './signature';
import type {
  Genome, RunOutcome, ExpressedBody, DeathCause, LineageLedger,
} from './phylum-types';
import { geneSnapshot, type GenomeSnapshot } from './phylum-types';
import type { ChatMsg } from '../../shared/types';
import type { Completion, ToolCall } from '../glm';
import type { Tool } from '../tools';

// ── 事件流(测试断言进化过程的唯一事实源) ──

export type EvoEvent =
  | { what: 'founder'; genomeId: string; signature: string }
  | { what: 'breed'; genomeId: string; lineage: string; generation: number; from: string }
  | { what: 'mutate'; genomeId: string; lineage: string; generation: number; cause: DeathCause }
  | { what: 'death'; genomeId: string; cause: DeathCause }
  | { what: 'gamete'; genomeId: string };

/** 任务模板(实验的"环境"):grader 确定性,不经 LLM。 */
export interface TaskTemplate {
  id: string;
  /** 第 i 个副本的任务文本 */
  render(variant: number): string;
  /** 语义判分:true=产物正确 */
  grade(out: { lastOutput: string; steps: number }): { success: boolean; detail: string };
  /** 物理必需工具(亲和过滤保护名单;模型调被摘除工具 → essential_tool_missing) */
  requiredTools: string[];
}

export interface UniverseOpts {
  templates: TaskTemplate[];
  /** 全量工具注册表(mock 实现见下) */
  tools?: Tool[];
  rng?: () => number;
  /** 环境先验:该签名下工具调用的成功率(默认全 0.8;设 0 可稳定制造 tool_error 死亡) */
  toolSuccessPrior?: Record<string, number>;
  /**
   * 自定义模型人格(杀手实验的核心旋钮):基因如何影响行为全在这条缝里观察。
   * 返回的 ChatFn 只能调用 body.tools 里存在的工具(被亲和摘除 = 物理不可调)。
   * 默认人格:直接调第一个必需工具,零缺陷 —— 无选择压力,进化无从谈起。
   */
  chatFactory?: (ctx: { rng: () => number; tpl: TaskTemplate; variant: number; body: ExpressedBody }) => ChatFn;
}

export interface RoundOpts {
  perTask: number;
  /** 强制注入 founder 亲和(测必需工具饿死/回升) */
  forceAffinity?: Record<string, number>;
  /** 用户中止场景 */
  abort?: boolean;
}

export interface RoundStat {
  round: number;
  signature: string;
  successRate: number;
  avgTokens: number;
  avgScore: number;
}

// ── mock 工具(真实 Tool 接口,执行确定性) ──

function mockTools(prior: Record<string, number>, rng: () => number): Tool[] {
  let callCount = 0;
  return [
    {
      name: 'read_file', description: '读取文件', parameters: {},
      async run(args) {
        callCount++;
        const p = prior['read_file'] ?? 0.8;
        if (rng() >= p) throw new Error('EACCES: permission denied');
        return `文件内容已读取:共 4 行,末行 line-${(args as { n?: number }).n ?? callCount}`;
      },
    },
    {
      name: 'shell', description: '执行命令', parameters: {},
      async run() {
        callCount++;
        const p = prior['shell'] ?? 0.5;
        if (rng() >= p) throw new Error('command not found');
        return 'stdout...\n[exit:0]';
      },
    },
    {
      name: 'web_search', description: '搜索', parameters: {},
      async run() {
        callCount++;
        const p = prior['web_search'] ?? 0.6;
        if (rng() >= p) throw new Error('search backend timeout');
        return '搜索结果片段:topic 相关内容';
      },
    },
  ];
}

/** 全局确定性 RNG(mulberry32)—— mock 工具的成败也吃它,保证整链可复现。 */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Universe:实验壳 ──

export class Universe {
  reg: GeneRegistry;
  private history: RunOutcome[] = [];
  private events: EvoEvent[] = [];
  private stats: RoundStat[] = [];
  private rng: () => number;
  private tools: Tool[];
  /** 死亡归因的权威传递通路(内存,按 lineage 最近一条):化石层只做审计,不反解析 */
  private lastAttribution = new Map<string, AttributionFacts>();
  /** 实验旋钮缓存:templateId → 待注入 founder 的亲和覆写 */
  private pendingAffinity: Record<string, Record<string, number>> = {};

  constructor(private opts: UniverseOpts) {
    this.rng = opts.rng ?? seededRng(1);
    this.tools = opts.tools ?? mockTools(opts.toolSuccessPrior ?? {}, this.rng);
    this.reg = new GeneRegistry({ rng: this.rng });
  }

  /** 实验旋钮:预设某签名 founder 的指定工具亲和(对照实验用,隔离基因差异)。
   *  必须在第一轮 round() 之前调用;-founder 尚未出生时记入 pending,出生时生效。 */
  overrideFounderAffinity(templateId: string, affinity: Record<string, number>): void {
    this.pendingAffinity[templateId] = { ...affinity };
  }

  /** 跑一轮:每模板 perTask 个副本,公平曝光 + 死亡即结算 + 批末繁殖。 */
  async round(round: number, roundOpts: RoundOpts): Promise<RoundStat[]> {
    const before = this.stats.length;
    const ob = this.history.length;
    for (const tpl of this.opts.templates) {
      await this.runTemplateRound(tpl, roundOpts, round);
    }
    // 出本轮曲线:只用本轮 outcome —— 累计值会把学习曲线抹平,不诚实
    const fresh: RoundStat[] = [];
    for (const tpl of this.opts.templates) {
      const sig = signatureOfTemplate(tpl.id);
      const rows = this.history.slice(ob).filter((o) => o.signature === sig);
      const n = rows.length || 1;
      fresh.push({
        round, signature: sig,
        successRate: rows.filter((o) => o.success).length / n,
        avgTokens: rows.reduce((s, o) => s + o.tokens, 0) / n,
        avgScore: avgScore(rows),
      });
    }
    this.stats.push(...fresh);
    return this.stats.slice(before);
  }

  private async runTemplateRound(tpl: TaskTemplate, opts: RoundOpts, round: number): Promise<void> {
    const sig = signatureOfTemplate(tpl.id);

    // 出生调度
    if (this.reg.needsFounder(sig)) {
      const gam = this.reg.bestGamete(sig);
      if (gam) {
        const child = this.reg.cloneFrom(gam.genome);
        this.events.push({ what: 'breed', genomeId: child.genomeId, lineage: child.lineage, generation: child.generation, from: gam.genome.genomeId });
      } else {
        const f = this.reg.spawnFounder(tpl.id);
        if (this.pendingAffinity[tpl.id]) Object.assign(f.affinity, this.pendingAffinity[tpl.id]);
        if (opts.forceAffinity) Object.assign(f.affinity, opts.forceAffinity);
        this.events.push({ what: 'founder', genomeId: f.genomeId, signature: sig });
      }
    }
    // 繁殖判据达标且只有一只活体 → 补变异体(多样性)
    let live = this.reg.liveBySignature(sig);
    if (live.length === 1) {
      const lg = live[0];
      const recent = this.history.filter((o) => o.lineage === lg.lineage);
      if (this.reg.mayBreed(lg.lineage, recent)) {
        const facts = this.lastFossilFacts(lg.lineage);
        const child = this.reg.mutateFrom(lg, facts);
        this.events.push({ what: 'mutate', genomeId: child.genomeId, lineage: child.lineage, generation: child.generation, cause: facts.cause });
      }
    }

    // 公平曝光:每个副本重新取活体表 —— 种群是动态的(个体死亡即结算,
    // 替补出生接力),用循环外快照会让死者在副本间"僵尸执行",稀释选择压力。
    for (let v = 0; v < opts.perTask; v++) {
      live = this.reg.liveBySignature(sig);
      if (!live.length) break;
      const genome = live[v % live.length];
      const outcome = await this.runOne(tpl, v, genome, opts.abort);
      this.history.push(outcome);
      const facts = this.attribute(outcome, tpl, genome);
      const wasAborted = outcome.aborted;
      this.reg.settle(outcome, genome, facts);
      if (!wasAborted && !outcome.success) this.lastAttribution.set(genome.lineage, facts);
      this.events.push({ what: 'death', genomeId: genome.genomeId, cause: outcome.aborted ? 'aborted' : outcome.cause });
      if (outcome.success) this.events.push({ what: 'gamete', genomeId: genome.genomeId });
      // 替补:非中止死亡 → 从冠军配子池出生,保持种群密度。
      // 出生方式按死因分流:近期有归因死因 → 定向突变(疤痕遗传,死亡归因决定突变位点);
      // 无归因(如 grader 判错/步数超限已由 mutateFrom 内部分流)→ 纯克隆占位。
      if (!wasAborted && this.reg.liveBySignature(sig).length === 0) {
        const gam = this.reg.bestGamete(sig);
        if (gam) {
          const facts = this.lastAttribution.get(gam.genome.lineage);
          const child = facts
            ? this.reg.mutateFrom(gam.genome, facts)
            : this.reg.cloneFrom(gam.genome);
          this.events.push(facts
            ? { what: 'mutate', genomeId: child.genomeId, lineage: child.lineage, generation: child.generation, cause: facts.cause }
            : { what: 'breed', genomeId: child.genomeId, lineage: child.lineage, generation: child.generation, from: gam.genome.genomeId });
        }
      }
    }
  }

  private async runOne(tpl: TaskTemplate, variant: number, genome: Genome, abort?: boolean): Promise<RunOutcome> {
    const body: ExpressedBody = express(genome, this.tools, tpl.requiredTools);
    const chat = this.opts.chatFactory
      ? this.opts.chatFactory({ rng: this.rng, tpl, variant, body })
      : mockChat(this.rng, tpl, variant, abort);
    const r = await runBodyPlan({
      task: tpl.render(variant), cwd: '/tmp/phylum-e2e', body, genome,
      chat, tools: body.tools,
      signal: abort ? AbortSignal.abort() : undefined,
    });
    const g = tpl.grade({ lastOutput: r.lastOutput, steps: r.steps });
    const success = r.aborted ? false : g.success;
    // grader 失败 + 有真实工具轨迹 → 归因 wrong_answer(语义错,突变扰动);
    // grader 失败 + 无轨迹 → bodyplan 已给 wrong_answer;成功 → none(无突变)。
    const cause: DeathCause = r.aborted ? 'aborted'
      : (g.success ? 'none'
        : (r.finished && (r.trace?.length ?? 0) > 0 ? 'wrong_answer' : r.cause));
    return {
      taskId: `${tpl.id}#v${variant}`, signature: genome.signature,
      genomeId: genome.genomeId, lineage: genome.lineage, generation: genome.generation,
      success, aborted: r.aborted, cause, steps: r.steps, tokens: r.tokens,
      detail: r.detail || g.detail,
      trace: r.trace,
    };
  }

  private attribute(o: RunOutcome, tpl: TaskTemplate, genome: Genome): AttributionFacts {
    switch (o.cause) {
      case 'essential_tool_missing':
        return { cause: o.cause, missingTool: /'([^']+)'/.exec(o.detail)?.[1], removedTools: express(genome, this.tools, tpl.requiredTools).removedTools };
      case 'assertion_fail':
        return { cause: o.cause, assertionId: /'([^']+)'/.exec(o.detail)?.[1] };
      case 'tool_error':
        return { cause: o.cause, toolName: /'([^']+)'/.exec(o.detail)?.[1] };
      default:
        return { cause: o.cause };
    }
  }

  private lastFossilFacts(lineage: string): AttributionFacts {
    return this.lastAttribution.get(lineage) ?? { cause: 'wrong_answer' };
  }

  // ── 观测点(测试用) ──

  outcomes(): RunOutcome[] { return this.history; }
  evoLog(): EvoEvent[] { return this.events; }
  genes(): GenomeSnapshot[] { return this.reg.liveBySignature('').map(geneSnapshot).concat(this.reg.allLive().map(geneSnapshot)); }
  ledgers(): LineageLedger[] { return this.reg.allLedgers(); }
  roundStats(): RoundStat[] { return this.stats; }
}

/** 简单平均分(测试/日志用;繁殖判定不用它)。 */
function avgScore(rows: RunOutcome[]): number {
  if (!rows.length) return 0;
  const cn = rows.map((o) => 1 - Math.min(1, o.tokens / 200)); // 粗略类内成本分:仅观测
  const ok = rows.filter((o) => o.success).length / rows.length;
  return 0.6 * ok + 0.4 * (cn.reduce((s, v) => s + v, 0) / cn.length);
}

// ── 脚本化 mock 模型:个体"性格"由模板 + rng 决定,死亡/成功路径可精确编排 ──

type Persona = { primary: string; fallback: string };

function mockChat(rng: () => number, tpl: TaskTemplate, variant: number, abort?: boolean) {
  // 脚本:优先调任务必需工具;工具报错由 mock 工具内部(吃同一 rng)抛出。
  // abort 场景:第一轮 chat 前已 aborted(runBodyPlan 先检 signal)。
  return async (messages: ChatMsg[], toolDefs: Array<{ function: { name: string } }>): Promise<Completion> => {
    void messages;
    void rng;
    if (abort) {
      // 已 abort 时不会进来;防御性兜底
      return done();
    }
    const available = toolDefs.map((d) => d.function.name);
    const primary = tpl.requiredTools.find((t) => available.includes(t)) ?? available[0];
    if (!primary) return done('无可用工具');
    const call: ToolCall = { id: `c-${variant}-${primary}`, name: primary, arguments: JSON.stringify({ n: variant, path: `data-${variant}.txt`, query: `topic-${variant}` }) };
    return { content: '', toolCalls: [call], rawAssistant: emptyAssistant(call), tokensIn: 100, tokensOut: 20 };
  };
}

function done(text = '任务完成'): Completion {
  return { content: text, toolCalls: [], rawAssistant: { role: 'assistant', content: text }, tokensIn: 50, tokensOut: 10 };
}

function emptyAssistant(call: ToolCall) {
  return {
    role: 'assistant' as const, content: '',
    tool_calls: [{ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments } }],
  };
}
