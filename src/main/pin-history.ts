// pinTurn 的消息级映射 —— 纯函数,便于单测。
//
// 2026-09 修复:trimHistoryToTokenBudget / compactHistory 保护的是 ChatMsg 上的 `_pinned` 标记,
// 但全代码库从未有任何代码路径写入过该标记(用户在 UI 锁定 turn 只写了 turn.pinned 元数据),
// "锁定轮不被压缩"整体失效。现在 send 时记录每个 turn 在 directHistory 中的起点(histStart),
// pin/unpin 时按区间 [histStart, 下一 turn.histStart ?? 末尾) 把 turn 级锁定映射到消息级标记。
import type { ChatMsg } from '../shared/types';

export interface PinTarget {
  id: string;
  histStart?: number;
}

export type PinResult = { ok: true } | { ok: false; reason: string };

/**
 * 把 turn 的锁定状态映射到 directHistory 消息的 _pinned 标记。
 * 校验失败时拒绝并给出原因(不假装生效):
 * - 缺 histStart:该轮早于本功能上线,历史区间未知;
 * - 区间越界/为空:引擎异常路径未更新历史,或 turn 与历史已错位;
 * - 区间首条不是 user 消息:历史已被压缩/手工编辑重排,原始区间不复存在。
 */
export function applyPin(hist: ChatMsg[], turns: PinTarget[], turnId: string, pinned: boolean): PinResult {
  const idx = turns.findIndex((t) => t.id === turnId);
  if (idx < 0) return { ok: false, reason: 'turn 不存在' };
  const turn = turns[idx];
  if (turn.histStart == null || turn.histStart < 0 || turn.histStart > hist.length) {
    return { ok: false, reason: '该轮缺少历史区间信息(早于本版本创建),锁定不会影响后续压缩' };
  }
  const next = turns[idx + 1];
  const end = Math.min(next?.histStart ?? hist.length, hist.length);
  if (turn.histStart >= end) return { ok: false, reason: '该轮对应的历史区间为空' };
  const first = hist[turn.histStart] as ChatMsg | undefined;
  const firstText = typeof first?.content === 'string' ? first.content : '';
  // 摘要消息也是 user role:压缩重排后它可能恰好落在区间起点,必须一并排除,
  // 否则会把"摘要 + 后续消息"误当成该轮原始消息锁住。
  if (!first || first.role !== 'user' || firstText.startsWith('[早期对话摘要]')) {
    return { ok: false, reason: '历史已被压缩或手工编辑重排,无法定位该轮原始消息;请解除后重新锁定' };
  }
  for (let i = turn.histStart; i < end; i++) {
    const m = hist[i] as ChatMsg & { _pinned?: boolean };
    if (pinned) m._pinned = true;
    else delete m._pinned;
  }
  return { ok: true };
}
