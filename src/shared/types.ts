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
  [k: string]: unknown;
};

export type APIProtocol = 'openai' | 'anthropic';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
// ponytail: MVP approval is a binary "ask before every shell" toggle. Original has 4 modes
// (never/onFailure/onRequest/untrusted) — none of those need the multi-agent machinery, add when needed.
export type ApprovalPolicy = 'always' | 'never';

export type EngineKind = 'direct' | 'claudeCode' | 'codex';
export const ENGINE_LABELS: Record<EngineKind, string> = {
  direct: 'Kaios (Direct)',
  claudeCode: 'Claude Code',
  codex: 'Codex',
};
// Sandbox controls what spawned CLIs (claude --permission-mode / codex -s) may do.
export type SandboxMode = 'readOnly' | 'workspaceWrite' | 'fullAccess';

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
  priceInPerMTok: number; // USD per 1M tokens; 0 = use built-in default
  priceOutPerMTok: number;
  presetId: string;
  lang: Lang; // UI 语言(en / zh-CN / zh-TW / ja),默认 zh-CN;给模型看的字符串不译
  theme: 'dark' | 'light'; // 暗 / 淡色主题
  // ── Embedding 接口配置(独立于主 LLM 接口)──
  // 默认留空 = 跟随主接口(baseURL/apiKey 复用主 LLM 的),填了则独立走自己的 endpoint。
  embedBaseURL: string;    // '' = 复用主 baseURL
  embedApiKey: string;     // '' = 复用主 apiKey
  embedModel: string;      // 'embedding-3' 等 OpenAI 兼容模型 id
  budget: BudgetAlert;     // 成本预算 / 熔断
};

// A discoverable skill from ~/.claude/skills or ~/.codex/skills (SKILL.md frontmatter). The slash
// menu lists these; the Direct engine injects the body when the user invokes /<name>.
export type SkillType = 'skill' | 'command' | 'agent';
export type SkillInfo = {
  name: string;
  description: string;
  source: 'claude' | 'codex';
  type: SkillType;
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
  | { type: 'done' }
  | { type: 'error'; message: string };

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
};

export type ConvStatus = 'ready' | 'running';

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
  cwd: string;
  createdAt: number;
  customTitle: string | null;
  directHistory: ChatMsg[]; // Direct-only OpenAI-format, persisted for cross-turn + restart context
  engineSessionId: string | null; // claude/codex session id → --resume next turn (persisted)
  turns: Turn[];
  status: ConvStatus;
  statusNote: string | null;
  cost: number;
  tokens: number;
  branchInfo?: BranchInfo | null; // 分支来源(null/undefined = 原创会话)
  pipelineId?: string | null; // 如果由 pipeline 创建,记录 pipeline id
};

// 一个目录条目(files 窗口的文件树用)。path 是绝对路径(下次 listDir 的入参)。
export type DirEntry = { name: string; path: string; isDir: boolean };

// Git 快照(状态 + 最近提交),git tab 用。code 是单字符状态码(M/A/D/R/?/…)。
export type GitChange = { path: string; code: string; staged: boolean };
export type GitCommit = { hash: string; author: string; date: string; subject: string };
export type GitSnapshot = {
  ok: boolean;
  branch?: string;
  changes?: GitChange[];
  log?: GitCommit[];
  error?: string;
};
export type GitDiffResult = { ok: boolean; diff?: string; error?: string };

// The API the preload exposes to the renderer via contextBridge (window.kinet).
export interface KinetAPI {
  getConversations(): Promise<Conversation[]>;
  newConversation(cwd?: string, engine?: EngineKind): Promise<Conversation>;
  send(id: string, text: string): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  deleteConversation(id: string): Promise<boolean>;
  clearConversation(id: string): Promise<boolean>;
  rename(id: string, title: string): Promise<boolean>;
  setCwd(id: string, cwd: string): Promise<boolean>;
  setEngine(id: string, engine: EngineKind): Promise<boolean>;
  setModel(id: string, model: string): Promise<boolean>;
  getSettings(): Promise<AppSettings>;
  saveSettings(s: AppSettings): Promise<boolean>;
  testConnection(s?: AppSettings): Promise<{ ok: boolean; message: string }>;
  listSkills(): Promise<SkillInfo[]>;
  listMcp(): Promise<Array<{ source: string; name: string; tools: string[] }>>;
  pickDirectory(): Promise<string>;
  readFile(rel: string, cwd: string): Promise<{ ok: boolean; name?: string; content?: string; error?: string }>;
  fileRead(abs: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  fileWrite(abs: string, content: string): Promise<{ ok: boolean; error?: string }>;
  getBrand(): Promise<{ productName: string; homeDir: string }>;
  quickSubmit(text: string): Promise<string>;
  openDashboard(): Promise<void>;
  openFiles(cwd?: string): Promise<void>;
  openArena(cwd?: string): Promise<void>;
  shellOpen(url: string): Promise<void>;
  listDir(absPath: string): Promise<{ ok: boolean; entries?: DirEntry[]; error?: string }>;
  gitSnapshot(cwd: string): Promise<GitSnapshot>;
  gitDiff(cwd: string, opts: { file?: string; hash?: string; staged?: boolean }): Promise<GitDiffResult>;
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
  // 快照面板:列出 / 还原(写入前自动快照的文件原文)。
  snapshotList(cwd: string, convId?: string): Promise<{ ok: boolean; items?: Array<{ id: string; convId: string; absPath: string; tool: string; ts: number }>; error?: string }>;
  snapshotRestore(cwd: string, id: string): Promise<{ ok: boolean; error?: string }>;
  // Plugin SDK:<userData>/plugins/* 下的扩展,贡献 Tool[]。列出 + 强制重载。
  pluginList(): Promise<{ ok: boolean; items?: Array<{ name: string; version: string; description?: string; author?: string; toolCount: number; error?: string; dir: string }>; error?: string }>;
  pluginReload(): Promise<{ ok: boolean; count?: number; error?: string }>;
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
  // ── 会话导出 ──
  exportConversation(convId: string, format: ExportFormat): Promise<{ ok: boolean; path?: string; error?: string }>;
  // ── Arena Diff ──
  arenaDiff(leftConvId: string, rightConvId: string): Promise<{ ok: boolean; diff?: string; leftEngine?: string; rightEngine?: string; error?: string }>;
  // ── 系统级截图(renderer getDisplayMedia → canvas 截帧)──
  captureScreen(): Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
  // ── 语音转写(renderer 录音 → main 调 /audio/transcriptions)──
  transcribeAudio(base64: string, mime: string): Promise<{ ok: boolean; text?: string; error?: string }>;
  onAgentEvent(cb: (convId: string, ev: AgentEvent) => void): void;
  onFilesCwd(cb: (cwd: string) => void): void;
  onArenaCwd(cb: (cwd: string) => void): void;
  onConversation(cb: (conv: Conversation) => void): void;
  onConversationRemoved(cb: (convId: string) => void): void;
  onConfirmRequest(cb: (req: { id: string; cmd: string }) => void): void;
  confirmResponse(id: string, approved: boolean): void;
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

// ponytail: Math.random id — step/turn ids only need uniqueness within a session, not crypto.
export function rid(): string {
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
