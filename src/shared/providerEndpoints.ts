// Provider 端点映射(纯函数,主进程/渲染端/测试共用)。
// 解决:同一 provider 的 OpenAI 兼容与 Anthropic 兼容 base URL 不同,
// 用户切换协议时 UI 必须同步换 URL,否则请求打到错误端点 404。
// Provider endpoint mapping (pure, shared by main/renderer/tests):
// switching protocol must swap the base URL to the matching endpoint.
// 端点来源(官方文档,2026-11 核对):
// - 智谱开放平台: open.bigmodel.cn/api/paas/v4 (OpenAI) ↔ open.bigmodel.cn/api/anthropic (Claude 兼容)
// - 阿里百炼 Token Plan: token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 (OpenAI)
//                       ↔ token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic (Anthropic)

export const ZHIPU_OPENAI = 'https://open.bigmodel.cn/api/paas/v4';
export const ZHIPU_ANTHROPIC = 'https://open.bigmodel.cn/api/anthropic';
export const ALIYUN_TP_OPENAI = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
export const ALIYUN_TP_ANTHROPIC = 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic';
/** 兼容旧引用(settings.ts 等已用此名) */
export const ALIYUN_TOKEN_PLAN_ANTHROPIC = ALIYUN_TP_ANTHROPIC;
export const ALIYUN_TOKEN_PLAN_OPENAI = ALIYUN_TP_OPENAI;

/**
 * 协议切换时的 base URL 联动:返回新 base URL;无匹配形态返回 null(UI 保持原值不动)。
 * 规则:
 * - 智谱(bigmodel.cn):/api/paas/v4 ↔ /api/anthropic 双向
 * - 阿里 Token Plan(token-plan.*.aliyuncs.com):compatible-mode/v1 ↔ apps/anthropic 双向
 *   ⚠️ 阿里分支必须在智谱判定之后独立匹配(其 anthropic 形态不含 /api/anthropic,天然不冲突)
 * - 其它 provider(DeepSeek/Ollama 等两协议共用同一 URL):返回 null
 */
export function swapBaseUrlForProtocol(currentBase: string, nextProto: 'openai' | 'anthropic'): string | null {
  const cur = currentBase.trim().replace(/\/+$/, '');
  // 智谱双向(host 大小写容忍,路径精确)
  if (/^https:\/\/open\.bigmodel\.cn\/api\/paas\/v4$/i.test(cur)) {
    return nextProto === 'anthropic' ? ZHIPU_ANTHROPIC : null;
  }
  if (/^https:\/\/open\.bigmodel\.cn\/api\/anthropic$/i.test(cur)) {
    return nextProto === 'openai' ? ZHIPU_OPENAI : null;
  }
  // 阿里 Token Plan 双向
  if (/^https:\/\/token-plan\.[a-z0-9.-]+\.aliyuncs\.com\/compatible-mode\/v1$/i.test(cur)) {
    return nextProto === 'anthropic' ? ALIYUN_TP_ANTHROPIC : null;
  }
  if (/^https:\/\/token-plan\.[a-z0-9.-]+\.aliyuncs\.com\/apps\/anthropic$/i.test(cur)) {
    return nextProto === 'openai' ? ALIYUN_TP_OPENAI : null;
  }
  return null;
}

/**
 * 判断 baseURL 是否「与协议错配」(已知 provider 的另一种形态),保存前可用于警示。
 * 例:proto=anthropic 但 URL 是智谱 paas/v4 → 错配。
 * 两协议共用同一 URL 的 provider(DeepSeek 等)不算错配。
 */
export function isProtoBaseMismatch(base: string, proto: 'openai' | 'anthropic'): boolean {
  // 当前 URL 能被「切换到 proto」映射走 ⇔ base 本身是另一协议的专属形态 ⇔ 与 proto 错配
  return swapBaseUrlForProtocol(base, proto) !== null;
}

/**
 * 从 baseURL 推断 provider 类型(纯函数,主进程 system prompt 分流 + 余额路由共用)。
 * Detect provider from baseURL — drives per-provider prompt economics & balance routing.
 * 匹配不到 → 'generic'(无特判,走默认行为)。
 */
export type ProviderKind = 'zhipu' | 'aliyun-token-plan' | 'generic';
export function detectProvider(baseURL: string): ProviderKind {
  const b = (baseURL || '').toLowerCase();
  if (/token-plan\.[a-z0-9.-]+\.aliyuncs\.com/.test(b)) return 'aliyun-token-plan';
  if (/bigmodel\.cn|z\.ai/.test(b)) return 'zhipu';
  return 'generic';
}
