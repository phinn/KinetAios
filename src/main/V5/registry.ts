// 基因库注册表:支系账本 + 活体配子库 + 化石层。
// 存储策略:v1 内存 Map + JSONL 追加落盘(O(基因数) 不是 O(轨迹数));
// SQLite 迁移留给第三步接引擎槽时做(接口在此冻结,换后端不动调用方)。
//
// Gene registry: lineage ledgers + live gamete pool + fossil layer.
// v1 = in-memory maps + JSONL append; SQLite swap-in is step 3 behind this frozen interface.

import fs from 'node:fs';
import path from 'node:path';
import {
  type FitnessRecord, type FossilRecord, type Gamete, type Genome,
  type LineageLedger, type RunOutcome, type DeathCause,
  type TraceTemplate, type TraceSlot, type TraceStep,
  AFFINITY_PENALTY, ESSENTIAL_RECOVERY, AFFINITY_MIN, AFFINITY_MAX, MUTATION_STEP, MAX_STEPS_MAX,
  FOSSIL_DEPOSIT_RATE, FOSSIL_MISS_RETIRE, CONVERGE_MIN_TRIALS,
} from './phylum-types';
import { extractSlots } from './replay';
import { signatureOfTemplate } from './signature';

/** 归因器输入:一次执行结束时的全部事实(不带任何解释)。 */
export interface AttributionFacts {
  cause: DeathCause;
  /** cause=tool_error:肇事工具名 */
  toolName?: string;
  /** cause=assertion_fail:被违反的断言 id */
  assertionId?: string;
  /** cause=essential_tool_missing:被摘除的必需工具名 */
  missingTool?: string;
  /** 本轮被亲和过滤摘除的工具全集(判断 essential_tool_missing 用) */
  removedTools?: string[];
}

export interface RegistryInit {
  /** JSONL 落盘目录;不传 = 纯内存(测试用) */
  dataDir?: string;
  /** 随机源:默认 Math.random;实验注入种子 RNG 保证可复现 */
  rng?: () => number;
}

const emptyFitness = (): FitnessRecord => ({ trials: 0, successes: 0, costZSum: 0, stepsSum: 0, aborted: 0 });

export class GeneRegistry {
  /** genomeId → 当前活体(活着=执行中或待命中;死亡即移出) */
  private live = new Map<string, Genome>();
  /** genomeId → 个体账本 */
  private fitness = new Map<string, FitnessRecord>();
  /** lineage → 支系账本 */
  private ledgers = new Map<string, LineageLedger>();
  /** 配子库:成功死者留下的基因快照 */
  private gametes = new Map<string, Gamete>();
  private fossils: FossilRecord[] = [];
  /** 可执行化石模板(档②轨迹重放):成功轨迹的槽位化骨架,跨会话持久化 */
  private fossilTemplates = new Map<string, TraceTemplate>();
  private rng: () => number;
  private dataDir?: string;
  private seq = 0; // id 单调序号

  constructor(init: RegistryInit = {}) {
    this.rng = init.rng ?? Math.random;
    this.dataDir = init.dataDir;
    if (this.dataDir) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.loadTemplates();
    }
  }

  /** 从 templates.json 读回化石模板(基因/账本走 JSONL 追加,模板是可变结构 → 整文件快照)。 */
  private loadTemplates(): void {
    if (!this.dataDir) return;
    try {
      const f = path.join(this.dataDir, 'templates.json');
      if (!fs.existsSync(f)) return;
      const arr = JSON.parse(fs.readFileSync(f, 'utf8')) as TraceTemplate[];
      for (const t of arr) this.fossilTemplates.set(t.id, t);
    } catch { /* 损坏文件当作无化石:进化层自愈 */ }
  }

  private saveTemplates(): void {
    if (!this.dataDir) return;
    fs.writeFileSync(path.join(this.dataDir, 'templates.json'), JSON.stringify([...this.fossilTemplates.values()]));
  }

  // ── 出生 ──

  /** 冷启动:某签名无活体且无可用配子 → 发 founder 基因(中性先验,对照组,不参与进化评价)。 */
  spawnFounder(templateId: string): Genome {
    const sig = signatureOfTemplate(templateId);
    const lineage = `L0-${sig}`;
    const g: Genome = {
      version: 1, genomeId: this.nextId('g'), lineage, signature: sig,
      routing: { maxSteps: 12, granularity: 0.7, successPrior: 0.5 },
      affinity: {},
      assertions: [], // founder 无先天断言:断言只能由人工注入或死因删除产生
      generation: 0, bornAt: Date.now(),
    };
    this.live.set(g.genomeId, g);
    this.ensureLedger(g);
    this.appendJsonl('born', g);
    return g;
  }

  /** 克隆:成功个体死后(或支系达标时)原样复制 + ±CLONE_JITTER 微扰。 */
  cloneFrom(parent: Genome): Genome {
    const child = structuredClone(parent);
    child.genomeId = this.nextId('g');
    child.generation = parent.generation + 1;
    child.bornAt = Date.now();
    for (const k of Object.keys(child.affinity)) {
      child.affinity[k] = clamp(child.affinity[k] + (this.rng() * 2 - 1) * 0.03, AFFINITY_MIN, AFFINITY_MAX);
    }
    this.live.set(child.genomeId, child);
    this.ensureLedger(child);
    this.appendJsonl('born', child);
    return child;
  }

  /** 定向突变:按死因只扰动对应基因位(死亡归因决定突变位点)。 */
  mutateFrom(parent: Genome, facts: AttributionFacts): Genome {
    const child = structuredClone(parent);
    child.genomeId = this.nextId('g');
    child.generation = parent.generation + 1;
    child.bornAt = Date.now();
    switch (facts.cause) {
      case 'tool_error': {
        if (facts.toolName) {
          child.affinity[facts.toolName] = clamp(
            (child.affinity[facts.toolName] ?? 0.5) - AFFINITY_PENALTY, AFFINITY_MIN, AFFINITY_MAX);
        }
        break;
      }
      case 'essential_tool_missing': {
        // 环境教育:全表亲和回升(这支血脉学会了"别把饭碗扔了")
        for (const k of Object.keys(child.affinity)) {
          child.affinity[k] = clamp(child.affinity[k] + ESSENTIAL_RECOVERY, AFFINITY_MIN, AFFINITY_MAX);
        }
        if (facts.missingTool) {
          child.affinity[facts.missingTool] = clamp(0.3, AFFINITY_MIN, AFFINITY_MAX);
        }
        break;
      }
      case 'step_budget': {
        // +4/次:6→12 的旧参数下 +1 要连死 6 次才爬满,选择压力浪费在重复踩同一堵墙;
        // 现值域 [1,40],4 次死亡内爬到典型任务所需(12→16→20→24)。
        child.routing.maxSteps = Math.min(MAX_STEPS_MAX, child.routing.maxSteps + 4);
        break;
      }
      case 'assertion_fail': {
        // 断言基因位只删不增:违规断言从子代删除(防 Goodhart:断言不参与自由进化)
        if (facts.assertionId) {
          child.assertions = child.assertions.filter((a) => a.id !== facts.assertionId);
        }
        break;
      }
      case 'wrong_answer': {
        // 断言全过但语义错:断言不够严 → 不允许加断言(只删不增铁律),
        // 退而扰动工具亲和(假设:选错了工具导致产物错),加小幅探索噪声。
        for (const k of Object.keys(child.affinity)) {
          child.affinity[k] = clamp(child.affinity[k] + (this.rng() * 2 - 1) * MUTATION_STEP, AFFINITY_MIN, AFFINITY_MAX);
        }
        break;
      }
      default:
        break; // aborted/none 不产生突变子代
    }
    this.live.set(child.genomeId, child);
    this.ensureLedger(child);
    this.appendJsonl('born', child);
    return child;
  }

  // ── 结算:死亡 + 记账 ──

  /** 个体一生结束。成功 → 留配子;失败 → 按死因留化石。aborted → 只记账不计成败。 */
  settle(o: RunOutcome, g: Genome, facts: AttributionFacts): void {
    const f = this.fitness.get(g.genomeId) ?? emptyFitness();
    const lg = this.ensureLedger(g);
    if (o.aborted) {
      f.aborted++; lg.aborted++;
    } else {
      f.trials++; lg.trials++;
      f.stepsSum += o.steps; lg.stepsSum += o.steps;
      if (o.success) { f.successes++; lg.successes++; }
    }
    this.fitness.set(g.genomeId, f);
    lg.bornGenCounter++;
    this.live.delete(g.genomeId); // 死亡:移出活体,尸体火化(轨迹不留)
    if (o.aborted) return; // 中止:不进配子/化石,零进化信号
    if (o.success) {
      this.gametes.set(g.genomeId, { genome: structuredClone(g), recent: { ...f }, diedAt: Date.now() });
      // 化石沉积:成功 + 带轨迹 + 支系近窗达标(FOSSIL_DEPOSIT_RATE,比繁殖线更高的种群背书)。
      // 同签名只保留最新一份(重复任务本质同一生态位;旧模板自动被顶替)。
      const rate = lg.trials === 0 ? 0 : lg.successes / lg.trials;
      if (o.trace?.length && rate >= FOSSIL_DEPOSIT_RATE) this.depositFossil(o.trace, g, o.detail, lg.trials, rate);
    } else {
      this.fossils.push({
        genomeId: g.genomeId, lineage: g.lineage, signature: g.signature,
        generation: g.generation, cause: facts.cause, detail: this.fossilDetail(o, facts), diedAt: Date.now(),
      });
    }
    this.appendJsonl('settle', o);
  }

  private fossilDetail(o: RunOutcome, facts: AttributionFacts): string {
    const bits = [`steps=${o.steps}`, `cause=${facts.cause}`];
    if (facts.toolName) bits.push(`tool=${facts.toolName}`);
    if (facts.assertionId) bits.push(`assertion=${facts.assertionId}`);
    if (facts.missingTool) bits.push(`missing=${facts.missingTool}`);
    if (o.detail) bits.push(o.detail.slice(0, 80));
    return bits.join(' ');
  }

  // ── 查询 ──

  liveBySignature(sig: string): Genome[] {
    return [...this.live.values()].filter((g) => g.signature === sig);
  }

  ledgerOf(lineage: string): LineageLedger | undefined {
    return this.ledgers.get(lineage);
  }

  fitnessOf(genomeId: string): FitnessRecord | undefined {
    return this.fitness.get(genomeId);
  }

  fossilCount(): number { return this.fossils.length; }

  fossilBySignature(sig: string): FossilRecord[] {
    return this.fossils.filter((f) => f.signature === sig);
  }

  // ── 可执行化石(档②轨迹重放)──

  /** 成功轨迹 → 槽位化模板。参数形状保留,实例相关值进槽位表(重放时按 kind 重抽)。 */
  private depositFossil(trace: TraceStep[], g: Genome, taskExample: string, trials: number, rate: number): void {
    const t: TraceTemplate = {
      version: 1, id: this.nextId('tpl'), signature: g.signature, lineage: g.lineage,
      steps: structuredClone(trace),
      slots: extractSlots(trace),
      taskExample: taskExample.slice(0, 2000),
      bornAt: Date.now(), replayHits: 0, replayMisses: 0,
    };
    // 同签名替换:新化石继承旧化石的重放口碑(.hits/-misses),不重置教训
    const old = this.templateBySignature(g.signature);
    if (old) { t.replayHits = old.replayHits; t.replayMisses = old.replayMisses; this.fossilTemplates.delete(old.id); }
    this.fossilTemplates.set(t.id, t);
    this.saveTemplates();
    void trials; void rate; // 语义已并入上方判定,参数留作签名文档
  }

  templateBySignature(sig: string): TraceTemplate | undefined {
    for (const t of this.fossilTemplates.values()) if (t.signature === sig) return t;
    return undefined;
  }

  /** 重放质量记账:hit 归零 miss,miss 累计达 FOSSIL_MISS_RETIRE → 退役(环境漂移检测)。 */
  noteReplay(id: string, hit: boolean): void {
    const t = this.fossilTemplates.get(id);
    if (!t) return;
    if (hit) { t.replayHits++; t.replayMisses = 0; }
    else {
      t.replayMisses++;
      if (t.replayMisses >= FOSSIL_MISS_RETIRE) { this.fossilTemplates.delete(id); this.saveTemplates(); return; }
    }
    this.saveTemplates();
  }

  /** 档①冻结路由判定:支系近窗达标 → 本能 prompt 注入"路线已验证,按基因工具先验走"。 */
  isConverged(sig: string): boolean {
    let lg: LineageLedger | undefined;
    for (const l of this.ledgers.values()) if (l.signature === sig) { lg = l; break; }
    if (!lg || lg.trials < CONVERGE_MIN_TRIALS) return false;
    return lg.successes / lg.trials >= FOSSIL_DEPOSIT_RATE;
  }

  templatesCount(): number { return this.fossilTemplates.size; }

  /** [测试垫片] 直改支系账本(99 烟囱造收敛态;生产路径由 settle 累积)。按签名找首个账本,没有就造 L0。 */
  debugFillLedger(sig: string, trials: number, successes: number): void {
    for (const l of this.ledgers.values()) {
      if (l.signature === sig) { l.trials = trials; l.successes = successes; return; }
    }
    this.ledgers.set(`L0-${sig}`, { lineage: `L0-${sig}`, signature: sig, generation: 0,
      trials, successes, costZSum: 0, stepsSum: 0, aborted: 0, bornGenCounter: trials });
  }

  gameteCount(): number { return this.gametes.size; }

  /** 繁殖权判定:支系近窗成功率 ≥ BREED_SUCCESS_RATE 且样本 ≥ BREED_MIN_TRIALS 且冷却已过。 */
  mayBreed(lineage: string, recentWindow: RunOutcome[]): boolean {
    const lg = this.ledgers.get(lineage);
    if (!lg) return false;
    if (lg.bornGenCounter < 4) return false; // 冷却
    const recent = recentWindow.filter((r) => r.lineage === lineage && !r.aborted);
    if (recent.length < 12 && lg.trials < 12) return false; // 样本不足(近窗或累计任一达标即可)
    const succ = recent.length >= 12
      ? recent.filter((r) => r.success).length / recent.length
      : lg.successes / Math.max(1, lg.trials);
    return succ >= 0.7;
  }

  /** 取配子(该签名下质量最好的:近窗成功率优先,同分取最新)。 */
  bestGamete(sig: string): Gamete | undefined {
    let best: Gamete | undefined;
    for (const g of this.gametes.values()) {
      if (g.genome.signature !== sig) continue;
      if (!best) { best = g; continue; }
      const rate = g.recent.trials === 0 ? 0 : g.recent.successes / g.recent.trials;
      const bestRate = best.recent.trials === 0 ? 0 : best.recent.successes / best.recent.trials;
      if (rate > bestRate || (rate === bestRate && g.diedAt > best.diedAt)) best = g;
    }
    return best;
  }

  /** 该签名是否需要 founder(无活体且无配子)。 */
  needsFounder(sig: string): boolean {
    return this.liveBySignature(sig).length === 0 && !this.bestGamete(sig);
  }

  /** 该签名的活体出生代际分布(公平曝光用)。 */
  private nextId(prefix: string): string {
    return `${prefix}${(++this.seq).toString(36)}${Math.floor(this.rng() * 1e6).toString(36)}`;
  }

  private ensureLedger(g: Genome): LineageLedger {
    let lg = this.ledgers.get(g.lineage);
    if (!lg) {
      lg = { lineage: g.lineage, signature: g.signature, generation: g.generation,
        ...emptyFitness(), bornGenCounter: 0 };
      this.ledgers.set(g.lineage, lg);
    }
    return lg;
  }

  private appendJsonl(kind: 'born' | 'settle', payload: unknown): void {
    if (!this.dataDir) return;
    fs.appendFileSync(path.join(this.dataDir, 'phylum-log.jsonl'), JSON.stringify({ kind, at: Date.now(), payload }) + '\n');
  }

  /** 全部存活个体(跨签名;审计/快照用)。 */
  allLive(): Genome[] {
    return [...this.live.values()];
  }

  /** 全部支系账本(审计用)。 */
  allLedgers(): LineageLedger[] {
    return [...this.ledgers.values()];
  }

  /** 当前统计快照(stats 命令/测试断言用)。 */
  stats(): { live: number; ledgers: number; fossils: number; gametes: number } {
    return { live: this.live.size, ledgers: this.ledgers.size, fossils: this.fossils.length, gametes: this.gametes.size };
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
