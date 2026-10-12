// V4 Backoff — 429 限流退避 + 任务 park(而不是 kill)
//
// 数据动机: history.db 里 157 次 429 直接杀死无人值守任务,前面几十美元的执行成本作废。
// V4 的契约: 遇到 429/5xx 瞬态错误 → 任务挂起(park)等待退避窗口,恢复后从 checkpoint 续跑。
// 全局单例 + 信号量: 所有 V4 引擎实例共享一个退避门,避免多会话同时撞击同一个 rate limit。
//
// V4 Backoff — 429/5xx rate-limit backoff with task *park* (not kill).
// Data motive: 157 unattended marathons were killed outright by 429s in history.db.
// Contract: transient errors park the task during the backoff window, then resume
// from the last node checkpoint. A single process-wide gate is shared by all V4
// sessions so concurrent conversations don't hammer the same rate limit.

/** 瞬态错误判定 — 复用 AgentLoop 的语义(429/5xx/网络抖动)。 Transient-error predicate (429/5xx/network). */
import { isTransientError } from '../AgentLoop';

let gate: Promise<void> = Promise.resolve();
let parkedUntil = 0; // epoch ms; 0 = 无 park
let last429 = 0;

export function isParked(): boolean { return Date.now() < parkedUntil; }

/** 等待全局退避门放行。若当前在 park 窗口内则 sleep 到窗口结束。 Waits for the global gate to clear. */
export function waitForGate(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  if (now >= parkedUntil) return Promise.resolve();
  const wait = parkedUntil - now;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { gate = Promise.resolve(); resolve(); }, wait);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

/**
 * 报告一次瞬态错误(429/5xx)。指数退避: 60s → 120s → 240s,上限 5min。
 * Report a transient error. Exponential backoff: 60s → 120s → 240s, capped at 5min.
 */
export function reportTransient(): void {
  const now = Date.now();
  const since = now - last429;
  last429 = now;
  // 上次 429 在 10min 内 → 加倍;否则重置为 60s
  const next = since < 10 * 60 * 1000 ? Math.min((parkedUntil > now ? (parkedUntil - now) * 2 : 60_000), 300_000) : 60_000;
  parkedUntil = now + next;
}

/** 计划中断时主动清门(abort 路径)。 Clears the gate on abort. */
export function clearGate(): void { parkedUntil = 0; }

export function isTransient(e: unknown): boolean { return isTransientError(e); }
