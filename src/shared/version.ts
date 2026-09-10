// ── 版本比较(纯函数,renderer/main 共用,可独立测试)──
// 只认数字段:x.y.z(容忍 v 前缀、两段号、预发布后缀忽略比较主段)。
// compareVersions('3.6.0', '3.5.9') → 1;('v3.6', '3.6.0') → 0(缺省段按 0)。
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** latest 严格大于 current → true(相等不算更新) */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

function parseVersion(v: string): number[] {
  const m = String(v ?? '').trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+){0,3})/);
  if (!m) return [0];
  return m[1].split('.').map((n) => parseInt(n, 10) || 0);
}

// ── 更新检查结果(main → renderer 传输结构)──
export interface UpdateInfo {
  current: string; // 本机版本(app.getVersion)
  latest: string | null; // 远端最新版本号(解析失败/网络失败 = null)
  hasUpdate: boolean; // latest 严格大于 current
  url: string | null; // release 页面(releases/latest 或具体 release html_url)
  notes: string | null; // release notes 预览(截断 ~600 字符)
  checkedAt: number; // 本次结果的时间戳(缓存命中 = 上次真实检查时间)
  fromCache: boolean; // true = 24h 内缓存,未发起网络请求
  error: string | null; // 网络失败原因(已本地化,可直接展示)
}
