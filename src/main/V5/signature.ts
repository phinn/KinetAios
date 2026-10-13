// 任务签名(v1 冻结)。
// 实验期策略:任务模板 id 即签名 —— 零抖动、全可复现,这正是杀手实验要的。
// 生产化路径(v2,接口不变):L0 硬指纹(工具序列模式+输入 MIME+动词集合归一化 hash)
//   + L1 冻结 embedding 余弦 >0.82 合并;此处刻意不实现,避免实验期引入语义抖动。
//
// Task signature (frozen v1). During the experiment the task-template id IS the
// signature: zero jitter, fully reproducible. Production L0/L1 hashing lands in v2
// behind this same interface, deliberately deferred to keep the experiment deterministic.

import type { Genome } from './phylum-types';

/** 实验期签名:直接使用任务模板 id(模板注册表保证幂等)。 */
export function signatureOfTemplate(templateId: string): string {
  return `tpl@v1:${templateId}`;
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
