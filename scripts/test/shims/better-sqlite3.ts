// 测试用 better-sqlite3 shim —— 基于 node:sqlite(≥22.5 内置,含 FTS5)。
// 仅覆盖 store.ts 用到的 API 面:Database(path)/exec/pragma/prepare(run|get|all)/transaction/close。
// 目的是绕开 better-sqlite3 的 Electron ABI 依赖(NODE_MODULE_VERSION 125),在系统 Node 下跑单测。
// 语义与 better-sqlite3 对齐:同一 SQLite + FTS5(unicode61 tokenizer),FTS/中文行为一致。
import { DatabaseSync } from 'node:sqlite';

type RunResult = { changes: number; lastInsertRowid: number };
type MinimalStatement = {
  run: (...args: unknown[]) => RunResult;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
};

export default class Database {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  // better-sqlite3: db.pragma('journal_mode = WAL') → 返回结果行;node:sqlite 无 .pragma() → prepare+get 等价。
  pragma(source: string): unknown {
    const stmt = this.db.prepare(`PRAGMA ${source}`);
    try {
      return stmt.get();
    } catch {
      return undefined; // wal_checkpoint 等无结果行 pragma
    }
  }

  prepare(sql: string): MinimalStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...args: unknown[]): RunResult => {
        const r = stmt.run(...(args as never[]));
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
      get: (...args: unknown[]) => stmt.get(...(args as never[])),
      all: (...args: unknown[]) => stmt.all(...(args as never[])),
    };
  }

  // better-sqlite3: db.transaction(fn)(...args) → BEGIN/COMMIT/ROLLBACK 包装。
  transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
    return (...args: unknown[]) => {
      this.db.exec('BEGIN');
      try {
        const out = fn(...args);
        this.db.exec('COMMIT');
        return out;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}
