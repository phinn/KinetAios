// Conversation manager. Port of Swift TaskManager (engine dispatch + persistence + memory).
// Three engines now (Direct / Claude Code / Codex); each implements the Engine interface.
import type { AgentEvent, Conversation, EngineKind } from '../shared/types';
import { applyEvent, newTurn, rid } from '../shared/types';
import * as store from './store';
import { snapshot } from './settings';
import { currentProvider } from './glm';
import { buildEngines, type Engine } from './engines';

export interface TaskManagerEmitter {
  emitEvent(convId: string, ev: AgentEvent): void;
  emitConversation(conv: Conversation): void;
  emitRemoved(convId: string): void;
  confirm(cmd: string): Promise<boolean>;
}

export class TaskManager {
  private convs = new Map<string, Conversation>();
  private order: string[] = []; // newest first
  private aborts = new Map<string, AbortController>();
  private engines: Map<EngineKind, Engine>;

  constructor(private emit: TaskManagerEmitter) {
    this.engines = buildEngines(emit.confirm);
  }

  load(): void {
    for (const c of store.loadConversations()) {
      this.convs.set(c.id, c);
      this.order.push(c.id);
    }
  }

  list(): Conversation[] {
    return this.order.map((id) => this.convs.get(id)!).filter(Boolean);
  }

  get(id: string): Conversation | undefined {
    return this.convs.get(id);
  }

  newConversation(cwd: string, engine: EngineKind = 'direct'): Conversation {
    const conv: Conversation = {
      id: rid(),
      engine,
      cwd,
      createdAt: Date.now(),
      customTitle: null,
      directHistory: [],
      engineSessionId: null,
      turns: [],
      status: 'ready',
      statusNote: null,
      cost: 0,
      tokens: 0,
    };
    store.saveConversation(conv);
    this.convs.set(conv.id, conv);
    this.order.unshift(conv.id);
    this.emit.emitConversation(conv);
    return conv;
  }

  // Switch engine mid-conversation. Clears cross-protocol context (directHistory + CLI session),
  // same as Swift AgentTask.setEngine — a Claude session id is meaningless to Codex, etc.
  setEngine(id: string, engine: EngineKind): void {
    const conv = this.convs.get(id);
    if (!conv || conv.engine === engine) return;
    conv.engine = engine;
    conv.directHistory = [];
    conv.engineSessionId = null;
    store.saveConversation(conv);
    this.emit.emitConversation(conv);
  }

  deleteConversation(id: string): void {
    this.cancel(id);
    store.deleteConversation(id);
    this.convs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.emit.emitRemoved(id);
  }

  clearConversation(id: string): void {
    const conv = this.convs.get(id);
    if (!conv) return;
    conv.turns = [];
    conv.directHistory = [];
    conv.engineSessionId = null;
    conv.cost = 0;
    conv.tokens = 0;
    conv.statusNote = null;
    store.deleteTurns(id);
    store.saveDirectHistory(conv);
    store.updateConversationSession(conv);
    this.emit.emitConversation(conv);
  }

  rename(id: string, title: string): void {
    const conv = this.convs.get(id);
    if (!conv) return;
    conv.customTitle = title.trim() || null;
    store.updateConversationMeta(conv);
    this.emit.emitConversation(conv);
  }

  setCwd(id: string, cwd: string): void {
    const conv = this.convs.get(id);
    if (!conv) return;
    conv.cwd = cwd;
    store.updateConversationCwd(conv);
    this.emit.emitConversation(conv);
  }

  cancel(id: string): void {
    const ac = this.aborts.get(id);
    if (ac) {
      ac.abort();
      this.aborts.delete(id);
    }
    const conv = this.convs.get(id);
    if (conv && conv.status === 'running') {
      const t = conv.turns[conv.turns.length - 1];
      if (t && !t.done) {
        t.done = true;
        if (!t.answer) t.error = '已取消';
        else conv.statusNote = '已停止';
      }
      conv.status = 'ready';
      this.emit.emitConversation(conv);
    }
  }

  async send(id: string, text: string): Promise<void> {
    const conv = this.convs.get(id);
    if (!conv) return;
    const prompt = text.trim();
    if (!prompt || conv.status === 'running') return;

    store.appendMessage('user', prompt);
    conv.turns.push(newTurn(prompt));
    conv.status = 'running';
    conv.statusNote = null;
    this.emit.emitConversation(conv); // renderer sees the new (empty) turn + running state

    const ac = new AbortController();
    this.aborts.set(id, ac);
    const engine = this.engines.get(conv.engine);
    if (!engine) {
      this.applyAndPersist(conv, id, { type: 'error', message: `未知引擎: ${conv.engine}` }, prompt);
      this.aborts.delete(id);
      return;
    }

    await engine.run({
      conv,
      memoryBlock: this.memoryBlock(conv),
      signal: ac.signal,
      onEvent: (ev) => this.applyAndPersist(conv, id, ev, prompt),
    });

    this.aborts.delete(id);
    // Direct keeps cross-turn context in directHistory (updated by the engine); persist it.
    if (conv.engine === 'direct') store.saveDirectHistory(conv);
    this.emit.emitConversation(conv); // final flush
  }

  // Apply event to the live conv, stream to renderer, persist durable state, kick off memory extraction.
  private applyAndPersist(conv: Conversation, id: string, ev: AgentEvent, prompt: string): void {
    applyEvent(conv, ev);
    this.emit.emitEvent(id, ev);
    this.persist(conv, ev);
    const t = conv.turns[conv.turns.length - 1];
    if (ev.type === 'done' && t?.answer) this.extractMemories(t, prompt).catch(() => {});
  }

  private persist(conv: Conversation, ev: AgentEvent): void {
    const t = conv.turns[conv.turns.length - 1];
    if (!t) return;
    switch (ev.type) {
      case 'sessionStarted':
        store.updateConversationSession(conv); // claude/codex session id → next turn --resume
        break;
      case 'tool':
        store.appendMessage('shell', `🔧 ${ev.name}(${ev.args})\n${ev.result}`);
        break;
      case 'cost':
        store.saveTurn(conv.id, t);
        break;
      case 'done':
        if (t.answer) {
          store.appendMessage('assistant', t.answer);
          store.saveTurn(conv.id, t);
        }
        break;
      case 'error':
        store.appendMessage('assistant', `⚠️ ${ev.message}`);
        break;
    }
  }

  // Inject into the system prompt (Direct) / --append-system-prompt (Claude) / prompt prefix (Codex).
  private memoryBlock(conv: Conversation): string {
    let out = '';
    const mems = store.loadMemories().map((m) => m.content);
    if (mems.length) {
      out += '\n\n## 关于用户(长期记忆,回答时参考)\n' + mems.map((m) => `- ${m}`).join('\n');
    }
    if (conv.cwd) out += `\n\n## 当前工作目录\n${conv.cwd}`;
    return out;
  }

  // Best-effort: extract durable facts about the user from a finished turn (uses the Direct provider).
  private async extractMemories(turn: Conversation['turns'][number], prompt: string): Promise<void> {
    if (!turn.answer || turn.answer.length <= 15) return;
    const snap = snapshot();
    const sys = `你是记忆提取器。从下面这轮对话里提取【关于用户本人】的持久事实 —— 身份、职业、偏好、习惯、技术栈、家庭/宠物、所在城市、工具链、长期项目、价值观。
哪怕只透出一点点信号也提取,宁可多提取不要漏。每条 ≤ 18 字,陈述句,主语是「用户」(可省略)。
不提取:本次任务的一次性细节、纯时间敏感(今天/这次)。
只输出 JSON 字符串数组,无持久事实才输出 []。只输出 JSON,不要解释。`;
    const user = `用户: ${prompt}\n\n助手: ${turn.answer.slice(0, 2000)}`;
    try {
      const comp = await currentProvider(snap).streamComplete(
        [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        [],
        snap,
        new AbortController().signal,
        () => {},
      );
      const existing = new Set(store.allMemoryContents());
      for (const f of parseFacts(comp.content)) {
        if (f && !existing.has(f)) store.addMemory(f);
      }
    } catch (e) {
      console.error('[memory] extract failed:', (e as Error)?.message);
    }
  }
}

// Pull a JSON string array out of an LLM response that may have surrounding prose.
function parseFacts(s: string): string[] {
  const lo = s.indexOf('[');
  const hi = s.lastIndexOf(']');
  if (lo < 0 || hi <= lo) return [];
  try {
    const arr = JSON.parse(s.slice(lo, hi + 1)) as unknown[];
    return arr.filter((x): x is string => typeof x === 'string').map((x) => x.trim());
  } catch {
    return [];
  }
}
