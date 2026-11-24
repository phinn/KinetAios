// 失败归因 —— 把 turn 的失败拆到「谁的锅」上。纯函数,零依赖,好测。
//
// 为什么需要:turn_feedback 只告诉我们「这轮被否了」,不告诉我们为什么被否。
// 没有归因,自进化只能做「整体调参」;有了归因才能定向修:
//   fail:tool:shell   → 工具本身/参数闸有问题
//   fail:plan:max-turns → 规划发散,该收敛预算或改 planner
//   fail:env:transient  → 上游抖动,重试即可,不该记成能力问题
//   fail:context:overflow → 上下文工程问题
//   fail:model:no-tool   → 模型没调工具就交差(能力/提示问题)
//
// 口径约定:
// - 标签统一 `fail:<class>[:<detail>]`,便于报告脚本按前缀聚合。
// - 用户主动停止不是失败(aborted/cancelled)→ 单独 user 类,不计入能力评估。
// - 只输出「可证实」的归因;拿不准就 unknown,不猜。

export type FailureClass = 'tool' | 'plan' | 'env' | 'context' | 'model' | 'user' | 'unknown';

export type AttributionStep = {
  name: string;
  outcome?: 'ok' | 'error' | 'aborted';
  result?: string;
};

export type AttributionInput = {
  /** 引擎给出的失败类型(见 Turn.errorKind) */
  errorKind?: 'maxTurns' | 'transient' | 'contextTooLong' | 'cancelled';
  /** 原始错误文本(用于识别上游/网络类) */
  errorMsg?: string | null;
  /** 本轮的工具步骤 */
  steps?: AttributionStep[];
  /** 用户是否点了停止 */
  aborted?: boolean;
  /** 本轮是否已交付但被用户判为没达标(纠正/重问) */
  unmet?: boolean;
};

export type Attribution = {
  /** 主因(取第一个);null = 没有可归因的失败 */
  primary: FailureClass | null;
  /** 所有命中的类别(可能多个,如 tool + plan) */
  classes: FailureClass[];
  /** 打标用:fail:<class>[:detail] */
  tags: string[];
};

/** 上游/网络类错误特征。这些不是"agent 能力"问题,报告时应单列。 */
const TRANSIENT_RE =
  /(429|rate.?limit|too many requests|5\d\d|service unavailable|bad gateway|gateway timeout|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|连接超时|网络|限流|超时)/i;

/**
 * 鉴权/配置类错误。单独识别的原因:401/403 落在"没有工具调用 + 有错误"的组合里,
 * 会被误判成 model:no-tool,进而错误地调模型/改提示 —— 实际该去查 key 和 baseURL。
 */
const AUTH_RE =
  /(401|403|unauthorized|forbidden|invalid.?api.?key|authentication|not authorized|x-api-key|api key|鉴权|密钥|未授权)/i;

/** 工具连续失败到这个数,就不再是"某个工具坏了",而是规划/重试策略有问题。 */
const TOOL_RETRY_THRESHOLD = 3;

/**
 * 归因一轮的失败。没有失败信号时返回空归因(primary=null, tags=[])。
 * 判定顺序很重要:先排除"不是失败"(用户停止),再区分外部原因,最后才是内部原因。
 */
export function attributeTurnFailure(input: AttributionInput): Attribution {
  const steps = input.steps ?? [];
  const toolErrors = steps.filter((s) => s.outcome === 'error');
  const tags: string[] = [];
  const classes: FailureClass[] = [];

  const push = (cls: FailureClass, detail?: string): void => {
    if (!classes.includes(cls)) classes.push(cls);
    tags.push(detail ? `fail:${cls}:${detail}` : `fail:${cls}`);
  };

  // ① 用户主动停止 —— 不是能力失败,单独归类,且直接结束(其它信号都是它的副产物)。
  if (input.aborted || input.errorKind === 'cancelled') {
    push('user', 'stop');
    return { primary: 'user', classes, tags };
  }

  // ② 上下文溢出:最明确的一类。
  if (input.errorKind === 'contextTooLong') {
    push('context', 'overflow');
    return { primary: 'context', classes, tags };
  }

  // ③ 轮次预算耗尽(规划发散 / 不肯结束)。
  if (input.errorKind === 'maxTurns') {
    push('plan', 'max-turns');
    // 预算耗尽往往伴随大量工具失败,补一条 tool 归因更有诊断价值。
    if (toolErrors.length >= TOOL_RETRY_THRESHOLD) push('tool', 'retry-storm');
    return { primary: 'plan', classes, tags };
  }

  // ④ 鉴权/配置错误:最容易被误判成"模型不行",必须排在模型归因之前。
  const msg = (input.errorMsg ?? '').trim();
  if (msg && AUTH_RE.test(msg)) {
    push('env', 'auth');
    return { primary: 'env', classes, tags };
  }

  // ⑤ 外部抖动(引擎标注 transient 或错误文本命中网络/限流特征)。
  if (input.errorKind === 'transient' || (msg && TRANSIENT_RE.test(msg))) {
    push('env', 'transient');
    return { primary: 'env', classes, tags };
  }

  // ⑥ 工具失败:看最后一个失败的工具是谁;连续失败过多则叠加规划问题。
  if (toolErrors.length) {
    const last = toolErrors[toolErrors.length - 1];
    push('tool', last.name || 'unknown');
    if (toolErrors.length >= TOOL_RETRY_THRESHOLD) push('plan', 'retry-storm');
    return { primary: 'tool', classes, tags };
  }

  // ⑥ 有错误但一个工具都没调 → 模型层(不会用工具 / 直接拒答)。
  if (msg && steps.length === 0) {
    push('model', 'no-tool');
    return { primary: 'model', classes, tags };
  }

  // ⑦ 已交付但被用户判没达标:归不到具体环节,单列 unmet,别硬猜。
  if (input.unmet) {
    push('unknown', 'unmet');
    return { primary: 'unknown', classes, tags };
  }

  // ⑧ 有错误文本、有工具调用,但不匹配任何特征 —— 不猜。
  if (msg) {
    push('unknown');
    return { primary: 'unknown', classes, tags };
  }

  return { primary: null, classes: [], tags: [] };
}
