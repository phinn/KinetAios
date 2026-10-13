// 任务签名(v1 冻结)。
// 实验期策略:任务模板 id 即签名 —— 零抖动、全可复现,这正是杀手实验要的。
// 生产化路径(v2,接口不变):L0 硬指纹(工具序列模式+输入 MIME+动词集合归一化 hash)
//   + L1 冻结 embedding 余弦 >0.82 合并;此处刻意不实现,避免实验期引入语义抖动。
//
// Task signature (frozen v1). During the experiment the task-template id IS the
// signature: zero jitter, fully reproducible. Production L0/L1 hashing lands in v2
// behind this same interface, deliberately deferred to keep the experiment deterministic.

import type { Genome } from './phylum-types';

// ── 任务重量分池(2026-10-13 事故复盘:签名路由太粗)────────────
// 「装 Windows(数小时)」和「读文件总结(数秒)」同落 tpl@v1:misc,gen-0 founder
// (12 步预算)误领重活,裸奔 443 步。修法:同模板按重量分池 —— 重量是签名的一部分,
// heavy 池 founder 起步预算更高,轻活烧不出重活的账。
// 重量判定是启发式(动词+范围词),宁重勿轻:误判 heavy 只多给步数(有硬墙 200 兜底),
// 误判 light 会让个体死在半路(step_budget 突变 +4 也会爬上来,但浪费代际)。

/** heavy 信号:环境级/长时程动词(装系统、全量构建、批量迁移、多轮烧录)。 */
const HEAVY_VERBS = /装|安装|install|部署|deploy|迁移|migrat|烧录|flash|全量|整套|整个|从零|搭建|build.*all|e2e|端到端/i;
/** heavy 信号:多目标并列(≥3 个「和/并/然后/、」连接的动作链)。 */
const CHAIN_RE = /[,,、和并然后].*(装|安装|配|写|跑|测|编译|build|install|run|test)/i;

/** 任务重量:heavy = 需要更多步数的长时程任务(签名的一部分,进池键)。 */
export type TaskWeight = 'heavy' | 'light';

/** prompt → 任务重量(启发式,宁重勿轻)。 */
export function weightOfPrompt(prompt: string): TaskWeight {
  if (HEAVY_VERBS.test(prompt)) return 'heavy';
  if (CHAIN_RE.test(prompt) && prompt.length > 120) return 'heavy';
  return 'light';
}

/** 模板 id + 重量 → 签名。重量不同 = 不同池(基因/账本/化石互相隔离)。 */
export function signatureOfTemplateWeighted(templateId: string, weight: TaskWeight): string {
  return `tpl@v1:${templateId}@${weight}`;
}

/** 从基因上读回签名(显式函数而非裸字段,为 v2 换实现留缝)。 */
export function signatureOfGenome(g: Genome): string {
  return g.signature;
}

/** v2 预留:硬指纹接口。实验期不调用 —— 留在这里是防止将来接口漂移。 */
export type HardFingerprintInput = {
  toolSequence: string[];
  verbSet: string[];
  inputMime: string;
};
