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

// 窗口状态(占比 + 距重置分钟):给 dashboard 窗口消耗视图直接展示。
// 只在 provider 是 zhipu-coding-plan 时有值;其余 provider 返回 null = 视图显示"不适用"。
// Window state (used % + minutes to reset) for the dashboard window view; null = N/A.
export async function quotaWindowState(): Promise<{ usedPct: number | null; minsLeft: number | null }> {
  // unit=3 是 5h 窗口,period 初值拿不到具体起点 —— 用"上次 percentage 变化的时刻"近似:
  // 简化口径:窗口起点 = 当前时间对齐到 5h 网格的起点。智谱窗口是滚动 5h(从首查起算),
  // 精确重置时刻只有服务端知道;这里用网格起点估算剩余时间,误差最多一个 5h 周期。
  // Simplification: align to the 5h wall-clock grid for minutesLeft (rolling window true
  // reset time is server-side only); display as estimate.
  const pct = await codingPlan5hPct(null);
  // 网格近似:5h 窗口起点按 wall-clock 对齐(0/5/10/15/20 点),剩余分钟 = 5h - 窗口内已过分钟。
  // Rolling window 的精确重置时刻只有服务端知道,此处为估算,误差最多一个周期。
  // Grid approximation: window starts at 0/5/10/15/20h wall-clock; minutesLeft = 5h - elapsed.
  const now = new Date();
  const hourInWindow = (now.getHours() % 5) * 60 + now.getMinutes();
  const minsLeft = 5 * 60 - hourInWindow;
  return { usedPct: pct, minsLeft: pct === null ? null : minsLeft };
}
