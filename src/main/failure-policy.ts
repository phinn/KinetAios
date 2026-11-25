// 失败归因 → 策略闭环。
//
// 归因(turn-attribution)回答「谁的锅」;这里回答「下一轮怎么改」:
//   tool:<x>         → 下一轮注入避坑指令;连续失败则临时停用该工具(冷却)
//   plan:max-turns   → 注入收敛指令(少步计划、限制重复调用)
//   context:overflow → 注入压缩指令(只读片段、结论写文件)
//   env:transient    → 自动重试(有限次、指数退避),不打扰用户
//   env:auth         → 不重试(重试只会再 401),提示去查 key/baseURL
//   model:no-tool    → 要求先用工具取证
//
// 分工:decideFailureResponse 是纯函数(好测);directive / cooldown 的存储是
// 会话级内存状态 —— 只影响下一次 send,不写库(失败策略不该跨重启放大)。
import type { AttributionStep } from './turn-attribution';

export type PolicyInput = {
  /** attributeTurnFailure().tags,形如 fail:tool:shell / fail:env:transient */
  tags: string[];
  steps?: AttributionStep[];
  errorMsg?: string | null;
  /** 本轮之前已自动重试过几次(0 = 还没重试) */
  transientAttempt?: number;
  maxTransientRetries?: number;
};

export type FailureDecision = {
  /** 自动重试(仅 env:transient);delayMs 已含退避 */
  retry: { delayMs: number; attempt: number } | null;
  /** 下一轮开头注入的复盘指令(一次性) */
  directive: string | null;
  /** 临时停用的工具 */
  cooldown: { tool: string; ttlMs: number } | null;
  /** 便于日志/报告的一句话决策 */
  reason: string;
};

const DEFAULT_MAX_RETRY = 2;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 15_000;
const TOOL_COOLDOWN_MS = 10 * 60_000;

function tagDetail(tags: string[], prefix: string): string | null {
  const hit = tags.find((t) => t.startsWith(prefix));
  return hit ? hit.slice(prefix.length) || null : null;
}

/** 纯决策:归因标签 → 下一轮动作。没有可动作的失败时返回全空。 */
export function decideFailureResponse(input: PolicyInput): FailureDecision {
  const tags = input.tags ?? [];
  const maxRetry = input.maxTransientRetries ?? DEFAULT_MAX_RETRY;
  const attempt = input.transientAttempt ?? 0;
  const none: FailureDecision = { retry: null, directive: null, cooldown: null, reason: '无需干预' };

  // ① 上游抖动:自动重试,不写复盘指令(用户不该看到"这是你的错")。
  if (tags.includes('fail:env:transient')) {
    if (attempt < maxRetry) {
      const delayMs = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
      return { retry: { delayMs, attempt: attempt + 1 }, directive: null, cooldown: null, reason: `上游抖动,${Math.round(delayMs / 1000)}s 后自动重试(${attempt + 1}/${maxRetry})` };
    }
    return { retry: null, directive: '[自动复盘] 上游已连续抖动,自动重试已用完。先不要重复大请求;把任务拆小或换模型后再试。', cooldown: null, reason: '重试已达上限' };
  }

  // ② 鉴权/配置:重试无意义,给一条明确的人工动作。
  if (tags.includes('fail:env:auth')) {
    return { retry: null, directive: '[自动复盘] 上一轮鉴权失败(401/403)。这不是任务本身的问题:先检查设置里的 API Key 与 baseURL,修好前不要反复重试同一请求。', cooldown: null, reason: '鉴权失败,需人工处理' };
  }

  // ③ 上下文溢出:下一轮强制压缩工作方式。
  if (tags.includes('fail:context:overflow')) {
    return {
      retry: null,
      directive: '[自动复盘] 上一轮上下文溢出。本轮改成压缩式工作:用 start_line/end_line 只读需要的片段;中间结论写到文件,不要把全文贴回对话。',
      cooldown: null,
      reason: '上下文溢出 → 压缩式工作',
    };
  }

  // ④ 规划发散 / 轮次耗尽:收敛指令;retry-storm 同时停用问题工具。
  if (tags.includes('fail:plan:max-turns') || tags.includes('fail:plan:retry-storm')) {
    const stormTool = tagDetail(tags, 'fail:tool:');
    const cooldown = stormTool && stormTool !== 'retry-storm'
      ? { tool: stormTool, ttlMs: TOOL_COOLDOWN_MS }
      : null;
    const ban = cooldown ? `工具 ${cooldown.tool} 已临时停用 ${TOOL_COOLDOWN_MS / 60_000} 分钟,换等价手段。` : '';
    return {
      retry: null,
      directive: `[自动复盘] 上一轮因发散(轮次/重试耗尽)失败。本轮先给 3 步以内的最小计划,每步做完立刻验证;同一工具同一参数最多试 2 次。${ban}`,
      cooldown,
      reason: cooldown ? `规划发散 + 停用 ${cooldown.tool}` : '规划发散 → 收敛指令',
    };
  }

  // ⑤ 单点工具失败:注入避坑指令,不直接停用(偶发失败很常见)。
  const tool = tagDetail(tags, 'fail:tool:') ?? (tags.includes('fail:tool') ? 'unknown' : null);
  if (tool) {
    return {
      retry: null,
      directive: `[自动复盘] 上一轮工具 ${tool} 失败。本轮不要用相同参数重试:先确认输入(路径/命令/参数),再换参数或换工具。`,
      cooldown: null,
      reason: `工具 ${tool} 失败 → 避坑指令`,
    };
  }

  // ⑥ 一轮下来一个工具都没调(直接拒答/空转)。
  if (tags.includes('fail:model:no-tool')) {
    return {
      retry: null,
      directive: '[自动复盘] 上一轮没有调用任何工具就结束了。本轮必须先取证:读文件/查目录/跑命令拿到事实,再给结论。',
      cooldown: null,
      reason: '未调工具 → 强制取证',
    };
  }

  // user:stop / unknown:unmet 等:不自动应对(用户主动停不是失败;unmet 归因不明)。
  return none;
}

// ── 会话级一次性复盘指令 ──────────────────────────────────
// 只存最新一条:连续几轮失败时,最新一轮的复盘最贴近当前问题。
const directives = new Map<string, string>();

export function pushFailureDirective(convId: string, text: string): void {
  const t = text.trim();
  if (t) directives.set(convId, t);
}

/** 引擎在 turn 开始取走(取走即清除),拼进本轮 userInput。 */
export function pullFailureDirective(convId: string): string | null {
  const t = directives.get(convId);
  if (t === undefined) return null;
  directives.delete(convId);
  return t;
}

// ── 工具冷却 ────────────────────────────────────────────────
const cooldowns = new Map<string, Map<string, number>>(); // convId → tool → untilMs

export function cooldownTool(convId: string, tool: string, ttlMs: number, now = Date.now()): void {
  let m = cooldowns.get(convId);
  if (!m) { m = new Map(); cooldowns.set(convId, m); }
  m.set(tool, now + ttlMs);
}

/** 引擎组工具表时调用:命中的工具本轮不暴露给模型。 */
export function isToolCoolingDown(convId: string, tool: string, now = Date.now()): boolean {
  const m = cooldowns.get(convId);
  if (!m) return false;
  const until = m.get(tool);
  if (until === undefined) return false;
  if (until <= now) { m.delete(tool); return false; }
  return true;
}

/** 会话删除/取消时清理,防 Map 累积。 */
export function clearFailureState(convId: string): void {
  directives.delete(convId);
  cooldowns.delete(convId);
}
