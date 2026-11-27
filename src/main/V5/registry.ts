// 基因库注册表:支系账本 + 活体配子库 + 化石层。
// 存储策略:v1 内存 Map + JSONL 追加落盘(O(基因数) 不是 O(轨迹数));
// SQLite 迁移留给第三步接引擎槽时做(接口在此冻结,换后端不动调用方)。
//
// Gene registry: lineage ledgers + live gamete pool + fossil layer.
// v1 = in-memory maps + JSONL append; SQLite swap-in is step 3 behind this frozen interface.

import fs from 'node:fs';
import path from 'node:path';
import type { ToolErrorKind } from '../../shared/types';
import {
  type FitnessRecord, type FossilRecord, type Gamete, type Genome,
  type LineageLedger, type RunOutcome, type DeathCause,
  type TraceTemplate, type TraceSlot, type TraceStep,
  AFFINITY_PENALTY, ESSENTIAL_RECOVERY, AFFINITY_MIN, AFFINITY_MAX, MUTATION_STEP, MAX_STEPS_MAX,
  GRANULARITY_HINT_STEP, FOSSIL_DEPOSIT_RATE, FOSSIL_MISS_RETIRE, MAX_FOSSILS_PER_SIGNATURE, CONVERGE_MIN_TRIALS,
  RECENT_SLICE_CAP,
} from './phylum-types';
import { extractSlots } from './replay';
import { signatureOfTemplateWeighted } from './signature';

/** 归因器输入:一次执行结束时的全部事实(不带任何解释)。 */
export interface AttributionFacts {
  cause: DeathCause;
  /** cause=tool_error:肇事工具名 */
  toolName?: string;
  /** cause=tool_error:工具错误类型(参数类失败不该惩罚工具亲和) */
  errorKind?: ToolErrorKind;
  /** cause=assertion_fail:被违反的断言 id */
  assertionId?: string;
  /** cause=essential_tool_missing:被摘除的必需工具名 */
  missingTool?: string;
  /** 本轮被亲和过滤摘除的工具全集(判断 essential_tool_missing 用) */
  removedTools?: string[];
}

/** 环境类错误:目标不存在/权限/不支持/IO —— 不是基因能改的事,零惩罚、不留疤。 */
export function isEnvironmentErrorKind(kind?: ToolErrorKind): boolean {
  return kind === 'not_found' || kind === 'permission' || kind === 'unsupported' || kind === 'io';
}

/** 交付该轮的基因身份(用于用户否决后的追溯降权)。 */
export interface TurnGenome {
  /** 化石重放交付时无基因个体 → 只记模板 */
  genomeId?: string;
  lineage?: string;
  signature: string;
  /** 若该轮由化石重放交付,记下模板 id(否决时同时给模板记 miss) */
  templateId?: string;
  at: number;
}

/** 追溯映射上限:只保留最近 200 轮(用户否决通常发生在下一轮)。 */
const TURN_GENOMES_MAX = 200;

export interface RegistryInit {
  /** JSONL 落盘目录;不传 = 纯内存(测试用) */
  dataDir?: string;
  /** 随机源:默认 Math.random;实验注入种子 RNG 保证可复现 */
  rng?: () => number;
}

/** heavy 签名 founder 的步数预算:小时级任务给足探索空间,但仍受 bodyplan 硬墙 200 兜底 */
export const HEAVY_FOUNDER_STEPS = 32;

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
  /** 疤痕库:lineage → 最近死亡归因(定向突变依据)。随 state.json 持久化 ——
   *  修前在引擎层纯内存:死亡与替补出生之间 app 重启,疤痕丢失,定向突变退化成盲目克隆。 */
  private scars = new Map<string, AttributionFacts>();
  /** 仓库级疤痕(路径 → 参数类失败):跨签名共享,只收 bad_args/edit_mismatch */
  private repoScars = new Map<string, AttributionFacts>();
  /** turnId → 交付该轮的基因(用户否决追溯用;随 state.json 持久化) */
  private turnGenomes = new Map<string, TurnGenome>();
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
      this.loadState(); // 活体池/账本/配子跨进程持久化:app 重启不丢种群(挂起个体因此能续跑)
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

  // ── 种群状态快照(活体+个体账本+支系账本+配子):state.json 整文件读写 ──
  // 为什么不沿用 JSONL:活体池是可变集合(挂起个体要原样续跑),快照语义才对;
  // 审计历史仍走 phylum-log.jsonl(append-only),两者互补。

  private saveState(): void {
    if (!this.dataDir) return;
    const snap = {
      live: [...this.live.values()],
      fitness: [...this.fitness.entries()],
      ledgers: [...this.ledgers.entries()],
      gametes: [...this.gametes.entries()],
      scars: [...this.scars.entries()],
      repoScars: [...this.repoScars.entries()],
      turnGenomes: [...this.turnGenomes.entries()],
      seq: this.seq,
    };
    const f = path.join(this.dataDir, 'state.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(snap));
    fs.renameSync(f + '.tmp', f); // 原子替换:写一半崩溃不损旧状态
  }

  private loadState(): void {
    if (!this.dataDir) return;
    try {
      const f = path.join(this.dataDir, 'state.json');
      if (!fs.existsSync(f)) return;
      const snap = JSON.parse(fs.readFileSync(f, 'utf8')) as {
        live: Genome[]; fitness: [string, FitnessRecord][];
        ledgers: [string, LineageLedger][]; gametes: [string, Gamete][];
        scars?: [string, AttributionFacts][]; repoScars?: [string, AttributionFacts][];
        turnGenomes?: [string, TurnGenome][]; seq?: number;
      };
      for (const g of snap.live) this.live.set(g.genomeId, g);
      for (const [k, v] of snap.fitness) this.fitness.set(k, v);
      for (const [k, v] of snap.ledgers) this.ledgers.set(k, v);
      for (const [k, v] of snap.gametes) this.gametes.set(k, v);
      for (const [k, v] of snap.scars ?? []) this.scars.set(k, v);
      for (const [k, v] of snap.repoScars ?? []) this.repoScars.set(k, v);
      for (const [k, v] of snap.turnGenomes ?? []) this.turnGenomes.set(k, v);
      this.seq = snap.seq ?? 0;
    } catch { /* 损坏文件当作空种群:重新 founder,进化层自愈 */ }
  }

  // ── 疤痕库(引擎层的定向突变依据,随 state.json 跨进程持久)──
  /** 记录某 lineage 的最近死亡归因(死亡即结算时调用)。同 lineage 新疤痕覆盖旧疤。 */
  recordScar(lineage: string, facts: AttributionFacts): void {
    this.scars.set(lineage, facts);
    this.saveState();
  }
  /** 取疤痕(替补出生时定突变方向);无痕返回 null。 */
  scarOf(lineage: string): AttributionFacts | null {
    return this.scars.get(lineage) ?? null;
  }

  // ── 仓库级疤痕(横向遗传:同一仓库的参数类教训跨签名共享)──

  /** 只收参数类失败(bad_args/edit_mismatch):环境类不是基因能改的事,不跨任务传播。 */
  recordRepoScar(repoKey: string, facts: AttributionFacts): void {
    if (!repoKey) return;
    if (facts.cause !== 'tool_error') return;
    if (facts.errorKind !== 'bad_args' && facts.errorKind !== 'edit_mismatch') return;
    this.repoScars.set(path.resolve(repoKey), facts);
    this.saveState();
  }

  repoScarOf(repoKey: string): AttributionFacts | null {
    return repoKey ? this.repoScars.get(path.resolve(repoKey)) ?? null : null;
  }

  // ── 追溯选择:交付后用户否决(下一轮开头调用)──

  /** 记下这一轮由哪个基因交付(成功交付才需要)。 */
  noteTurnGenome(turnId: string, info: Omit<TurnGenome, 'at'>): void {
    if (!turnId) return;
    this.turnGenomes.set(turnId, { ...info, at: Date.now() });
    if (this.turnGenomes.size > TURN_GENOMES_MAX) {
      const oldest = [...this.turnGenomes.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.turnGenomes.delete(oldest[0]);
    }
    this.saveState();
  }

  /**
   * 用户否决的追溯结算:不否定当轮已发生的事实,只调整未来的繁殖/重放概率。
   *   - 有化石模板 → 记一次 replay miss(坏路线降口碑,连续 2 次退役);
   *   - 交付基因仍在配子池 → rejections+1,≥2 出池并留 wrong_answer 疤(后代定向规避)。
   */
  applyUserRejection(turnId: string): { applied: boolean; retiredGene: boolean; templateId?: string } {
    const info = this.turnGenomes.get(turnId);
    if (!info) return { applied: false, retiredGene: false };
    this.turnGenomes.delete(turnId);
    if (info.templateId) this.noteReplay(info.templateId, false);
    let retiredGene = false;
    const gam = info.genomeId ? this.gametes.get(info.genomeId) : undefined;
    if (gam) {
      gam.rejections = (gam.rejections ?? 0) + 1;
      if (gam.rejections >= 2) {
        this.gametes.delete(info.genomeId as string);
        retiredGene = true;
        if (info.lineage) this.recordScar(info.lineage, { cause: 'wrong_answer' });
      }
    }
    this.saveState();
    return { applied: true, retiredGene, templateId: info.templateId };
  }

  // ── 出生 ──

  /** 冷启动:某签名无活体且无可用配子 → 发 founder 基因(中性先验,对照组,不参与进化评价)。
   *  heavy 池 founder 起步 32 步(2026-10-13 分池修法:重活不靠死 5 次 step_budget 爬预算)。
   *  seed = 仓库级疤痕:新签名出生时先继承本仓库的参数类教训(跨签名横向遗传)。 */
  spawnFounder(templateId: string, weight: 'heavy' | 'light' = 'light', seed?: AttributionFacts | null): Genome {
    const sig = signatureOfTemplateWeighted(templateId, weight);
    const lineage = `L0-${sig}`;
    const g: Genome = {
      version: 1, genomeId: this.nextId('g'), lineage, signature: sig,
      routing: { maxSteps: weight === 'heavy' ? HEAVY_FOUNDER_STEPS : 12, granularity: 0.7, successPrior: 0.5 },
      affinity: {},
      assertions: [], // founder 无先天断言:断言只能由人工注入或死因删除产生
      generation: 0, bornAt: Date.now(),
    };
    if (seed) this.applyParamScar(g, seed);
    this.live.set(g.genomeId, g);
    this.ensureLedger(g);
    this.appendJsonl('born', g);
    this.saveState();
    return g;
  }

  /** 克隆:成功个体死后(或支系达标时)原样复制 + ±CLONE_JITTER 微扰。 */
  cloneFrom(parent: Genome): Genome {
    const child = structuredClone(parent);
    child.genomeId = this.nextId('g');
    child.generation = parent.generation + 1;
    child.bornAt = Date.now();
    delete child.scarNote; // 成功者不留旧疤:疤痕只传一代
    for (const k of Object.keys(child.affinity)) {
      child.affinity[k] = clamp(child.affinity[k] + (this.rng() * 2 - 1) * 0.03, AFFINITY_MIN, AFFINITY_MAX);
    }
    this.live.set(child.genomeId, child);
    this.ensureLedger(child);
    this.appendJsonl('born', child);
    this.saveState();
    return child;
  }

  /** 参数类失败的定向修正(粒度上调 + 文字疤痕);非参数类返回 false 不处理。 */
  private applyParamScar(g: Genome, facts: AttributionFacts): boolean {
    if (facts.cause !== 'tool_error') return false;
    if (facts.errorKind !== 'bad_args' && facts.errorKind !== 'edit_mismatch') return false;
    g.routing.granularity = clamp(g.routing.granularity + GRANULARITY_HINT_STEP, 0, 1);
    if (facts.toolName) {
      g.scarNote = facts.errorKind === 'edit_mismatch'
        ? `编辑 ${facts.toolName} 的 old_string 曾失配:先读原文再改,不要凭记忆下笔。`
        : `调用 ${facts.toolName} 曾参数报错:先确认路径/参数形状,再执行。`;
    }
    return true;
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
          if (this.applyParamScar(child, facts)) {
            // 参数类失败:工具本身没坏,是调用方式不对 —— 不降亲和(否则会把有用工具摘掉),
            // 改为把步子拆细 + 留文字疤痕给后代本能提示。
          } else if (isEnvironmentErrorKind(facts.errorKind)) {
            // 环境类(目标不存在/权限/不支持/IO):基因改不了世界 → 零惩罚、零疤痕
          } else {
            child.affinity[facts.toolName] = clamp(
              (child.affinity[facts.toolName] ?? 0.5) - AFFINITY_PENALTY, AFFINITY_MIN, AFFINITY_MAX);
            child.scarNote = `${facts.toolName} 曾执行失败(${facts.errorKind ?? 'unknown'}):换参数或换等价手段。`;
          }
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
    this.saveState();
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
    // 近窗结果序列:FIFO 有界,是化石沉积/收敛判定的"种群当前状态"口径(2026-11-27)。
    // aborted 不入窗(与 aborted 不计成败同口径)。
    if (!o.aborted) {
      if (!lg.recent) lg.recent = [];
      lg.recent.push(o.success);
      if (lg.recent.length > RECENT_SLICE_CAP) lg.recent.splice(0, lg.recent.length - RECENT_SLICE_CAP);
    }
    this.live.delete(g.genomeId); // 死亡:移出活体,尸体火化(轨迹不留)
    if (o.aborted) return; // 中止:不进配子/化石,零进化信号
    if (o.success) {
      this.gametes.set(g.genomeId, { genome: structuredClone(g), recent: { ...f }, diedAt: Date.now() });
      // 化石沉积:成功 + 带轨迹 + 支系**近窗**达标(FOSSIL_DEPOSIT_RATE,比繁殖线更高的种群背书)。
      // 同签名只保留最新一份(重复任务本质同一生态位;旧模板自动被顶替)。
      // 2026-11-27 修正:此前用支系累计成功率——早期失败的支系连赢 15 次成功率才 0.71,
      // 化石永远沉积不下("墓园终态"设计空转)。改用有界近窗(见 lineageRecentRate)。
      const rate = this.lineageRecentRate(lg);
      if (o.trace?.length && rate >= FOSSIL_DEPOSIT_RATE) this.depositFossil(o.trace, g, o.detail, lg.trials, rate);
    } else {
      this.fossils.push({
        genomeId: g.genomeId, lineage: g.lineage, signature: g.signature,
        generation: g.generation, cause: facts.cause, detail: this.fossilDetail(o, facts), diedAt: Date.now(),
      });
    }
    this.appendJsonl('settle', o);
    this.saveState(); // 状态快照:重启/挂起续跑不丢账本
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

  /** 全部活体(体检用:不区分签名)。 */
  liveGenomes(): Genome[] {
    return [...this.live.values()];
  }

  /** 体检换血:直接把个体移出活体(不记 trial),下次出生由配子接力。 */
  retire(genomeId: string): boolean {
    const ok = this.live.delete(genomeId);
    if (ok) this.saveState();
    return ok;
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

  /** 成功轨迹 → 槽位化模板。参数形状保留,实例相关值进槽位表(重放时按 kind 重抽)。
   *  同签名允许多份模板竞争(不同工具路线);完全相同的轨迹不重复沉积。 */
  private depositFossil(trace: TraceStep[], g: Genome, taskExample: string, trials: number, rate: number): void {
    const steps = structuredClone(trace);
    const same = this.templatesBySignature(g.signature)
      .find((t) => JSON.stringify(t.steps) === JSON.stringify(steps));
    if (same) { same.taskExample = taskExample.slice(0, 2000); this.saveTemplates(); return; }
    const t: TraceTemplate = {
      version: 1, id: this.nextId('tpl'), signature: g.signature, lineage: g.lineage,
      steps,
      slots: extractSlots(steps),
      taskExample: taskExample.slice(0, 2000),
      bornAt: Date.now(), replayHits: 0, replayMisses: 0,
    };
    this.fossilTemplates.set(t.id, t);
    // 竞争淘汰:同签名只留前 MAX_FOSSILS_PER_SIGNATURE 份(2026-11-27 F 修复:
    // 未试过的新模板不参与淘汰 —— 否则新沉积的(Laplace 0.5 垫底)会立刻被砍,
    // 连一次重放机会都没有;淘汰对象从"口碑最差"改为"口碑最差的已试模板")。
    const ranked = this.templatesBySignature(g.signature);
    const tried = ranked.filter((t) => !isUntried(t));
    const survivors = ranked.filter((t) => isUntried(t));
    const keepTried = tried.slice(0, Math.max(1, MAX_FOSSILS_PER_SIGNATURE - survivors.length));
    for (const drop of [...tried.slice(keepTried.length), ...survivors.slice(MAX_FOSSILS_PER_SIGNATURE)]) {
      this.fossilTemplates.delete(drop.id);
    }
    this.saveTemplates();
    void trials; void rate; // 语义已并入上方判定,参数留作签名文档
  }

  /** 同签名全部模板,按重放口碑排序;口碑相同 → 步数少(便宜路线)优先;再同 → 新模板优先。
   *  2026-11-27 F 修复:从未试过(0 hit 0 miss)的模板乐观排序置顶 —— Laplace 先验 0.5
   *  会被任何有命中的老模板(>0.5)永久压底,新路线实际永无曝光;置顶保证每份新模板
   *  至少一次探索机会(最多花一次 miss),试过即回落口碑排序。 */
  templatesBySignature(sig: string): TraceTemplate[] {
    return [...this.fossilTemplates.values()]
      .filter((t) => t.signature === sig)
      .sort((a, b) =>
        ((isUntried(b) ? 1 : 0) - (isUntried(a) ? 1 : 0))
        || (isUntried(a) && isUntried(b) ? b.bornAt - a.bornAt : 0)
        || replayScore(b) - replayScore(a)
        || a.steps.length - b.steps.length
        || b.bornAt - a.bornAt);
  }

  /** 该签名当前最值得先试的化石(口碑最高)。 */
  templateBySignature(sig: string): TraceTemplate | undefined {
    return this.templatesBySignature(sig)[0];
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
    return this.lineageRecentRate(lg) >= FOSSIL_DEPOSIT_RATE;
  }

  /**
   * 支系近窗成功率(2026-11-27):来自账本上的有界 recent 序列(settle 时 FIFO 维护)。
   * 旧快照没有 recent 字段 → 回退累计口径(历史数据平滑迁移,不产生断崖);
   * 回退口径在失败稀释下偏保守,只会少存化石,不会错存。
   * Lineage recent-window success rate. Falls back to lifetime ratio for old
   * snapshots without the `recent` field (conservative direction: fewer
   * deposits, never wrong ones).
   */
  private lineageRecentRate(lg: LineageLedger): number {
    if (lg.recent && lg.recent.length) {
      return lg.recent.filter(Boolean).length / lg.recent.length;
    }
    return lg.trials === 0 ? 0 : lg.successes / lg.trials;
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

  /** 取配子(近窗成功率优先;成功率相同 → 每成功步数少的优先;再同 → 被否次数少、最新)。 */
  bestGamete(sig: string): Gamete | undefined {
    let best: Gamete | undefined;
    for (const g of this.gametes.values()) {
      if (g.genome.signature !== sig) continue;
      if ((g.rejections ?? 0) >= 2) continue; // 连续被用户否决 → 出池
      if (!best || betterGamete(g, best)) best = g;
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

const rateOf = (f: FitnessRecord): number => (f.trials === 0 ? 0 : f.successes / f.trials);

/** 每成功一次的平均步数(无成功时退回每试平均)—— 成本只在成功率打平时参与排序。 */
const costOf = (f: FitnessRecord): number => {
  const base = f.successes > 0 ? f.successes : f.trials;
  return base === 0 ? 0 : f.stepsSum / base;
};

/** 配子质量:成功率高 → 每成功步数少 → 被否次数少 → 更新。 */
function betterGamete(a: Gamete, b: Gamete): boolean {
  const ra = rateOf(a.recent);
  const rb = rateOf(b.recent);
  if (ra !== rb) return ra > rb;
  const ca = costOf(a.recent);
  const cb = costOf(b.recent);
  if (Math.abs(ca - cb) > 1e-9) return ca < cb;
  const ja = a.rejections ?? 0;
  const jb = b.rejections ?? 0;
  if (ja !== jb) return ja < jb;
  return a.diedAt > b.diedAt;
}

/** 化石重放口碑(Laplace 平滑):0/0 的新模板 = 0.5,有命中才升、连续 miss 才降 ——
 *  新路线因此有机会被尝试,而不是永远排在老模板后面。 */
function replayScore(t: TraceTemplate): number {
  return (t.replayHits + 1) / (t.replayHits + t.replayMisses + 2);
}

/** 从未参与过重放的模板(乐观探索候选)。 */
function isUntried(t: TraceTemplate): boolean {
  return t.replayHits === 0 && t.replayMisses === 0;
}
