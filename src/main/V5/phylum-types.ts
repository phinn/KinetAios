// Phylum 种群进化层 —— 共享类型与常量(冻结 v1)。
// 设计原则:基因是纯数据 KB 级 JSON,模型只是表达器官;所有常量在此集中,
// 每个常量带"依据注释"(为什么是这个值),防止后人瞎调。
//
// Phylum evolution layer — shared types & frozen v1 constants.
// Genes are pure KB-level JSON; the model is merely the expression organ.

import type { Tool } from '../tools';

/** 支系 id:同签名下由创始个体分裂出的进化线。 */
export type LineageId = string;

/** 基因组版本:签名函数或 schema 变更时递增,旧基因不迁移,分桶存。 */
export const GENOME_SCHEMA_VERSION = 1 as const;

/** 断言类型 DSL:全是确定性检查,不经 LLM 之手(防幻觉遗传的第一道闸)。
 *  两层共用:①基因断言(每步工具输出,express 后随 body) ②Ralph 任务验收(整轮交付物,
 *  ralph-accept)。file_* 三个类型只有验收层用(基因断言不碰磁盘——每步读盘成本不可控)。 */
export type AssertionDsl =
  | { type: 'exit_code_eq'; value: number }          // 前置:上一工具是 shell
  | { type: 'regex_contains'; pattern: string }      // 对最后工具输出
  | { type: 'output_not_empty' }                     // 最后工具输出非空
  | { type: 'line_count_gt'; value: number }         // 最后工具输出行数
  | { type: 'file_exists'; path: string }            // 验收层:cwd 内相对/绝对路径
  | { type: 'regex_file_contains'; path: string; pattern: string }        // 验收层:文件内容
  | { type: 'file_line_count_gt'; path: string; value: number };          // 验收层:文件行数

/** 断言基因位:门级免疫系统,只删不增不自由变异(见 DESIGN_NOTE.md 防 Goodhart)。 */
export interface AssertionGene {
  id: string;
  check: AssertionDsl;
  /** 何时应用:每次工具调用后。v1 只有这一档,字段留着给将来 "任务完成后"。 */
  when: 'after_each_tool';
}

/** 定向突变的死因类别(归因器输出)。 */
export type DeathCause =
  | 'tool_error'              // 死于工具报错 → 扰 tool_affinity
  | 'assertion_fail'          // 死于断言失败 → 删该断言
  | 'step_budget'             // 死于步数超限 → granularity 上升(步子拆细)
  | 'essential_tool_missing'  // 死于必需工具被亲和过滤摘除 → 亲和回升(环境教育)
  | 'wrong_answer'            // 断言全过但产物语义错误(由任务的 grader 判定)
  | 'fossil_miss'             // 化石重放失败 → 降级开荒(化石不直接删,连续 miss 才退役)
  | 'provider_suspended'      // provider 侧停供(quota 429/5h 窗口/network/auth):世界停了,不是个体的错 → 挂起,零进化信号
  | 'aborted'                 // 用户中止:不算进化信号,fitness 记 abort 不记败
  | 'none';                   // 成功

/** 轨迹步:一次工具调用的最小记录(化石模板的骨架单元,KB 级)。 */
export interface TraceStep {
  tool: string;
  /** JSON.parse 后的工具参数(槽位化:填充值被换掉,形状保留) */
  args: Record<string, unknown>;
}

/** 化石模板:成功轨迹的参数槽位化骨架(档②轨迹重放;档③真编译的输入)。
 *  与 FossilRecord(死因墓志铭)不同:这是**可执行的**遗产 —— 重放新任务时按
 *  槽位类型从任务文本抽参数填入,断言 gate 把关,失败自动回退 LLM 开荒。 */
export interface TraceTemplate {
  version: typeof GENOME_SCHEMA_VERSION;
  id: string;
  signature: string;
  lineage: LineageId;          // 出处血脉(记账/退役参考)
  steps: TraceStep[];
  /** 槽位表:从任务文本抽取的参数(重放时重新抽取填充)。空 = 全常量轨迹,直接重放。 */
  slots: TraceSlot[];
  /** 任务文本样例(抽槽参考,重放时不参与执行) */
  taskExample: string;
  bornAt: number;
  /** 重放质量记账:命中/未命中(连续 miss 达 FOSSIL_MISS_RETIRE → 退役) */
  replayHits: number;
  replayMisses: number;
}

/** 参数槽位:模板里某个参数是任务实例相关的,重放时需从新任务文本抽取。 */
export interface TraceSlot {
  /** 槽位路径,如 "steps.0.args.path"(JSON pointer 风格,从模板根寻址) */
  path: string;
  kind: 'path' | 'url' | 'query';
  /** 抽取失败时的缺省值(上一版成功值;query 类兜底也可直接用) */
  fallback: unknown;
}

// ── 基因三件套 ──

export interface Genome {
  version: typeof GENOME_SCHEMA_VERSION;
  genomeId: string;            // 个体唯一 id(一次出生一个,死了不复用)
  lineage: LineageId;
  signature: string;           // 任务签名(实验内 = 任务模板 id;生产化时 L0 指纹扩展)
  /** ① 路由先验 */
  routing: {
    /** 分解上限:1 = 直接执行不分解。值域 [1,40]。表达 = bodyplan 执行器 maxSteps。 */
    maxSteps: number;
    /** 0..1:任务分解粒度(高 = 小步快跑)。表达 = bodyplan 每步工具调用预算(取整 1-3)。 */
    granularity: number;
    /** 0..1:同签名历史成功率先验,表达 = 出生时注入 system prompt 的一句话(软先验)。 */
    successPrior: number;
  };
  /** ② 工具亲和向量:表达 = 亲和 < TOOL_CUTOFF 的工具从注册表摘除(硬约束,绕过 prompt)。 */
  affinity: Record<string, number>; // 0..1,缺省 TOOL_AFFINITY_DEFAULT
  /** ③ 断言模板库 */
  assertions: AssertionGene[];
  /** 繁殖代数:founder=0 */
  generation: number;
  /** 出生时间(单调时钟毫秒,记账用) */
  bornAt: number;
}

/** 个体 fitness 记账(按 genomeId;死亡时合并回支系账本)。 */
export interface FitnessRecord {
  trials: number;
  successes: number;
  /** 类内归一化后的成本 z 分数累计(见 scorer.ts:跨签名成本不可比) */
  costZSum: number;
  stepsSum: number;
  aborted: number; // 中止次数:不计成败
}

/** 支系账本:个体死了账不丢(见 DESIGN_NOTE.md 记账单位)。 */
export interface LineageLedger extends FitnessRecord {
  lineage: LineageId;
  signature: string;
  generation: number;
  /** 繁殖冷却:出生后必须活满 MIN_AGE_BEFORE_BREED 个个体才可再繁殖 */
  bornGenCounter: number;
}

/** 化石层:死因墓志铭(3-5 行摘要),供突变归因参考;不存轨迹。 */
export interface FossilRecord {
  genomeId: string;
  lineage: LineageId;
  signature: string;
  generation: number;
  cause: DeathCause;
  /** 死因细节(工具名/断言 id/步数),KB 内 */
  detail: string;
  diedAt: number;
}

// ── 常量(冻结 v1;每个值都有依据) ──

/** 亲和低于此值的工具从注册表摘除。0.2:上一轮设计评审定的摘除线。 */
export const TOOL_CUTOFF = 0.2;

/** 新基因/未知工具的默认亲和。0.5:中性,不高估不低估。 */
export const TOOL_AFFINITY_DEFAULT = 0.5;

/** 克隆微扰幅度(连续成功个体的快速占位复制)。±0.03:足够小不破坏已验证生态位。 */
export const CLONE_JITTER = 0.03;

/** 定向突变的单步扰动幅度。0.15:一次突变足以改变工具选择结果,又不至于把基因打碎。 */
export const MUTATION_STEP = 0.15;

/** 亲和钳制范围。下限 0(全禁),上限 0.95(永远给环境留一点反向证据的空间)。 */
export const AFFINITY_MIN = 0;
export const AFFINITY_MAX = 0.95;

/** 死亡归因 → 亲和惩罚(死因=tool_error 时,对肇事工具)。 */
export const AFFINITY_PENALTY = 0.15;

/** 必需工具缺失死亡后,全表亲和回升量("环境教育":这支血脉知道不能饿死自己)。 */
export const ESSENTIAL_RECOVERY = 0.1;

/** 个体单次任务步数硬上限(门级护栏,基因只能低于不能高于它)。
 *  对齐宿主 Direct 引擎实战:真实任务一次工具调用算一步(查→读→改→验就 4+ 步),
 *  宿主默认 maxTurns=50,这里给 64 留出长 IO(shell 链)余量。 */
export const STEP_BUDGET_CEIL = 64;

/** maxSteps 基因位值域。上限 40:进化的自由度要够真实任务用,
 *  门级护栏 STEP_BUDGET_CEIL=64 仍在外面兜底(基因只能低于不能高于它)。 */
export const MAX_STEPS_MIN = 1;
export const MAX_STEPS_MAX = 40;

/** 繁殖条件:支系近窗口成功率 ≥ 此值才获得繁殖权。0.7:上轮设计定的繁殖线。 */
export const BREED_SUCCESS_RATE = 0.7;

/** 繁殖条件:支系最小样本量。低于此不成水平 comparison,防 3 连幸运成功引发震荡。 */
export const BREED_MIN_TRIALS = 12;

/** 个体死亡后 fitness 合并进支系账本前的最近表现窗口。 */
export const RECENT_WINDOW = 3;

// ── 化石层(档②轨迹重放;修正版设计:种群终态是墓园,化石零 token 运行)──

/** 支系近窗成功率 ≥ 此值才值得沉积化石模板(垃圾轨迹不值得重放)。0.8:比繁殖线(0.7)更高 —— 化石是种群最高背书。 */
export const FOSSIL_DEPOSIT_RATE = 0.8;

/** 化石连续重放失败达此数 → 退役(环境漂移:化石是零感知的,错得安静,靠计数器发现)。 */
export const FOSSIL_MISS_RETIRE = 2;

/** 收敛判定:支系近窗 trials ≥ 此数且成功率 ≥ FOSSIL_DEPOSIT_RATE → 本能 prompt 冻结路由(档①)。 */
export const CONVERGE_MIN_TRIALS = 6;

/** 出生后至少经历这么多任务才可参与繁殖判定(防"出生即繁殖"震荡)。 */
export const MIN_AGE_BEFORE_BREED = 4;

/** 批次结算:每 N 个副本跑完结算一次繁殖(防单任务结算的幸运震荡)。 */
export const SETTLE_BATCH = 12;

/** 成功个体死后留下的配子(基因快照),供繁殖时取用。 */
export interface Gamete {
  genome: Genome;
  /** 死时的近窗表现(供配子质量加权,排除近窗全败的老冠军) */
  recent: FitnessRecord;
  diedAt: number;
}

/** 一次执行的完整记录(实验数据行)。 */
export interface RunOutcome {
  taskId: string;
  signature: string;
  genomeId: string;
  lineage: LineageId;
  generation: number;
  success: boolean;
  aborted: boolean;
  cause: DeathCause;
  steps: number;
  /** 归一化成本(token 计,结算时类内转 z) */
  tokens: number;
  detail: string;
  /** 成功轨迹(结构化;成功结算时被 registry 沉积为化石模板) */
  trace?: TraceStep[];
  /** bodyplan 自然完成(final answer):生产路径的成功语义 */
  finished?: boolean;
}

/** 基因表达产物:bodyplan 执行器的硬约束(绕过 prompt 的表达通路)。 */
export interface ExpressedBody {
  /** 过滤后的工具注册表(亲和 < TOOL_CUTOFF 已摘除) */
  tools: Tool[];
  /** 被摘除的工具名(记入死因归因) */
  removedTools: string[];
  maxSteps: number;
  /** 出生注入的软先验段(system prompt,占比刻意小) */
  instinctPrompt: string;
  assertions: AssertionGene[];
}


/** 基因快照(观测/审计用:全量数值导出,与进化决策解耦)。 */
export interface GenomeSnapshot {
  genomeId: string;
  lineage: string;
  signature: string;
  generation: number;
  granularity: number;
  toolAffinity: Record<string, number>;
  assertions: Array<{ id: string; check: AssertionDsl; when: AssertionGene['when'] }>;
  maxSteps: number;
  successPrior: number;
}

export function geneSnapshot(g: Genome): GenomeSnapshot {
  return {
    genomeId: g.genomeId, lineage: g.lineage, signature: g.signature, generation: g.generation,
    granularity: g.routing.granularity,
    toolAffinity: { ...g.affinity },
    assertions: g.assertions.map((a) => ({ id: a.id, check: structuredClone(a.check), when: a.when })),
    maxSteps: g.routing.maxSteps,
    successPrior: g.routing.successPrior,
  };
}

// ── 工具函数 ──

export function clamp01(v: number, min = AFFINITY_MIN, max = AFFINITY_MAX): number {
  return Math.max(min, Math.min(max, v));
}

/** 深拷贝(基因是纯 JSON,structuredClone 足够,不引依赖)。 */
export function cloneGenome(g: Genome): Genome {
  return structuredClone(g);
}
