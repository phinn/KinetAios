// Conversation manager. Port of Swift TaskManager (engine dispatch + persistence + memory).
// Three engines now (Direct / Claude Code / Codex); each implements the Engine interface.
import fs from 'node:fs';
import type { AgentEvent, ChatMsg, Conversation, EngineKind } from '../shared/types';
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

    // ── 跨会话引用:解析 @conv:xxx → 把被引用会话的最后一轮 answer 拼到 prompt 前面 ──
    // 支持多种写法:@conv:abc123 / @session:abc123 / @对话:abc123。
    // 被引用的会话必须存在,否则忽略(不报错,只发个 status 提示)。
    const refRe = /@(?:conv|session|对话):([a-zA-Z0-9_-]{4,})/g;
    const refIds = new Set<string>();
    let refMatch: RegExpExecArray | null;
    while ((refMatch = refRe.exec(prompt)) !== null) {
      refIds.add(refMatch[1]);
    }
    let refBlock = '';
    if (refIds.size > 0) {
      const refContents: string[] = [];
      for (const refId of refIds) {
        const refConv = this.convs.get(refId);
        if (refConv && refConv.turns.length > 0) {
          const lastTurn = refConv.turns[refConv.turns.length - 1];
          const title = refConv.customTitle || refConv.turns[0]?.prompt.slice(0, 30) || refId;
          refContents.push(`### 引用会话: ${title} (${refId.slice(0, 8)})\n\n${lastTurn.answer.slice(0, 3000)}`);
          // 记录引用关系到 conv_refs(用于任务图)
          store.addConvRef(conv.id, refId, refConv.turns.length - 1);
        } else {
          this.emit.emitEvent(id, { type: 'status', text: `@conv:${refId.slice(0, 8)} 未找到,已跳过` });
        }
      }
      if (refContents.length) {
        refBlock = `\n\n# 跨会话引用(以下内容来自其他会话的输出,作为参考)\n${refContents.join('\n\n---\n\n')}\n`;
      }
    }

    await engine.run({
      conv,
      memoryBlock: this.memoryBlock(conv),
      rulesBlock: loadRulesBlock(conv.cwd),
      contextBlock: loadContextBlock(conv.cwd),
      skillBlock,
      refBlock,
      signal: ac.signal,
      onEvent: (ev) => this.applyAndPersist(conv, id, ev, prompt, ac.signal),
    }).catch((e) => {
      // 引擎抛错 → 确保不会永久卡在 running 状态
      const msg = e instanceof Error ? e.message : String(e);
      this.applyAndPersist(conv, id, { type: 'error', message: msg }, prompt, ac.signal);
    }).finally(() => {
      this.aborts.delete(id);
    });

    // 如果会话在引擎运行期间被删除(cancel→deleteConversation),跳过所有持久化。
    if (!this.convs.has(id)) return;

    // Direct keeps cross-turn context in directHistory (updated by the engine); persist it.
    if (conv.engine === 'direct') store.saveDirectHistory(conv);
    // 普通会话也记一笔 cost_log → 成本看板才有数据(pipeline 已自行记录)。
    // 记本轮 turn 的增量(t.costUSD),不是 conv.cost 累计值,否则多轮会重复。
    const lastTurn = conv.turns[conv.turns.length - 1];
    if (lastTurn && lastTurn.costUSD > 0) {
      store.logCost(conv.id, conv.engine, lastTurn.costUSD, (lastTurn.tokensIn ?? 0) + (lastTurn.tokensOut ?? 0));
    }
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
    // 限制注入条数:长期使用后记忆可能几百条,全量注入会占大量 token。
    // 按创建时间倒序取最近 50 条(最新的最相关)。
    const MEM_LIMIT = 50;
    const limited = mems.length > MEM_LIMIT ? mems.slice(0, MEM_LIMIT) : mems;
    if (limited.length) {
      out += '\n\n## 关于用户(长期记忆,回答时参考)\n' + limited.map((m) => `- ${m}`).join('\n');
      if (mems.length > MEM_LIMIT) {
        out += `\n…(共 ${mems.length} 条记忆,仅显示最近 ${MEM_LIMIT} 条)`;
      }
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

  // ── Pipeline 跨引擎编排 ──
  // 串行执行多个 stage,每个 stage 用不同引擎。上一步输出拼到下一步 prompt 前。
  // 所有 stage 共用一个会话(用户在 UI 上可以看到每步的执行过程)。
  // ponytail: MVP 只做串行链;并行扇出 / 条件分支后续加。
  async runPipeline(stages: Array<{ engine: EngineKind; prompt: string; label?: string }>, cwd: string, name: string): Promise<string> {
    if (!stages.length) throw new Error('Pipeline 至少需要一个 stage');
    // 创建会话
    const conv = this.newConversation(cwd, stages[0].engine);
    conv.pipelineId = name;
    store.saveConversation(conv);

    let prevOutput = '';
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const label = stage.label || `Step ${i + 1}`;
      const stepPrompt = prevOutput
        ? `【Pipeline · ${name} · ${label}】\n\n上一阶段(${stages[i - 1].label || 'Step ' + i})的输出:\n\n---\n${prevOutput}\n---\n\n${stage.prompt}`
        : `【Pipeline · ${name} · ${label}】\n\n${stage.prompt}`;

      // 切引擎(非第一个 stage)
      if (i > 0) this.setEngine(conv.id, stage.engine);

      // 等待执行完成
      await this.send(conv.id, stepPrompt);
      // 等 done
      const maxWait = 120_000; // 单 stage 超时 2 分钟
      const start = Date.now();
      while (conv.status === 'running') {
        if (Date.now() - start > maxWait) {
          this.cancel(conv.id);
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      // 提取最后一个 turn 的 answer 作为下一步输入
      const lastTurn = conv.turns[conv.turns.length - 1];
      if (lastTurn?.error) {
        throw new Error(`Pipeline 在 ${label} 失败: ${lastTurn.error}`);
      }
      prevOutput = lastTurn?.answer ?? '';
      if (!prevOutput) break;
    }

    // 记录总成本 —— pipeline 的每个 stage 已在 send() 里按 turn 增量记过 cost_log,
    // 这里不再重复记(之前记 conv.cost 累计值会导致重复)。
    return conv.id;
  }

  // ── 搜索会话(给 @conv: 引用补全用)──
  searchConversations(query: string): Array<{ id: string; title: string; engine: EngineKind; turns: number; lastActive: number }> {
    const q = (query ?? '').toLowerCase().trim();
    const all = this.list();
    if (!q) return all.slice(0, 20).map((c) => ({ id: c.id, title: c.customTitle || c.turns[0]?.prompt.slice(0, 40) || c.id.slice(0, 8), engine: c.engine, turns: c.turns.length, lastActive: c.createdAt }));
    return all
      .filter((c) => {
        const title = (c.customTitle || '').toLowerCase();
        const firstPrompt = (c.turns[0]?.prompt || '').toLowerCase();
        return title.includes(q) || firstPrompt.includes(q) || c.id.toLowerCase().includes(q);
      })
      .slice(0, 20)
      .map((c) => ({ id: c.id, title: c.customTitle || c.turns[0]?.prompt.slice(0, 40) || c.id.slice(0, 8), engine: c.engine, turns: c.turns.length, lastActive: c.createdAt }));
  }

  // ── 上下文压缩可视化:估算会话 token 使用量 ──
  // 用 AgentLoop 的校准系数(和 trim/compact 同源),给 UI 进度条用。
  estContextTokens(convId: string): { tokens: number; modelMax: number; pct: number } {
    const conv = this.convs.get(convId);
    if (!conv) return { tokens: 0, modelMax: 128_000, pct: 0 };
    // 只对 Direct 引擎有意义(CLI 引擎的上下文由各自的 CLI 管理)
    const { estTokenCount } = require('./AgentLoop') as typeof import('./AgentLoop');
    const tokens = estTokenCount(conv.directHistory);
    // 常见模型上下文上限(GLM-4: 128K, Claude: 200K, GPT-4o: 128K)。
    // ponytail: 硬编码 128K 默认值;后续可按 model 名查表。
    const modelMax = 128_000;
    return { tokens, modelMax, pct: Math.min(100, Math.round((tokens / modelMax) * 100)) };
  }

  // ── Pin/Unpin Turn:锁定的 turn 在 compact 时永远保留 ──
  pinTurn(convId: string, turnId: string, pinned: boolean): boolean {
    const conv = this.convs.get(convId);
    if (!conv) return false;
    const turn = conv.turns.find((t) => t.id === turnId);
    if (!turn) return false;
    turn.pinned = pinned;
    store.saveTurn(convId, turn);
    this.emit.emitConversation(conv);
    return true;
  }

  // ── 上下文检查器:获取 Direct 引擎的 directHistory ──
  // 返回完整消息列表 + token 估算(给 UI 显示进度条)。
  // 非 Direct 引擎返回 engine 字段让 UI 提示「仅 Direct 引擎支持」。
  getDirectHistory(convId: string): { ok: boolean; history?: ChatMsg[]; engine?: EngineKind; tokens?: number; modelMax?: number; error?: string } {
    const conv = this.convs.get(convId);
    if (!conv) return { ok: false, error: '会话不存在' };
    // 深拷贝(避免 renderer 直接修改内存对象)
    const history = JSON.parse(JSON.stringify(conv.directHistory ?? [])) as ChatMsg[];
    const { estTokenCount } = require('./AgentLoop') as typeof import('./AgentLoop');
    const tokens = estTokenCount(history);
    return { ok: true, history, engine: conv.engine, tokens, modelMax: 128_000 };
  }

  // ── 上下文检查器:保存编辑后的 directHistory ──
  // 会话正在运行时拒绝修改(防数据竞争);非 Direct 引擎也拒绝。
  saveDirectHistory(convId: string, history: ChatMsg[]): { ok: boolean; error?: string } {
    const conv = this.convs.get(convId);
    if (!conv) return { ok: false, error: '会话不存在' };
    if (conv.status === 'running') return { ok: false, error: '会话运行中,无法修改上下文' };
    // 替换 directHistory + 持久化
    conv.directHistory = history;
    store.saveDirectHistory(conv);
    this.emit.emitConversation(conv);
    return { ok: true };
  }

  // ── 会话分支 ──
  // 从指定 turn 的位置创建新会话,复制该 turn 及之前所有 turn。
  // 新会话引擎/模型/cwd 与源会话一致,但 directHistory 清空(新上下文)。
  branchFrom(srcConvId: string, turnIdx: number): Conversation | null {
    const src = this.convs.get(srcConvId);
    if (!src || turnIdx < 0 || turnIdx >= src.turns.length) return null;
    const conv: Conversation = {
      id: rid(),
      engine: src.engine,
      model: src.model,
      cwd: src.cwd,
      createdAt: Date.now(),
      customTitle: `${src.customTitle || src.turns[0]?.prompt.slice(0, 20) || 'Session'} (分支)`,
      directHistory: [],
      engineSessionId: null,
      turns: src.turns.slice(0, turnIdx + 1).map((t) => ({ ...t, id: rid(), steps: (t.steps ?? []).map((s) => ({ ...s })) })),
      status: 'ready',
      statusNote: null,
      cost: 0,
      tokens: 0,
      branchInfo: { id: rid(), sourceConvId: srcConvId, sourceTurnIdx: turnIdx, createdAt: Date.now() },
    };
    store.saveConversation(conv);
    for (const t of conv.turns) store.saveTurn(conv.id, t);
    this.convs.set(conv.id, conv);
    this.order.unshift(conv.id);
    this.emit.emitConversation(conv);
    return conv;
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

// Strip shell metacharacters that could cause prompt injection or shell expansion from memory strings.
// 只去 shell 控制字符(&|<>`^)和 \x00-\x1f 控制符,保留括号/引号/百分号(代码片段需要)。
function shellSafeMemory(s: string): string {
  return s.replace(/[\x00-\x1f\x7f&|<>`\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
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
