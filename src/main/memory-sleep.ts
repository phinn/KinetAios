// 记忆睡眠期固化 —— 在应用空闲时跑一轮"睡觉时该做的事":
//   去重(相同/近义事实只留最新) → 衰减(长期不用逐步降权/清除)
//   → 晋升(高价值且反复被 recall 的事实固化进常驻 consolidated 块)
//   → 降权(30 天没人用、importance 仍高的旧事实减一级)
//   → 低价值清理 + 冗余事件清理
//
// 调度:startMemorySleep 注册一个空闲定时器(默认启动后 10 分钟首跑,之后每 6 小时)。
// 每 5 次 done 触发的轻量 GC 也走这里,但受 30 分钟最小间隔节流 ——
// 固化本身不贵,贵的是 dedupMemories 的 O(n²)(见 store 里的事故注释)。
import * as store from './store';

export type SleepReport = {
  ranAt: number;
  deduped: number;
  decayed: number;
  pruned: number;
  promoted: number;
  demoted: number;
  eventsPruned: number;
  /** 没跑的原因(节流/忙/正在跑);有值时其它计数均为 0 */
  skipped?: string;
};

export const MIN_GAP_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_IDLE_MS = 10 * 60_000;
const PROMOTE_MIN_IMPORTANCE = 8;
const PROMOTE_MIN_USES = 3;
const DEMOTE_AFTER_DAYS = 30;
const CONSOLIDATED_BLOCK = 'consolidated';

/** 晋升判据:importance 高 + 被 recall 反复命中。 */
export function shouldPromote(m: { importance: number; useCount: number }): boolean {
  return m.importance >= PROMOTE_MIN_IMPORTANCE && m.useCount >= PROMOTE_MIN_USES;
}

/** 降权判据:存在超过 30 天、从未被召回、importance 仍 > 1。 */
export function shouldDemote(m: { importance: number; useCount: number; ageDays: number }): boolean {
  return m.ageDays >= DEMOTE_AFTER_DAYS && m.useCount === 0 && m.importance > 1;
}

function normFact(s: string): string {
  return s.replace(/^[-•]\s*/, '').replace(/[\s，。；、,.;:：]+/g, '').toLowerCase();
}

/**
 * 把候选事实合进常驻块:逐条去重(整句包含即视为重复),超限从头部整行淘汰、保留最新。
 * 纯函数,便于测试;不读写 DB。
 */
export function mergePromoted(current: string, contents: string[], charLimit: number): { value: string; added: number } {
  const lines = String(current ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const seen = new Set(lines.map(normFact));
  let added = 0;
  for (const raw of contents) {
    const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const key = normFact(t);
    if (!key || seen.has(key)) continue;
    if (lines.some((l) => normFact(l).includes(key) || key.includes(normFact(l)))) continue;
    lines.push(`- ${t}`);
    seen.add(key);
    added++;
  }
  while (lines.length > 1 && lines.join('\n').length > charLimit) lines.shift();
  let value = lines.join('\n');
  if (value.length > charLimit) value = value.slice(-charLimit);
  return { value, added };
}

/** 调度闸:同一轮不能并发;非 force 时忙/间隔不足都跳过。 */
export function canRunSleep(o: {
  lastRunAt: number;
  now: number;
  force?: boolean;
  busy?: boolean;
  running?: boolean;
  minGapMs?: number;
}): { ok: true } | { ok: false; reason: string } {
  if (o.running) return { ok: false, reason: 'already-running' };
  if (!o.force && o.busy) return { ok: false, reason: 'busy' };
  const gap = o.minGapMs ?? MIN_GAP_MS;
  if (!o.force && o.lastRunAt > 0 && o.now - o.lastRunAt < gap) return { ok: false, reason: 'throttled' };
  return { ok: true };
}

let running = false;
let lastRunAt = 0;

/** 跑一轮固化。force=true 绕过"忙/间隔"闸(设置面板的手动整理按钮)。 */
export async function runMemorySleep(opts: { force?: boolean; busy?: boolean } = {}): Promise<SleepReport> {
  const now = Date.now();
  const gate = canRunSleep({ lastRunAt, now, force: opts.force, busy: opts.busy, running });
  if (!gate.ok) {
    return { ranAt: now, deduped: 0, decayed: 0, pruned: 0, promoted: 0, demoted: 0, eventsPruned: 0, skipped: gate.reason };
  }
  running = true;
  try {
    // 顺序有讲究:先清掉重复/垃圾,再晋升 —— 否则会把马上要被 dedup 掉的旧副本固化进常驻块。
    const deduped = await store.dedupMemories(0.65);
    const decayed = store.decayMemories();
    const pruned = store.pruneLowImportanceMemories(2);
    const eventsPruned = store.pruneOldConvEvents();

    let promoted = 0;
    try {
      const cands = store.loadPromotionCandidates(PROMOTE_MIN_IMPORTANCE, PROMOTE_MIN_USES, 20).filter(shouldPromote);
      if (cands.length) {
        store.ensureMemoryBlock(CONSOLIDATED_BLOCK, 1500);
        const block = store.loadMemoryBlock(CONSOLIDATED_BLOCK);
        if (block) {
          const merged = mergePromoted(block.value, cands.map((c) => c.content), block.charLimit);
          if (merged.added > 0) {
            store.updateMemoryBlock(CONSOLIDATED_BLOCK, merged.value);
            promoted = merged.added;
          }
        }
      }
    } catch { /* 固化失败不影响 GC 主流程 */ }

    let demoted = 0;
    try {
      const cutoff = now / 1000 - DEMOTE_AFTER_DAYS * 86_400;
      const ids = store.loadDemotionCandidates(cutoff, 1, 200).map((c) => c.id);
      demoted = store.bumpMemoryImportance(ids, -1);
    } catch { /* 同上 */ }

    lastRunAt = Date.now();
    return { ranAt: lastRunAt, deduped, decayed, pruned, promoted, demoted, eventsPruned };
  } finally {
    running = false;
  }
}

// ── 空闲调度 ────────────────────────────────────────────────
let timer: ReturnType<typeof setTimeout> | null = null;
let busyProbe: (() => boolean) | null = null;
let intervalMs = DEFAULT_INTERVAL_MS;
let reporter: ((r: SleepReport) => void) | null = null;

export function setMemorySleepProbe(fn: (() => boolean) | null): void {
  busyProbe = fn;
}

export function memorySleepStatus(): { lastRunAt: number; intervalMs: number; running: boolean } {
  return { lastRunAt, intervalMs, running };
}

/**
 * 启动空闲固化。busyProbe:是否有 turn 在跑(忙时不跑,避免和对话抢主线程/SQLite)。
 * 定时器 unref:不阻止进程退出;重复 start 会先停旧的。
 */
export function startMemorySleep(opts: {
  busyProbe?: () => boolean;
  idleMs?: number;
  intervalMs?: number;
  onReport?: (r: SleepReport) => void;
} = {}): void {
  stopMemorySleep();
  if (opts.busyProbe) busyProbe = opts.busyProbe;
  if (opts.intervalMs && opts.intervalMs > 0) intervalMs = opts.intervalMs;
  if (opts.onReport) reporter = opts.onReport;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;

  const tick = async (): Promise<void> => {
    try {
      const r = await runMemorySleep({ busy: busyProbe ? busyProbe() : false });
      if (!r.skipped) reporter?.(r);
    } catch { /* 固化失败静默:后台维护不能影响前台 */ }
    timer = setTimeout(() => void tick(), intervalMs);
    (timer as { unref?: () => void }).unref?.();
  };
  timer = setTimeout(() => void tick(), idleMs);
  (timer as { unref?: () => void }).unref?.();
}

export function stopMemorySleep(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
