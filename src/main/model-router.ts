// 子任务模型路由 —— 按「能力」而不是「整个会话」绑定模型。
//
// 现状:一个会话绑一个模型,只有 quota/auth 失败才 failover。结果是"规划该用强模型、摘要该用便宜模型、
// 视觉必须多模态"这类常识组合做不到。本模块把能力分成四类:
//   plan      规划 / 拆解      (强推理优先)
//   exec      执行 / 工具循环  (会话主模型,通常保持不变)
//   summarize 上下文压缩摘要   (便宜优先)
//   vision    看图 / 视觉验收  (必须多模态)
//
// 覆盖顺序(后者被前者覆盖):全局默认 → 会话模型 → settings.modelRouting[cap] → 环境变量
//   KINET_MODEL_PLAN / KINET_MODEL_EXEC / KINET_MODEL_SUMMARIZE / KINET_MODEL_VISION
// 每次决策返回 source + reason,可解释;KINET_ROUTE_DEBUG=1 时打印决策日志。
// 规则全部是显式覆盖,不做"猜哪个模型更聪明"的隐式打分 —— 猜错比不猜更贵。
import type { AppSettings, ConfigSnapshot } from '../shared/types';

export type Capability = 'plan' | 'exec' | 'summarize' | 'vision';

export interface RouteDecision {
  capability: Capability;
  model: string;
  /** 目标 profile(跨 provider 路由时使用;缺省 = 会话/profile 默认) */
  profileId?: string;
  source: 'env' | 'settings' | 'conversation' | 'default' | 'unset';
  /** 人话解释:为什么选了这个模型(展示在工具结果/日志里) */
  reason: string;
}

const ENV_KEYS: Record<Capability, string> = {
  plan: 'KINET_MODEL_PLAN',
  exec: 'KINET_MODEL_EXEC',
  summarize: 'KINET_MODEL_SUMMARIZE',
  vision: 'KINET_MODEL_VISION',
};

const CAP_LABELS: Record<Capability, string> = {
  plan: '规划',
  exec: '执行',
  summarize: '摘要',
  vision: '视觉',
};

function clean(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

type ProfileLike = { id: string; name: string };

/**
 * 目标写法:`模型名` 或 `profile名/模型名`(跨 provider)。
 * 只有 profile 前缀能在 settings.modelProfiles 里解析出 id 时才切 profile;
 * 解析不出来就整体当模型名 —— 不静默换到错误的 provider。
 */
function parseTarget(raw: string, profiles: ProfileLike[] | undefined): { model: string; profileId?: string; note?: string } {
  const v = clean(raw);
  if (!v) return { model: '' };
  const slash = v.lastIndexOf('/');
  if (slash > 0 && profiles?.length) {
    const prefix = v.slice(0, slash).trim();
    const model = v.slice(slash + 1).trim();
    const hit = profiles.find((p) => p.id === prefix || p.name === prefix);
    if (hit && model) return { model, profileId: hit.id };
    return { model: v, note: `未找到 profile「${prefix}」,已整串按模型名使用` };
  }
  return { model: v };
}

/**
 * 解析某一能力的模型。纯函数:缺省值由调用方传入,便于测试与解释。
 * model 返回空串 = 没有任何可用配置(调用方保留当前模型)。
 */
export function resolveModelRoute(input: {
  capability: Capability;
  settings?: Pick<AppSettings, 'modelRouting'> & { model?: string; modelProfiles?: ProfileLike[] };
  /** 会话显式选择的模型(conv.model) */
  convModel?: string | null;
  /** 当前生效的默认模型(通常是 profile 的 model) */
  baseModel?: string;
}): RouteDecision {
  const cap = input.capability;
  const profiles = input.settings?.modelProfiles;
  const envKey = ENV_KEYS[cap];
  const fromEnv = parseTarget(process.env[envKey] ?? '', profiles);
  if (fromEnv.model) {
    return { capability: cap, model: fromEnv.model, profileId: fromEnv.profileId, source: 'env', reason: `环境变量 ${envKey} 指定${fromEnv.note ? `(${fromEnv.note})` : ''}` };
  }
  const fromSettings = parseTarget(input.settings?.modelRouting?.[cap] ?? '', profiles);
  if (fromSettings.model) {
    return {
      capability: cap,
      model: fromSettings.model,
      profileId: fromSettings.profileId,
      source: 'settings',
      reason: `设置中配置了${CAP_LABELS[cap]}专用模型${fromSettings.profileId ? '(跨 profile)' : ''}${fromSettings.note ? `(${fromSettings.note})` : ''}`,
    };
  }
  const fromConv = clean(input.convModel);
  if (fromConv) {
    return { capability: cap, model: fromConv, source: 'conversation', reason: '跟随会话所选模型' };
  }
  const fromBase = clean(input.baseModel) || clean(input.settings?.model);
  if (fromBase) {
    return { capability: cap, model: fromBase, source: 'default', reason: '回退全局默认模型' };
  }
  return { capability: cap, model: '', source: 'unset', reason: '没有可用模型配置' };
}

/** 执行阶段快照:只替换 model/profile,其余(协议/密钥/推理档)按目标 profile 重建。 */
export function withExecRoute(base: ConfigSnapshot, convModel?: string | null, convProfileId?: string | null): ConfigSnapshot {
  const { getSettings } = require('./settings') as typeof import('./settings');
  const route = resolveModelRoute({ capability: 'exec', settings: getSettings(), convModel, baseModel: base.model });
  return applyRoute(base, route, convProfileId);
}

/** 规划阶段快照(仅 V2 这类有独立规划轮的引擎用)。 */
export function withPlanRoute(base: ConfigSnapshot, convModel?: string | null, convProfileId?: string | null): ConfigSnapshot {
  const { getSettings } = require('./settings') as typeof import('./settings');
  const route = resolveModelRoute({ capability: 'plan', settings: getSettings(), convModel, baseModel: base.model });
  return applyRoute(base, route, convProfileId);
}

function applyRoute(base: ConfigSnapshot, route: RouteDecision, convProfileId?: string | null): ConfigSnapshot {
  let out = base;
  // 跨 provider:目标 profile 与会话 profile 不同 → 整体换快照(baseURL/密钥/协议都要跟着换)。
  if (route.profileId && route.profileId !== convProfileId) {
    try {
      const { snapshot } = require('./settings') as typeof import('./settings');
      const routed = snapshot(route.profileId);
      if (routed?.model) out = routed;
    } catch { /* profile 解析失败 → 保留原快照 */ }
  }
  const model = route.model || out.model;
  if (process.env.KINET_ROUTE_DEBUG === '1') {
    console.log('[route] capability=%s model=%s profile=%s source=%s reason=%s', route.capability, model, route.profileId ?? '(conv)', route.source, route.reason);
  }
  return model === out.model ? out : { ...out, model };
}
