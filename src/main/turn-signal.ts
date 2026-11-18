// 隐式反馈信号判定(2026-11-18)。从「用户下一轮怎么说话」里读出上一轮好不好。
//
// 为什么单独成文件:这两个判定是 turn_feedback 账本的唯一输入源,而账本是技能淘汰 /
// 基因选择的样本来源 —— 判错了会一路错到"删掉有用的技能"。抽出来才能单测钉死阈值,
// 也避免和 TaskManager 那个大类的其它逻辑纠缠。
//
// 零依赖(不 import store/electron),纯函数,好测。

/** 用户「带着不满回来」的话术特征。
 *  规则 strike(detectCorrectionAndStrike)与 turn 定级(gradeLastTurn)共用这一份 ——
 *  各写一份必然漂移(历史上就是内联字面量)。
 *  2026-11-18 补:`还是不行/还是不对/还是没好/还是没对/又错` —— 写单测时才发现原正则
 *  只认「还是错/还是报」,而"还是不行"才是最常说的那句,等于漏掉大半返工信号。
 *  刻意不收录光秃秃的「不对」「错了」:它们在高频正常对话里太容易误伤(如"这个字段不对齐")。 */
export const CORRECTION_RE =
  /你还|你又|我说过|说了多少遍|还是错|还是报|还是不行|还是不对|还是没好|还是没对|不是让你|别再|怎么又|为啥又|又错|又犯|又忘|不遵守|没遵守/;

/** 新 prompt 是不是把上一轮的问题又问了一遍(= 上一轮等于白干)。
 *  二元组 Jaccard:去空白标点后比较,阈值 0.72 且两边长度都 ≥8。
 *  「继续」「再试一次」「好的」这类短承接词不算重问 —— 那是延续,不是返工;
 *  长度门槛就是为了挡住它们(8 个字符以下基本是语气词)。 */
export function isReask(next: string, prev?: string): boolean {
  if (!prev) return false;
  const norm = (s: string): string => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const a = norm(prev);
  const b = norm(next);
  if (a.length < 8 || b.length < 8) return false;
  if (a === b) return true;
  const grams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const g of gb) if (ga.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  return union > 0 && inter / union >= 0.72;
}
