// Conversation manager. Port of Swift TaskManager (engine dispatch + persistence + memory).
// Three engines now (Direct / Claude Code / Codex); each implements the Engine interface.
import fs from 'node:fs';
import type { AgentEvent, ChatMsg, Conversation, ContextMode, EngineKind, Turn } from '../shared/types';
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
  // 任务完成通知钩子:turn 真正结束(done/error)且非用户主动取消时调用。
  // 由 main.ts 实现系统通知(最小化/失焦时才发)。TaskManager 不关心窗口状态。
  notifyDone(conv: Conversation, kind: 'done' | 'error', wasCancelled: boolean): void;
}

export class TaskManager {
  private convs = new Map<string, Conversation>();
  private order: string[] = []; // newest first
  private aborts = new Map<string, AbortController>();
  // Goal loop 取消标志:cancel() 设置后,runGoalLoop 的下一轮检查时退出。
  private goalLoopStopped = new Set<string>();
  // 追踪每个会话切换前的引擎(用于判断同族切换是否需要清空上下文)。
  private lastEngine: Record<string, EngineKind> = {};
  // P3: done 事件计数器,用于触发周期性 idle reflection(每 5 次 done 触发一次记忆 GC)
  private doneCounter = 0;
  private engines: Map<EngineKind, Engine>;

  constructor(private emit: TaskManagerEmitter) {
    this.engines = buildEngines(emit.confirm);
  }

  // 插件引擎热注册(Plugin SDK v3):plugin-reload / install / uninstall / toggle 后
  // 由 main.ts 调用,重建引擎表。运行中的会话不受影响(aborts 持有旧 engine 引用,
  // run 到完为止);新 send 走新表。builtin id 不变,已注册的 plugin: 项增删覆盖。
  // Hot-reregister plugin engines after plugin cache invalidation. In-flight runs
  // keep their old engine reference; new sends dispatch through the fresh table.
  rebuildEngines(): void {
    this.engines = buildEngines(this.emit.confirm);
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

  // 懒加载 hydrate:send 前 turns 必须就位(engine 取 lastTurn.prompt / applyEvent 追加 turn)。
  // Hydrate before send — engines read the last turn and applyEvent appends to it.
  private ensureTurns(id: string): void {
    const conv = this.convs.get(id);
    if (!conv || conv.turnsLoaded !== false) return;
    conv.turns = store.loadConvTurns(id);
    conv.turnsLoaded = true;
  }

  // 公开 hydrate:renderer/IPC 消费点(export、voice、arena-diff)按需拉 turns。
  hydrate(id: string): Conversation | undefined {
    const conv = this.convs.get(id);
    if (conv && conv.turnsLoaded === false) {
      conv.turns = store.loadConvTurns(id);
      conv.turnsLoaded = true;
    }
    return conv;
  }

  newConversation(cwd: string, engine?: EngineKind): Conversation {
    const eng = engine ?? getSettings().defaultEngine ?? 'direct';
    const conv: Conversation = {
      id: rid(),
      engine: eng,
      model: getSettings().model,
      subAgentModel: getSettings().subAgentModel || null,
      cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
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
  // Direct 家族(direct ↔ directV2)共享 directHistory,切换不清空。
  // 跨族切换时:把已有 turns 摘要存入 crossEngineContext,让新引擎首次 run 时注入。
  setEngine(id: string, engine: EngineKind): void {
    const conv = this.convs.get(id);
    if (!conv || conv.engine === engine) return;
    if (!this.engines.has(engine)) return; // 插件关闭 → 引擎未注册 → 拒绝 / unregistered → refuse
    const oldEngine = conv.engine;
    conv.engine = engine;
    // 跨族切换才清空上下文(同族 direct ↔ directV2 保留)
    if (!isDirectFamily(engine) || !isDirectFamily(this.lastEngine[id] ?? engine)) {
      // 生成上下文摘要,让新引擎知道之前做了什么(仅当有实质性对话时)
      this.ensureTurns(id); // 摘要需要读全部 turns
      const validTurns = conv.turns.filter((t) => t.prompt || t.answer);
      if (validTurns.length > 0) {
        conv.crossEngineContext = buildCrossEngineSummary(validTurns, oldEngine);
      }
      conv.directHistory = [];
      conv.engineSessionId = null;
    }
    this.lastEngine[id] = engine;
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
  setSubModel(id: string, model: string): void {
    const conv = this.convs.get(id);
    if (!conv) return;
    conv.subAgentModel = model.trim() || null;
    store.saveConversation(conv);
    this.emit.emitConversation(conv);
  }

  // 绑定/解绑会话的模型配置档 —— DirectEngine 运行时按 profileId 读取完整配置。
  setConvProfile(id: string, profileId: string | null): void {
    const conv = this.convs.get(id);
    if (!conv) return;
    conv.profileId = profileId;
    // 同步更新 model 显示名(让 header 里看到当前用的模型)
    if (profileId) {
      const profile = getSettings().modelProfiles.find((p) => p.id === profileId);
      if (profile) conv.model = profile.model;
    }
    store.saveConversation(conv);
    this.emit.emitConversation(conv);
  }

  // 上下文模式切换 —— standard(默认) / hifi(不截断+大预算)。以后可扩展更多模式。
  setContextMode(id: string, mode: ContextMode): void {
    const conv = this.convs.get(id);
    if (!conv) return;
    conv.contextMode = mode;
    store.saveConversation(conv);
    this.emit.emitConversation(conv);
  }

  // 会话级替身画像开关 —— false = 本会话不注入 persona。
  setPersonaEnabled(id: string, enabled: boolean): void {
    const conv = this.convs.get(id);
    if (!conv) return;
    conv.personaEnabled = enabled;
    store.saveConversation(conv);
    this.emit.emitConversation(conv);
  }

  deleteConversation(id: string): void {
    this.cancel(id);
    store.deleteConversation(id);
    this.convs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    delete this.lastEngine[id]; // P1: 清理引擎记录,防止 key 无限累积
    this.goalLoopStopped.delete(id); // P1: 清理 goal loop 停止标记
    this.extractionLocks.delete(id); // P1: 清理 extraction lock,防止残留 resolved Promise 堆积
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
    this.goalLoopStopped.add(id); // 通知 goal loop 停止
    const conv = this.convs.get(id);
    this.ensureTurns(id); // cancel 要写 lastTurn(done/error 标记),先 hydrate
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
    this.ensureTurns(id); // 懒加载:engine 读 lastTurn.prompt,turns 必须先就位
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

    // Engine must be registered (plugin enabled). Guard here so a stale renderer
    // dropdown can't dispatch into a disabled engine.
    if (!this.engines.has(conv.engine)) {
      this.failTurn(conv, prompt, t(getSettings().lang, 'tmgr.engineDisabled'));
      return;
    }

    // /goal <text>:设置会话目标(持续注入 systemPrompt,引导整个会话)。不发给引擎。
    // /goal(无参数):清除目标。UI 会收到 conversation 事件后刷新。
    const goalMatch = prompt.match(/^\/goal(?:\s+(.*))?$/i);
    if (goalMatch) {
      const goalText = goalMatch[1]?.trim() || null;
      conv.goal = goalText;
      store.saveConversation(conv);
      // 插入一个已完成的 turn 作为视觉反馈(不发给引擎)
      const t = newTurn(prompt);
      t.answer = goalText ? `🎯 会话目标已设置: ${goalText}` : '🎯 会话目标已清除';
      t.done = true;
      conv.turns.push(t);
      conv.updatedAt = Date.now(); // /goal 也算活动。
      store.saveTurn(conv.id, t);
      this.emit.emitConversation(conv);
      return;
    }

    store.appendMessage('user', prompt);
    conv.turns.push(newTurn(prompt));
    conv.status = 'running';
    conv.statusNote = null;
    conv.updatedAt = Date.now(); // 用户发消息也算活动,更新时间戳。
    store.touchConversation(conv.id); // 写库,侧栏排序/时间显示依赖 updated_at 列。
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
    if (isDirectFamily(conv.engine)) {
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
        if (refConv && refConv.turnsLoaded === false) {
          refConv.turns = store.loadConvTurns(refId); // 懒加载:引用频道按需拉全文
          refConv.turnsLoaded = true;
        }
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
      memoryBlock: await this.memoryBlock(conv),
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
      // P0-fix: 引擎异常退出 → 清除 V2 crash recovery checkpoint,防止下次 send 误 resume 旧 plan。
      // crash recovery 只为进程崩溃设计(重启后恢复),同进程内异常不应触发。
      if (conv.engine === 'directV2') store.clearV2State(conv.id);
    }).finally(() => {
      this.aborts.delete(id);
    });

    // 如果会话在引擎运行期间被删除(cancel→deleteConversation),跳过所有持久化。
    if (!this.convs.has(id)) return;

    // Direct keeps cross-turn context in directHistory (updated by the engine); persist it.
    if (isDirectFamily(conv.engine)) store.saveDirectHistory(conv);
    // 普通会话也记一笔 cost_log → 成本看板才有数据(pipeline 已自行记录)。
    // 记本轮 turn 的增量(t.costUSD),不是 conv.cost 累计值,否则多轮会重复。
    const lastTurn = conv.turns[conv.turns.length - 1];
    if (lastTurn && lastTurn.costUSD > 0) {
      store.logCost(conv.id, conv.engine, lastTurn.costUSD, (lastTurn.tokensIn ?? 0) + (lastTurn.tokensOut ?? 0));
    }
    this.emit.emitConversation(conv); // final flush

    // ── Goal Auto-Loop:有 goal 且本轮未出错且未标记完成 → 自动发下一轮 ──
    if (conv.goal && isDirectFamily(conv.engine) && lastTurn && !lastTurn.error && lastTurn.answer) {
      // 立即恢复 running 状态(applyEvent 的 done 会把它设成 ready,这里夺回)
      conv.status = 'running';
      this.emit.emitConversation(conv);
      await this.runGoalLoop(conv, id, ac);
    }
  }

  // Goal 自动循环:每轮结束后检查是否完成,未完成则自动 dispatch 下一轮。
  // 取消机制:用户点 Stop → cancel() → ac.abort() + conv.status='ready' → 循环检测到后退出。
  private async runGoalLoop(conv: Conversation, id: string, initialAc: AbortController): Promise<void> {
    const GOAL_MAX_ITERATIONS = 20; // 防止无限循环
    this.goalLoopStopped.delete(id); // 清除上次的取消标记
    // 用户取消会 abort 当前 ac,循环检测到后退出
    let currentAc = initialAc;
    for (let iter = 0; iter < GOAL_MAX_ITERATIONS; iter++) {
      // 检查上一轮的结果
      const lastTurn = conv.turns[conv.turns.length - 1];
      if (!lastTurn?.answer) break;
      // 模型输出 [GOAL_COMPLETE] → 目标完成,停止循环
      if (lastTurn.answer.includes('[GOAL_COMPLETE]')) {
        // 去掉标记文本,给用户一个干净的结尾
        lastTurn.answer = lastTurn.answer.replace(/\s*\[GOAL_COMPLETE\]\s*/g, '').trim();
        store.saveTurn(conv.id, lastTurn);
        conv.statusNote = '✅ 目标已完成';
        this.emit.emitConversation(conv);
        break;
      }
      // 用户取消(cancel 会 abort + 设 goalLoopStopped)或会话被删除 → 停止
      if (currentAc.signal.aborted || this.goalLoopStopped.has(id) || !this.convs.has(id)) break;

      // 准备下一轮:发一个简短的 continue prompt(goal 已在 systemPrompt 里,这里只需推动)
      const continuePrompt = `继续推进目标:「${conv.goal}」。执行下一步。`;
      store.appendMessage('user', continuePrompt);
      conv.turns.push(newTurn(continuePrompt));
      conv.status = 'running';
      this.emit.emitConversation(conv);

      const ac = new AbortController();
      this.aborts.set(id, ac);
      currentAc = ac;
      const engine = this.engines.get(conv.engine);
      if (!engine) break;

      await engine.run({
        conv,
        memoryBlock: await this.memoryBlock(conv),
        rulesBlock: loadRulesBlock(conv.cwd),
        contextBlock: loadContextBlock(conv.cwd),
        signal: ac.signal,
        onEvent: (ev) => this.applyAndPersist(conv, id, ev, continuePrompt, ac.signal),
      }).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.applyAndPersist(conv, id, { type: 'error', message: msg }, continuePrompt, ac.signal);
        // P0-fix: 同上,清除 V2 checkpoint 防误 resume。
        if (conv.engine === 'directV2') store.clearV2State(conv.id);
      }).finally(() => {
        this.aborts.delete(id);
      });

      if (!this.convs.has(id)) break;
      store.saveDirectHistory(conv);
      // 记本轮 cost → 成本看板
      const goalTurn = conv.turns[conv.turns.length - 1];
      if (goalTurn && goalTurn.costUSD > 0) {
        store.logCost(conv.id, conv.engine, goalTurn.costUSD, (goalTurn.tokensIn ?? 0) + (goalTurn.tokensOut ?? 0));
      }
      if (goalTurn?.error) break; // 出错 → 停止循环
    }
    // 循环结束 → 确保状态恢复 + 清理标记
    this.goalLoopStopped.delete(id);
    if (this.convs.has(id) && conv.status === 'running') {
      conv.status = 'ready';
      this.emit.emitConversation(conv);
    }
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
    // 任务完成通知:done/error 都是 turn 终态。用户 cancel 不通知(cancel() 自己不走路径,
    // 但 abort 可能引发 engine 内部 error 事件 → 用 signal.aborted 区分)。
    if (ev.type === 'done' || ev.type === 'error') {
      this.emit.notifyDone(conv, ev.type === 'done' ? 'done' : 'error', signal.aborted);
    }
    const t = conv.turns[conv.turns.length - 1];
    if (ev.type === 'done' && t?.answer) {
      this.extractMemories(t, prompt, conv.id, signal).catch(() => {});
      // P2: 异步提取会话摘要(episodic memory),不阻塞主流程
      this.extractEpisodicMemory(conv, signal).catch(() => {});
      // P3: 异步执行记忆 GC(idle reflection),每 5 次 done 触发一次
      this.doneCounter++;
      if (this.doneCounter % 5 === 0) {
        this.runIdleReflection().catch(() => {});
      }
    }
  }

  private persist(conv: Conversation, ev: AgentEvent): void {
    const t = conv.turns[conv.turns.length - 1];
    if (!t) return;
    conv.updatedAt = Date.now(); // 更新最后活动时间,侧栏排序和时间显示用。
    store.touchConversation(conv.id); // 同步写库,确保所有事件路径都持久化 updated_at。
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
  // P0: Memory Blocks(结构化常驻记忆,XML-like 格式注入)+ 检索式记忆(embedding/FTS5)+ episodic 摘要。
  private async memoryBlock(conv: Conversation): Promise<string> {
    let out = '';

    // ── P0: Memory Blocks(结构化核心记忆,每轮都注入,类似 Letta Memory Blocks)──
    const blocks = store.loadMemoryBlocks();
    const activeBlocks = blocks.filter((b) => b.value.trim());
    if (activeBlocks.length) {
      out += '\n\n<memory_blocks>';
      for (const b of activeBlocks) {
        out += `\n<${b.label}>\n${b.value}\n</${b.label}>`;
      }
      out += '\n</memory_blocks>';
      out += '\n\n💡 你可以用 memory_replace / memory_append 工具更新这些记忆块(例如发现 project_context 过时了)。';
    }

    // 构造检索 query:取最近 1-3 轮的用户消息拼接。
    const recentUserMsgs = conv.turns.filter((t) => t.prompt).slice(-3).map((t) => t.prompt!);
    const query = recentUserMsgs.join(' ').slice(0, 500);

    // ── P1: 加权检索式记忆(importance * 0.5 + recency * 0.3 + relevance * 0.2)──
    const recalled = await this.recallForInjection(query);
    const limited = recalled.map((m) => shellSafeMemory(m.content));

    if (limited.length) {
      out += '\n\n## 关于用户(长期记忆,回答时参考)\n' + limited.map((m) => `- ${m}`).join('\n');
      const allCount = store.memoryCount();
      if (allCount > limited.length) {
        out += `\n…(共 ${allCount} 条记忆,根据当前对话检索注入 ${limited.length} 条)`;
      }
    }
    // 知识图谱三元组注入。
    if (query) {
      const triples = store.searchMemoryTriples(query, 5);
      if (triples.length) {
        out += '\n\n## 用户知识图谱(语义关系)\n' + triples.map((t) => `- ${t.subject} —${t.predicate}→ ${t.object}`).join('\n');
      }
    }
    // ── P2: Episodic Memory(最近会话摘要,帮助回忆"上次做了什么")──
    const episodes = store.loadEpisodicMemories(5);
    if (episodes.length) {
      out += '\n\n## 最近会话摘要\n' + episodes.map((e) => {
        const date = new Date(e.createdAt).toISOString().slice(0, 10);
        return `- [${date}] (⭐${e.importance}) ${e.summary}`;
      }).join('\n');
      const totalEp = store.episodicMemoryCount();
      if (totalEp > episodes.length) {
        out += `\n…(共 ${totalEp} 条会话摘要,显示最近 ${episodes.length} 条)`;
      }
    }
    if (conv.cwd) out += `\n\n## 当前工作目录\n${conv.cwd}`;
    return out;
  }

  // 三级回退检索:embedding cosine → FTS5 → recent-N 兜底。
  // P1: 结果按 importance * 0.5 + recency * 0.3 + relevance * 0.2 加权排序。
  private async recallForInjection(query: string): Promise<Array<{ content: string }>> {
    const INJECT_LIMIT = 15; // 检索注入条数:相关记忆只需 10-15 条,远少于全量 50 条。

    // 1. embedding cosine 检索(有 embedding 且 query 非空时)→ P1 加权重排
    if (query) {
      try {
        const embedRows = store.listMemoryEmbeddings();
        if (embedRows.length) {
          const snap = snapshot();
          const qVecArr = await embed([query], snap);
          if (qVecArr[0]?.length) {
            const qVec = new Float32Array(qVecArr[0]);
            // 先用 embedding cosine 召回 top-30(宽召回)
            const candidates = embedRows
              .map((r) => ({ memoryId: r.memoryId, content: r.content, score: store.cosine(qVec, r.vec) }))
              .filter((r) => r.score > 0.2)
              .sort((a, b) => b.score - a.score)
              .slice(0, 30);
            if (candidates.length >= 3) {
              // P1: 再用 scoredMemories 做重要性+时效性+相关性加权重排
              const relevanceMap = new Map<string, number>();
              for (const c of candidates) relevanceMap.set(c.content, c.score);
              const scored = store.scoredMemories(query, INJECT_LIMIT, (content) => relevanceMap.get(content) ?? 0);
              if (scored.length >= 3) {
                for (const s of scored) {
                  try { store.touchMemoryUsed(s.id); } catch { /* non-blocking */ }
                }
                return scored.map(({ content }) => ({ content }));
              }
              // scoredMemories 没有足够结果 → 用原始 embedding 排序
              for (const s of candidates.slice(0, INJECT_LIMIT)) {
                try { store.touchMemoryUsed(s.memoryId); } catch { /* non-blocking */ }
              }
              return candidates.slice(0, INJECT_LIMIT).map(({ content }) => ({ content }));
            }
          }
        }
      } catch {
        /* embedding 失败 → FTS5 兜底 */
      }

      // 2. FTS5 全文检索(从 memories 表搜)→ 按 importance 排序
      try {
        const ftsHits = store.searchMemories(query, INJECT_LIMIT);
        if (ftsHits.length >= 2) {
          return ftsHits.map(({ content }) => ({ content }));
        }
      } catch {
        /* FTS5 失败 → recent-N 兜底 */
      }
    }

    // 3. recent-N 兜底(无 query / 检索无结果时,取最新的 N 条)
    return store.loadMemories().slice(0, INJECT_LIMIT).map(({ content }) => ({ content }));
  }

  // Best-effort: extract durable facts about the user from a finished turn (uses the Direct provider).
  // Bound by the turn's abort signal (cancel stops it) + a 30s timeout so it can't hang or run away。
  // 输出两部分:facts(原有,自由文本记忆)+ triples(Phase 4 新增,主谓宾三元组,Memory Graph 用)。
  // 同会话 extraction 串行化(防止并发提取产生重复 fact/triple)
  private extractionLocks = new Map<string, Promise<void>>();
  private async extractMemories(turn: Conversation['turns'][number], prompt: string, convId: string, parentSignal: AbortSignal): Promise<void> {
    if (!turn.answer || turn.answer.length <= 15) return;
    // 串行化:等同一会话的上一次 extraction 完成
    const prev = this.extractionLocks.get(convId) ?? Promise.resolve();
    let release!: () => void;
    this.extractionLocks.set(convId, new Promise<void>((r) => { release = r; }));
    try { await prev.catch(() => {}); } finally { /* prev done, continue */ }
    const snap = snapshot(this.convs.get(convId)?.profileId);
    const sys = `你是记忆提取器。从下面这轮对话里提取持久事实 —— 涵盖用户画像、项目知识、工作流三个维度。
哪怕只透出一点点信号也提取,宁可多提取不要漏。
输出 JSON 对象,四个字段:
- "facts": [{ "text": "≤ 18字陈述句", "importance": 1-10 }] 数组,主语「用户」(可省略)。importance: 核心偏好/技术栈=8-10,一般习惯=5-7,边缘信号=2-4。
- "project_facts": [{ "text": "≤ 18字陈述句", "importance": 1-10 }] 数组,关于项目/代码/架构的持久知识。例:"KinetAios 用 better-sqlite3 + FTS5" / "打包命令是 npm run dist" / "的记忆系统用 cosine 评分"。importance: 核心架构/构建命令=8-10,一般约定=5-7,边缘细节=2-4。
- "triples": [{ "s": 主语, "p": 谓语, "o": 宾语 }] 三元组,例 {"s":"用户","p":"偏好","o":"Tailwind"} / {"s":"KinetAios","p":"用","o":"better-sqlite3"} / {"s":"项目","p":"构建","o":"npm run dist"}。每段 ≤ 14 字。
不提取:本次任务的一次性细节(如临时变量名)、纯时间敏感(今天/这次)、单次 bug 的具体修复步骤(除非是通用 pattern)。
无持久事实就输出 {"facts":[],"project_facts":[],"triples":[]}。只输出 JSON,不要解释。`;
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
      const { facts, projectFacts, triples } = parseExtraction(comp.content);
      const existingFacts = store.allMemoryContents();

      // ── 去重策略:精确匹配 → 模糊去重(Jaccard) → 语义去重(embedding cosine)
      // 1. 精确匹配(快,过滤掉完全一样的)
      // 2. 无 embedding 接口时:用 Jaccard token 相似度(> 0.6 视为重复)
      // 3. 有 embedding 接口时:cosine > 0.85 视为重复(语义级,最准)
      // ──────────────────────────────────────────────────────────────────────
      const isDuplicateFuzzy = (candidate: string): boolean => {
        for (const ex of existingFacts) {
          if (textSimilarity(candidate, ex) >= 0.65) return true;
        }
        return false;
      };

      // 先做精确 + 模糊过滤,拿到「文字层不重复」的候选(P1: 带 importance)
      // user facts + project facts 合入同一条去重管线
      const candidates: Array<{ text: string; importance: number }> = [];
      for (const f of [...facts, ...projectFacts]) {
        if (!f.text) continue;
        if (existingFacts.includes(f.text)) continue; // 精确匹配
        if (isDuplicateFuzzy(f.text)) continue; // 模糊匹配
        candidates.push(f);
      }

      // 有 embedding 接口时再过一遍语义去重
      let finalFacts: Array<{ text: string; importance: number }>;
      if (candidates.length === 0) {
        finalFacts = [];
      } else {
        try {
          const { embed } = await import('./glm');
          // embed 候选 + 全部已有记忆,算 cosine
          const candVecs = await embed(candidates.map((c) => c.text), snap, ac.signal);
          const embeddings = store.listMemoryEmbeddings();
          if (embeddings.length > 0) {
            // 有已有 embedding → 算 cosine
            finalFacts = [];
            for (let i = 0; i < candidates.length; i++) {
              if (!candVecs[i]?.length) { finalFacts.push(candidates[i]); continue; }
              const candVec = new Float32Array(candVecs[i]);
              let isDup = false;
              for (const ex of embeddings) {
                if (store.cosine(candVec, ex.vec) > 0.85) { isDup = true; break; }
              }
              if (!isDup) finalFacts.push(candidates[i]);
            }
          } else {
            // 没有已有 embedding → 候选之间互相去重
            finalFacts = [];
            const accepted: Float32Array[] = [];
            for (let i = 0; i < candidates.length; i++) {
              if (!candVecs[i]?.length) { finalFacts.push(candidates[i]); continue; }
              const candVec = new Float32Array(candVecs[i]);
              let isDup = false;
              for (const acc of accepted) {
                if (store.cosine(candVec, acc) > 0.85) { isDup = true; break; }
              }
              if (!isDup) { finalFacts.push(candidates[i]); accepted.push(candVec); }
            }
          }
        } catch {
          // embedding 不可用 → 模糊去重的结果就是最终结果
          finalFacts = candidates;
        }
      }

      const added: Array<{ id: string; text: string }> = [];
      for (const f of finalFacts) {
        if (parentSignal.aborted) return;
        // P1: 传入 importance
        const id = store.addMemory(f.text, convId, f.importance);
        existingFacts.push(f.text);
        added.push({ id, text: f.text });
      }
      // triples 去重按小写 s|p|o,跨频道也去重(全局知识图谱语义)。
      const existingTriples = store.allMemoryTripleKeys();
      for (const t of triples) {
        if (parentSignal.aborted) return;
        const key = `${t.s}|${t.p}|${t.o}`.toLowerCase();
        if (!existingTriples.has(key)) {
          store.addMemoryTriple(t.s, t.p, t.o, convId);
          existingTriples.add(key);
        }
      }
      // 给新插入的 fact 算 embedding。失败不阻塞主流程,recall_memory 会回退 FTS5。
      // 批量 embedding:一次 API 调用处理所有新 fact,避免 N+1 性能问题。
      if (added.length) {
        try {
          const { embedSnapshot } = await import('./settings');
          const esnap = embedSnapshot();
          // 一次性批量 embed 所有新 fact
          const vecs = await embed(added.map((e) => e.text), snap, ac.signal);
          for (let i = 0; i < added.length && i < vecs.length; i++) {
            if (vecs[i]?.length) store.setMemoryEmbedding(added[i].id, vecs[i], esnap.model);
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
      release();
    }
  }

  // P2: Episodic Memory — 会话摘要提取。每次 done 后异步执行,生成"这次会话做了什么"的叙事摘要。
  // 与 extractMemories 的区别:extractMemories 提取原子事实(facts),extractEpisodicMemory 提取叙事摘要(episodes)。
  // 用于跨会话回忆:"上次那个 bug 怎么修的" → 搜 episodic_memories 表。
  private async extractEpisodicMemory(conv: Conversation, parentSignal: AbortSignal): Promise<void> {
    // 只在有实际内容的 turn 上提取
    const meaningfulTurns = conv.turns.filter((t) => t.answer && t.answer.length > 50);
    if (meaningfulTurns.length === 0) return;
    // 太短的会话不值得提取
    const totalChars = meaningfulTurns.reduce((s, t) => s + (t.answer?.length ?? 0), 0);
    if (totalChars < 200) return;

    const snap = snapshot(conv.profileId);
    const sys = `你是会话摘要器。把下面的多轮对话压缩成 3-5 句话的叙事摘要。
重点:
1. 这次的任务目标是什么?
2. 根因/解决方案是什么?
3. 改了哪些文件/模块?
4. 用户学到了什么 / 什么决策值得记住?
输出 JSON 对象:
- "summary": 3-5 句话摘要(≤ 200 字)
- "importance": 1-10(日常问答=1-3,修 bug=5-7,架构改动=8-10)
- "tags": 字符串数组(关键词标签,如 ["bug-fix", "concurrency", "AgentLoop"],最多 5 个)
只输出 JSON,不要解释。`;

    // 压缩对话内容:取最近 5 轮,每轮截取前 500 字
    const recentTurns = meaningfulTurns.slice(-5);
    const dialog = recentTurns.map((t, i) =>
      `[Turn ${i + 1}] 用户: ${(t.prompt ?? '').slice(0, 300)}\n助手: ${(t.answer ?? '').slice(0, 500)}`
    ).join('\n\n');

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    const onParentAbort = (): void => ac.abort();
    if (parentSignal.aborted) { ac.abort(); return; }
    parentSignal.addEventListener('abort', onParentAbort, { once: true });

    try {
      const comp = await currentProvider(snap).streamComplete(
        [{ role: 'system', content: sys }, { role: 'user', content: dialog }],
        [],
        snap,
        ac.signal,
        () => {},
      );
      // 解析 JSON
      const lo = comp.content.indexOf('{');
      const hi = comp.content.lastIndexOf('}');
      if (lo < 0 || hi <= lo) return;
      const obj = JSON.parse(comp.content.slice(lo, hi + 1)) as { summary?: string; importance?: number; tags?: string[] };
      if (!obj.summary || obj.summary.length < 10) return;
      store.addEpisodicMemory({
        convId: conv.id,
        summary: obj.summary.slice(0, 500),
        importance: obj.importance ?? 5,
        tags: Array.isArray(obj.tags) ? obj.tags.slice(0, 5).join(', ') : undefined,
      });
    } catch {
      /* best-effort,失败不影响主流程 */
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  // P3: Idle Reflection — 记忆 GC(合并重复 / 删除低价值 / 更新过时)。
  // 在会话 done 事件后异步触发,也可以通过设置面板手动触发。
  // 不用 LLM(成本高 + 慢),用规则:dedupMemories(已有) + decayMemories(已有) + 新增 importance-based prune。
  async runIdleReflection(): Promise<{ deduped: number; decayed: number; lowImportancePruned: number }> {
    const deduped = await store.dedupMemories(0.65); // async 让出事件循环,不再卡死主进程
    const decayed = store.decayMemories();
    // P1: 删除 importance ≤ 2 且从未被 recall 命中的低价值记忆
    const lowImportancePruned = store.pruneLowImportanceMemories(2);
    return { deduped, decayed, lowImportancePruned };
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
    if (!src) return null;
    if (src.turnsLoaded === false) {
      src.turns = store.loadConvTurns(srcConvId); // 分支需要源频道 turns,懒加载
      src.turnsLoaded = true;
    }
    if (turnIdx < 0 || turnIdx >= src.turns.length) return null;
    const conv: Conversation = {
      id: rid(),
      engine: src.engine,
      model: src.model,
      cwd: src.cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
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

  // ── 替身画像生成 ──
  // 分析历史对话 + 记忆,调 LLM 总结出用户的做事风格 Markdown。
  // Analyze history + memories, ask LLM to produce a structured persona profile.
  async generatePersona(): Promise<{ ok: boolean; persona?: string; stats?: { conversations: number; turns: number; memories: number }; error?: string }> {
    try {
      const snap = snapshot();
      const recentTurns = store.loadRecentTurns(200);
      const memories = store.loadMemories();
      const conversations = store.loadConversationsFull(); // 画像分析需要全部 turns

      if (recentTurns.length === 0 && memories.length === 0) {
        return { ok: false, error: '历史数据不足,无法生成画像(需要至少一轮对话或一条记忆)' };
      }

      // 拼接对话样本(最多 100 轮,每轮 prompt + answer 前 500 字)
      // Assemble conversation samples (max 100 turns, truncate each to 500 chars)
      const turnSamples = recentTurns.slice(0, 100).map((t, i) =>
        `[对话${i + 1} | ${t.engine} | ${t.cwd}]\n用户: ${t.prompt.slice(0, 300)}\n助手: ${t.answer.slice(0, 500)}`,
      ).join('\n\n---\n\n');

      // 记忆样本(最多 200 条)
      const memorySamples = memories.slice(0, 200).map((m) => `- ${m.content}`).join('\n');

      const sys = `你是用户行为分析师。根据用户的历史对话和长期记忆,生成一份结构化的「用户做事风格画像」。
这份画像将用于构建 AI 替身 —— 让 AI 能以用户本人的风格自主使用工具完成任务。

输出 Markdown 格式,包含以下部分(某部分信息不足可跳过,不要编造):

## 沟通风格
- 语言习惯、句式特征、详细度偏好
- 提问方式(直接给指令 / 描述问题等)

## 技术画像
- 主力技术栈、编程语言、框架
- 常用工具链和开发环境
- 熟悉的领域和技术

## 工作偏好
- 偏好的方案风格(最小改动 / 彻底重构 / 快速落地等)
- 对代码质量的要求(验收标准)
- commit / 文档习惯

## 项目背景
- 正在进行的主要项目
- 产品领域和目标用户

## 决策模式
- 遇到选择题时倾向于怎么选
- 什么时候会打断 / 纠正 AI
- 对自主执行的容忍度

## 替身指令
(给 AI 替身的直接指令,以 "你扮演上述用户,使用 KinetAios 完成任务时:" 开头,列出 3-5 条核心行为准则)

只输出 Markdown,不要加额外解释。基于实际数据,不要编造。`;

      const user = `## 用户历史对话样本(最近 ${recentTurns.length} 轮,共 ${conversations.length} 个会话)

${turnSamples || '(无对话样本)'}

## 用户长期记忆(${memories.length} 条)

${memorySamples || '(无记忆)'}`;

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60_000);
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
        clearTimeout(timer);

        if (!comp.content || comp.content.trim().length < 50) {
          return { ok: false, error: '生成结果过短,可能模型未正确响应' };
        }

        return {
          ok: true,
          persona: comp.content.trim(),
          stats: {
            conversations: conversations.length,
            turns: recentTurns.length,
            memories: memories.length,
          },
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  }
}

// Direct 家族引擎(direct + directV2)共享 directHistory 上下文。
// 切换引擎时,同族之间保留上下文,跨族(→ CLI)清空。
function isDirectFamily(e: EngineKind): boolean {
  return e === 'direct' || e === 'directV2' || e === 'directV3';
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
// P1: 解析增强 — 支持 facts 为 [{text, importance}] 或纯 string[]（向后兼容）
function parseExtraction(s: string): { facts: Array<{ text: string; importance: number }>; projectFacts: Array<{ text: string; importance: number }>; triples: Array<{ s: string; p: string; o: string }> } {
  const empty = { facts: [] as Array<{ text: string; importance: number }>, projectFacts: [] as Array<{ text: string; importance: number }>, triples: [] as Array<{ s: string; p: string; o: string }> };
  const lo = s.indexOf('{');
  const hi = s.lastIndexOf('}');
  if (lo >= 0 && hi > lo) {
    try {
      const obj = JSON.parse(s.slice(lo, hi + 1)) as Record<string, unknown>;
      // 兼容两种格式：[{text, importance}] 或 string[]
      const parseFactArray = (arr: unknown): Array<{ text: string; importance: number }> => {
        const out: Array<{ text: string; importance: number }> = [];
        if (!Array.isArray(arr)) return out;
        for (const x of arr) {
          if (typeof x === 'string') {
            out.push({ text: x.trim(), importance: 5 });
          } else if (x && typeof x === 'object') {
            const r = x as Record<string, unknown>;
            const text = typeof r.text === 'string' ? r.text.trim() : '';
            const importance = typeof r.importance === 'number' ? Math.max(1, Math.min(10, Math.round(r.importance))) : 5;
            if (text) out.push({ text, importance });
          }
        }
        return out;
      };
      const facts = parseFactArray(obj.facts);
      // project_facts 是新增字段,旧格式不会返回 → 空数组兜底
      const projectFacts = parseFactArray(obj.project_facts);
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
      return { facts, projectFacts, triples };
    } catch {
      return empty;
    }
  }
  // 兼容老格式(纯 facts [])
  return { facts: parseFactsLegacy(s).map((text) => ({ text, importance: 5 })), projectFacts: [], triples: [] };
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

// ── 记忆模糊去重:文本相似度(embedding 不可用时的降级方案)──
// 1. 规范化:去"用户"前缀、去括号注释、去空格、转小写
// 2. 包含关系:短串是长串的子串 → 按长度比算相似度
// 3. bigram Jaccard:中文按字 bigram、英文按单词,集合交集比
// 取 max(包含比, Jaccard) 作为最终相似度,适配 5-30 字的短记忆。
function textSimilarity(aRaw: string, bRaw: string): number {
  const norm = (s: string): string => {
    let r = s.replace(/^用户/, '').trim();
    r = r.replace(/[（(].*?[)）]/g, '');
    r = r.replace(/\s+/g, '').toLowerCase();
    return r;
  };
  const a = norm(aRaw);
  const b = norm(bRaw);
  if (!a || !b) return 0;
  // 包含关系:短的是长的子串
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    return shorter > 3 ? shorter / longer : 0;
  }
  // bigram Jaccard
  const tokens = (s: string): Set<string> => {
    const t = new Set<string>();
    for (const w of s.match(/[a-z0-9]+/g) ?? []) t.add(w);
    for (let i = 0; i < s.length - 1; i++) t.add(s.slice(i, i + 2));
    return t;
  };
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// ── 跨引擎切换上下文摘要 ──
// 从已有 turns 生成一段紧凑的摘要,让新引擎理解"之前做了什么"。
// 纯文本格式(Direct → CLI 或 CLI → Direct 都能用),不依赖 LLM 调用(避免切引擎时还要等 API)。
// 最近 N 轮保留原文(prompt 截断 200 字 + answer 截断 500 字),更早的只留 prompt 第一句。
function buildCrossEngineSummary(turns: Turn[], fromEngine: EngineKind): string {
  const MAX_TURNS = 8;        // 最多取最近 8 轮
  const PROMPT_TRUNC = 200;   // 每轮 prompt 截断
  const ANSWER_TRUNC = 500;   // 每轮 answer 截断
  const recent = turns.slice(-MAX_TURNS);
  const lines: string[] = [
    `# 跨引擎上下文(从 ${fromEngine} 切换而来)`,
    `以下是之前会话的最近 ${recent.length} 轮摘要,请基于此继续。`,
    '',
  ];
  for (let i = 0; i < recent.length; i++) {
    const t = recent[i];
    const p = (t.prompt || '').slice(0, PROMPT_TRUNC);
    const a = (t.answer || '').slice(0, ANSWER_TRUNC);
    if (!p && !a) continue;
    lines.push(`## 第 ${i + 1} 轮`);
    if (p) lines.push(`用户: ${p}${t.prompt.length > PROMPT_TRUNC ? '…' : ''}`);
    if (a) lines.push(`助手: ${a}${t.answer.length > ANSWER_TRUNC ? '…' : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}
