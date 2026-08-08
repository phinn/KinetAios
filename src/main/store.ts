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

// 检查表是否存在(旧版 DB 可能未迁移,memory_embeddings/memory_meta 等表缺失)
function hasTable(table: string): boolean {
  return (db.prepare("SELECT count(*) as n FROM sqlite_master WHERE type='table' AND name=?;").get(table) as { n: number }).n > 0;
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
    -- 会话级 KV 锚点(P0-2):remember_fact / recall_fact 用。
    -- key 在同一 conv 内唯一,value 是 JSON 或纯文本。sub-agent 也可以 recall_fact 跨子任务共享。
    CREATE TABLE IF NOT EXISTS conv_facts(
      conv_id TEXT, key TEXT, value TEXT, updated_at REAL,
      PRIMARY KEY(conv_id, key));
    -- P2:AgentTeams — 团队成员 + 他们的历史。每个 team 挂在主 conv 下,多个 member 各自独立 history。
    CREATE TABLE IF NOT EXISTS team_members(
      team_id TEXT, member_id TEXT, name TEXT, role TEXT,
      history TEXT, last_message TEXT, last_result TEXT,
      status TEXT, created_at REAL, updated_at REAL,
      PRIMARY KEY(team_id, member_id));
    -- V2 逐步持久化:每步完成后存 plan JSON + execHistory JSON。
    -- crash 后 resume 时读取最后一条 v2_state 恢复执行进度。
    -- row_type = 'step_checkpoint':逐步 checkpoint; row_type = 'final':最终结果。
    CREATE TABLE IF NOT EXISTS v2_state(
      conv_id TEXT, step_id TEXT, row_type TEXT,
      plan_json TEXT, history_json TEXT, created_at REAL,
      PRIMARY KEY(conv_id, step_id));
    -- P0: Memory Blocks — 结构化核心记忆(借鉴 Letta Memory Blocks)。
    -- label 是 block 类型(persona/user_profile/project_context/active_goals),
    -- value 是内容,char_limit 防膨胀,read_only 标记不可被 agent 编辑。
    -- 与 memories 的区别:memories 是追加式事实流,memory_blocks 是结构化、可原地编辑的常驻块。
    CREATE TABLE IF NOT EXISTS memory_blocks(
      label TEXT PRIMARY KEY, value TEXT, char_limit INTEGER DEFAULT 2000,
      read_only INTEGER DEFAULT 0, updated_at REAL);
    -- P2: Episodic Memory — 会话摘要(每次 done 后自动提取)。
    -- 与 memories(facts)的区别:episodic 是"这次会话做了什么"的叙事摘要,
    -- memories 是"关于用户的持久事实"。episodic 用于跨会话回忆"上次那个 bug 怎么修的"。
    CREATE TABLE IF NOT EXISTS episodic_memories(
      id TEXT PRIMARY KEY, conv_id TEXT, summary TEXT,
      importance INTEGER DEFAULT 5, tags TEXT,
      created_at REAL);
  `);
  for (const [col, def] of [
    ['custom_title', 'TEXT'],
    ['direct_history', 'TEXT'],
    ['engine_session_id', 'TEXT'],
    ['model', 'TEXT'],
    ['branch_info', 'TEXT'],   // JSON: BranchInfo(branchFrom 的来源信息),null = 原创会话
    ['pipeline_id', 'TEXT'],   // pipeline 创建的会话标记,null = 非 pipeline
    ['goal', 'TEXT'],          // 会话目标(/goal 设置,持续注入 systemPrompt),null = 无目标
    ['profile_id', 'TEXT'],    // 绑定的模型配置档 ID,null = 用全局默认配置
    ['high_fidelity', 'INTEGER'], // deprecated: 旧列,保留做 migration 兼容(见 context_mode)
    ['context_mode', 'TEXT'],     // 上下文模式:standard(默认) / hifi(不截断+大预算) / 未来可扩展
    ['persona_enabled', 'INTEGER'], // 替身画像开关:1 = 注入(默认), 0 = 本会话关闭
    ['updated_at', 'REAL'],       // 最后活动时间:每次 saveTurn / saveConversation 时更新。用于侧栏"按最近活动排序"
    ['sub_agent_model', 'TEXT'],  // 子 agent 模型(空 = 跟随主模型),每会话独立保存
    ['wecom_key', 'TEXT'],        // 企微会话来源 key(userid),用于按用户复用会话
    ['feishu_key', 'TEXT'],       // 飞书会话来源 key(open_id),用于按用户复用会话
  ] as const) {
    if (!hasColumn('conversations', col)) db.exec(`ALTER TABLE conversations ADD COLUMN ${col} ${def};`);
  }
  // memories 加 conversation_id(nullable:历史行 + 全局导入的都为 NULL,意为「来源频道未知/全局」)。
  if (!hasColumn('memories', 'conversation_id'))
    db.exec(`ALTER TABLE memories ADD COLUMN conversation_id TEXT;`);
  // P1: memories 加 importance 列(1-10 分,LLM 提取时输出,默认 5)。
  // 检索排序:importance * 0.5 + recency * 0.3 + relevance * 0.2。
  if (!hasColumn('memories', 'importance'))
    db.exec(`ALTER TABLE memories ADD COLUMN importance INTEGER DEFAULT 5;`);
  // P0: 初始化 Memory Blocks 默认值
  initMemoryBlocks();
}

// Prepared statement 缓存:热路径函数(appendMessage/saveTurn 等)每次调用都 prepare,
// 产生大量临时 Statement JS 对象 + GC 压力。缓存复用,避免内存抖动。
const stmtCache = new Map<string, Database.Statement>();
function stmt(sql: string): Database.Statement {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}

// MARK: message-level FTS (recall_memory searches this)
export function appendMessage(role: string, content: string): void {
  stmt('INSERT INTO history(role, content) VALUES (?, ?);').run(role, content);
}

export function search(q: string, limit = 20): Array<{ role: string; content: string }> {
  const fts = sanitize(q);
  if (!fts) return [];
  try {
    return db
      .prepare('SELECT role, content FROM history WHERE history MATCH ? ORDER BY rowid DESC LIMIT ?;')
      .all(fts, limit) as Array<{ role: string; content: string }>;
  } catch {
    // FTS5 语法错误 → 用转义后的查询重试
    const safe = q.replace(/["*]/g, ' ').trim();
    if (!safe) return [];
    return db
      .prepare('SELECT role, content FROM history WHERE history MATCH ? ORDER BY rowid DESC LIMIT ?;')
      .all(sanitize(safe), limit) as Array<{ role: string; content: string }>;
  }
}

// FTS5 查询构建:英文按空格分词 + 中文按 bigram 分词。
// FTS5 默认 tokenizer (unicode61) 对中文按字符切分,搜"乱码"无法命中"中文乱码问题"。
// bigram 分词把"乱码"拆成 "乱码"(整词匹配),同时用 OR 连接提高召回率。
function sanitize(q: string): string {
  const tokens: string[] = [];
  for (const part of q.split(/\s+/)) {
    if (!part) continue;
    // 英文/数字 token 直接加引号
    if (/^[\x00-\x7F]+$/.test(part)) {
      tokens.push(`"${part.replace(/"/g, '""')}"`);
    } else {
      // 中文:整词匹配 + bigram 子串(提高 FTS5 召回率)
      tokens.push(`"${part.replace(/"/g, '""')}"`);
      if (part.length > 2) {
        for (let i = 0; i < part.length - 1; i++) {
          tokens.push(`"${part.slice(i, i + 2)}"`);
        }
      }
    }
  }
  // 用 OR 连接:任意 token 命中即召回,后续由 embedding 重排保证精确度
  return tokens.length ? tokens.join(' OR ') : '';
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
  goal: string | null;
  profile_id: string | null;
  high_fidelity: number;
  context_mode: string | null;
  persona_enabled: number | null;
  updated_at: number | null;
  sub_agent_model: string | null;
  wecom_key: string | null;
  feishu_key: string | null;
};

export function saveConversation(c: Conversation): void {
  db.prepare(
    `INSERT INTO conversations(id, engine, cwd, created_at, custom_title, engine_session_id, model, branch_info, pipeline_id, goal, profile_id, high_fidelity, context_mode, persona_enabled, updated_at, sub_agent_model, wecom_key, feishu_key)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET engine=excluded.engine, cwd=excluded.cwd,
       custom_title=excluded.custom_title, engine_session_id=excluded.engine_session_id, model=excluded.model,
       branch_info=excluded.branch_info, pipeline_id=excluded.pipeline_id, goal=excluded.goal, profile_id=excluded.profile_id,
       high_fidelity=excluded.high_fidelity, context_mode=excluded.context_mode, persona_enabled=excluded.persona_enabled,
       updated_at=excluded.updated_at, sub_agent_model=excluded.sub_agent_model, wecom_key=excluded.wecom_key, feishu_key=excluded.feishu_key;`,
  ).run(c.id, c.engine, c.cwd, c.createdAt, c.customTitle, c.engineSessionId, c.model,
    c.branchInfo ? JSON.stringify(c.branchInfo) : null,
    c.pipelineId ?? null,
    c.goal ?? null,
    c.profileId ?? null,
    c.contextMode === 'hifi' ? 1 : 0,
    c.contextMode ?? 'standard',
    c.personaEnabled === false ? 0 : 1,
    c.updatedAt ?? Date.now(),
    c.subAgentModel ?? null,
    c.wecomKey ?? null,
    c.feishuKey ?? null);
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
  stmt('UPDATE conversations SET direct_history=? WHERE id=?;').run(
    JSON.stringify(c.directHistory ?? []),
    c.id,
  );
}

/** 更新会话最后活动时间(侧栏"按最近活动排序"依赖此列)。轻量,只写一列。 */
export function touchConversation(convId: string): void {
  stmt('UPDATE conversations SET updated_at=? WHERE id=?;').run(Date.now(), convId);
}

export function saveTurn(convId: string, t: Turn): void {
  stmt(
    `INSERT INTO turns(id, conv_id, data, created_at) VALUES(?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET data=excluded.data;`,
  ).run(t.id, convId, JSON.stringify(t), t.ts);
  // 同步更新会话最后活动时间(persist() 也会调 touchConversation,但 saveTurn 单独调用时也覆盖)。
  touchConversation(convId);
}

export function deleteConversation(id: string): void {
  // 事务保证原子性 —— 崩溃不会留孤儿 turns
  db.transaction(() => {
    stmt('DELETE FROM turns WHERE conv_id=?;').run(id);
    stmt('DELETE FROM cost_log WHERE conv_id=?;').run(id);
    stmt('DELETE FROM memory_triples WHERE conversation_id=?;').run(id);
    // 级联清理该会话产生的记忆 + 向量 + meta(避免孤儿数据)
    if (hasTable('memory_embeddings')) stmt('DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memories WHERE conversation_id=?);').run(id);
    if (hasTable('memory_meta')) stmt('DELETE FROM memory_meta WHERE memory_id IN (SELECT id FROM memories WHERE conversation_id=?);').run(id);
    stmt('DELETE FROM memories WHERE conversation_id=?;').run(id);
    // P2: 级联清理 episodic memories
    if (hasTable('episodic_memories')) stmt('DELETE FROM episodic_memories WHERE conv_id=?;').run(id);
    stmt('DELETE FROM conversations WHERE id=?;').run(id);
  })();
}

export function deleteTurns(convId: string): void {
  stmt('DELETE FROM turns WHERE conv_id=?;').run(convId);
}

function loadTurns(convId: string): Turn[] {
  const rows = stmt('SELECT data FROM turns WHERE conv_id=? ORDER BY created_at;').all(convId) as Array<{
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
      'SELECT id, engine, cwd, created_at, custom_title, direct_history, engine_session_id, model, branch_info, pipeline_id, goal, profile_id, high_fidelity, context_mode, persona_enabled, updated_at, sub_agent_model, wecom_key, feishu_key FROM conversations ORDER BY created_at DESC;',
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
    const engine: EngineKind = (['direct', 'directV2', 'directV3', 'claudeCode', 'codex'] as const).includes(r.engine as EngineKind)
      ? (r.engine as EngineKind)
      : 'direct';
    const conv: Conversation = {
      id: r.id,
      engine,
      model: r.model || '',
      cwd: r.cwd || '',
      createdAt: r.created_at ?? 0,
      updatedAt: r.updated_at ?? r.created_at ?? 0, // 旧数据 fallback 到创建时间
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
      goal: r.goal ?? null,
      profileId: r.profile_id ?? null,
      contextMode: r.context_mode === 'hifi' ? 'hifi' : (r.high_fidelity ? 'hifi' : 'standard'), // 优先读 context_mode,旧数据从 high_fidelity 迁移
      personaEnabled: r.persona_enabled === 0 ? false : true, // 0 = 显式关闭,其余(含 null/旧数据) = 默认开
      subAgentModel: r.sub_agent_model ?? null,
      wecomKey: r.wecom_key ?? null,
      feishuKey: r.feishu_key ?? null,
    };
    return conv;
  });
}

// 批量读取最近的 turns(prompt + answer),供替身画像分析用。
// Load recent turns (prompt + answer) for persona generation.
export function loadRecentTurns(limit: number): Array<{ prompt: string; answer: string; engine: string; cwd: string }> {
  const rows = db.prepare(
    `SELECT t.data, c.engine, c.cwd FROM turns t
     JOIN conversations c ON t.conv_id = c.id
     ORDER BY t.created_at DESC LIMIT ?;`,
  ).all(limit) as Array<{ data: string; engine: string; cwd: string }>;
  const results: Array<{ prompt: string; answer: string; engine: string; cwd: string }> = [];
  for (const r of rows) {
    try {
      const t = JSON.parse(r.data) as { prompt?: string; answer?: string };
      if (t.prompt && t.answer && t.answer.length > 20) {
        results.push({ prompt: t.prompt, answer: t.answer, engine: r.engine, cwd: r.cwd });
      }
    } catch { /* skip malformed */ }
  }
  return results;
}

// MARK: long-term memory (injected into the system prompt)
// convId 过滤:有值只返回该频道产生的;undefined 返回全部。
export function loadMemories(convId?: string): Array<{ id: string; content: string; conversation_id: string | null; importance: number }> {
  if (convId === undefined) {
    return db.prepare('SELECT id, content, conversation_id, importance FROM memories ORDER BY created_at DESC;').all() as Array<{
      id: string;
      content: string;
      conversation_id: string | null;
      importance: number;
    }>;
  }
  return db.prepare('SELECT id, content, conversation_id, importance FROM memories WHERE conversation_id=? ORDER BY created_at DESC;').all(convId) as Array<{
    id: string;
    content: string;
    conversation_id: string | null;
    importance: number;
  }>;
}

export function allMemoryContents(): string[] {
  return (db.prepare('SELECT content FROM memories;').all() as Array<{ content: string }>).map((r) => r.content);
}

/** 快速返回记忆总数(不做全量 load,只 COUNT)。 */
export function memoryCount(): number {
  return (db.prepare('SELECT count(*) as n FROM memories;').get() as { n: number }).n;
}

// 关键词搜索 memories 表(LIKE 模糊匹配,不依赖 FTS5 也不依赖 embedding)。
// 无 embedding 接口时 recall_memory 用此作为记忆搜索的 fallback。
export function searchMemories(q: string, limit = 20): Array<{ id: string; content: string; conversation_id: string | null; importance: number }> {
  const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
  return db.prepare(
    `SELECT id, content, conversation_id, importance FROM memories WHERE content LIKE ? ESCAPE '\\' ORDER BY importance DESC, created_at DESC LIMIT ?;`,
  ).all(like, limit) as Array<{ id: string; content: string; conversation_id: string | null; importance: number }>;
}

// 关键词搜索 memory_triples 表(subject / predicate / object 三列任意 LIKE 匹配)。
// recall_memory 和 memoryBlock 注入时调用,让知识图谱不再只写不读。
export function searchMemoryTriples(q: string, limit = 10): Array<{ subject: string; predicate: string; object: string }> {
  const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
  return db.prepare(
    `SELECT subject, predicate, object FROM memory_triples
     WHERE subject LIKE ? ESCAPE '\\' OR predicate LIKE ? ESCAPE '\\' OR object LIKE ? ESCAPE '\\'
     ORDER BY created_at DESC LIMIT ?;`,
  ).all(like, like, like, limit) as Array<{ subject: string; predicate: string; object: string }>;
}

// ── 存量记忆去重清理:文本相似度(规范化+包含检测+bigram Jaccard)合并重复 ──
// 返回被删除的条数。threshold 以下视为重复,保留最早创建的那条。
// textSimilarity 取 max(包含比, bigram Jaccard),适配 5-30 字的短记忆。
function memTextSimilarity(aRaw: string, bRaw: string): number {
  const norm = (s: string): string => {
    let r = s.replace(/^用户/, '').trim();
    r = r.replace(/[（(].*?[)）]/g, '');
    r = r.replace(/\s+/g, '').toLowerCase();
    return r;
  };
  const a = norm(aRaw);
  const b = norm(bRaw);
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    return shorter > 3 ? shorter / longer : 0;
  }
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

export function dedupMemories(threshold = 0.65): number {
  const all = db.prepare('SELECT id, content, created_at FROM memories ORDER BY created_at ASC;').all() as Array<{
    id: string; content: string; created_at: number;
  }>;

  const toDelete = new Set<string>();

  for (let i = 0; i < all.length; i++) {
    if (toDelete.has(all[i].id)) continue;
    for (let j = i + 1; j < all.length; j++) {
      if (toDelete.has(all[j].id)) continue;
      if (memTextSimilarity(all[i].content, all[j].content) >= threshold) {
        toDelete.add(all[j].id); // 删后来的,保留 i(更早创建)
      }
    }
  }

  let pruned = 0;
  const hasEmbed = hasTable('memory_embeddings');
  const hasMeta = hasTable('memory_meta');
  const stmtDelMem = db.prepare('DELETE FROM memories WHERE id=?;');
  const stmtDelEmbed = hasEmbed ? db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?;') : null;
  const stmtDelMeta = hasMeta ? db.prepare('DELETE FROM memory_meta WHERE memory_id=?;') : null;
  db.transaction(() => {
    for (const id of toDelete) {
      stmtDelMem.run(id);
      if (stmtDelEmbed) stmtDelEmbed.run(id);
      if (stmtDelMeta) stmtDelMeta.run(id);
      pruned++;
    }
  })();
  return pruned;
}

export function addMemory(content: string, convId?: string, importance = 5): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  db.prepare('INSERT INTO memories(id, content, created_at, conversation_id, importance) VALUES(?,?,?,?,?);').run(
    id,
    content,
    Date.now() / 1000,
    convId ?? null,
    Math.max(1, Math.min(10, importance)),
  );
  return id;
}

// MARK: P0 — Memory Blocks (结构化核心记忆,借鉴 Letta)
// 与 memories 的区别:memories 是追加式事实流,memory_blocks 是结构化、可原地编辑的常驻块。
// 注入格式:XML-like <memory_blocks><persona>...</persona><user_profile>...</user_profile></memory_blocks>

export interface MemoryBlock {
  label: string;
  value: string;
  charLimit: number;
  readOnly: boolean;
  updatedAt: number;
}

const DEFAULT_BLOCKS: Array<{ label: string; value: string; charLimit: number; readOnly: boolean }> = [
  { label: 'persona', value: '', charLimit: 2000, readOnly: true },
  { label: 'user_profile', value: '', charLimit: 3000, readOnly: false },
  { label: 'project_context', value: '', charLimit: 3000, readOnly: false },
  { label: 'active_goals', value: '', charLimit: 1500, readOnly: false },
];

/** 初始化默认 blocks(首次启动时调用,已有则跳过)。 */
export function initMemoryBlocks(): void {
  for (const b of DEFAULT_BLOCKS) {
    db.prepare('INSERT OR IGNORE INTO memory_blocks(label, value, char_limit, read_only, updated_at) VALUES(?,?,?,?,?);')
      .run(b.label, b.value, b.charLimit, b.readOnly ? 1 : 0, Date.now() / 1000);
  }
}

export function loadMemoryBlocks(): MemoryBlock[] {
  initMemoryBlocks(); // 确保默认 blocks 存在
  return (db.prepare('SELECT label, value, char_limit AS charLimit, read_only AS readOnly, updated_at AS updatedAt FROM memory_blocks ORDER BY label;').all() as Array<{ label: string; value: string; charLimit: number; readOnly: number; updatedAt: number }>)
    .map((r) => ({ ...r, readOnly: !!r.readOnly, updatedAt: r.updatedAt * 1000 }));
}

export function loadMemoryBlock(label: string): MemoryBlock | null {
  const r = db.prepare('SELECT label, value, char_limit AS charLimit, read_only AS readOnly, updated_at AS updatedAt FROM memory_blocks WHERE label=?;').get(label) as { label: string; value: string; charLimit: number; readOnly: number; updatedAt: number } | undefined;
  return r ? { ...r, readOnly: !!r.readOnly, updatedAt: r.updatedAt * 1000 } : null;
}

/** Agent 原地替换 block 内容(类似 Letta core_memory_replace)。 */
export function updateMemoryBlock(label: string, value: string): boolean {
  const block = loadMemoryBlock(label);
  if (!block) return false;
  if (block.readOnly) return false;
  const truncated = value.slice(0, block.charLimit);
  db.prepare('UPDATE memory_blocks SET value=?, updated_at=? WHERE label=?;')
    .run(truncated, Date.now() / 1000, label);
  return true;
}

/** Agent 追加内容到 block 末尾(类似 Letta core_memory_append)。 */
export function appendMemoryBlock(label: string, content: string): boolean {
  const block = loadMemoryBlock(label);
  if (!block) return false;
  if (block.readOnly) return false;
  const newValue = (block.value + '\n' + content).slice(0, block.charLimit);
  db.prepare('UPDATE memory_blocks SET value=?, updated_at=? WHERE label=?;')
    .run(newValue, Date.now() / 1000, label);
  return true;
}

// MARK: P2 — Episodic Memory (会话摘要,每次 done 后自动提取)
// 与 memories(facts)的区别:episodic 记录"这次会话做了什么"(叙事摘要),
// memories 记录"关于用户的持久事实"(原子命题)。episodic 用于跨会话回忆"上次那个 bug 怎么修的"。

export interface EpisodicMemory {
  id: string;
  convId: string | null;
  summary: string;
  importance: number;
  tags: string | null;
  createdAt: number;
}

export function addEpisodicMemory(e: { convId: string; summary: string; importance: number; tags?: string }): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  db.prepare('INSERT INTO episodic_memories(id, conv_id, summary, importance, tags, created_at) VALUES(?,?,?,?,?,?);')
    .run(id, e.convId, e.summary, Math.max(1, Math.min(10, e.importance)), e.tags ?? null, Date.now() / 1000);
  return id;
}

export function loadEpisodicMemories(limit = 20): EpisodicMemory[] {
  return (db.prepare('SELECT id, conv_id AS convId, summary, importance, tags, created_at AS createdAt FROM episodic_memories ORDER BY created_at DESC LIMIT ?;').all(limit) as Array<{ id: string; convId: string; summary: string; importance: number; tags: string | null; createdAt: number }>)
    .map((r) => ({ ...r, createdAt: r.createdAt * 1000 }));
}

export function searchEpisodicMemories(q: string, limit = 5): EpisodicMemory[] {
  const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
  return (db.prepare('SELECT id, conv_id AS convId, summary, importance, tags, created_at AS createdAt FROM episodic_memories WHERE summary LIKE ? ESCAPE \'\\\' OR tags LIKE ? ESCAPE \'\\\' ORDER BY importance DESC, created_at DESC LIMIT ?;').all(like, like, limit) as Array<{ id: string; convId: string; summary: string; importance: number; tags: string | null; createdAt: number }>)
    .map((r) => ({ ...r, createdAt: r.createdAt * 1000 }));
}

export function episodicMemoryCount(): number {
  return (db.prepare('SELECT count(*) as n FROM episodic_memories;').get() as { n: number }).n;
}
// 设计目的:v2 多步任务的关键产出(文件路径列表、关键决策)存这里,不被 trim/compact 砍掉。
// key 在 conv 内唯一;value 纯文本或 JSON 字符串。
// 不参与跨会话同步(每个 conv 独立),后续可加 namespace 机制。
export function saveFact(convId: string, key: string, value: string): void {
  // INSERT OR REPLACE 实现 upsert,同 conv 同 key 覆盖更新。
  db.prepare(
    'INSERT INTO conv_facts(conv_id, key, value, updated_at) VALUES(?,?,?,?) ON CONFLICT(conv_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;'
  ).run(convId, key, value, Date.now() / 1000);
}

export function loadFact(convId: string, key: string): string | null {
  const row = db.prepare('SELECT value FROM conv_facts WHERE conv_id=? AND key=?;').get(convId, key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function listFacts(convId: string): Array<{ key: string; value: string; updated_at: number }> {
  return db.prepare('SELECT key, value, updated_at FROM conv_facts WHERE conv_id=? ORDER BY updated_at DESC;').all(convId) as Array<{ key: string; value: string; updated_at: number }>;
}

export function deleteFact(convId: string, key: string): boolean {
  const info = db.prepare('DELETE FROM conv_facts WHERE conv_id=? AND key=?;').run(convId, key);
  return info.changes > 0;
}

// 加载会话所有 fact 拼成一段文本(给 systemPrompt 注入用,作为锚点参考)。
// 与 recall_memory 的区别:facts 是结构化锚点(v2 步骤间共享),memories 是跨轮长期记忆。
export function factsAsBlock(convId: string): string {
  const facts = listFacts(convId);
  if (facts.length === 0) return '';
  return facts.map((f) => `- ${f.key}: ${f.value}`).join('\n');
}

// MARK: AgentTeams 持久化(P2)
// 设计:一个 team 是一组 named agent,member 各自独立 history,但都挂在主 conv 下。
// 不复用 conversations 表 —— member 不是"独立会话",而是"team 的局部状态"。
export interface TeamMember {
  team_id: string;
  member_id: string;
  name: string;
  role: string; // 'explorer' / 'reviewer' / 'integrator' 等,描述职责
  history: string; // JSON: ChatMsg[] 序列化的成员本地 history
  last_message: string | null; // 最近发给它的 message(用于 UI 显示"我在做什么")
  last_result: string | null; // 最近一次回答(用于 UI 显示"我做了什么")
  status: string; // 'idle' / 'running' / 'done' / 'failed'
  created_at: number;
  updated_at: number;
}

export function upsertTeamMember(m: TeamMember): void {
  db.prepare(
    `INSERT INTO team_members(team_id, member_id, name, role, history, last_message, last_result, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(team_id, member_id) DO UPDATE SET
       name=excluded.name, role=excluded.role, history=excluded.history,
       last_message=excluded.last_message, last_result=excluded.last_result,
       status=excluded.status, updated_at=excluded.updated_at;`
  ).run(m.team_id, m.member_id, m.name, m.role, m.history, m.last_message, m.last_result, m.status, m.created_at, m.updated_at);
}

export function loadTeamMember(teamId: string, memberId: string): TeamMember | null {
  const row = db.prepare('SELECT * FROM team_members WHERE team_id=? AND member_id=?;').get(teamId, memberId) as TeamMember | undefined;
  return row ?? null;
}

export function listTeamMembers(teamId: string): TeamMember[] {
  return db.prepare('SELECT * FROM team_members WHERE team_id=? ORDER BY created_at ASC;').all(teamId) as TeamMember[];
}

export function deleteTeam(teamId: string): number {
  return db.prepare('DELETE FROM team_members WHERE team_id=?;').run(teamId).changes;
}

export function listTeamsForConv(convId: string): Array<{ team_id: string; member_count: number; updated_at: number }> {
  // ponytail:team_id 与 convId 约定用 "conv:<convId>" 前缀,方便 JOIN 查询。
  return db.prepare(
    `SELECT team_id, COUNT(*) as member_count, MAX(updated_at) as updated_at
     FROM team_members WHERE team_id LIKE ? GROUP BY team_id ORDER BY updated_at DESC;`
  ).all(`conv:${convId}%`) as Array<{ team_id: string; member_count: number; updated_at: number }>;
}

/** 从 team_id 解析出 conv_id("conv:<convId>:team:<ts>" → "<convId>") */
export function convIdFromTeamId(teamId: string): string | null {
  const m = teamId.match(/^conv:(.+):team:[^:]+$/);
  return m ? m[1] : null;
}

// MARK: V2 逐步持久化(P2-1)
// 每次 step 完成后存 checkpoint(plan JSON + execHistory JSON)。
// crash 后 resume 时读取最后一条 checkpoint 恢复执行进度。
export function saveV2Checkpoint(convId: string, stepId: string, planJson: string, historyJson: string, rowType = 'step_checkpoint'): void {
  db.prepare(
    `INSERT INTO v2_state(conv_id, step_id, row_type, plan_json, history_json, created_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(conv_id, step_id) DO UPDATE SET
       row_type=excluded.row_type, plan_json=excluded.plan_json,
       history_json=excluded.history_json, created_at=excluded.created_at;`
  ).run(convId, stepId, rowType, planJson, historyJson, Date.now() / 1000);
}

export function loadV2Checkpoint(convId: string, stepId: string): { plan_json: string; history_json: string; row_type: string; created_at: number } | null {
  const row = db.prepare('SELECT plan_json, history_json, row_type, created_at FROM v2_state WHERE conv_id=? AND step_id=?;').get(convId, stepId) as { plan_json: string; history_json: string; row_type: string; created_at: number } | undefined;
  return row ?? null;
}

export function loadLatestV2Checkpoint(convId: string): { step_id: string; plan_json: string; history_json: string; row_type: string; created_at: number } | null {
  const row = db.prepare('SELECT step_id, plan_json, history_json, row_type, created_at FROM v2_state WHERE conv_id=? ORDER BY created_at DESC LIMIT 1;').get(convId) as { step_id: string; plan_json: string; history_json: string; row_type: string; created_at: number } | undefined;
  return row ?? null;
}

export function clearV2State(convId: string): void {
  db.prepare('DELETE FROM v2_state WHERE conv_id=?;').run(convId);
}

export function updateMemory(id: string, content: string): void {
  db.prepare('UPDATE memories SET content=? WHERE id=?;').run(content, id);
  // content 变了 → 删旧 embedding;memory-update IPC handler 会同步重建新 embedding。
  if (hasTable('memory_embeddings')) db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?;').run(id);
}

export function deleteMemory(id: string): void {
  // 级联清理孤儿数据(embeddings + meta)——没有外键约束,手动删。
  // 事务保证原子性。
  db.transaction(() => {
    db.prepare('DELETE FROM memories WHERE id=?;').run(id);
    if (hasTable('memory_embeddings')) db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?;').run(id);
    if (hasTable('memory_meta')) db.prepare('DELETE FROM memory_meta WHERE memory_id=?;').run(id);
  })();
}

// MARK: memory graph(实体关系三元组;与 memories 并行,不互依)
// 提取器从对话里抽 (subject, predicate, object),例:(用户, 偏好, Tailwind) / (用户, 在做, Halo 项目)。
// ponytail: 不做 entity 字典/归一化 —— 直接存原文,模型自己处理同义;后续可加规范化层。
export function loadMemoryTriples(convId?: string): Array<{ id: string; subject: string; predicate: string; object: string; conversation_id: string | null; created_at: number }> {
  // ponytail: LIMIT 500 —— 超过时只取最新 500 条,后续可加翻页
  if (convId === undefined) {
    return db
      .prepare('SELECT id, subject, predicate, object, conversation_id, created_at FROM memory_triples ORDER BY created_at DESC LIMIT 500;')
      .all() as Array<{ id: string; subject: string; predicate: string; object: string; conversation_id: string | null; created_at: number }>;
  }
  return db
    .prepare('SELECT id, subject, predicate, object, conversation_id, created_at FROM memory_triples WHERE conversation_id=? ORDER BY created_at DESC LIMIT 500;')
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
  if (hasTable('memory_embeddings')) db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?;').run(memoryId);
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
  stmt('INSERT INTO cost_log(id, conv_id, engine, amount, tokens, ts) VALUES(?,?,?,?,?,?);')
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
export function loadMemoryTimeline(): Array<{ id: string; content: string; conversation_id: string | null; created_at: number; weight: number; lastUsed: number; useCount: number; importance: number }> {
  const mems = (db.prepare('SELECT id, content, conversation_id, created_at, importance FROM memories ORDER BY created_at DESC LIMIT 500;').all()) as Array<{ id: string; content: string; conversation_id: string | null; created_at: number; importance: number }>;
  const metas = new Map<string, { weight: number; last_used: number; use_count: number }>();
  for (const m of (db.prepare('SELECT memory_id, weight, last_used, use_count FROM memory_meta;').all()) as Array<{ memory_id: string; weight: number; last_used: number; use_count: number }>) {
    metas.set(m.memory_id, { weight: m.weight, last_used: m.last_used, use_count: m.use_count });
  }
  return mems.map((m) => {
    const meta = metas.get(m.id) ?? { weight: 1.0, last_used: 0, use_count: 0 };
    return { ...m, created_at: m.created_at * 1000, weight: meta.weight, lastUsed: meta.last_used, useCount: meta.use_count, importance: m.importance ?? 5 };
  });
}

// 触摸一条记忆的 lastUsed(被 recall 命中时调用)
// 使用 INSERT ... ON CONFLICT 避免 read-then-write 竞态
export function touchMemoryUsed(id: string): void {
  stmt(`INSERT INTO memory_meta(memory_id, weight, last_used, use_count)
    VALUES(?, 1.0, ?, 1)
    ON CONFLICT(memory_id) DO UPDATE SET last_used=excluded.last_used, use_count=use_count+1;`)
    .run(id, Date.now());
}

// P1: 加权排序检索 —— importance * 0.5 + recency * 0.3 + relevance * 0.2
// relevance 来自调用方(embedding cosine 或 FTS5 BM25,归一化到 0-1)。
// recency = exp(-Δt / half_life),half_life = 30天(ms)。
// 返回按 final_score 降序排列的记忆列表。
export function scoredMemories(
  query: string,
  limit: number,
  relevanceFn?: (content: string) => number,
): Array<{ id: string; content: string; conversation_id: string | null; importance: number; score: number }> {
  const halfLife = 30 * 86400_000; // 30 天(ms)
  const now = Date.now();
  const mems = loadMemories();
  const metas = new Map<string, { weight: number; last_used: number; use_count: number }>();
  for (const m of (db.prepare('SELECT memory_id, weight, last_used, use_count FROM memory_meta;').all() as Array<{ memory_id: string; weight: number; last_used: number; use_count: number }>)) {
    metas.set(m.memory_id, { weight: m.weight, last_used: m.last_used, use_count: m.use_count });
  }
  const scored = mems.map((m) => {
    const meta = metas.get(m.id);
    const importanceNorm = (m.importance ?? 5) / 10; // 0-1
    // recency: 无 meta → 用 created_at;有 meta → 用 last_used
    const refTs = meta?.last_used || (m as { created_at?: number }).created_at || now;
    // created_at 存秒,last_used 存毫秒 → 统一到毫秒
    const refMs = refTs < 1e12 ? refTs * 1000 : refTs;
    const recency = Math.exp(-(now - refMs) / halfLife);
    // relevance: 外部传入(embedding cosine)或简单 LIKE 匹配
    const relevance = relevanceFn ? relevanceFn(m.content) : (m.content.includes(query) ? 0.5 : 0);
    const score = importanceNorm * 0.5 + recency * 0.3 + relevance * 0.2;
    return { ...m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// 执行衰减:weight *= 0.95^(days_since_last_used),weight < 0.1 的连同 memory 一起删除。
// 返回被清除的条数。
// 未被 recall 命中过(无 memory_meta 行)的记忆按 weight=1.0 / last_used=created_at 参与。
export function decayMemories(): number {  const now = Date.now();
  const dayMs = 86400_000;
  const hasEmbed = hasTable('memory_embeddings');
  const hasMeta = hasTable('memory_meta');
  // 预编译 statement(避免循环内重复 prepare)
  const stmtDel = db.prepare('DELETE FROM memories WHERE id=?;');
  const stmtDelMeta = hasMeta ? db.prepare('DELETE FROM memory_meta WHERE memory_id=?;') : null;
  const stmtDelEmbed = hasEmbed ? db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?;') : null;
  const stmtUpdate = db.prepare('UPDATE memory_meta SET weight=? WHERE memory_id=?;');
  // 从 memories 表出发 LEFT JOIN meta,覆盖所有记忆(含从未被 recall 的长尾记忆)
  const all = (db.prepare(
    `SELECT mem.id AS memory_id, mem.created_at AS created_at,
       m.weight AS weight, m.last_used AS last_used
     FROM memories mem
     LEFT JOIN memory_meta m ON m.memory_id = mem.id;`,
  ).all()) as Array<{ memory_id: string; weight: number | null; last_used: number | null; created_at: number | null }>;
  let pruned = 0;
  const tx = db.transaction(() => {
    for (const m of all) {
      const weight = m.weight ?? 1.0;      // 无 meta → 初始权重 1.0
      // last_used 存毫秒;created_at 存秒。统一到毫秒。
      const refTs = m.last_used || (m.created_at ?? now / 1000) * 1000;
      const days = (now - refTs) / dayMs;
      const decayed = weight * Math.pow(0.95, days);
      if (decayed < 0.1) {
        stmtDel.run(m.memory_id);
        if (stmtDelMeta) stmtDelMeta.run(m.memory_id);
        if (stmtDelEmbed) stmtDelEmbed.run(m.memory_id);
        pruned++;
      } else if (m.weight !== null) {
        // 有 meta 行才更新;无 meta 的不自动创建(下次 recall 命中时 touchMemoryUsed 会创建)
        stmtUpdate.run(decayed, m.memory_id);
      }
    }
  });
  tx();
  return pruned;
}

// P1: 删除 importance ≤ threshold 且从未被 recall 命中(use_count = 0)的低价值记忆。
// 防止大量噪声记忆(临时路径、一次性数据)堆积。
export function pruneLowImportanceMemories(threshold = 2): number {
  // 找到 importance 低 + 从未被 recall 的记忆
  const candidates = db.prepare(`
    SELECT m.id FROM memories m
    LEFT JOIN memory_meta meta ON meta.memory_id = m.id
    WHERE COALESCE(m.importance, 5) <= ? 
      AND (meta.use_count IS NULL OR meta.use_count = 0)
  `).all(threshold) as Array<{ id: string }>;
  if (!candidates.length) return 0;
  const hasEmbed = hasTable('memory_embeddings');
  const hasMeta = hasTable('memory_meta');
  const stmtDel = db.prepare('DELETE FROM memories WHERE id=?;');
  const stmtDelEmbed = hasEmbed ? db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?;') : null;
  const stmtDelMeta = hasMeta ? db.prepare('DELETE FROM memory_meta WHERE memory_id=?;') : null;
  let pruned = 0;
  db.transaction(() => {
    for (const c of candidates) {
      stmtDel.run(c.id);
      if (stmtDelEmbed) stmtDelEmbed.run(c.id);
      if (stmtDelMeta) stmtDelMeta.run(c.id);
      pruned++;
    }
  })();
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
