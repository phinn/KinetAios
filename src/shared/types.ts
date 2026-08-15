// Shared types + pure state logic. Imported by main (CJS) and renderer (bundled).
// Type-only and pure-function — no Node- or DOM-only APIs in here.
import type { Lang } from './i18n';

// OpenAI chat-message shape (loose — tool_calls / tool_call_id optional). Both
// providers normalize to this so AgentLoop history is protocol-agnostic.
// content 支持 string(纯文本) 或 ContentPart[](多模态:文本+图片)。
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export type ChatMsg = {
  role: string;
  content: string | ContentPart[] | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  [k: string]: unknown; // _memory, _pinned 等标记字段
};

export type APIProtocol = 'openai' | 'anthropic';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
// ponytail: MVP approval is a binary "ask before every shell" toggle. Original has 4 modes
// (never/onFailure/onRequest/untrusted) — none of those need the multi-agent machinery, add when needed.
export type ApprovalPolicy = 'always' | 'never';

// 内置引擎种类。插件引擎(Plugin SDK v3)用 `plugin:<name>` 前缀,不在此穷举。
// Builtin engine kinds. Plugin engines use the `plugin:<name>` prefix (Plugin SDK v3).
export type BuiltinEngineKind = 'direct' | 'directV2' | 'directV3' | 'claudeCode' | 'codex';
export const BUILTIN_ENGINE_KINDS: readonly BuiltinEngineKind[] = ['direct', 'directV2', 'directV3', 'claudeCode', 'codex'];
export type EngineKind = BuiltinEngineKind | `plugin:${string}`;

// 插件引擎 id ↔ 插件名。plugin:foo ↔ foo。 / Plugin engine id ↔ plugin name.
export function pluginEngineName(engine: string): string {
  return engine.startsWith('plugin:') ? engine.slice('plugin:'.length) : engine;
}
export function isPluginEngine(engine: string): engine is `plugin:${string}` {
  return engine.startsWith('plugin:');
}

// 上下文模式 —— 控制工具结果截断策略与上下文预算。以后可扩展更多模式(如 deep-research)。
// Context mode — controls tool result truncation + context budget. Extensible for future modes.
// 注意:ContextMode 是用户级覆盖开关,真正的默认策略来自 ENGINE_POLICIES (按 engine 独立配置)。
// 关系:用户设置 contextMode='hifi' → 对应 engine 策略的 budget/threshold 翻倍;设置 'standard' → 严格按默认策略。
export type ContextMode = 'standard' | 'hifi';
export const CONTEXT_MODES: ContextMode[] = ['standard', 'hifi'];

// 引擎上下文策略包 —— 不同 engine 对上下文的需求完全不同,统一用策略对象描述。
// v1 Direct 是单 ReAct 短对话;v2 DirectV2 是多步累积,plan 上下文必须留住;
// sub-agent 完全独立,只信 prompt 不信 history。
// 一个策略里把所有"上下文相关魔数"集中,改一处生效全部 engine。
export type EngineContextPolicy = {
  /** reactive trim 预算(history 字符总和超过则砍旧消息)。hifi 模式翻倍。 */
  trimBudget: number;
  /** step 间 compact 预算(v2 才用:每步完成后,多步累积的 history 摘要后塞回的字符上限)。 */
  interStepCompactBudget: number;
  /** 工具结果截断阈值(单条 tool 输出的最大字符数)。hifi 模式翻倍。 */
  truncateThreshold: number;
  /** v2 步骤完成时是否往 history 追加"步骤摘要消息"(否则下一步靠 read_file 拿产物)。 */
  appendStepSummary: boolean;
  /** 摘要消息最大保留字数(超过则截短,逼模型用 remember_fact 存关键数据)。 */
  stepSummaryMaxChars: number;
  /** 步骤完整结果的最大保留字数(存 PlanStep.result,不进 prompt 但 Judge/replan 可引用)。0 = 不截断。 */
  stepResultMaxChars: number;
  /** sub-agent 接收 history 的默认范围(给 dispatch_agent 的默认 scope.mode)。 */
  subAgentScope: 'none' | 'last_n_turns' | 'summary_only' | 'full_history';
};

// 插件引擎无静态策略(不进 Direct 家族 history 管理),回落 direct 兜底。
// Plugin engines fall back to the Direct policy — they manage context like a black box.
export const ENGINE_POLICIES: Record<BuiltinEngineKind, EngineContextPolicy> = {
  // v1 Direct:单 ReAct,短对话快响应,默认轻量。
  // interStepCompactBudget: v1 单轮 ReAct 不需要多步累积压缩,但 compactHistory 需要一个显式预算。
  // 设 30K(与旧版 fallback 一致):历史 <30K 直接保留尾部,超出才调 LLM 摘要。
  direct: {
    trimBudget: 15_000,
    interStepCompactBudget: 30_000,
    truncateThreshold: 4000,
    appendStepSummary: false,
    stepSummaryMaxChars: 0,
    stepResultMaxChars: 0,
    subAgentScope: 'none',
  },
  // v2 DirectV2:Plan-Verify 多步累积。这里的值仅作 fallback —— 实际预算由
  // resolveEnginePolicy 根据 v2ModelWindow * v2BudgetRatio 动态计算(见下方)。
  directV2: {
    trimBudget: 80_000,
    interStepCompactBudget: 80_000,
    truncateThreshold: 12_000,
    appendStepSummary: true,
    stepSummaryMaxChars: 800,
    stepResultMaxChars: 6000,
    subAgentScope: 'last_n_turns',
  },
  // v3 DirectV3:自适应流水线。Fast path 轻量(与 v1 类似),Std path 中等,
  // Deep path 大量累积。这里给一个中等偏大的默认值,实际由 path 动态调整。
  directV3: {
    trimBudget: 60_000,
    interStepCompactBudget: 60_000,
    truncateThreshold: 10_000,
    appendStepSummary: true,
    stepSummaryMaxChars: 600,
    stepResultMaxChars: 4000,
    subAgentScope: 'last_n_turns',
  },
  // Claude Code / Codex:外部 CLI 各自管自己的 context,这里只给个保底值(目前未触发)。
  claudeCode: {
    trimBudget: 15_000,
    interStepCompactBudget: 0,
    truncateThreshold: 4000,
    appendStepSummary: false,
    stepSummaryMaxChars: 0,
    stepResultMaxChars: 0,
    subAgentScope: 'none',
  },
  codex: {
    trimBudget: 15_000,
    interStepCompactBudget: 0,
    truncateThreshold: 4000,
    appendStepSummary: false,
    stepSummaryMaxChars: 0,
    stepResultMaxChars: 0,
    subAgentScope: 'none',
  },
};

// v2 动态预算计算:根据用户配置的模型窗口大小和预算比例,算出 trim/compact/truncate 阈值。
// 这样切换模型(GLM-4.6 128K → GLM-5.2 1M)只需改设置,不用改代码。
// 默认:1M 窗口 * 8% = 80K trim/compact 预算,hifi 翻倍到 160K。
export const V2_DEFAULT_MODEL_WINDOW = 1_000_000;
export const V2_DEFAULT_BUDGET_RATIO = 0.08;

export function v2BudgetFromWindow(modelWindow: number, ratio: number): { trim: number; compact: number; truncate: number } {
  const trim = Math.floor(modelWindow * ratio);
  return {
    trim,
    compact: trim,                         // trim 和 compact 保持一致(同一个预算池)
    truncate: Math.floor(trim * 0.15),      // 单条工具结果 = 总预算的 15%
  };
}

/**
 * 把 EngineContextPolicy + ContextMode 合成最终生效的策略。
 * hifi 模式:trimBudget / truncateThreshold 翻倍;appendStepSummary / stepSummaryMaxChars / subAgentScope 不动。
 * 让用户能"加预算"但不破坏 v2 的策略设计。
 *
 * directV2 特殊处理:trim/compact/truncate 由 v2ModelWindow * v2BudgetRatio 动态计算,
 * 覆盖 ENGINE_POLICIES 里的 fallback 值。其他 engine 仍走静态策略。
 */
export function resolveEnginePolicy(
  engine: EngineKind,
  mode: ContextMode | undefined,
  v2ModelWindow?: number,
  v2BudgetRatio?: number,
): EngineContextPolicy {
  // 插件引擎:没有静态策略条目 → 回落 direct 兜底(与 store 读档降级一致)。
  // Plugin engines have no static entry → Direct fallback (same as store load degradation).
  const base = ENGINE_POLICIES[engine as BuiltinEngineKind] || ENGINE_POLICIES.direct;

  // directV2/directV3:动态预算
  if ((engine === 'directV2' || engine === 'directV3') && v2ModelWindow) {
    const ratio = v2BudgetRatio ?? V2_DEFAULT_BUDGET_RATIO;
    const { trim, compact, truncate } = v2BudgetFromWindow(v2ModelWindow, ratio);
    const hifiMul = mode === 'hifi' ? 2 : 1;
    return {
      ...base,
      trimBudget: trim * hifiMul,
      interStepCompactBudget: compact * hifiMul,
      truncateThreshold: truncate * hifiMul,
    };
  }

  // 其他 engine:静态策略 + hifi 翻倍
  if (mode === 'hifi') {
    return {
      ...base,
      trimBudget: base.trimBudget * 2,
      interStepCompactBudget: base.interStepCompactBudget * 2,
      truncateThreshold: base.truncateThreshold * 2,
    };
  }
  return base;
}
// 引擎显示名(内置)。插件引擎的 label 走 engineLabel() 的 plugin: 分支。
// Display names (builtin). Plugin engines label via engineLabel()'s plugin: branch.
export const ENGINE_LABELS: Record<BuiltinEngineKind, string> = {
  direct: 'Kaios (Direct)',
  directV2: 'Kaios v2 (Plan·Verify)',
  directV3: 'Kaios v3 (Adaptive)',
  claudeCode: 'Claude Code',
  codex: 'Codex',
};
// Sandbox controls what spawned CLIs (claude --permission-mode / codex -s) may do.
export type SandboxMode = 'readOnly' | 'workspaceWrite' | 'fullAccess';

// 模型配置档 — 保存完整 LLM 连接信息,聊天界面可快速切换。
// A saved model profile — contains everything needed to connect to an LLM provider.
export type ModelProfile = {
  id: string;
  name: string;           // 显示名 (e.g. "GLM-5.2", "DeepSeek-V3")
  apiKey: string;
  baseURL: string;
  model: string;
  apiProtocol: APIProtocol;
  reasoning: ReasoningEffort;
  priceInPerMTok: number;
  priceOutPerMTok: number;
  createdAt: number;
};

export type AppSettings = {
  apiKey: string;
  baseURL: string;
  model: string;
  apiProtocol: APIProtocol;
  reasoning: ReasoningEffort;
  approval: ApprovalPolicy;
  sandbox: SandboxMode;
  planMode: boolean;
  // Claude Code + Codex shell out to locally-installed CLIs. Off by default — turn on only after
  // installing the CLI, else the engine just errors "找不到 CLI". Direct never needs this.
  enableCliEngines: boolean;
  defaultEngine: EngineKind; // 新会话默认引擎(direct / directV2 / claudeCode / codex)
  subAgentModel: string;    // 子 agent (dispatch_agent) 默认模型(空 = 跟随主 agent 模型)
  priceInPerMTok: number; // USD per 1M tokens; 0 = use built-in default
  priceOutPerMTok: number;
  presetId: string;
  lang: Lang; // UI 语言(en / zh-CN / zh-TW / ja),默认 zh-CN;给模型看的字符串不译
  theme: 'dark' | 'light' | 'aurora' | 'serene' | 'tahoe' | 'sierra' | 'craft' | 'seed'; // 暗 / 淡色 / 极光 / 高雅淡色 / Tahoe 液态玻璃 / Sierra 暖色液态玻璃 / 我的世界像素风 / 高达SEED军事风
  townStyle: 'classic' | 'minecraft'; // 小镇视图风格:经典等距小房子 / 我的世界方块风
  fontScale: number; // 全局字号缩放(%):100 = 默认 13px,112/125/150 放大字号
  appIcon: string;   // 应用图标选择: 'default' | 'bluepurple' | 'k' | 'd1' ...对应 build/icon-*.png
  // ── 模型配置档:保存多套完整 LLM 配置(含 apiKey/baseURL/model/protocol 等),聊天界面可快速切换 ──
  // 当前生效的配置 = 活跃 profile(若有),否则回退到全局 apiKey/baseURL/model 等(向后兼容)。
  modelProfiles: ModelProfile[];
  activeProfileId: string | null; // null = 使用全局默认配置(无 profile)
  // ── Embedding 接口配置(独立于主 LLM 接口)──
  // 默认留空 = 跟随主接口(baseURL/apiKey 复用主 LLM 的),填了则独立走自己的 endpoint。
  embedBaseURL: string;    // '' = 复用主 baseURL
  embedApiKey: string;     // '' = 复用主 apiKey
  embedModel: string;      // 'embedding-3' 等 OpenAI 兼容模型 id
  budget: BudgetAlert;     // 成本预算 / 熔断
  maxTurns: number;        // Direct 引擎单轮对话最大 ReAct 循环数(防 tool_call 死循环;0 = 无限)
  // ── 窗口关闭行为 ── quit = 退出应用(默认);minimize = 最小化到任务栏;tray = 最小化到系统托盘。
  closeBehavior: 'quit' | 'minimize' | 'tray';
  // ── 多机协作:本机 MCP Server 配置(把自己暴露为远程工具节点)──
  // 开启后,局域网内其它机器可通过 SSE transport 连接,调用本机工具(shell / read_file / web_fetch 等)。
  localMcpServer: { enabled: boolean; port: number; token: string };
  // ── 多机协作:远程 MCP Server 列表(把别的 KinetAios 节点当工具用)──
  remoteMcpServers: Array<{ name: string; url: string; token?: string }>;
  // ── 插件管理:被禁用的插件 name 列表(空 = 全部启用) ──
  disabledPlugins: string[];
  // ── 语音实时输入(Web Speech API)── 开启后语音按钮切到实时模式:
  // 说话时实时显示文字(VAD 检测静音后自动发送,无需手动点"发送")。
  // 默认关闭 — 走旧的 MediaRecorder 录音 → 转写 → 填入 composer 模式。
  voiceAutoSend: boolean;
  // ── 任务完成通知 ── 最小化/失焦时任务完成发系统通知 + 任务栏闪烁。
  // 默认关闭(不影响现有用户),稳定后再改默认开。
  notifyOnDone: boolean;
  // ── 高保真模式上下文预算(token)── 控制高保真模式的 reactive trim / compactHistory 预算上限。
  // 默认 200000(GLM-5.2 有 1M 窗口,留余量给 system prompt + 多轮对话)。
  hifiContextBudget: number;
  // ── V2 引擎上下文配置 ── 根据模型窗口大小动态计算 trim/compact 预算。
  // 切换模型时只需改这里,不用改代码。默认适配 GLM-5.2 的 1M 窗口。
  v2ModelWindow: number;     // 模型上下文窗口大小(token)。默认 1000000(GLM-5.2)。GLM-4.6 = 128000。
  v2BudgetRatio: number;     // V2 预算比例(占窗口的百分比,0-1)。默认 0.08(8%)。trim/compact = window * ratio。
  // ── 替身画像(Persona)── 从历史对话中提取的用户做事风格 Markdown 文本。
  // 替身模式开启后注入 Direct 引擎 systemPrompt,让 AI 模仿用户风格自主执行任务。
  // 空字符串 = 未生成,替身功能不可用。
  persona: string;
  // ── 实时语音助手(豆包实时语音大模型)── WebSocket 双向音频流,实时说话→实时回复。
  // 配置火山引擎实时语音 API 凭据和音色。
  voiceChat: VoiceChatConfig;
  // ── MiniMax 文生视频 API Key ── 留空 = 工具调用时提示用户去设置。
  minimaxApiKey: string;
  // ── 企业微信智能机器人 ── WebSocket 长连接模式,接收企信消息并路由到 Agent 引擎处理。
  wecomBot: WeComBotConfig;
  // ── 飞书机器人 ── WebSocket 长连接模式,接收飞书消息并路由到 Agent 引擎处理。
  feishuBot: FeishuBotConfig;
};

/** 企业微信智能机器人配置 / WeCom AI Bot config (WebSocket long-connection mode) */
export type WeComBotConfig = {
  enabled: boolean;       // 是否启用(默认 false)
  botId: string;          // 机器人 ID(企业微信后台获取)
  secret: string;         // 机器人 Secret(企业微信后台获取)
  defaultCwd: string;     // 默认工作目录(空 = 用户主目录)
  engine: EngineKind;     // 处理企信消息使用的引擎(默认 direct)
  model: string;          // 该频道使用的模型(空 = 使用全局默认模型)
  subAgentModel: string;  // 子 agent / dispatch_agent 使用的模型(空 = 跟随主模型)
  streamReply: boolean;   // 是否流式回复(默认 true;false = 等待完整结果再回复)
};

/** 飞书机器人配置 / Feishu Bot config (WebSocket long-connection mode) */
export type FeishuBotConfig = {
  enabled: boolean;       // 是否启用(默认 false)
  appId: string;          // 飞书应用 App ID(开发者后台获取)
  appSecret: string;      // 飞书应用 App Secret(开发者后台获取)
  defaultCwd: string;     // 默认工作目录(空 = 用户主目录)
  engine: EngineKind;     // 处理飞书消息使用的引擎(默认 direct)
  model: string;          // 该频道使用的模型(空 = 使用全局默认模型)
  subAgentModel: string;  // 子 agent / dispatch_agent 使用的模型(空 = 跟随主模型)
  streamReply: boolean;   // 是否流式回复(默认 true;false = 等待完整结果再回复)
};

// 实时语音配置 / Realtime voice chat config (Volcengine / Doubao realtime voice API)
export type VoiceChatConfig = {
  appId: string;        // 火山引擎 AppID
  accessToken: string;  // 火山引擎 Access Token
  wsUrl: string;        // WebSocket 连接地址(含 region 路由),默认走火山引擎官方地址
  voiceType: string;    // 音色 ID(Voice Type),如 'zh_female_wanwanxiaohe_moon_bigtts'
  enable: boolean;      // 是否在聊天界面启用语音入口(关闭 = 只用文字)
  contextHint?: string; // 上下文提示(当前项目名/最近对话摘要),注入 system_role
};

// A discoverable skill from ~/.claude/skills or ~/.codex/skills (SKILL.md frontmatter). The slash
// menu lists these; the Direct engine injects the body when the user invokes /<name>.
export type SkillType = 'skill' | 'command' | 'agent';
export type SkillInfo = {
  name: string;
  description: string;
  source: 'claude' | 'codex' | 'plugin' | 'builtin';
  type: SkillType;
  category?: string; // 自动推断的分类(marketing/dev/design/review/ops/docs/media/other)
};

// Snapshot of endpoint config for one request (mirrors Swift ConfigSnapshot).
export type ConfigSnapshot = {
  baseURL: string;
  model: string;
  apiKey: string; // '' = none
  apiProtocol: APIProtocol;
  reasoning: ReasoningEffort;
};

// Embedding 接口快照 —— embed() 用这个,字段解析优先于主 ConfigSnapshot。
// embedBaseURL / embedApiKey 为空时回退到主接口。model 默认 embedding-3。
export type EmbedSnapshot = {
  baseURL: string;
  apiKey: string;
  model: string;
};

// The unified event model — every engine emits these; the dashboard renders them.
export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; args: string; result: string; durationMs?: number }
  | { type: 'cost'; usd: number; tokens: number; tokensIn?: number; tokensOut?: number }
  | { type: 'status'; text: string }
  | { type: 'sessionStarted'; id: string } // CLI engines (claude/codex) report their session id for --resume
  | { type: 'context'; action: 'compacted' | 'trimmed'; beforeTokens: number; afterTokens: number } // 上下文压缩事件 → renderer 可视化
  | { type: 'done' }
  | { type: 'error'; message: string };

/** 远程 Agent 事件 —— 当本机 MCP Server 被远程调用 run_agent 时,转发到 dashboard UI。 */
export type RemoteAgentEvent =
  | { type: 'start'; prompt: string }
  | { type: 'status'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'token'; text: string }
  | { type: 'cost'; usd: number; tokens: number }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string };

// 实时语音事件(IPC 传输用,音频以 base64 编码)
// Voice chat event for IPC transport (audio as base64 since IPC can't transfer Buffer directly)
export type VoiceChatEventPayload =
  | { type: 'state'; state: 'idle' | 'connecting' | 'connected' | 'speaking' | 'listening' | 'error' }
  | { type: 'userText'; text: string }
  | { type: 'aiText'; text: string }
  | { type: 'aiAudio'; data: string }  // base64 PCM 16kHz 16-bit mono
  | { type: 'aiAudioEnd' }
  | { type: 'error'; message: string }
  | { type: 'ready' };

export type TaskStep = {
  id: string;
  name: string;
  args: string;
  result: string;
  ts: number;
  durationMs?: number; // 工具执行耗时(回放用)
};

export type Turn = {
  id: string;
  prompt: string;
  answer: string;
  steps: TaskStep[];
  error: string | null;
  done: boolean;
  ts: number;
  costUSD: number;
  tokensIn: number;
  tokensOut: number;
  pinned?: boolean; // 用户锁定此 turn → compact 时永远保留(不被摘要压缩)
};

export type ConvStatus = 'ready' | 'running';

// ── AgentTeams:多 agent 团队协作 ──
// 一个 team 挂在主 conv 下,由 N 个 named member agent 组成。
// Member 各自独立 history,串行/并行执行,通过 broadcast / send 通信。
export type MemberStatus = 'idle' | 'running' | 'done' | 'failed';

export type TeamMemberInfo = {
  team_id: string;
  member_id: string;
  name: string;
  role: string;
  status: MemberStatus;
  last_message: string | null;
  last_result: string | null;
  created_at: number;
  updated_at: number;
};

export type TeamInfo = {
  team_id: string;
  conv_id: string;
  member_count: number;
  updated_at: number;
};

// Team 实时事件(独立 IPC 通道 onTeamEvent,不走 AgentEvent)
export type TeamEvent =
  | { type: 'memberStatus'; memberName: string; status: MemberStatus }
  | { type: 'memberToken'; memberName: string; text: string }
  | { type: 'memberTool'; memberName: string; toolName: string; toolResult: string }
  | { type: 'memberCost'; memberName: string; usd: number; tokens: number }
  | { type: 'memberDone'; memberName: string; answer: string };

// ── Pipeline 跨引擎编排 ──
// 一个 pipeline 由多个 stage 组成,每个 stage 指定引擎 + prompt。
// 上一个 stage 的输出自动拼到下一个 stage 的 prompt 前面(链式传递)。
export type PipelineStage = {
  engine: EngineKind;
  prompt: string;
  label?: string; // 可选 stage 名称(显示用)
};

export type Pipeline = {
  id: string;
  name: string;
  stages: PipelineStage[];
  cwd: string;
  createdAt: number;
};

// ── 会话分支 ──
// 从任意历史 turn 分叉出新会话(类似 git branch)。
export type BranchInfo = {
  id: string;
  sourceConvId: string;
  sourceTurnIdx: number; // 从哪个 turn 分叉(0-based)
  createdAt: number;
};

// ── 成本预算 ──
export type BudgetAlert = {
  enabled: boolean;
  perSessionLimit: number; // 单次会话上限(USD),0 = 不限
  dailyLimit: number;      // 日上限(USD),0 = 不限
};

// ── 模板 ──
export type PromptTemplate = {
  id: string;
  name: string;
  description: string;
  engine: EngineKind;
  systemPrompt?: string;
  prompt: string;
  category: string;
  icon: string;
  builtin: boolean;
};

// ── 可视化规则 ──
export type RuleConfig = {
  codeStyle: string;     // 'typescript' | 'python' | 'rust' | ...
  namingConvention: string; // 'camelCase' | 'snake_case' | ...
  commentStyle: 'bilingual' | 'chinese' | 'english' | 'none';
  indent: 'tabs' | '2spaces' | '4spaces';
  bannedApis: string;    // 禁用的 API(逗号分隔)
  extraRules: string;    // 自定义额外规则
};

// ── 自定义工具(用户通过 UI 注册,持久化到 SQLite)──
// name: 工具名(英文+下划线),description: 给模型看的描述,
// parameters: JSON Schema,commandTpl: shell 命令模板(支持 $ARG_<param> 占位)
export type CustomTool = {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  commandTpl: string; // e.g. "echo $ARG_text" — $ARG_<param_name> 替换为实际参数值
  timeoutMs: number;
  createdAt?: number;
};

// ── 记忆时间线 + 衰减 ──
// 每条 memory 带权重(久未引用 → 权重低),recall 时按权重排序。
export type MemoryWithMeta = {
  id: string;
  content: string;
  conversation_id: string | null;
  created_at: number;
  weight: number;    // 衰减权重 0~1,新 fact = 1.0
  lastUsed: number;  // 最后一次被 recall 命中的时间戳
  useCount: number;  // 累计命中次数
  importance: number; // P1: 重要性评分 1-10
};

// P0: Memory Block — 结构化核心记忆(借鉴 Letta Memory Blocks)
export type MemoryBlockData = {
  label: string;
  value: string;
  charLimit: number;
  readOnly: boolean;
  updatedAt: number;
};

// P2: Episodic Memory — 会话摘要
export type EpisodicMemoryData = {
  id: string;
  convId: string | null;
  summary: string;
  importance: number;
  tags: string | null;
  createdAt: number;
};

// ── 会话导出 ──
export type ExportFormat = 'markdown' | 'html' | 'json';

// ── Arena Diff 对比 ──
export type ArenaDiffResult = {
  leftEngine: EngineKind;
  rightEngine: EngineKind;
  leftText: string;
  rightText: string;
  leftConvId: string;
  rightConvId: string;
};

export type Conversation = {
  id: string;
  engine: EngineKind;
  model: string; // Direct 引擎用的模型,每会话独立;claudeCode/codex 由各自 CLI 配置
  profileId?: string | null; // 绑定的模型配置档(切换 profile 时更新;null = 用全局 settings)
  goal?: string | null; // 会话目标(通过 /goal 设置,持续注入 systemPrompt 直到清除)
  contextMode?: ContextMode; // 上下文模式:standard(默认省 token) / hifi(不截断+大预算) / 未来可扩展
  cwd: string;
  createdAt: number;
  updatedAt?: number; // 最后活动时间(saveTurn 时更新),用于侧栏排序和时间显示
  customTitle: string | null;
  directHistory: ChatMsg[]; // Direct-only OpenAI-format, persisted for cross-turn + restart context
  engineSessionId: string | null; // claude/codex session id → --resume next turn (persisted)
  turns: Turn[];
  // 懒加载标记:turns 未加载(head 模式)时消费方需先 hydrate(loadConvTurns)。
  // undefined = 旧路径/新频道,视为已加载(turns 本来就是空的)。
  turnsLoaded?: boolean;
  turnCount?: number; // 频道总轮数(head 模式下侧栏/NEXUS 直接用,不用拉 turns)
  firstPrompt?: string; // 首条 prompt(标题兜底,替代 turns[0]?.prompt)
  status: ConvStatus;
  statusNote: string | null;
  cost: number;
  tokens: number;
  branchInfo?: BranchInfo | null; // 分支来源(null/undefined = 原创会话)
  pipelineId?: string | null; // 如果由 pipeline 创建,记录 pipeline id
  personaEnabled?: boolean; // 替身画像开关(默认 true;false = 本会话不注入 persona)
  /** 跨引擎切换时自动生成的上下文摘要(让新引擎知道之前做了什么)。
   *  首次 run 后消费并清除。null = 无待注入摘要。 */
  crossEngineContext?: string | null;
  /** 企信会话映射 key(格式: `wecom:${userid}`)。
   *  非空 = 该会话由企信机器人创建,用于按用户复用会话避免每条消息新建频道。 */
  wecomKey?: string | null;
  /** 飞书会话映射 key(格式: `feishu:${open_id}`)。
   *  非空 = 该会话由飞书机器人创建,用于按用户复用会话避免每条消息新建频道。 */
  feishuKey?: string | null;
  /** 子 agent (dispatch_agent) 使用的模型覆盖。
   *  来源:频道配置(飞书/企微)或全局设置。空 = 跟随主 agent 模型。 */
  subAgentModel?: string | null;
};

// 一个目录条目(files 窗口的文件树用)。path 是绝对路径(下次 listDir 的入参)。
export type DirEntry = { name: string; path: string; isDir: boolean };

// ── Visual Inspector:圈选标注后从 webview 内收集的元素信息 ──
// 由注入的 inspect 脚本通过 executeJavaScript 返回,用于构建 AI prompt。
export interface ElementInfo {
  tag: string;               // 标签名(div / span / h1 …)
  id: string;                // #id(空则 '')
  className: string;         // .class1.class2(空则 '')
  textPreview: string;       // 元素内可见文本(截断 300 字)
  outerHTML: string;         // 元素 + 子节点的 HTML(截断 2000 字,给 AI 看结构)
  computedStyle: Record<string, string>; // 关键 computed style(color/font-size/width/height/…)
  domPath: string;           // CSS 选择器路径(如 div.card > h3.title)
  rect: { x: number; y: number; w: number; h: number }; // 视口坐标 + 尺寸
}

// Git 快照(状态 + 最近提交),git tab 用。code 是单字符状态码(M/A/D/R/?/…)。
export type GitChange = { path: string; code: string; staged: boolean };
export type GitCommit = { hash: string; author: string; date: string; subject: string };
export type GitSnapshot = {
  ok: boolean;
  branch?: string;
  changes?: GitChange[];
  log?: GitCommit[];
  /** 本地领先远程的 commit 数 */
  ahead?: number;
  /** 本地落后远程的 commit 数 */
  behind?: number;
  /** 上游跟踪分支名 (如 origin/main) */
  upstream?: string;
  /** 远程仓库是否存在 */
  hasRemote?: boolean;
  error?: string;
};
export type GitDiffResult = { ok: boolean; diff?: string; error?: string };

// Git 操作（stage/unstage/commit/pull/push/fetch/stash/branch 等）。
// ponytail: commit message 由 renderer 传入（弹输入框），main 不做 UI。
export type GitActionKind =
  | 'stageAll' | 'unstageAll' | 'stageFile' | 'unstageFile'
  | 'commit' | 'amend' | 'pull' | 'push' | 'fetch'
  | 'stash' | 'stashPop' | 'checkout' | 'discard';

export type GitActionResult = { ok: boolean; message?: string; error?: string };

// The API the preload exposes to the renderer via contextBridge (window.kinet).
export interface KinetAPI {
  getConversations(): Promise<Conversation[]>;
  // 懒加载:按需拉取单个频道的全部 turns(head 模式启动后,切频道时调用)
  getTurns(convId: string): Promise<Turn[]>;
  newConversation(cwd?: string, engine?: EngineKind): Promise<Conversation>;
  send(id: string, text: string): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  deleteConversation(id: string): Promise<boolean>;
  clearConversation(id: string): Promise<boolean>;
  rename(id: string, title: string): Promise<boolean>;
  setCwd(id: string, cwd: string): Promise<boolean>;
  setEngine(id: string, engine: EngineKind): Promise<boolean>;
  setModel(id: string, model: string): Promise<boolean>;
  setSubModel(id: string, model: string): Promise<boolean>;
  /** 切换会话使用的模型配置档(写入 profileId,引擎运行时读取 profile 配置) */
  setConvProfile(id: string, profileId: string | null): Promise<boolean>;
  /** 切换会话的上下文模式(standard / hifi) */
  setContextMode(id: string, mode: ContextMode): Promise<boolean>;
  getSettings(): Promise<AppSettings>;
  saveSettings(s: AppSettings): Promise<boolean>;
  /** 热切换应用图标(立即生效,无需重启) */
  setAppIcon(iconKey: string): Promise<boolean>;
  /** 解析 icon 文件的 file:// URL(供 renderer <img> 使用,兼容打包/开发) */
  resolveIconUrl(file: string): Promise<string>;
  testConnection(s?: AppSettings): Promise<{ ok: boolean; message: string }>;
  /** 列出本地(Ollama 等)已安装的模型 */
  listLocalModels(baseURL?: string): Promise<{ ok: boolean; models: string[]; message: string }>;
  /** 查询智谱 API 账户状态: Coding Plan 用量或钱包余额 */
  getBalance(): Promise<{
    ok: boolean;
    codingPlan?: boolean;
    level?: string;                        // 套餐等级 Lite/Pro/Max
    tiers?: Array<{ window: string; pct: number; reset?: string }>;
    balance?: string;
    left?: string;
    gift?: string;
    message?: string;
  }>;
  listSkills(): Promise<SkillInfo[]>;
  listMcp(): Promise<Array<{ source: string; name: string; tools: string[] }>>;
  // ── 多机协作:本机 MCP Server 启停 + 状态 ──
  startMcpServer(port: number, token: string): Promise<{ ok: boolean; error?: string }>;
  stopMcpServer(): Promise<{ ok: boolean }>;
  mcpServerStatus(): Promise<{ running: boolean; port: number; url: string }>;
  // ── 多机协作:远程节点信息 + 远程任务调用 ──
  listRemoteNodes(): Promise<Array<{ name: string; url?: string; online: boolean; toolCount: number }>>;
  callRemoteAgent(serverName: string, prompt: string): Promise<string>;
  pickDirectory(): Promise<string>;
  readFile(rel: string, cwd: string): Promise<{ ok: boolean; name?: string; content?: string; error?: string }>;
  fileRead(abs: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  fileWrite(abs: string, content: string): Promise<{ ok: boolean; error?: string }>;
  getBrand(): Promise<{ productName: string; homeDir: string; version: string }>;
  quickSubmit(text: string): Promise<string>;
  openDashboard(): Promise<void>;
  openFiles(cwd?: string): Promise<void>;
  openArena(cwd?: string): Promise<void>;
  shellOpen(url: string): Promise<void>;
  listDir(absPath: string): Promise<{ ok: boolean; entries?: DirEntry[]; error?: string }>;
  gitSnapshot(cwd: string): Promise<GitSnapshot>;
  gitDiff(cwd: string, opts: { file?: string; hash?: string; staged?: boolean }): Promise<GitDiffResult>;
  gitAction(cwd: string, action: GitActionKind, opts?: { message?: string; file?: string; branch?: string }): Promise<GitActionResult>;
  readRules(cwd: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  writeRules(cwd: string, content: string): Promise<{ ok: boolean; error?: string }>;
  readContext(cwd: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  writeContext(cwd: string, content: string): Promise<{ ok: boolean; error?: string }>;
  // 长期记忆导入/导出(JSON 文件;main 进程走原生 dialog 选路径)
  memoryExport(): Promise<{ ok: boolean; path?: string; count?: number; error?: string }>;
  memoryImport(): Promise<{ ok: boolean; imported?: number; skipped?: number; error?: string }>;
  // 长期记忆面板:列出 / 编辑 / 删除单条。convId 省略 = 全部。
  memoryList(convId?: string): Promise<{ ok: boolean; items?: Array<{ id: string; content: string; conversation_id: string | null }>; error?: string }>;
  memoryUpdate(id: string, content: string): Promise<{ ok: boolean; error?: string }>;
  memoryDelete(id: string): Promise<{ ok: boolean; error?: string }>;
  // Memory Graph(主谓宾三元组):列出 / 删除。convId 省略 = 全部。
  memoryTriples(convId?: string): Promise<{ ok: boolean; items?: Array<{ id: string; subject: string; predicate: string; object: string; conversation_id: string | null }>; error?: string }>;
  memoryTripleDelete(id: string): Promise<{ ok: boolean; error?: string }>;
  // P0-2:会话级 KV 锚点(renderer debug 面板用)。工具本身直接调 store(),不走 IPC。
  factList(convId: string): Promise<{ ok: boolean; items?: Array<{ key: string; value: string; updated_at: number }>; error?: string }>;
  factDelete(convId: string, key: string): Promise<{ ok: boolean; error?: string }>;
  // 快照面板:列出 / 还原(写入前自动快照的文件原文)。
  snapshotList(cwd: string, convId?: string): Promise<{ ok: boolean; items?: Array<{ id: string; convId: string; absPath: string; tool: string; ts: number }>; error?: string }>;
  snapshotRestore(cwd: string, id: string): Promise<{ ok: boolean; error?: string }>;
  // Plugin SDK v2:<userData>/plugins/* 下的扩展, 贡献 tools / slashCommands / systemPrompt / panel。列出 + 重载 + 安装 + 卸载。
  pluginList(): Promise<{ ok: boolean; items?: Array<{ name: string; version: string; description?: string; author?: string; category: string; icon?: string; permissions: string[]; engines: string[]; toolCount: number; slashCommandCount: number; tools: { name: string; description: string }[]; slashCommands: { name: string; description: string }[]; systemPrompt?: string; hasPanel?: boolean; panelTitle?: string; panelIcon?: string; enabled: boolean; error?: string; dir: string; engine?: { bin: string; label?: string; protocol?: string }; engineError?: string }>; error?: string }>;
  pluginReload(): Promise<{ ok: boolean; count?: number; error?: string }>;
  pluginInstall(sourcePath: string): Promise<{ ok: boolean; name?: string; error?: string }>;
  pluginUninstall(name: string): Promise<{ ok: boolean; error?: string }>;
  // 启用/禁用插件(不删除,只是从工具/prompt/命令注入中排除)。
  pluginToggle(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  // Plugin SDK v2.1: 渲染层扩展 —— 插件声明 panel.html, 返回 HTML 内容供 renderer 注入。
  // Panel 插件获得一个独立的全屏视图 (像 workbench / town 一样), 由插件自己管理 UI。
  pluginPanels(): Promise<{ ok: boolean; items?: Array<{ name: string; title: string; icon?: string; html: string }>; error?: string }>;
  // Cron 定时任务:每分钟 tick,匹配的自动起会话发 prompt。
  cronList(): Promise<{ ok: boolean; items?: Array<{ id: string; cron: string; prompt: string; cwd: string | null; enabled: boolean; lastRun: number | null; createdAt: number }>; error?: string }>;
  cronAdd(t: { id: string; cron: string; prompt: string; cwd?: string }): Promise<{ ok: boolean; error?: string }>;
  cronUpdate(id: string, patch: { cron?: string; prompt?: string; cwd?: string; enabled?: boolean }): Promise<{ ok: boolean; error?: string }>;
  cronDelete(id: string): Promise<{ ok: boolean; error?: string }>;
  cronValidate(expr: string): Promise<{ ok: boolean; error?: string }>;
  // Watch 模式:<cwd>/.kinet-watch.json 配置 glob + prompt,自动触发会话。
  watchList(): Promise<{ ok: boolean; items?: string[]; error?: string }>;
  watchStart(cwd: string): Promise<{ ok: boolean; error?: string }>;
  watchStop(cwd: string): Promise<{ ok: boolean; error?: string }>;
  // ── Pipeline 跨引擎编排 ──
  pipelineRun(p: { name: string; stages: PipelineStage[]; cwd: string }): Promise<{ ok: boolean; convId?: string; error?: string }>;
  pipelineTemplates(): Promise<Pipeline[]>;
  pipelineSave(p: Pipeline): Promise<{ ok: boolean; error?: string }>;
  pipelineDelete(id: string): Promise<{ ok: boolean; error?: string }>;
  // ── 会话分支 ──
  branchFromTurn(convId: string, turnIdx: number): Promise<{ ok: boolean; convId?: string; error?: string }>;
  // ── 成本预算 ──
  getBudget(): Promise<BudgetAlert>;
  saveBudget(b: BudgetAlert): Promise<{ ok: boolean; error?: string }>;
  getCostStats(): Promise<{ today: number; week: number; month: number; byEngine: Record<string, number>; byDay: Array<{ date: string; cost: number }> }>;
  // ── Prompt 模板 ──
  templateList(): Promise<PromptTemplate[]>;
  templateSave(t: PromptTemplate): Promise<{ ok: boolean; error?: string }>;
  templateDelete(id: string): Promise<{ ok: boolean; error?: string }>;
  // ── 可视化规则生成 ──
  rulesGenerate(cfg: RuleConfig): Promise<{ ok: boolean; content?: string; error?: string }>;
  // ── 自定义工具 ──
  customToolList(): Promise<{ ok: boolean; items?: CustomTool[]; error?: string }>;
  customToolSave(t: CustomTool): Promise<{ ok: boolean; error?: string }>;
  customToolDelete(id: string): Promise<{ ok: boolean; error?: string }>;
  // ── 记忆时间线 ──
  memoryTimeline(): Promise<{ ok: boolean; items?: MemoryWithMeta[]; error?: string }>;
  memoryDecay(): Promise<{ ok: boolean; pruned?: number; error?: string }>;
  memoryDedup(): Promise<{ ok: boolean; pruned?: number; error?: string }>;
  // ── P0: Memory Blocks(结构化核心记忆)──
  memoryBlocksList(): Promise<{ ok: boolean; blocks?: MemoryBlockData[]; error?: string }>;
  memoryBlockUpdate(label: string, value: string): Promise<{ ok: boolean; error?: string }>;
  // ── P2: Episodic Memory(会话摘要)──
  episodicMemories(limit?: number): Promise<{ ok: boolean; items?: EpisodicMemoryData[]; error?: string }>;
  // ── P3: Idle Reflection(记忆 GC)──
  memoryReflection(): Promise<{ ok: boolean; result?: { deduped: number; decayed: number; lowImportancePruned: number }; error?: string }>;
  // ── 会话导出 ──
  exportConversation(convId: string, format: ExportFormat): Promise<{ ok: boolean; path?: string; error?: string }>;
  // ── Arena Diff ──
  arenaDiff(leftConvId: string, rightConvId: string): Promise<{ ok: boolean; diff?: string; leftEngine?: string; rightEngine?: string; error?: string }>;
  // ── 上下文压缩可视化 ──
  // 估算指定会话的当前 token 使用量(用校准系数,和 trim/compact 同源)。
  estContextTokens(convId: string): Promise<{ tokens: number; modelMax: number; pct: number }>;
  // 锁定/解锁一个 turn → pinned turn 在 compact 时永远保留(不被摘要压缩)。
  pinTurn(convId: string, turnId: string, pinned: boolean): Promise<{ ok: boolean; error?: string }>;
  // ── 上下文检查器:查看 / 编辑 Direct 引擎的 directHistory(实际发给 LLM 的消息列表)──
  // 获取指定会话的 directHistory(OpenAI ChatMsg[] 格式,含 role/content/tool_calls)。
  getDirectHistory(convId: string): Promise<{ ok: boolean; history?: ChatMsg[]; engine?: EngineKind; tokens?: number; modelMax?: number; error?: string }>;
  // 保存编辑后的 directHistory 回会话(持久化到 DB,下一轮 send 用新的上下文)。
  saveDirectHistory(convId: string, history: ChatMsg[]): Promise<{ ok: boolean; error?: string }>;
  // ── 跨会话引用 + Agent 任务图 ──
  // 任务图:返回所有会话间的 DAG 关系(分支/引用/pipeline)。
  taskGraph(): Promise<{ nodes: Array<{ id: string; engine: string; cwd: string; createdAt: number; customTitle: string | null; turns: number; cost: number }>; edges: Array<{ from: string; to: string; type: string; meta?: Record<string, unknown> }> }>;
  // 搜索会话(按标题/prompt 内容模糊匹配,给 @conv: 引用补全用)。
  searchConversations(query: string): Promise<Array<{ id: string; title: string; engine: string; turns: number; lastActive: number }>>;
  // ── 全局对话搜索(跨所有会话搜内容)──
  searchHistory(query: string): Promise<Array<{ role: string; content: string; convId: string | null; convTitle: string | null }>>;
  // ── 记忆图谱数据(给力导向图渲染,含溯源+冲突)──
  memoryGraphData(): Promise<{
    nodes: Array<{ id: string; label: string; idx: number }>;
    edges: Array<{ source: string; target: string; predicate: string; tripleId: string; convId: string | null; createdAt: number }>;
    triples: Array<{ id: string; subject: string; predicate: string; object: string; convId: string | null; createdAt: number; sourceEngine: string | null; sourcePrompt: string | null }>;
    conflicts: Array<{ subject: string; predicate: string; entries: Array<{ tripleId: string; object: string; convId: string | null; createdAt: number }> }>;
  }>;
  // ── 删除记忆三元组 ──
  deleteMemoryTriple(tripleId: string): Promise<{ ok: boolean }>;
  // ── Arena 深度统计 ──
  arenaStats(): Promise<Array<{ engine: string; sessions: number; totalCost: number; totalTokens: number; totalTools: number; avgCost: number; avgTokens: number; avgTools: number; avgTurnDurationMs: number; costByDay: Array<{ date: string; cost: number }> }>>;
  // ── 记忆图谱窗口 ──
  openMemoryGraph(): Promise<boolean>;
  // ── 远程 Agent 直播状态 ──
  remoteAgentStatus(): Promise<{ active: boolean; events: Array<{ type: string; ts: number; text?: string; name?: string; usd?: number; tokens?: number; message?: string; prompt?: string; summary?: string }>; eventCount: number }>;
  // ── 会话交接(多机协作)──
  exportSessionState(convId: string): Promise<{ ok: boolean; json?: string; error?: string }>;
  importSessionState(sessionJson: string): Promise<{ ok: boolean; convId?: string; error?: string }>;
  // ── 记忆同步(多机共享记忆)──
  syncMemoriesWithRemote(serverName: string): Promise<{ ok: boolean; added?: number; total?: number; error?: string }>;
  // ── 系统级截图(renderer getDisplayMedia → canvas 截帧)──
  captureScreen(): Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
  // ── 语音转写(renderer 录音 → main 调 /audio/transcriptions)──
  transcribeAudio(base64: string, mime: string): Promise<{ ok: boolean; text?: string; error?: string }>;
  // ── 剪贴板(走主进程 clipboard 模块,绕过 contextIsolation 下 navigator.clipboard 失效问题)──
  clipboardWriteText(text: string): Promise<{ ok: boolean; error?: string }>;
  // ── Visual Inspector:向 webview 注入 inspect 脚本,执行后返回元素信息 ──
  // 安全:白名单 action 模式,不接受任意脚本字符串 / Security: whitelist action, no arbitrary script string.
  // renderer 传 webview 的 guestInstanceId + action 名 + 结构化参数 → main 组装脚本 → executeJavaScript。
  webviewInspect(guestInstanceId: number, action: string, params?: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  // ── Visual Inspector:获取 webview 的 guestInstanceId ──
  // webview 嵌在 renderer,但 guestInstanceId 只有通过 Electron webview API 才能拿到。
  // preload 直接暴露无返回值的桥即可,renderer 自己 webview.getGuestInstanceId()。
  // ── 替身画像(Persona)── 分析历史对话生成风格画像 / 读取 / 保存 ──
  /** 分析历史对话 + 记忆,生成用户做事风格画像(markdown) */
  generatePersona(): Promise<{ ok: boolean; persona?: string; stats?: { conversations: number; turns: number; memories: number }; error?: string }>;
  /** 读取已保存的画像(settings.persona 的便捷接口) */
  getPersona(): Promise<{ ok: boolean; persona?: string; error?: string }>;
  /** 保存画像(用户编辑后回写) */
  savePersona(persona: string): Promise<{ ok: boolean; error?: string }>;
  /** 设置会话级替身画像开关 */
  setPersonaEnabled(convId: string, enabled: boolean): Promise<boolean>;
  onAgentEvent(cb: (convId: string, ev: AgentEvent) => void): void;
  onFilesCwd(cb: (cwd: string) => void): void;
  onArenaCwd(cb: (cwd: string) => void): void;
  onConversation(cb: (conv: Conversation) => void): void;
  onConversationRemoved(cb: (convId: string) => void): void;
  onConfirmRequest(cb: (req: { id: string; cmd: string }) => void): void;
  onRemoteAgentEvent(cb: (ev: RemoteAgentEvent) => void): void;
  confirmResponse(id: string, approved: boolean): void;

  // ── 实时语音助手(豆包实时语音大模型)──
  /** 启动语音会话(连接 WebSocket) */
  voiceChatStart(convId: string): Promise<{ ok: boolean; error?: string }>;
  /** 停止语音会话(断开 WebSocket) */
  voiceChatStop(): Promise<{ ok: boolean }>;
  /** 发送麦克风音频(PCM 16kHz 16-bit mono Buffer) */
  voiceChatSendAudio(pcm: ArrayBuffer): Promise<{ ok: boolean }>;
  /** 当前语音状态 */
  voiceChatState(): Promise<{ state: string }>;
  /** 语音事件回调(状态变化/ASR文本/AI文本/AI音频/错误) */
  onVoiceChatEvent(cb: (ev: VoiceChatEventPayload) => void): void;

  // ── AgentTeams:多 agent 团队协作 ──
  /** 列出当前会话下的所有 team */
  listTeams(convId: string): Promise<TeamInfo[]>;
  /** 创建 team(返回 team_id) */
  createTeam(convId: string, members: Array<{ name: string; role: string }>): Promise<{ ok: boolean; team_id?: string; error?: string }>;
  /** 删除 team(含所有 member) */
  deleteTeamById(teamId: string): Promise<boolean>;
  /** 列出 team 下所有 member */
  listTeamMembers(teamId: string): Promise<TeamMemberInfo[]>;
  /** 给单个 member 发消息(手动操控) */
  sendToTeamMember(teamId: string, memberName: string, message: string): Promise<{ ok: boolean; answer?: string; error?: string }>;
  /** 广播给所有 member */
  broadcastToTeam(teamId: string, message: string): Promise<{ ok: boolean; results?: Record<string, string>; error?: string }>;
  /** Team 实时事件流 */
  onTeamEvent(cb: (teamId: string, ev: TeamEvent) => void): void;

  // ── 企业微信智能机器人 ──
  /** 获取企信机器人的运行状态(连接状态、活跃会话数等) */
  wecomBotStatus(): Promise<{ connected: boolean; pendingCount: number }>;
  /** 手动连接企信 WebSocket(settings 变更后调用) */
  wecomBotConnect(): Promise<{ ok: boolean; error?: string }>;
  /** 手动断开企信 WebSocket */
  wecomBotDisconnect(): Promise<{ ok: boolean }>;
  /** 企信事件回调(连接状态变化、消息收发日志) */
  onWeComBotEvent(cb: (ev: { type: string; data?: unknown }) => void): void;

  // ── 飞书机器人 ──
  /** 获取飞书机器人的运行状态 */
  feishuBotStatus(): Promise<{ connected: boolean; pendingCount: number }>;
  /** 手动连接飞书 WebSocket */
  feishuBotConnect(): Promise<{ ok: boolean; error?: string }>;
  /** 手动断开飞书 WebSocket */
  feishuBotDisconnect(): Promise<{ ok: boolean }>;
  /** 飞书事件回调 */
  onFeishuBotEvent(cb: (ev: { type: string; data?: unknown }) => void): void;
}

export function newTurn(prompt: string): Turn {
  return {
    id: rid(),
    prompt,
    answer: '',
    steps: [],
    error: null,
    done: false,
    ts: Date.now(),
    costUSD: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
}

// ponytail: 用 crypto.randomUUID() 如果可用(Node/main 进程),否则回退 Math.random(renderer)。
// shared/types.ts 是纯模块,不能 import node:crypto —— 两边都用,运行时检测。
export function rid(): string {
  try {
    // Node 环境(Electron main)有 globalThis.crypto.randomUUID
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
  } catch { /* fallthrough */ }
  // renderer / 旧环境回退
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Apply one streaming event to a conversation's current (last) turn. Single source of truth —
// main calls it then persists; renderer calls it to update the view. Mirrors Swift apply().
export function applyEvent(conv: Conversation, ev: AgentEvent): void {
  const t = conv.turns[conv.turns.length - 1];
  if (!t) return;
  switch (ev.type) {
    case 'token':
      conv.statusNote = null;
      t.answer += ev.text;
      break;
    case 'tool':
      t.steps.push({ id: rid(), name: ev.name, args: ev.args, result: ev.result, ts: Date.now(), durationMs: ev.durationMs });
      break;
    case 'cost':
      conv.cost += ev.usd;
      conv.tokens += ev.tokens;
      t.costUSD += ev.usd;
      // Prefer the real in/out split carried on the event (Direct + Codex usage path). Engines
      // that only know the sum (Claude, which reports cost but no per-turn tokens) leave both 0.
      if (ev.tokens > 0) {
        t.tokensIn += ev.tokensIn ?? 0;
        t.tokensOut += ev.tokensOut ?? 0;
      }
      break;
    case 'status':
      conv.statusNote = ev.text;
      break;
    case 'context':
      // 压缩事件:在 statusNote 里显示(可视化提示)。UI 可额外渲染进度条。
      conv.statusNote = ev.action === 'compacted'
        ? `已自动压缩 ${ev.beforeTokens} → ${ev.afterTokens} tokens(早期对话摘要)`
        : `上下文过长,已裁剪 ${ev.beforeTokens} → ${ev.afterTokens} tokens`;
      break;
    case 'sessionStarted':
      conv.engineSessionId = ev.id;
      break;
    case 'done':
      conv.statusNote = null;
      t.done = true;
      conv.status = 'ready';
      break;
    case 'error':
      conv.statusNote = null;
      t.error = ev.message;
      t.done = true;
      conv.status = 'ready'; // one failed turn doesn't lock the whole conversation
      break;
  }
}
