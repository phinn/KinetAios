// 窗口标题候选排序:截错窗口的主要成本不是失败,而是"失败后模型再猜一次"。
// 失败时直接给最接近的 3 个标题(按字符 bigram 相似度),让它一次选对。
// 纯函数,便于测试;不依赖 desktopCapturer。
import { lineSimilarity } from './edit-match';

export interface WindowCandidate {
  name: string;
  owner?: string;
  score: number;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s\-_—·|,，。/\\()（）[\]【】"'“”]+/g, ' ').trim();
}

/** 从可截窗口里挑与 query 最接近的几个(标题或宿主应用名都参与比较)。 */
export function rankWindowCandidates(
  query: string,
  windows: Array<{ name: string; owner?: string }>,
  max = 3,
): WindowCandidate[] {
  const q = norm(query);
  if (!q) return [];
  const scored = windows.map((w) => {
    const byTitle = lineSimilarity(q, norm(w.name));
    const byOwner = w.owner ? lineSimilarity(q, norm(w.owner)) * 0.9 : 0; // 宿主名略降权,标题更精确
    return { ...w, score: Math.max(byTitle, byOwner) };
  });
  return scored
    .filter((w) => w.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

/** 渲染成模型可直接照抄的一行(标题 + 宿主)。 */
export function formatWindowCandidates(cands: WindowCandidate[]): string {
  if (!cands.length) return '';
  return cands
    .map((c) => `「${c.name}」${c.owner ? `(${c.owner})` : ''}`)
    .join(' / ');
}
