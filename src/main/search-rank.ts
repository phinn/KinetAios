// grep 结果相关性排序 —— 同样的 200 条命中,"哪条最可能是你要找的"决定模型下一步的成败。
//
// 现状问题:按文件遍历顺序截取前 200 条,大仓库里真正的实现常被测试夹具/文档/生成代码挤掉,
// agent 得再搜一轮甚至换关键词。这里加一层零依赖的启发式打分(不引 embedding,成本为零):
//   大小写精确匹配 > 忽略大小写;词边界 > 子串;源码目录 > 测试/文档;短行 > 长行。
// 同文件最多保留 N 条,保证结果覆盖多个文件而不是被一个巨型文件占满。

export interface GrepHit {
  /** 相对路径 */
  file: string;
  line: number;
  /** 命中行原文(已 trim/截断) */
  text: string;
}

const SOURCE_DIR_RE = /(^|\/)(src|lib|app|apps|packages|core|server|client|main|shared|internal)\//i;
const LOW_VALUE_RE = /(^|\/)(__tests__|tests?|spec|fixtures?|mocks?|docs?|examples?|samples?|vendor|third[_-]?party|dist|build|coverage)\//i;
const LOW_VALUE_FILE_RE = /\.(test|spec|stories|fixture)\.|\.(md|mdx|txt|lock)$/i;
const GENERATED_FILE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.(js|css))$/i;

/** 单条命中的相关性分值。pattern 用于对比大小写精确度与词边界。 */
export function scoreGrepHit(hit: GrepHit, pattern: string): number {
  let score = 1;
  const text = hit.text;
  let ci: RegExp | null = null;
  let cs: RegExp | null = null;
  try { ci = new RegExp(pattern, 'i'); cs = new RegExp(pattern); } catch { /* 非法正则由调用方兜底 */ }

  // 大小写精确匹配:模型搜 `runToolBatch` 时,`runtoolbatch` 基本不是目标。
  if (cs?.test(text)) score += 3;
  else if (ci?.test(text)) score += 0;

  // 词边界:命中两侧不是标识符字符 → 更像"这个词本身"而不是某个长标识符的子串。
  if (ci) {
    const m = ci.exec(text);
    if (m && m[0]) {
      const before = m.index > 0 ? text[m.index - 1] : '';
      const after = text[m.index + m[0].length] ?? '';
      const word = /[\w$]/;
      if (!word.test(before) && !word.test(after)) score += 2;
    }
  }

  if (SOURCE_DIR_RE.test(`/${hit.file}`)) score += 2;
  if (LOW_VALUE_RE.test(`/${hit.file}`)) score -= 2;
  if (LOW_VALUE_FILE_RE.test(hit.file)) score -= 2;
  if (GENERATED_FILE_RE.test(hit.file)) score -= 3;
  if (text.length <= 120) score += 1;
  else if (text.length > 180) score -= 1;
  return score;
}

/**
 * 排序 + 去噪:按分数降序,分数相同按路径浅深 / 行号稳定排序;
 * 同一文件最多 perFile 条,总条数 max。返回顺序即展示顺序。
 */
export function rankGrepHits(hits: GrepHit[], pattern: string, opts: { max?: number; perFile?: number } = {}): GrepHit[] {
  const max = Math.max(1, opts.max ?? 200);
  const perFile = Math.max(1, opts.perFile ?? 8);
  const scored = hits.map((h, i) => ({ h, i, score: scoreGrepHit(h, pattern) }));
  scored.sort((a, b) => b.score - a.score || depth(a.h.file) - depth(b.h.file) || a.h.line - b.h.line || a.i - b.i);

  const out: GrepHit[] = [];
  const perFileCount = new Map<string, number>();
  for (const { h } of scored) {
    if (out.length >= max) break;
    const n = perFileCount.get(h.file) ?? 0;
    if (n >= perFile) continue;
    perFileCount.set(h.file, n + 1);
    out.push(h);
  }
  return out;
}

function depth(p: string): number {
  return p.split('/').length;
}
