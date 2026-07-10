// Shared types + pure state logic. Imported by main (CJS) and renderer (bundled).
// Type-only and pure-function — no Node- or DOM-only APIs in here.

// OpenAI chat-message shape (loose — tool_calls / tool_call_id optional). Both
// providers normalize to this so AgentLoop history is protocol-agnostic.
export type ChatMsg = {
  role: string;
  content: string | null;
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
};

// A discoverable skill from ~/.claude/skills or ~/.codex/skills (SKILL.md frontmatter). The slash
// menu lists these; the Direct engine injects the body when the user invokes /<name>.
export type SkillInfo = {
  name: string;
  description: string;
  source: 'claude' | 'codex';
};

// Snapshot of endpoint config for one request (mirrors Swift ConfigSnapshot).
export type ConfigSnapshot = {
  baseURL: string;
  model: string;
  apiKey: string; // '' = none
  apiProtocol: APIProtocol;
  reasoning: ReasoningEffort;
};

// The unified event model — every engine emits these; the dashboard renders them.
export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; args: string; result: string }
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
};

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
  quickSubmit(text: string): Promise<string>;
  onAgentEvent(cb: (convId: string, ev: AgentEvent) => void): void;
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
      t.steps.push({ id: rid(), name: ev.name, args: ev.args, result: ev.result, ts: Date.now() });
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
