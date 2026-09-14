// ── Coding Plan 5h 用量窗口查询(TaskManager 主动 failover 用)──
// 智谱 Coding Plan 的订阅制 5 小时用量窗口:走 settings.balanceSnapshot 已有的
// quota 端点(GET {host}/api/monitor/usage/quota/limit,Auth 裸 token),
// limits[] 里 unit=3 是 5h 窗口,percentage 即用满百分比。
// 之前只有「报 quota 错才切」的被动 failover;这里补「窗口用满提前切」的主动路径 ——
// 等错误发生再切会浪费一轮失败重试,过夜任务尤其亏。
// Query a profile's Coding-Plan 5h usage percentage (null = 不支持/查询失败)。
// 结果缓存 60s,避免 goal 循环每轮都打 quota 端点。
import { balanceSnapshot } from './settings';

const cache = new Map<string, { at: number; pct: number | null }>();
const CACHE_MS = 60_000;

export async function codingPlan5hPct(profileId: string | null | undefined): Promise<number | null> {
  const key = profileId ?? '__global__';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.pct;
  const pct = await queryOnce(profileId ?? null);
  cache.set(key, { at: Date.now(), pct });
  return pct;
}

async function queryOnce(profileId: string | null): Promise<number | null> {
  const bal = balanceSnapshot(profileId);
  if (bal.provider !== 'zhipu-coding-plan' || !bal.url || !bal.apiKey) return null;
  try {
    const resp = await fetch(bal.url, {
      method: 'GET',
      headers: { Authorization: bal.apiKey, 'Content-Type': 'application/json', 'Accept-Language': 'en-US,en' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const j = (await resp.json()) as { data?: { limits?: Array<{ type?: string; unit?: number; percentage?: number }> } };
    const limits = j?.data?.limits;
    if (!Array.isArray(limits)) return null;
    for (const item of limits) {
      if (!String(item?.type || '').toUpperCase().includes('TOKENS_LIMIT')) continue;
      if (item?.unit === 3) {
        const pct = Number(item?.percentage);
        return Number.isFinite(pct) ? pct : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
