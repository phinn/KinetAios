// V4 Legis — 结果缓存 + 429 退避队列
//
// 两层防浪费(设计文档 §5.2/§5.3):
//   缓存:同会话内同 (tool,args,cwd) 的只读调用按 TTL 命中即复用 ——
//         数据依据:同 turn 21% 完全重复调用(typecheck ×220 / snapshot ×412)。
//   退避:429/限流不再 kill 任务 —— park 节点,60s/180s/600s 指数退避,
//         复用 AgentLoop 的 isTransientError 判定。
// Result cache (TTL, read-only tools, per-conversation) + 429 backoff queue.

import { createHash } from 'crypto';
import type { ToolCtx } from '../tools';
import type { Tool } from '../tools';
import { isTransientError } from '../AgentLoop';

// ────────────────────────────────────────────────────────────────────────
// 结果缓存
// ────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  at: number;
  result: string;
  hits: number;
}

// TTL 分级(毫秒)。写工具不进缓存(见 isCacheable)。
const TTL_MS: Record<string, number> = {
  read_file: 30_000,
  grep: 30_000,
  glob: 30_000,
  web_fetch: 30_000,
  web_search: 30_000,
  recall_memory: 30_000,
  git_diff: 30_000,
  recall_fact: 30_000,
  shell: 60_000,
  browser_navigate: 5_000,
  browser_snapshot: 5_000,
  browser_eval: 5_000,
};

// 缓存按 convId 隔离(跨会话不复用,宁慢勿错 —— 设计文档 §5.3)。
const STORE = new Map<string, Map<string, CacheEntry>>();
// 命中统计(事件流展示,验证 21% 重复的削减效果)
const STATS = new Map<string, { hits: number; savedCalls: number }>();

export function cacheStats(convId: string): { hits: number; savedCalls: number } {
  return STATS.get(convId) ?? { hits: 0, savedCalls: 0 };
}

function cacheKey(tool: string, args: Record<string, unknown>, cwd: string): string {
  const stable = JSON.stringify(args, Object.keys(args).sort());
  return `${tool}:${createHash('sha1').update(`${stable}|${cwd}`).digest('hex').slice(0, 16)}`;
}

function isCacheable(toolName: string, args: Record<string, unknown>): boolean {
  if (!(toolName in TTL_MS)) return false;
  // shell 只缓存"确定性"命令:含 sleep/echo/cat 的不缓存(无意义/脏),
  // npm run typecheck / tsc / ls / git status 类才缓存。
  if (toolName === 'shell') {
    const cmd = String(args.command ?? '');
    if (!cmd.trim()) return false;
    if (/\b(sleep|echo|cat|tail|head|rm|touch)\b/.test(cmd)) return false;
    return true;
  }
  return true;
}

/**
 * 包装一个工具为带缓存的版本(replay 节点用)。
 * 命中 → 直接返回缓存 result(事件流里标注 [cache]);
 * 未命中 → 真跑,可缓存则落缓存。
 */
export function withCache(tool: Tool, convId: string, cwd: string, onNote?: (note: string) => void): Tool {
  const ttl = TTL_MS[tool.name];
  const canCache = tool.name in TTL_MS;
  return {
    ...tool,
    run: async (args, ctx) => {
      const key = cacheKey(tool.name, args, cwd);
      let bucket = STORE.get(convId);
      if (!bucket) { bucket = new Map(); STORE.set(convId, bucket); }
      if (canCache && ttl > 0) {
        const hit = bucket.get(key);
        if (hit && Date.now() - hit.at < ttl) {
          hit.hits += 1;
          const st = STATS.get(convId) ?? { hits: 0, savedCalls: 0 };
          st.hits += 1; st.savedCalls += 1;
          STATS.set(convId, st);
          onNote?.(`[cache ×${hit.hits}] ${tool.name}`);
          return hit.result;
        }
      }
      const result = await tool.run(args, ctx);
      if (isCacheable(tool.name, args) && typeof result === 'string' && result.length <= 20_000) {
        bucket.set(key, { at: Date.now(), result, hits: 0 });
        // 存储卫生:单会话缓存条目上限 500,超限淘汰最旧
        if (bucket.size > 500) {
          const oldest = [...bucket.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) bucket.delete(oldest[0]);
        }
      }
      return result;
    },
  };
}

/** 会话删除时清缓存(TaskManager.releaseConv 调)。 */
export function clearConvCache(convId: string): void {
  STORE.delete(convId);
  STATS.delete(convId);
}

// ────────────────────────────────────────────────────────────────────────
// 429 / 限流退避
// ────────────────────────────────────────────────────────────────────────

// 退避序列:60s / 180s / 600s(上限 10min)。撞顶后任务终态 failed(诚实报错)。
const BACKOFF_MS = [60_000, 180_000, 600_000];

/** 判定错误是否限流/瞬时类(park 而非 fail)。 */
export function isRateLimitOrTransient(e: unknown): boolean {
  return isTransientError(e);
}

/**
 * 可中止的退避等待(429 park 用)。signal abort 立即 resolve(上层走 abort 路径)。
 * attempt 1-based:取 BACKOFF_MS[attempt-1],超序列长度取最后一档。
 */
export function sleepBackoff(attempt: number, signal: AbortSignal): Promise<void> {
  const idx = Math.min(attempt - 1, BACKOFF_MS.length - 1);
  const ms = BACKOFF_MS[Math.max(0, idx)] ?? 60_000;
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** 从错误文本提取 Retry-After 毫秒数(无则 null)。 */
export function retryAfterMs(e: unknown): number | null {
  const text = `${(e as { detail?: string })?.detail ?? ''} ${(e as Error)?.message ?? ''}`;
  const m = text.match(/(?:retry.?after|重试|重置).{0,20}?(\d{2,4})\s*(s|秒)/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n <= 900) return n * 1000;
  }
  return null;
}
