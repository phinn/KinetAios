// 企业微信 OA 服务端 API 客户端(审批数据) / WeCom OA server API client (approval data).
//
// 与 wecom.ts(智能机器人 WebSocket 消息通道)完全独立的体系:
// 机器人协议只有 botId+secret 的 WS 认证帧,拿不到审批数据;审批在服务端 API 体系,
// 需要 corpid + 自建应用 corpsecret → access_token,且应用要在
// 「管理后台-应用管理-审批-API-审批数据权限」中授权。
// The bot WS protocol cannot reach approval data; the OA server API needs
// corpid + self-built app corpsecret → access_token with approval permission granted.
//
// 接口(2024-07 版):
// - POST /cgi-bin/oa/getapprovalinfo  批量获取审批单号(600/min,时间跨度 ≤31 天,size ≤100)
// - POST /cgi-bin/oa/getapprovaldetail 获取审批申请详情(600/min)
import { getSettings } from './settings';

const BASE = 'https://qyapi.weixin.qq.com';

// ── access_token 缓存:corpsecret 维度(不同应用 secret 各自独立)──
// WeCom access_token 有效 7200s;提前 300s 过期防边界竞态。失败不缓存(下次重取)。
// Token cache keyed by secret; valid 7200s, expire 300s early; failures are not cached.
const tokenCache = new Map<string, { token: string; at: number }>();
const TOKEN_TTL_MS = (7200 - 300) * 1000;

export class WeComOAError extends Error {
  constructor(message: string, readonly errcode: number) {
    super(message);
  }
}

async function request<T>(path: string, body: unknown, secretKey: string): Promise<T> {
  const token = await getAccessToken(secretKey);
  const resp = await fetch(`${BASE}${path}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new WeComOAError(`HTTP ${resp.status}`, -1);
  const j = (await resp.json()) as { errcode?: number; errmsg?: string };
  // token 失效(40014/42001)→ 清缓存重试一次(常见于多实例/后台踢下线)
  if (j.errcode === 40014 || j.errcode === 42001) {
    tokenCache.delete(secretKey);
    const t2 = await getAccessToken(secretKey);
    const r2 = await fetch(`${BASE}${path}?access_token=${encodeURIComponent(t2)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return (await r2.json()) as T;
  }
  if (j.errcode) throw new WeComOAError(j.errmsg || `errcode ${j.errcode}`, j.errcode);
  return j as T;
}

/** 获取 access_token(corpsecret 维度缓存)。secret 未配置时抛错并给后台配置指引。 */
export async function getAccessToken(secretKey: string): Promise<string> {
  const hit = tokenCache.get(secretKey);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;
  const s = getSettings();
  const cfg = (s as { wecomOA?: WeComOAConfig }).wecomOA;
  const corpid = cfg?.corpid?.trim();
  const secret = (secretKey || cfg?.corpsecret || '').trim();
  if (!corpid || !secret) {
    throw new WeComOAError('未配置企业微信 OA 凭证:设置 → 企业微信 OA,填 corpid 和自建应用 corpsecret', 60100);
  }
  const resp = await fetch(`${BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(secret)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new WeComOAError(`gettoken HTTP ${resp.status}`, -1);
  const j = (await resp.json()) as { errcode?: number; errmsg?: string; access_token?: string };
  if (j.errcode || !j.access_token) throw new WeComOAError(j.errmsg || `gettoken errcode ${j.errcode}`, j.errcode ?? -1);
  tokenCache.set(secretKey, { token: j.access_token, at: Date.now() });
  return j.access_token;
}

// ── 类型(getapprovalinfo / getapprovaldetail 文档字段)──
export type WeComOAConfig = {
  corpid: string;     // 企业 ID(我的企业页)
  corpsecret: string; // 自建应用 Secret(需开通审批数据权限)
};

export type ApprovalFilters = {
  template_id?: string;
  creator?: string;    // 申请人 userid
  department?: string; // 部门 id
  sp_status?: number;  // 1 审批中 2 已通过 3 已驳回 4 已撤销 6 通过后撤销 7 已删除 10 已支付
  record_type?: number; // 1 请假 2 补卡 3 出差 4 外出 5 加班 6 调班 7 会议室 8 退款 9 红包报销
};

export type ApprovalSummary = { sp_no: string };

/** 批量获取审批单号。starttime/endtime 秒级时间戳,跨度 ≤31 天,size ≤100。返回单号列表 + 翻页游标。 */
export async function getApprovalInfo(opts: {
  starttime: number;
  endtime: number;
  size?: number;
  cursor?: string;
  filters?: ApprovalFilters[];
}): Promise<{ sp_no_list: string[]; new_next_cursor?: string }> {
  const s = getSettings();
  const secretKey = (s as { wecomOA?: WeComOAConfig }).wecomOA?.corpsecret ?? '';
  const span = opts.endtime - opts.starttime;
  if (span <= 0) throw new WeComOAError('endtime 必须大于 starttime', 301025);
  if (span > 31 * 86400) throw new WeComOAError('时间跨度不能超过 31 天(接口限制),请缩小范围或分段查询', 301112);
  const body: Record<string, unknown> = {
    starttime: String(opts.starttime),
    endtime: String(opts.endtime),
    new_cursor: opts.cursor ?? '',
    size: Math.min(Math.max(opts.size ?? 100, 1), 100),
  };
  if (opts.filters?.length) {
    body.filters = opts.filters.map((f) => {
      const [key, value] = Object.entries(f)[0];
      return { key, value: String(value) };
    });
  }
  const j = await request<{ sp_no_list?: string[]; new_next_cursor?: string }>('/cgi-bin/oa/getapprovalinfo', body, secretKey);
  return { sp_no_list: j.sp_no_list ?? [], new_next_cursor: j.new_next_cursor };
}

/** 获取审批申请详情(原始结构,含 apply_data 控件数组/sp_record 审批流/comments)。 */
export async function getApprovalDetail(spNo: string): Promise<Record<string, unknown>> {
  const s = getSettings();
  const secretKey = (s as { wecomOA?: WeComOAConfig }).wecomOA?.corpsecret ?? '';
  const j = await request<{ info?: Record<string, unknown> }>('/cgi-bin/oa/getapprovaldetail', { sp_no: spNo }, secretKey);
  return j.info ?? {};
}

// ── 面向 agent 的友好化:apply_data 控件数组压成「标题: 值」行 ──
// 控件 value 结构因 control 类型而异;这里覆盖常见类型,其余 JSON 序列化兜底。
// Flatten apply_data contents into "title: value" lines for agent consumption.
export function flattenApplyData(info: Record<string, unknown>): string[] {
  const applyData = info.apply_data as { contents?: Array<Record<string, unknown>> } | undefined;
  const contents = applyData?.contents ?? [];
  const out: string[] = [];
  for (const c of contents) {
    const control = String(c.control ?? '');
    const title = Array.isArray(c.title)
      ? (c.title as Array<{ text?: string; lang?: string }>).find((t) => t.lang === 'zh_CN')?.text
        ?? (c.title as Array<{ text?: string }>)[0]?.text ?? ''
      : '';
    const value = (c.value ?? {}) as Record<string, unknown>;
    let v = '';
    if (typeof value.text === 'string') v = value.text;
    else if (typeof value.new_number === 'number' || typeof value.new_money === 'number') v = String(value.new_number ?? value.new_money);
    else if (Array.isArray(value.members)) v = (value.members as Array<{ userid?: string }>).map((m) => m.userid).filter(Boolean).join(', ');
    else if (Array.isArray(value.departments)) v = (value.departments as Array<{ departmentid?: number }>).map((d) => d.departmentid).filter(Boolean).join(', ');
    else if (control === 'Date' && typeof value.s_time === 'number') v = new Date(value.s_time * 1000).toLocaleString();
    else if (Array.isArray(value.children) && value.children.length) v = `[${(value.children as unknown[]).length} 行明细]`;
    else if (Array.isArray(value.files)) v = (value.files as Array<{ file_name?: string }>).map((f) => f.file_name).filter(Boolean).join(', ');
    else if (typeof value.text === 'undefined' && Object.keys(value).length) v = JSON.stringify(value).slice(0, 120);
    out.push(`${title || control}: ${v || '(空)'}`);
  }
  return out;
}

// ── sp_status 中文映射 ──
export const SP_STATUS_LABEL: Record<number, string> = {
  1: '审批中', 2: '已通过', 3: '已驳回', 4: '已撤销', 6: '通过后撤销', 7: '已删除', 10: '已支付',
};
