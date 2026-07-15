// SQLite + FTS5 persistence. Port of Swift Store.swift, MVP schema only:
// history(FTS, recall_memory) + conversations + turns + memories.
// better-sqlite3 is synchronous — no dispatch-queue locking needed (unlike the Swift port).
import Database from 'better-sqlite3';
import path from 'node:path';
import { app } from 'electron';
import type { ChatMsg, Conversation, EngineKind, Turn } from '../shared/types';
import { newTurn } from '../shared/types';

let db: Database.Database;

function dbFile(): string {
  return path.join(app.getPath('userData'), 'history.db');
}

// Mirror Swift hasColumn(): check before ALTER so re-runs don't spam errors.
function hasColumn(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

export function initStore(): void {
  db = new Database(dbFile());
  db.pragma('journal_mode = WAL');
  // ponytail: multi-statement .exec runs the whole batch (like sqlite3_exec) —
  // .prepare would only run the first statement and silently skip the rest.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS history USING fts5(role, content);
    CREATE TABLE IF NOT EXISTS conversations(
      id TEXT PRIMARY KEY, engine TEXT, cwd TEXT, created_at REAL);
    CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, conv_id TEXT, data TEXT, created_at REAL);
    CREATE INDEX IF NOT EXISTS turns_conv ON turns(conv_id);
    CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, content TEXT, created_at REAL);
    CREATE TABLE IF NOT EXISTS memory_triples(
      id TEXT PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT,
      conversation_id TEXT, created_at REAL);
    CREATE TABLE IF NOT EXISTS cron_tasks(
      id TEXT PRIMARY KEY, cron TEXT, prompt TEXT, cwd TEXT,
      enabled INTEGER DEFAULT 1, last_run INTEGER, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS memory_embeddings(
      memory_id TEXT PRIMARY KEY, vec BLOB, model TEXT, created_at REAL);
    CREATE TABLE IF NOT EXISTS pipelines(
      id TEXT PRIMARY KEY, name TEXT, data TEXT, cwd TEXT, created_at REAL);
    CREATE TABLE IF NOT EXISTS prompt_templates(
      id TEXT PRIMARY KEY, name TEXT, data TEXT, created_at REAL);
    CREATE TABLE IF NOT EXISTS cost_log(
      id TEXT PRIMARY KEY, conv_id TEXT, engine TEXT, amount REAL, tokens INTEGER, ts REAL);
    CREATE TABLE IF NOT EXISTS custom_tools(
      id TEXT PRIMARY KEY, name TEXT, description TEXT, parameters TEXT, command_tpl TEXT, timeout_ms INTEGER, created_at REAL);
    CREATE TABLE IF NOT EXISTS memory_meta(
      memory_id TEXT PRIMARY KEY, weight REAL DEFAULT 1.0, last_used REAL DEFAULT 0, use_count INTEGER DEFAULT 0);
    -- 跨会话引用:用户在一个会话里 @conv:xxx 引用另一个会话的结果。
    -- ref_conv 是被引用的会话,source_conv 是引用方(可空 = 临时引用未持久化)。
    CREATE TABLE IF NOT EXISTS conv_refs(
      id TEXT PRIMARY KEY, source_conv TEXT, ref_conv TEXT, ref_turn_idx INTEGER,
      created_at REAL);
  `);
  for (const [col, def] of [
    ['custom_title', 'TEXT'],
    ['direct_history', 'TEXT'],
    ['engine_session_id', 'TEXT'],
    ['model', 'TEXT'],
    ['branch_info', 'TEXT'],   // JSON: BranchInfo(branchFrom 的来源信息),null = 原创会话
    ['pipeline_id', 'TEXT'],   // pipeline 创建的会话标记,null = 非 pipeline
  ] as const) {
    if (!hasColumn('conversations', col)) db.exec(`ALTER TABLE conversations ADD COLUMN ${col} ${def};`);
  }
  // memories 加 conversation_id(nullable:历史行 + 全局导入的都为 NULL,意为「来源频道未知/全局」)。
  if (!hasColumn('memories', 'conversation_id'))
    db.exec(`ALTER TABLE memories ADD COLUMN conversation_id TEXT;`);
}

// MARK: message-level FTS (recall_memory searches this)
export function appendMessage(role: string, content: string): void {
  db.prepare('INSERT INTO history(role, content) VALUES (?, ?);').run(role, content);
}

export function search(q: string, limit = 20): Array<{ role: string; content: string }> {
  const fts = sanitize(q);
  if (!fts) return [];
  return db
    .prepare('SELECT role, content FROM history WHERE history MATCH ? ORDER BY rowid DESC LIMIT ?;')
    .all(fts, limit) as Array<{ role: string; content: string }>;
}

// FTS5: wrap each whitespace-separated token in double-quotes. Same as Swift sanitize().
function sanitize(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

// MARK: conversations + turns (restart recovery)
type ConvRow = {
  id: string;
  engine: string;
  cwd: string;
  created_at: number;
  custom_title: string | null;
  direct_history: string | null;
  engine_session_id: string | null;
  model: string | null;
  branch_info: string | null;
  pipeline_id: string | null;
};

export function saveConversation(c: Conversation): void {
  db.prepare(
    `INSERT INTO conversations(id, engine, cwd, created_at, custom_title, engine_session_id, model, branch_info, pipeline_id)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET engine=excluded.engine, cwd=excluded.cwd,
       custom_title=excluded.custom_title, engine_session_id=excluded.engine_session_id, model=excluded.model,
       branch_info=excluded.branch_info, pipeline_id=excluded.pipeline_id;`,
  ).run(c.id, c.engine, c.cwd, c.createdAt, c.customTitle, c.engineSessionId, c.model,
    c.branchInfo ? JSON.stringify(c.branchInfo) : null,
    c.pipelineId ?? null);
}

export function updateConversationMeta(c: Conversation): void {
  db.prepare('UPDATE conversations SET custom_title=? WHERE id=?;').run(c.customTitle, c.id);
}

export function updateConversationCwd(c: Conversation): void {
  db.prepare('UPDATE conversations SET cwd=? WHERE id=?;').run(c.cwd, c.id);
}

export function updateConversationSession(c: Conversation): void {
  db.prepare('UPDATE conversations SET engine_session_id=? WHERE id=?;').run(c.engineSessionId, c.id);
}

export function saveDirectHistory(c: Conversation): void {
  db.prepare('UPDATE conversations SET direct_history=? WHERE id=?;').run(
    JSON.stringify(c.directHistory ?? []),
    c.id,
  );
}

export function saveTurn(convId: string, t: Turn): void {
  db.prepare(
    `INSERT INTO turns(id, conv_id, data, created_at) VALUES(?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET data=excluded.data;`,
  ).run(t.id, convId, JSON.stringify(t), t.ts);
}

export function deleteConversation(id: string): void {
  // 事务保证原子性 —— 崩溃不会留孤儿 turns
  db.transaction(() => {
    db.prepare('DELETE FROM turns WHERE conv_id=?;').run(id);
    db.prepare('DELETE FROM cost_log WHERE conv_id=?;').run(id);
    db.prepare('DELETE FROM memory_triples WHERE conversation_id=?;').run(id);
    db.prepare('DELETE FROM conversations WHERE id=?;').run(id);
  })();
}

export function deleteTurns(convId: string): void {
  db.prepare('DELETE FROM turns WHERE conv_id=?;').run(convId);
}

function loadTurns(convId: string): Turn[] {
  const rows = db.prepare('SELECT data FROM turns WHERE conv_id=? ORDER BY created_at;').all(convId) as Array<{
    data: string;
  }>;
  return rows.map((r) => parseTurn(r.data));
}

// Tolerant decode — old blobs may miss cost/token fields (mirrors Swift init(from:)).
function parseTurn(data: string): Turn {
  try {
    const o = JSON.parse(data) as Partial<Turn> & { prompt: string };
    const t = newTurn(o.prompt ?? '');
    return { ...t, ...o, id: o.id ?? t.id, ts: o.ts ?? t.ts, error: o.error ?? null };
  } catch {
    return newTurn('(unparseable turn)');
  }
}

export function loadConversations(): Conversation[] {
  const rows = db
    .prepare(
      'SELECT id, engine, cwd, created_at, custom_title, direct_history, engine_session_id, model, branch_info, pipeline_id FROM conversations ORDER BY created_at DESC;',
    )
    .all() as ConvRow[];
  return rows.map((r) => {
    let directHistory: ChatMsg[] = [];
    try {
      const parsed = JSON.parse(r.direct_history ?? '[]');
      if (Array.isArray(parsed)) directHistory = parsed as ChatMsg[];
    } catch {
      /* leave empty */
    }
    const turns = loadTurns(r.id);
    const engine: EngineKind = (['direct', 'claudeCode', 'codex'] as const).includes(r.engine as EngineKind)
      ? (r.engine as EngineKind)
      : 'direct';
    const conv: Conversation = {
      id: r.id,
      engine,
      model: r.model || '',
      cwd: r.cwd || '',
      createdAt: r.created_at ?? 0,
      customTitle: r.custom_title || null,
      directHistory,
      engineSessionId: r.engine_session_id || null,
      turns,
      status: 'ready',
      statusNote: null,
      // Backfill aggregate cost/tokens on load — turns persist the real numbers.
      cost: turns.reduce((s, t) => s + (t.costUSD ?? 0), 0),
      tokens: turns.reduce((s, t) => s + (t.tokensIn ?? 0) + (t.tokensOut ?? 0), 0),
      // 恢复分支信息(branchFrom 创建的关系)和 pipeline 标记 —— 重启后任务图边不丢。
      branchInfo: r.branch_info ? (() => { try { return JSON.parse(r.branch_info); } catch { return null; } })() : null,
      pipelineId: r.pipeline_id ?? null,
    };
    return conv;
  });
}

// MARK: long-term memory (injected into the system prompt)
// convId 过滤:有值只返回该频道产生的;undefined 返回全部。
export function loadMemories(convId?: string): Array<{ id: string; content: string; conversation_id: string | null }> {
  if (convId === undefined) {
    return db.prepare('SELECT id, content, conversation_id FROM memories ORDER BY created_at DESC;').all() as Array<{
      id: string;
      content: string;
      conversation_id: string | null;
    }>;
  }
  return db.prepare('SELECT id, content, conversation_id FROM memories WHERE conversation_id=? ORDER BY created_at DESC;').all(convId) as Array<{
    id: string;
    content: string;
    conversation_id: string | null;
  }>;
}

export function allMemoryContents(): string[] {
  return (db.prepare('SELECT content FROM memories;').all() as Array<{ content: string }>).map((r) => r.content);
}

export function addMemory(content: string, convId?: string): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  db.prepare('INSERT INTO memories(id, content, created_at, conversation_id) VALUES(?,?,?,?);').run(
    id,
    content,
    Date.now() / 1000,
    convId ?? null,
  );
  return id;
}

export function updateMemory(id: string, content: string): void {
  db.prepare('UPDATE memories SET content=? WHERE id=?;').run(content, id);
}

export function deleteMemory(id: string): void {
  // 级联清理孤儿数据(embeddings + meta)——没有外键约束,手动删。
  // 事务保证原子性。
  db.transaction(() => {
    db.prepare('DELETE FROM memories WHERE id=?;').run(id);
    db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?;').run(id);
    db.prepare('DELETE FROM memory_meta WHERE memory_id=?;').run(id);
  })();
}

// MARK: memory graph(实体关系三元组;与 memories 并行,不互依)
// 提取器从对话里抽 (subject, predicate, object),例:(用户, 偏好, Tailwind) / (用户, 在做, Halo 项目)。
// ponytail: 不做 entity 字典/归一化 —— 直接存原文,模型自己处理同义;后续可加规范化层。
export function loadMemoryTriples(convId?: string): Array<{ id: string; subject: string; predicate: string; object: string; conversation_id: string | null; created_at: number }> {
  if (convId === undefined) {
    return db
      .prepare('SELECT id, subject, predicate, object, conversation_id, created_at FROM memory_triples ORDER BY created_at DESC;')
      .all() as Array<{ id: string; subject: string; predicate: string; object: string; conversation_id: string | null; created_at: number }>;
  }
  return db
    .prepare('SELECT id, subject, predicate, object, conversation_id, created_at FROM memory_triples WHERE conversation_id=? ORDER BY created_at DESC;')
    .all(convId) as Array<{ id: string; subject: string; predicate: string; object: string; conversation_id: string | null; created_at: number }>;
}

// MARK: 记忆溯源 — 查找三元组来自哪次对话的哪条 turn / Provenance lookup
// 返回会话 id、engine、原始 prompt(触发记忆提取的那条用户消息)。
export function tripleProvenance(convId: string | null): { convId: string | null; engine: string | null; prompt: string | null; turnId: string | null } {
  if (!convId) return { convId: null, engine: null, prompt: null, turnId: null };
  // 拿会话 engine
  const conv = db.prepare('SELECT engine FROM conversations WHERE id=?;').get(convId) as { engine: string } | undefined;
  // 拿该会话的第一条 turn 的 prompt(通常是触发记忆提取的那条)
  const turn = db.prepare('SELECT id, data FROM turns WHERE conv_id=? ORDER BY created_at ASC LIMIT 1;').get(convId) as { id: string; data: string } | undefined;
  let prompt: string | null = null;
  let turnId: string | null = null;
  if (turn) {
    turnId = turn.id;
    try {
      const parsed = JSON.parse(turn.data) as { prompt?: string };
      prompt = parsed.prompt ?? null;
    } catch { /* ignore */ }
  }
  return { convId, engine: conv?.engine ?? null, prompt, turnId };
}

export function allMemoryTripleKeys(): Set<string> {
  const rows = db.prepare('SELECT subject, predicate, object FROM memory_triples;').all() as Array<{
    subject: string;
    predicate: string;
    object: string;
  }>;
  return new Set(rows.map((r) => `${r.subject}|${r.predicate}|${r.object}`.toLowerCase()));
}

export function addMemoryTriple(subject: string, predicate: string, object: string, convId?: string): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  db.prepare(
    'INSERT INTO memory_triples(id, subject, predicate, object, conversation_id, created_at) VALUES(?,?,?,?,?,?);',
  ).run(id, subject, predicate, object, convId ?? null, Date.now() / 1000);
  return id;
}

export function deleteMemoryTriple(id: string): void {
  db.prepare('DELETE FROM memory_triples WHERE id=?;').run(id);
}

// MARK: cron_tasks —— 定时任务调度器持久化(每分钟 tick 一遍,匹配 cron 字段就派发)
export interface CronRow {
  id: string;
  cron: string;
  prompt: string;
  cwd: string | null;
  enabled: boolean;
  lastRun: number | null;
  createdAt: number;
}
export function listCronTasks(): CronRow[] {
  const rows = db.prepare('SELECT id, cron, prompt, cwd, enabled, last_run, created_at FROM cron_tasks ORDER BY created_at DESC;').all() as Array<{
    id: string; cron: string; prompt: string; cwd: string | null; enabled: number; last_run: number | null; created_at: number;
  }>;
  return rows.map((r) => ({ id: r.id, cron: r.cron, prompt: r.prompt, cwd: r.cwd, enabled: !!r.enabled, lastRun: r.last_run, createdAt: r.created_at }));
}
export function addCronTask(t: { id: string; cron: string; prompt: string; cwd?: string }): void {
  db.prepare('INSERT INTO cron_tasks(id, cron, prompt, cwd, enabled, created_at) VALUES(?,?,?,?,1,?);')
    .run(t.id, t.cron, t.prompt, t.cwd ?? null, Date.now());
}
export function updateCronTask(id: string, patch: { cron?: string; prompt?: string; cwd?: string; enabled?: boolean }): void {
  const cur = db.prepare('SELECT * FROM cron_tasks WHERE id=?;').get(id) as { cron: string; prompt: string; cwd: string | null; enabled: number } | undefined;
  if (!cur) return;
  const next = {
    cron: patch.cron ?? cur.cron,
    prompt: patch.prompt ?? cur.prompt,
    cwd: patch.cwd !== undefined ? (patch.cwd || null) : cur.cwd,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
  };
  db.prepare('UPDATE cron_tasks SET cron=?, prompt=?, cwd=?, enabled=? WHERE id=?;')
    .run(next.cron, next.prompt, next.cwd, next.enabled, id);
}
export function deleteCronTask(id: string): void {
  db.prepare('DELETE FROM cron_tasks WHERE id=?;').run(id);
}
export function touchCronLastRun(id: string, ts: number): void {
  db.prepare('UPDATE cron_tasks SET last_run=? WHERE id=?;').run(ts, id);
}

// MARK: memory_embeddings —— Float32Array 存 BLOB。recall_memory 用 cosine 暴力 top-K。
export interface MemoryEmbeddingRow {
  memoryId: string;
  content: string;
  vec: Float32Array;
}
export function setMemoryEmbedding(memoryId: string, vec: number[], model: string): void {
  const buf = Buffer.from(new Float32Array(vec).buffer);
  db.prepare('INSERT OR REPLACE INTO memory_embeddings(memory_id, vec, model, created_at) VALUES(?,?,?,?);')
    .run(memoryId, buf, model, Date.now());
}
export function deleteMemoryEmbedding(memoryId: string): void {
  db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?;').run(memoryId);
}
export function listMemoryEmbeddings(): MemoryEmbeddingRow[] {
  const rows = db.prepare(
    'SELECT e.memory_id AS memoryId, e.vec AS vec, m.content AS content FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id;',
  ).all() as Array<{ memoryId: string; vec: Uint8Array; content: string }>;
  return rows.map((r) => ({
    memoryId: r.memoryId,
    content: r.content,
    vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4),
  }));
}
// cosine similarity,两个向量必须同维度。ponytail: 暴力 O(n),记忆规模(~几百条)够用。
export function cosine(a: Float32Array, b: Float32Array): number {
  // 维度不匹配(换 embedding 模型后常见)→ 返回 0 而非 NaN
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// MARK: pipelines — 跨引擎编排流水线持久化
export function savePipeline(p: { id: string; name: string; data: string; cwd: string }): void {
  db.prepare('INSERT OR REPLACE INTO pipelines(id, name, data, cwd, created_at) VALUES(?,?,?,?,?);')
    .run(p.id, p.name, p.data, p.cwd, Date.now());
}
export function loadPipelines(): Array<{ id: string; name: string; data: string; cwd: string; createdAt: number }> {
  return db.prepare('SELECT id, name, data, cwd, created_at AS createdAt FROM pipelines ORDER BY created_at DESC;').all() as Array<{ id: string; name: string; data: string; cwd: string; createdAt: number }>;
}
export function deletePipeline(id: string): void {
  db.prepare('DELETE FROM pipelines WHERE id=?;').run(id);
}

// MARK: prompt templates
export function saveTemplate(t: { id: string; name: string; data: string }): void {
  db.prepare('INSERT OR REPLACE INTO prompt_templates(id, name, data, created_at) VALUES(?,?,?,?);')
    .run(t.id, t.name, t.data, Date.now());
}
export function loadTemplates(): Array<{ id: string; name: string; data: string }> {
  return db.prepare('SELECT id, name, data FROM prompt_templates ORDER BY created_at DESC;').all() as Array<{ id: string; name: string; data: string }>;
}
export function deleteTemplate(id: string): void {
  db.prepare('DELETE FROM prompt_templates WHERE id=?;').run(id);
}

// MARK: cost_log — 每次会话完成时记一笔,用于成本看板趋势图
export function logCost(convId: string, engine: string, amount: number, tokens: number): void {
  db.prepare('INSERT INTO cost_log(id, conv_id, engine, amount, tokens, ts) VALUES(?,?,?,?,?,?);')
    .run(rid(), convId, engine, amount, tokens, Date.now());
}
export function costStats(): { today: number; week: number; month: number; byEngine: Record<string, number>; byDay: Array<{ date: string; cost: number }> } {
  const now = Date.now();
  const dayMs = 86400_000;
  const all = (db.prepare('SELECT engine, amount, ts FROM cost_log ORDER BY ts ASC;').all()) as Array<{ engine: string; amount: number; ts: number }>;
  let today = 0, week = 0, month = 0;
  const byEngine: Record<string, number> = {};
  const dayMap = new Map<string, number>();
  for (const r of all) {
    byEngine[r.engine] = (byEngine[r.engine] ?? 0) + r.amount;
    if (r.ts >= now - dayMs) today += r.amount;
    if (r.ts >= now - 7 * dayMs) week += r.amount;
    if (r.ts >= now - 30 * dayMs) month += r.amount;
    const d = new Date(r.ts).toISOString().slice(0, 10);
    dayMap.set(d, (dayMap.get(d) ?? 0) + r.amount);
  }
  // 取最近 14 天
  const byDay: Array<{ date: string; cost: number }> = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * dayMs).toISOString().slice(0, 10);
    byDay.push({ date: d, cost: dayMap.get(d) ?? 0 });
  }
  return { today, week, month, byEngine, byDay };
}

// 轻量 id 生成 —— 复用 shared/types 的 rid()。
import { rid } from '../shared/types';

// MARK: custom_tools — 用户通过 UI 注册的自定义工具
export function saveCustomTool(t: { id: string; name: string; description: string; parameters: string; commandTpl: string; timeoutMs: number }): void {
  db.prepare('INSERT OR REPLACE INTO custom_tools(id, name, description, parameters, command_tpl, timeout_ms, created_at) VALUES(?,?,?,?,?,?,?);')
    .run(t.id, t.name, t.description, t.parameters, t.commandTpl, t.timeoutMs, Date.now());
}
export function loadCustomTools(): Array<{ id: string; name: string; description: string; parameters: string; commandTpl: string; timeoutMs: number; createdAt: number }> {
  return db.prepare('SELECT id, name, description, parameters, command_tpl AS commandTpl, timeout_ms AS timeoutMs, created_at AS createdAt FROM custom_tools ORDER BY created_at DESC;').all() as Array<{ id: string; name: string; description: string; parameters: string; commandTpl: string; timeoutMs: number; createdAt: number }>;
}
export function deleteCustomTool(id: string): void {
  db.prepare('DELETE FROM custom_tools WHERE id=?;').run(id);
}

// MARK: memory_meta — 记忆权重/衰减/时间线
export function loadMemoryTimeline(): Array<{ id: string; content: string; conversation_id: string | null; created_at: number; weight: number; lastUsed: number; useCount: number }> {
  const mems = (db.prepare('SELECT id, content, conversation_id, created_at FROM memories ORDER BY created_at DESC;').all()) as Array<{ id: string; content: string; conversation_id: string | null; created_at: number }>;
  const metas = new Map<string, { weight: number; last_used: number; use_count: number }>();
  for (const m of (db.prepare('SELECT memory_id, weight, last_used, use_count FROM memory_meta;').all()) as Array<{ memory_id: string; weight: number; last_used: number; use_count: number }>) {
    metas.set(m.memory_id, { weight: m.weight, last_used: m.last_used, use_count: m.use_count });
  }
  return mems.map((m) => {
    const meta = metas.get(m.id) ?? { weight: 1.0, last_used: 0, use_count: 0 };
    // created_at 存的是 Unix 秒,前端 new Date() 需要毫秒 → ×1000
    return { ...m, created_at: m.created_at * 1000, weight: meta.weight, lastUsed: meta.last_used, useCount: meta.use_count };
  });
}

// 触摸一条记忆的 lastUsed(被 recall 命中时调用)
// 使用 INSERT ... ON CONFLICT 避免 read-then-write 竞态
export function touchMemoryUsed(id: string): void {
  db.prepare(`INSERT INTO memory_meta(memory_id, weight, last_used, use_count)
    VALUES(?, 1.0, ?, 1)
    ON CONFLICT(memory_id) DO UPDATE SET last_used=excluded.last_used, use_count=use_count+1;`)
    .run(id, Date.now());
}

// 执行衰减:weight *= 0.95^(days_since_last_used),weight < 0.1 的连同 memory 一起删除。
// 返回被清除的条数。
// 未被 recall 命中过(last_used=0)的记忆用 created_at 做 fallback,而非当成 1970 年。
export function decayMemories(): number {
  const now = Date.now();
  const dayMs = 86400_000;
  const all = (db.prepare('SELECT memory_id, weight, last_used FROM memory_meta;').all()) as Array<{ memory_id: string; weight: number; last_used: number }>;
  let pruned = 0;
  for (const m of all) {
    // last_used=0 → 用 created_at 做 fallback(从 memories 表取)
    let refTs = m.last_used;
    if (!refTs) {
      const mem = (db.prepare('SELECT created_at FROM memories WHERE id=?;').get(m.memory_id)) as { created_at: number } | undefined;
      refTs = mem?.created_at ?? now;
    }
    const days = (now - refTs) / dayMs;
    const decayed = m.weight * Math.pow(0.95, days);
    if (decayed < 0.1) {
      db.prepare('DELETE FROM memories WHERE id=?;').run(m.memory_id);
      db.prepare('DELETE FROM memory_meta WHERE memory_id=?;').run(m.memory_id);
      db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?;').run(m.memory_id);
      pruned++;
    } else {
      db.prepare('UPDATE memory_meta SET weight=? WHERE memory_id=?;').run(decayed, m.memory_id);
    }
  }
  return pruned;
}

// MARK: conv_refs — 跨会话引用记录 / Cross-conversation references
// 用户用 @conv:xxx 引用另一个会话时,记录引用关系(用于任务图 / 可追溯性)。
export function addConvRef(sourceConv: string | null, refConv: string, refTurnIdx?: number): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  db.prepare('INSERT INTO conv_refs(id, source_conv, ref_conv, ref_turn_idx, created_at) VALUES(?,?,?,?,?);')
    .run(id, sourceConv, refConv, refTurnIdx ?? null, Date.now() / 1000);
  return id;
}

export function loadConvRefs(convId?: string): Array<{ id: string; sourceConv: string | null; refConv: string; refTurnIdx: number | null; createdAt: number }> {
  if (convId === undefined) {
    return (db.prepare('SELECT id, source_conv AS sourceConv, ref_conv AS refConv, ref_turn_idx AS refTurnIdx, created_at AS createdAt FROM conv_refs ORDER BY created_at DESC;').all()) as Array<{ id: string; sourceConv: string | null; refConv: string; refTurnIdx: number | null; createdAt: number }>;
  }
  return (db.prepare('SELECT id, source_conv AS sourceConv, ref_conv AS refConv, ref_turn_idx AS refTurnIdx, created_at AS createdAt FROM conv_refs WHERE source_conv=? OR ref_conv=? ORDER BY created_at DESC;').all(convId, convId)) as Array<{ id: string; sourceConv: string | null; refConv: string; refTurnIdx: number | null; createdAt: number }>;
}

export function deleteConvRef(id: string): void {
  db.prepare('DELETE FROM conv_refs WHERE id=?;').run(id);
}

// MARK: 任务图(Task Graph)— 查询会话间的 DAG 关系
// 一个会话可以:① 分支自另一个会话(branchInfo);② 引用另一个会话(conv_refs);
// ③ 作为 pipeline 的一个 stage;④ 通过 dispatch_agent 派发子任务。
// 这里提供查询会话间关系的函数,renderer 用它画 DAG 图。
export interface TaskGraphNode {
  id: string;
  engine: string;
  cwd: string;
  createdAt: number;
  customTitle: string | null;
  turns: number;
  cost: number;
}

export interface TaskGraphEdge {
  from: string; // 源节点 conv id
  to: string;   // 目标节点 conv id
  type: 'branch' | 'reference' | 'pipeline' | 'dispatch';
  meta?: Record<string, unknown>;
}

export function loadTaskGraph(): { nodes: TaskGraphNode[]; edges: TaskGraphEdge[] } {
  // 节点:所有会话
  const convs = loadConversations();
  const nodes: TaskGraphNode[] = convs.map((c) => ({
    id: c.id,
    engine: c.engine,
    cwd: c.cwd,
    createdAt: c.createdAt,
    customTitle: c.customTitle,
    turns: c.turns.length,
    cost: c.cost,
  }));
  // 边:分支 + 引用(pipeline/dispatch 从 branchInfo 和 conv_refs 推断)
  const edges: TaskGraphEdge[] = [];
  for (const c of convs) {
    if (c.branchInfo) {
      edges.push({ from: c.branchInfo.sourceConvId, to: c.id, type: 'branch', meta: { turnIdx: c.branchInfo.sourceTurnIdx } });
    }
  }
  const refs = loadConvRefs();
  for (const r of refs) {
    if (r.sourceConv) {
      edges.push({ from: r.sourceConv, to: r.refConv, type: 'reference', meta: { turnIdx: r.refTurnIdx } });
    }
  }
  return { nodes, edges };
}

// MARK: searchEnriched — FTS5 全文搜索 + 关联会话信息
// history 表没有 conv_id,通过 turns 表的 data JSON 反查会话。
export function searchEnriched(q: string, limit = 50): Array<{ role: string; content: string; convId: string | null; convTitle: string | null }> {
  const fts = sanitize(q);
  if (!fts) return [];
  const results = db
    .prepare('SELECT role, content FROM history WHERE history MATCH ? ORDER BY rowid DESC LIMIT ?;')
    .all(fts, limit) as Array<{ role: string; content: string }>;
  // 用 turns 表反查 conv_id:取 content 前 50 字符做 LIKE 匹配。
  const stmtConv = db.prepare('SELECT conv_id FROM turns WHERE data LIKE ? LIMIT 1;');
  const stmtTitle = db.prepare('SELECT engine, cwd, custom_title FROM conversations WHERE id=?;');
  return results.map((r) => {
    let convId: string | null = null;
    let convTitle: string | null = null;
    try {
      const snippet = r.content.slice(0, 50).replace(/[%_]/g, (c) => '%' + c);
      const row = stmtConv.get(`%${snippet}%`) as { conv_id: string } | undefined;
      if (row) {
        convId = row.conv_id;
        const meta = stmtTitle.get(row.conv_id) as { engine: string; cwd: string; custom_title: string | null } | undefined;
        if (meta?.custom_title) convTitle = meta.custom_title;
      }
    } catch { /* best-effort */ }
    return { role: r.role, content: r.content, convId, convTitle };
  });
}

// MARK: arenaAggregate — 按引擎聚合统计(给 Arena 深度仪表盘用)
// 从 cost_log + conversations + turns 聚合:总成本/总 token/总耗时/工具调用数/会话数。
export function arenaAggregate(): Array<{
  engine: string;
  sessions: number;
  totalCost: number;
  totalTokens: number;
  totalTools: number;
  avgCost: number;
  avgTokens: number;
  avgTools: number;
  avgTurnDurationMs: number;
  costByDay: Array<{ date: string; cost: number }>;
}> {
  // 1. cost_log 聚合
  const costRows = db.prepare('SELECT engine, amount, tokens, ts FROM cost_log ORDER BY ts ASC;').all() as Array<{ engine: string; amount: number; tokens: number; ts: number }>;
  // 2. turns 里的 steps(工具调用)统计
  const convRows = db.prepare('SELECT id, engine FROM conversations;').all() as Array<{ id: string; engine: string }>;
  const turnRows = db.prepare('SELECT conv_id, data FROM turns;').all() as Array<{ conv_id: string; data: string }>;
  // 按 engine 聚合
  const engines = new Set<string>(['direct', 'claudeCode', 'codex']);
  for (const r of costRows) engines.add(r.engine);
  for (const c of convRows) engines.add(c.engine);
  const result: Array<{
    engine: string; sessions: number; totalCost: number; totalTokens: number;
    totalTools: number; avgCost: number; avgTokens: number; avgTools: number;
    avgTurnDurationMs: number; costByDay: Array<{ date: string; cost: number }>;
  }> = [];
  for (const engine of engines) {
    const sessions = convRows.filter((c) => c.engine === engine).length;
    const costs = costRows.filter((r) => r.engine === engine);
    const totalCost = costs.reduce((s, r) => s + r.amount, 0);
    const totalTokens = costs.reduce((s, r) => s + r.tokens, 0);
    // 工具调用数:遍历该 engine 的 turns → 解析 data JSON → 统计 steps 数组长度
    let totalTools = 0;
    let totalDuration = 0;
    let turnCount = 0;
    const engineConvIds = new Set(convRows.filter((c) => c.engine === engine).map((c) => c.id));
    for (const t of turnRows) {
      if (!engineConvIds.has(t.conv_id)) continue;
      try {
        const parsed = JSON.parse(t.data) as { steps?: Array<{ durationMs?: number }> };
        totalTools += parsed.steps?.length ?? 0;
        for (const s of parsed.steps ?? []) totalDuration += s.durationMs ?? 0;
        turnCount++;
      } catch { /* skip */ }
    }
    // cost by day (最近 7 天)
    const now = Date.now();
    const dayMs = 86400_000;
    const dayMap = new Map<string, number>();
    for (const r of costs) {
      if (r.ts >= now - 7 * dayMs) {
        const d = new Date(r.ts).toISOString().slice(0, 10);
        dayMap.set(d, (dayMap.get(d) ?? 0) + r.amount);
      }
    }
    const costByDay: Array<{ date: string; cost: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * dayMs).toISOString().slice(0, 10);
      costByDay.push({ date: d, cost: dayMap.get(d) ?? 0 });
    }
    result.push({
      engine, sessions, totalCost, totalTokens, totalTools,
      avgCost: sessions ? totalCost / sessions : 0,
      avgTokens: sessions ? totalTokens / sessions : 0,
      avgTools: sessions ? totalTools / sessions : 0,
      avgTurnDurationMs: turnCount ? totalDuration / turnCount : 0,
      costByDay,
    });
  }
  return result;
}
