// did-you-mean:失败时回吐候选集(平台级能力,2026-11-19)。
// 由来:screenshot_window 的失败里 224/249 是「未找到标题含 X 的窗口」,ocr_image 近7天 26.8%
// 失败几乎全是「文件不存在」—— 两类都不是能力不足,而是**参数指错了对象**:模型在一个它看不见
// 的命名空间里猜名字(窗口标题、文件路径、DOM selector),猜错的代价是整整一轮往返。
//
// 修法统一成一句话:**报错时把候选集一起回吐**。这里只放纯函数(便于测试),各工具自己决定
// 怎么拼进错误消息。顺序原则:先给"最像的",再给"同目录还有谁",最后给一句下一步动作。
// / Report failures with the candidate set attached. The model is guessing names in namespaces it
// cannot see (window titles, file paths, DOM selectors); showing the neighbours turns a failed
// round into a one-shot correction.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 二元组 Dice 相似度:对文件名/短标识符比编辑距离更宽容(顺序敏感、代价低)。 */
export function similarity(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 1;
  if (!x || !y) return 0;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const bx = bigrams(x);
  const by = bigrams(y);
  let inter = 0;
  for (const [g, n] of bx) inter += Math.min(n, by.get(g) ?? 0);
  return (2 * inter) / (x.length - 1 + y.length - 1);
}

/** 从候选里挑最像 wanted 的前 n 个(阈值以上),按相似度降序。 */
export function similarNames(candidates: string[], wanted: string, limit = 5): string[] {
  const w = wanted.trim();
  if (!w) return [];
  return candidates
    .map((c) => ({ c, s: similarity(c, w) }))
    .filter((x) => x.s >= 0.3)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 路径不存在时的候选:① 同目录最像的文件;② 若整个目录都不存在,向上找到最近的已存在祖先,
 * 列出它下面的目录名(常见错法是少/多一层目录);③ 大小写只差的文件。
 */
export function similarPaths(missing: string, limit = 5): { dir: string; names: string[]; note?: string } {
  const abs = path.resolve(missing);
  const base = path.basename(abs);
  let dir = path.dirname(abs);
  let note: string | undefined;

  if (!fs.existsSync(dir)) {
    // 目录不存在:向上找最近的已存在祖先,列出其子目录 —— 提示"你可能漏了/多了一层"
    let anc = dir;
    while (anc !== path.dirname(anc) && !fs.existsSync(anc)) anc = path.dirname(anc);
    const subs = safeReaddir(anc).filter((n) => {
      try { return fs.statSync(path.join(anc, n)).isDirectory(); } catch { return false; }
    });
    const close = similarNames(subs, path.basename(dir), limit);
    return {
      dir: anc,
      names: close.length ? close : subs.slice(0, limit),
      note: `目录 ${dir} 不存在,以下是 ${anc} 下的同级目录`,
    };
  }

  const entries = safeReaddir(dir).filter((n) => !n.startsWith('.'));
  const close = similarNames(entries, base, limit);
  // 大小写/空格差异(同一文件在大小写不敏感的文件系统上会"存在",但模型可能拼了全角/空格)
  const norm = (s: string): string => s.toLowerCase().replace(/[\s_\-.]/g, '');
  const loose = entries.filter((n) => n !== base && norm(n) === norm(base));
  if (loose.length) note = '疑似大小写/分隔符写法不同';

  return { dir, names: [...new Set([...loose, ...close])].slice(0, limit), note };
}

/** 渲染成给模型看的一段建议(空候选返回空串,调用方原样返回原错误)。 */
export function formatPathMiss(missing: string): string {
  const { dir, names, note } = similarPaths(missing);
  if (!names.length) {
    return `\n💡 目标目录 ${dir} 里没有相近的文件。先确认路径(可用 shell: ls "${dir}" 或 glob 在项目里搜文件名)。`;
  }
  return (
    `\n💡 ${note ? `${note}:` : `${dir} 下最接近的是:`}\n` +
    names.map((n) => `   ${path.join(dir, n)}`).join('\n') +
    `\n   → 若其中之一就是你要的,直接用上面的完整路径重试,不要再猜。`
  );
}
