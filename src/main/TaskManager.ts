// Conversation manager. Port of Swift TaskManager (engine dispatch + persistence + memory).
// Three engines now (Direct / Claude Code / Codex); each implements the Engine interface.
import fs from 'node:fs';
import type { AgentEvent, Conversation, EngineKind } from '../shared/types';
import { applyEvent, newTurn, rid } from '../shared/types';
import * as store from './store';
import { getSettings, snapshot } from './settings';
import { t } from '../shared/i18n';
import { currentProvider, embed } from './glm';
import { buildEngines, type Engine, loadRulesBlock, loadContextBlock } from './engines';
import { loadSkillBody } from './skills';

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
      model: getSettings().model,
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
    if (isCliEngine(engine) && !getSettings().enableCliEngines) return; // toggle off → refuse
    conv.engine = engine;
    conv.directHistory = [];
    conv.engineSessionId = null;
    store.saveConversation(conv);
    this.emit.emitConversation(conv);
  }

  // Direct engine model is per-conversation — multi-session can each use a different model.
  setModel(id: string, model: string): void {
    const conv = this.convs.get(id);
    if (!conv) return;
    conv.model = model.trim();
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
      const turn = conv.turns[conv.turns.length - 1];
      if (turn && !turn.done) {
        turn.done = true;
        const lang = getSettings().lang;
        if (!turn.answer) turn.error = t(lang, 'tmgr.cancelled');
        else conv.statusNote = t(lang, 'tmgr.stopped');
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

    // Validate cwd up front — a bad path makes the spawn ENOENT and the CLI engines only surface
    // an opaque "未返回结果". Fail fast with a clear message instead.
    if (!isUsableCwd(conv.cwd)) {
      conv.turns.push(newTurn(prompt));
      const turn = conv.turns[conv.turns.length - 1];
      turn.error = t(getSettings().lang, 'tmgr.badCwd', { cwd: conv.cwd || '(空)' });
      turn.done = true;
      store.appendMessage('user', prompt);
      store.saveTurn(conv.id, turn);
      this.emit.emitConversation(conv);
      return;
    }

    // CLI engines need the toggle on (and the CLI installed). Guard here so a stale renderer
    // dropdown can't dispatch into a disabled engine.
    if (isCliEngine(conv.engine) && !getSettings().enableCliEngines) {
      this.failTurn(conv, prompt, t(getSettings().lang, 'tmgr.engineDisabled'));
      return;
    }

    store.appendMessage('user', prompt);
    conv.turns.push(newTurn(prompt));
    conv.status = 'running';
    conv.statusNote = null;
    this.emit.emitConversation(conv); // renderer sees the new (empty) turn + running state

    const ac = new AbortController();
    this.aborts.set(id, ac);
    const engine = this.engines.get(conv.engine);
    if (!engine) {
      this.applyAndPersist(conv, id, { type: 'error', message: t(getSettings().lang, 'tmgr.unknownEngine', { engine: conv.engine }) }, prompt, ac.signal);
      this.aborts.delete(id);
      return;
    }

    // Slash skill: a leading /<name> resolves to a skill body (Direct only — Claude/Codex keep
    // their own CLI skill systems). The /name token stays in the prompt (harmless context); the
    // real instruction is the injected body. Unknown names resolve to null → no injection.
    let skillBlock: string | undefined;
    if (conv.engine === 'direct') {
      const m = prompt.match(/^\/([\w-]+)/);
      if (m) {
        const body = loadSkillBody(m[1]);
        if (body != null) {
          skillBlock = body;
          this.emit.emitEvent(id, { type: 'status', text: t(getSettings().lang, 'tmgr.skillLoaded', { name: m[1] }) });
        }
      }
    }

    await engine.run({
      conv,
      memoryBlock: this.memoryBlock(conv),
      rulesBlock: loadRulesBlock(conv.cwd),
      contextBlock: loadContextBlock(conv.cwd),
      skillBlock,
      signal: ac.signal,
      onEvent: (ev) => this.applyAndPersist(conv, id, ev, prompt, ac.signal),
    });

    this.aborts.delete(id);
    // Direct keeps cross-turn context in directHistory (updated by the engine); persist it.
    if (conv.engine === 'direct') store.saveDirectHistory(conv);
    this.emit.emitConversation(conv); // final flush
  }

  // Push a turn that immediately ends in an error (used when we bail before running an engine).
  private failTurn(conv: Conversation, prompt: string, message: string): void {
    conv.turns.push(newTurn(prompt));
    const t = conv.turns[conv.turns.length - 1];
    t.error = message;
    t.done = true;
    store.appendMessage('user', prompt);
    store.saveTurn(conv.id, t);
    this.emit.emitConversation(conv);
  }

  // Apply event to the live conv, stream to renderer, persist durable state, kick off memory extraction.
  private applyAndPersist(conv: Conversation, id: string, ev: AgentEvent, prompt: string, signal: AbortSignal): void {
    applyEvent(conv, ev);
    this.emit.emitEvent(id, ev);
    this.persist(conv, ev);
    const t = conv.turns[conv.turns.length - 1];
    if (ev.type === 'done' && t?.answer) this.extractMemories(t, prompt, conv.id, signal).catch(() => {});
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
    // Memories are model-extracted and flow into CLI prompts that pass through cmd.exe on Windows
    // (shell:true). Strip shell/shell-expansion metacharacters so a planted memory can't inject a
    // command. Short user facts don't legitimately need these chars.
    const mems = store.loadMemories().map((m) => shellSafeMemory(m.content));
    if (mems.length) {
      out += '\n\n## 关于用户(长期记忆,回答时参考)\n' + mems.map((m) => `- ${m}`).join('\n');
    }
    if (conv.cwd) out += `\n\n## 当前工作目录\n${conv.cwd}`;
    return out;
  }

  // Best-effort: extract durable facts about the user from a finished turn (uses the Direct provider).
  // Bound by the turn's abort signal (cancel stops it) + a 30s timeout so it can't hang or run away。
  // 输出两部分:facts(原有,自由文本记忆)+ triples(Phase 4 新增,主谓宾三元组,Memory Graph 用)。
  private async extractMemories(turn: Conversation['turns'][number], prompt: string, convId: string, parentSignal: AbortSignal): Promise<void> {
    if (!turn.answer || turn.answer.length <= 15) return;
    const snap = snapshot();
    const sys = `你是记忆提取器。从下面这轮对话里提取【关于用户本人】的持久事实 —— 身份、职业、偏好、习惯、技术栈、家庭/宠物、所在城市、工具链、长期项目、价值观。
哪怕只透出一点点信号也提取,宁可多提取不要漏。
输出 JSON 对象,两个字段:
- "facts": 字符串数组,每条 ≤ 18 字陈述句,主语「用户」(可省略)。
- "triples": [{ "s": 主语, "p": 谓语, "o": 宾语 }] 三元组,例 {"s":"用户","p":"偏好","o":"Tailwind"} / {"s":"用户","p":"在做","o":"Halo 项目"}。每段 ≤ 14 字。
不提取:本次任务的一次性细节、纯时间敏感(今天/这次)。
无持久事实就输出 {"facts":[],"triples":[]}。只输出 JSON,不要解释。`;
    const user = `用户: ${prompt}\n\n助手: ${turn.answer.slice(0, 2000)}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    const onParentAbort = (): void => ac.abort();
    if (parentSignal.aborted) ac.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    try {
      const comp = await currentProvider(snap).streamComplete(
        [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        [],
        snap,
        ac.signal,
        () => {},
      );
      const { facts, triples } = parseExtraction(comp.content);
      const existingFacts = new Set(store.allMemoryContents());
      const added: string[] = [];
      for (const f of facts) {
        if (f && !existingFacts.has(f)) {
          store.addMemory(f, convId);
          existingFacts.add(f);
          added.push(f);
        }
      }
      // triples 去重按小写 s|p|o,跨频道也去重(全局知识图谱语义)。
      const existingTriples = store.allMemoryTripleKeys();
      for (const t of triples) {
        const key = `${t.s}|${t.p}|${t.o}`.toLowerCase();
        if (!existingTriples.has(key)) {
          store.addMemoryTriple(t.s, t.p, t.o, convId);
          existingTriples.add(key);
        }
      }
      // 给新插入的 fact 算 embedding。失败不阻塞主流程,recall_memory 会回退 FTS5。
      // ponytail: addMemory 不返回 id,靠内容反查最新行;新 fact 量小,逐条 embed 够用。
      if (added.length) {
        try {
          const { embedSnapshot } = await import('./settings');
          const esnap = embedSnapshot();
          const recent = store.loadMemories(undefined);
          const byContent = new Map(recent.map((r) => [r.content, r.id]));
          for (const f of added) {
            const id = byContent.get(f);
            if (!id) continue;
            try {
              const vecs = await embed([f], snap, ac.signal);
              if (vecs[0]?.length) store.setMemoryEmbedding(id, vecs[0], esnap.model);
            } catch (embErr) {
              console.warn('[memory] embed failed (non-blocking):', (embErr as Error)?.message);
            }
          }
        } catch {
          /* embeddings 全失败也无所谓,recall 回退 FTS5 */
        }
      }
    } catch (e) {
      console.error('[memory] extract failed:', (e as Error)?.message);
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

function isCliEngine(e: EngineKind): boolean {
  return e === 'claudeCode' || e === 'codex';
}

// cwd must exist and be a directory; otherwise CLIs ENOENT with an opaque message.
function isUsableCwd(cwd: string): boolean {
  if (!cwd) return false;
  try {
    return fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

// Strip shell / shell-expansion metacharacters + control chars from a memory string (see memoryBlock).
function shellSafeMemory(s: string): string {
  return s.replace(/[\x00-\x1f\x7f&|<>{}()^%!'"`\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Pull a JSON object {facts:string[], triples:[{s,p,o}]} out of an LLM response that may have surrounding prose.
// 兼容老格式(纯 string[]):没匹配到 {} 时尝试匹配 []。
function parseExtraction(s: string): { facts: string[]; triples: Array<{ s: string; p: string; o: string }> } {
  const empty = { facts: [], triples: [] };
  const lo = s.indexOf('{');
  const hi = s.lastIndexOf('}');
  if (lo >= 0 && hi > lo) {
    try {
      const obj = JSON.parse(s.slice(lo, hi + 1)) as Record<string, unknown>;
      const facts = Array.isArray(obj.facts)
        ? obj.facts.filter((x): x is string => typeof x === 'string').map((x) => x.trim())
        : [];
      const triples = Array.isArray(obj.triples)
        ? obj.triples
            .map((t) => {
              if (!t || typeof t !== 'object') return null;
              const r = t as Record<string, unknown>;
              const s = typeof r.s === 'string' ? r.s.trim() : '';
              const p = typeof r.p === 'string' ? r.p.trim() : '';
              const o = typeof r.o === 'string' ? r.o.trim() : '';
              return s && p && o ? { s, p, o } : null;
            })
            .filter((t): t is { s: string; p: string; o: string } => t !== null)
        : [];
      return { facts, triples };
    } catch {
      return empty;
    }
  }
  // 兼容老格式(纯 facts [])
  return { facts: parseFactsLegacy(s), triples: [] };
}

function parseFactsLegacy(s: string): string[] {
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
