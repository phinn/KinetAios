// edit_file 的编辑精度内核 —— 空白/缩进归一化的模糊匹配 + 唯一性判定 + 失配候选。
//
// 背景(2026-11 实测):edit_file 失败率 4.4%,几乎全是「未找到要替换的片段」——
// 模型抄原文时缩进少两个空格、行尾空白不同、或者整段多了/少了一层缩进,精确匹配就死了。
// 死掉之后模型往往绕道 write_file 整体覆盖(风险更大)或反复重试(浪费轮次)。
//
// 本模块只做纯文本运算:
// 1. 行级归一化匹配(trim + 折叠行内空白),忽略缩进差异;
// 2. 唯一性判定 —— 模糊匹配到多处且没开 replace_all 时拒绝执行,列出候选行号;
// 3. 替换时把 new_string 重新缩进到实际代码块的缩进;
// 4. 完全失配时给出最接近的 3 个片段(带相似度/行号),让模型直接复制原文重试。
// 不做语法树、不猜语义 —— 宁可不匹配,也不改错位置。

export interface FuzzyEditOk {
  kind: 'ok';
  text: string;
  count: number;
  /** 命中的起始行号(1-based) */
  lines: number[];
  /** 是否应用了缩进重排 */
  reindented: boolean;
}

export interface FuzzyEditAmbiguous {
  kind: 'ambiguous';
  /** 模糊匹配到的起始行号(1-based) */
  lines: number[];
}

export interface EditSuggestion {
  /** 1-based 起始行 */
  line: number;
  /** 0~1 相似度 */
  score: number;
  /** 原文行(含缩进,已截断) */
  lines: string[];
}

export interface FuzzyEditNone {
  kind: 'none';
  suggestions: EditSuggestion[];
}

export type FuzzyEditResult = FuzzyEditOk | FuzzyEditAmbiguous | FuzzyEditNone;

/** 行归一化:去掉首尾空白 + 折叠行内连续空白(只用于比较,不用于写回)。 */
export function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function splitLines(s: string): string[] {
  const lines = s.split('\n');
  // 末行若是空串,说明原串以换行结尾 —— 内容行不包含它(换行留在切片外,替换后自然保留)
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

function lineOffsets(bodyLines: string[]): number[] {
  const offsets = new Array<number>(bodyLines.length);
  let acc = 0;
  for (let i = 0; i < bodyLines.length; i++) {
    offsets[i] = acc;
    acc += bodyLines[i].length + 1; // + '\n'
  }
  return offsets;
}

function firstIndent(lines: string[]): string {
  const hit = lines.find((l) => l.trim());
  return hit ? indentOf(hit) : '';
}

// 供调试/测试观察缩进基准(不参与主流程)
export function blockIndent(lines: string[]): string {
  return firstIndent(lines);
}

/** 把 new_string 套到匹配块的缩进上:逐行用「实际行缩进 - 原文行缩进」的差值重排。 */
function reindent(newS: string, oldLines: string[], bodyLines: string[]): { text: string; changed: boolean } {
  const oldInd = oldLines.map(indentOf);
  const bodyInd = bodyLines.map(indentOf);
  const last = Math.max(0, Math.min(oldLines.length, bodyLines.length) - 2); // 末尾通常是闭括号,不用它做基准
  const out = newS.split('\n').map((line, i) => {
    if (!line.trim()) return '';
    const j = Math.min(i, last);
    const oi = oldInd[j] ?? '';
    const ni = bodyInd[j] ?? '';
    if (oi === ni) return line;
    const stripped = oi && line.startsWith(oi) ? line.slice(oi.length) : line;
    return ni + stripped;
  });
  const text = out.join('\n');
  return { text, changed: text !== newS };
}

/**
 * 模糊替换。调用方应先用精确匹配/CRLF 匹配;都失败后再走这里。
 * - 匹配到 1 处 → 替换并重排缩进
 * - 匹配到多处且 replaceAll=false → 返回 ambiguous(不改)
 * - 0 处 → 返回最近候选
 */
export function fuzzyEdit(body: string, oldS: string, newS: string, replaceAll = false): FuzzyEditResult {
  const bodyLines = body.split('\n');
  const oldLines = splitLines(oldS);
  const n = oldLines.length;
  if (!n || !bodyLines.length) return { kind: 'none', suggestions: suggestSimilar(body, oldS) };

  const normOld = oldLines.map(normalizeLine);
  const normBody = bodyLines.map(normalizeLine);
  const starts: number[] = [];
  for (let i = 0; i + n <= bodyLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normBody[i + j] !== normOld[j]) { ok = false; break; }
    }
    if (ok) starts.push(i);
  }
  if (!starts.length) return { kind: 'none', suggestions: suggestSimilar(body, oldS) };
  if (starts.length > 1 && !replaceAll) {
    return { kind: 'ambiguous', lines: starts.map((i) => i + 1) };
  }

  const offsets = lineOffsets(bodyLines);
  let reindented = false;
  const apply = (i: number): { start: number; end: number; payload: string } => {
    const end = i + n < bodyLines.length ? offsets[i + n] : body.length;
    const r = reindent(newS, oldLines, bodyLines.slice(i, i + n));
    if (r.changed) reindented = true;
    let payload = r.text;
    if (end < body.length && !payload.endsWith('\n')) payload += '\n';
    return { start: offsets[i], end, payload };
  };

  let text = body;
  if (replaceAll) {
    for (let k = starts.length - 1; k >= 0; k--) {
      const { start, end, payload } = apply(starts[k]);
      text = text.slice(0, start) + payload + text.slice(end);
    }
  } else {
    const { start, end, payload } = apply(starts[0]);
    text = text.slice(0, start) + payload + text.slice(end);
  }
  return { kind: 'ok', text, count: starts.length, lines: starts.map((i) => i + 1), reindented };
}

/** 失配时找最接近的片段:滑窗 + 行级相似度(字符 bigram Dice 系数)。 */
export function suggestSimilar(body: string, oldS: string, max = 3): EditSuggestion[] {
  const bodyLines = body.split('\n');
  const oldLines = splitLines(oldS);
  const n = oldLines.length;
  if (!n || !bodyLines.length) return [];
  const normOld = oldLines.map(normalizeLine);

  const candidates: EditSuggestion[] = [];
  let i = 0;
  while (i + n <= bodyLines.length) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += lineSimilarity(normalizeLine(bodyLines[i + j]), normOld[j]);
    const score = sum / n;
    if (score >= 0.45) {
      candidates.push({
        line: i + 1,
        score,
        lines: bodyLines.slice(i, i + Math.min(n, 8)).map((l) => l.slice(0, 160)),
      });
      i += Math.max(1, n); // 跳过已命中的窗口,避免输出 3 个错开一行的近似结果
    } else {
      i++;
    }
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, max);
}

/** 字符 bigram Dice 相似度(对短行比 Levenshtein 便宜,足够排序)。 */
export function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigrams(a);
  const mb = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, ca] of ma) {
    total += ca;
    const cb = mb.get(g) ?? 0;
    inter += Math.min(ca, cb);
  }
  for (const cb of mb.values()) total += cb;
  return total === 0 ? 0 : (2 * inter) / total;
}
