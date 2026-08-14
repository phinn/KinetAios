// V3 Router — 零 LLM 调用的任务分类器
//
// 用启发式规则(关键词 / 消息长度 / 文件路径数 / 历史轮次)判断任务复杂度,
// 路由到三条执行路径之一:
//
//   fast — 单步可完成(读文件、查文档、grep、简单问答)→ 单轮 ReAct,零开销
//   std  — 多轮工具调用,但不需要全局规划(修 bug、写功能)→ Streaming ReAct
//   deep — 跨多文件重构、架构级变更 → DAG Plan + 并行执行 + Verify Gate
//
// 设计原则:宁可走 std 也不要误判为 fast(fast 没有重试机制);
// 宁可走 std 也不要误判为 deep(deep 有额外规划开销)。

import type { ChatMsg } from '../../shared/types';

export type RoutePath = 'fast' | 'std' | 'deep';

// deep 信号:这些关键词/模式几乎总是需要多步规划
const DEEP_SIGNALS = [
  '重构', 'refactor', '迁移', 'migrate', '架构', 'architect',
  '全部替换', '批量修改', '全量', 'complete rewrite',
  '从零', 'from scratch', '搭建', 'scaffold',
];

// fast 信号:这些模式几乎总是单步可完成
const FAST_SIGNALS = [
  '什么是', '解释一下', '解释', '说明', '说说',
  '读取', '查看', '看看', '打开',
  '搜索', 'grep', '查找', 'find', 'search',
  '总结', '摘要', 'translate', '翻译',
];

// L2-fix: 多步任务信号 — 出现这些词说明任务需要多轮工具/多文件关联,
// 即使命中 fast 信号也不能进 fast path(maxTurns=5 会截断)。
// 典型误吞场景:"读取 A.xlsx 和 B.xlsx 然后交叉分析" → 命中"读取"被路由到 fast。
const MULTI_STEP_SIGNALS = [
  '交叉分析', '关联分析', '对比分析', '分析一下', '统计分析',
  '数据透视', '汇总统计', '批量处理', '交叉', '关联',
  '合并', 'merge', 'join', '然后', '再', '接着', '之后',
  '全部', '所有', '多个', '各自', '分别',
];

// 写操作信号:即使看起来简单,也需要 std(因为有副作用,需要更多上下文)
const WRITE_SIGNALS = [
  '写入', '创建', '修改', '更新', '删除', '安装',
  'write', 'create', 'update', 'delete', 'install',
  '编辑', '替换', '重构',
];

/**
 * 分类任务,返回执行路径。
 * 不调 LLM,纯规则匹配,耗时 <1ms。
 */
export function routeTask(
  input: string,
  history: ChatMsg[],
  opts?: { fileCount?: number; hasGoal?: boolean },
): RoutePath {
  const text = input.trim();
  const lower = text.toLowerCase();

  // ── 信号收集 ──
  const fileCount = opts?.fileCount ?? countFilePaths(text);
  const userTurnCount = history.filter((m) => m.role === 'user').length;

  const hasDeepSignal = DEEP_SIGNALS.some((s) => lower.includes(s.toLowerCase()));
  const hasFastSignal = FAST_SIGNALS.some((s) => text.includes(s));
  const hasWriteSignal = WRITE_SIGNALS.some((s) => lower.includes(s.toLowerCase()));
  // L2-fix: 多步信号压制 fast(交叉分析/合并/批量等任务 5 轮跑不完)
  const hasMultiStepSignal = MULTI_STEP_SIGNALS.some((s) => text.includes(s));

  // ── Deep path 判定(高阈值,避免误判)──
  // 条件 1: 明确的 deep 关键词 + 多文件路径
  if (hasDeepSignal && fileCount >= 2) return 'deep';
  // 条件 2: 3+ 文件路径(几乎总是需要跨文件协调)
  if (fileCount >= 3) return 'deep';
  // 条件 3: goal 模式 + 长文本(goal 模式通常需要多步完成)
  if (opts?.hasGoal && text.length > 500) return 'deep';

  // ── Fast path 判定(保守,优先级低于 deep)──
  // 条件 1: fast 信号 + 短文本 + 无写操作 + 无多文件
  // L2-fix: 多步信号(交叉分析/合并/批量…)压制 fast — "读取A和B然后交叉分析"不能进 5 轮上限的 fast
  if (hasFastSignal && text.length < 300 && !hasWriteSignal && !hasMultiStepSignal && fileCount <= 1) {
    return 'fast';
  }
  // 条件 2: 纯问答(无任何工具信号) + 短文本
  if (!hasWriteSignal && !hasMultiStepSignal && fileCount === 0 && text.length < 150 && isQuestion(text)) {
    return 'fast';
  }

  // ── 默认:Standard path ──
  return 'std';
}

/** 从文本中检测文件路径数量(如 /path/to/file.ts 或 ./src/index.ts) */
function countFilePaths(text: string): number {
  // 匹配 /path/to/file.ext 或 ./relative/path.ext 或 src/file.ext
  const matches = text.match(/(?:\.?\/[\w./-]+\.[a-zA-Z]{1,5})|(?:src\/[\w./-]+)/g);
  return matches ? new Set(matches).size : 0;
}

/** 判断是否是纯问句 */
function isQuestion(text: string): boolean {
  return text.endsWith('?') || text.endsWith('？') ||
    /^(什么|怎么|为什么|哪里|哪个|是否|能不能|可以|如何|为何)/.test(text);
}
