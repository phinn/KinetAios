// 检索式记忆召回 —— 全局(recallForInjection)与会话限制(recallForInjectionSession)的统一实现。
//
// 2026-09 修复:会话限制模式(跨项目记忆关闭,即默认)原先只要库里有 embedding 就直接
// `listMemoryEmbeddings(convId).slice(0, N)` 返回 —— 不计算与 query 的相似度、SQL 无 ORDER BY
// (按 rowid 即最旧优先)。注入的"检索式记忆"与当前对话完全无关,且与全局路径行为不一致。
// 现在两种模式走同一条链,只差 restrictConvId:
//   1. embedding cosine 召回 top-30(宽召回)
//   2. scoredMemories 加权重排(importance/recency/relevance,池子按会话限制过滤)
//   3. FTS/LIKE 关键词兜底 → 4. recent-N 兜底
import * as store from './store';

export type RecalledMemory = {
  id: string;
  content: string;
  conversationId: string | null;
  /** 语义相关性(0-1);非 embedding 路径为 0。 */
  score: number;
};

/** embedding 可注入:生产传 glm.embed 包装,测试传 fake。 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export async function recallMemories(opts: {
  query: string;
  limit: number;
  /** undefined = 全局;传入 = 只召回该会话产生的记忆 + 无归属的全局记忆。 */
  restrictConvId?: string;
  embed: EmbedFn;
}): Promise<RecalledMemory[]> {
  const { query, limit, restrictConvId, embed } = opts;

  if (query) {
    // 1. embedding cosine 召回(有 embedding 且 query 非空时)
    try {
      const embedRows = store.listMemoryEmbeddings(restrictConvId);
      if (embedRows.length) {
        const qVecArr = await embed([query]);
        if (qVecArr[0]?.length) {
          const qVec = new Float32Array(qVecArr[0]);
          // 宽召回 top-30(score>0.2),修前会话模式完全没有这一步
          const candidates = embedRows
            .map((r) => ({ memoryId: r.memoryId, content: r.content, conversationId: r.conversationId, score: store.cosine(qVec, r.vec) }))
            .filter((r) => r.score > 0.2)
            .sort((a, b) => b.score - a.score)
            .slice(0, 30);
          if (candidates.length >= 3) {
            // 加权重排:relevance 按 memoryId 精确关联(修前按 content 关联,重复文本互相污染)
            const relevanceById = new Map(candidates.map((c) => [c.memoryId, c.score]));
            const scored = store.scoredMemories(
              query,
              limit,
              (_content, id) => relevanceById.get(id) ?? 0,
              restrictConvId,
            );
            if (scored.length >= 3) {
              for (const s of scored) {
                try { store.touchMemoryUsed(s.id); } catch { /* non-blocking */ }
              }
              return scored.map(({ id, content, conversation_id, score }) => ({ id, content, conversationId: conversation_id, score }));
            }
            // 重排结果不足 → 直接用原始 embedding 排序
            for (const s of candidates.slice(0, limit)) {
              try { store.touchMemoryUsed(s.memoryId); } catch { /* non-blocking */ }
            }
            return candidates.slice(0, limit).map(({ memoryId: id, content, conversationId, score }) => ({ id, content, conversationId, score }));
          }
        }
      }
    } catch {
      /* embedding 失败 → FTS 兜底 */
    }

    // 2. FTS/LIKE 关键词兜底(≥2 条命中才算有效召回)
    try {
      const ftsHits = store.searchMemories(query, limit, restrictConvId);
      if (ftsHits.length >= 2) {
        return ftsHits.map(({ id, content, conversation_id }) => ({ id, content, conversationId: conversation_id, score: 0 }));
      }
    } catch {
      /* → recent-N 兜底 */
    }
  }

  // 3. recent-N 兜底:restrict 时仍含无归属全局记忆(会话内无历史时冷启动需要基本上下文)。
  const rows = restrictConvId
    ? store.loadMemories().filter((m) => m.conversation_id === null || m.conversation_id === restrictConvId)
    : store.loadMemories();
  return rows
    .slice(0, limit)
    .map(({ id, content, conversation_id }) => ({ id, content, conversationId: conversation_id, score: 0 }));
}
