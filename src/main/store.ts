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
  `);
  for (const [col, def] of [
    ['custom_title', 'TEXT'],
    ['direct_history', 'TEXT'],
    ['engine_session_id', 'TEXT'],
    ['model', 'TEXT'],
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
};

export function saveConversation(c: Conversation): void {
  db.prepare(
    `INSERT INTO conversations(id, engine, cwd, created_at, custom_title, engine_session_id, model)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET engine=excluded.engine, cwd=excluded.cwd,
       custom_title=excluded.custom_title, engine_session_id=excluded.engine_session_id, model=excluded.model;`,
  ).run(c.id, c.engine, c.cwd, c.createdAt, c.customTitle, c.engineSessionId, c.model);
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
  db.prepare('DELETE FROM turns WHERE conv_id=?;').run(id);
  db.prepare('DELETE FROM conversations WHERE id=?;').run(id);
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
      'SELECT id, engine, cwd, created_at, custom_title, direct_history, engine_session_id, model FROM conversations ORDER BY created_at DESC;',
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
  db.prepare('DELETE FROM memories WHERE id=?;').run(id);
}

// MARK: memory graph(实体关系三元组;与 memories 并行,不互依)
// 提取器从对话里抽 (subject, predicate, object),例:(用户, 偏好, Tailwind) / (用户, 在做, Halo 项目)。
// ponytail: 不做 entity 字典/归一化 —— 直接存原文,模型自己处理同义;后续可加规范化层。
export function loadMemoryTriples(convId?: string): Array<{ id: string; subject: string; predicate: string; object: string; conversation_id: string | null }> {
  if (convId === undefined) {
    return db
      .prepare('SELECT id, subject, predicate, object, conversation_id FROM memory_triples ORDER BY created_at DESC;')
      .all() as Array<{ id: string; subject: string; predicate: string; object: string; conversation_id: string | null }>;
  }
  return db
    .prepare('SELECT id, subject, predicate, object, conversation_id FROM memory_triples WHERE conversation_id=? ORDER BY created_at DESC;')
    .all(convId) as Array<{ id: string; subject: string; predicate: string; object: string; conversation_id: string | null }>;
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
