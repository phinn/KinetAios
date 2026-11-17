// blackboard — 团队共享黑板(P1-6):team/workflow 成员的共享工作区 + 探查缓存。
// Shared blackboard for team/workflow members (P1-6): shared notes + recon cache.
//
// 解决:多个 member 各自 read_file/grep 同一批文件,token 三倍浪费、结论互不可见。
// 机制:
// - 每支 team 一块黑板(team_id 键),成员可 write_note / write_artifact(结构化产出)
// - 探查缓存:成员读完一个文件,全文落缓存;其他成员 read_file 命中缓存 → 标注「来自黑板缓存」直接返回
// - 缓存按文件 mtime 失效;会话结束随 team 关闭清理(closeTeam)

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BlackboardNote {
  from: string; // member 名
  kind: 'note' | 'artifact';
  title: string;
  body: string;
  ts: number;
}

interface CacheEntry {
  content: string;
  mtimeMs: number;
  by: string; // 谁读的
}

export class Blackboard {
  private notes: BlackboardNote[] = [];
  private cache = new Map<string, CacheEntry>();
  /** 探查缓存命中次数(可观测:省了多少重复读) */
  cacheHits = 0;

  writeNote(from: string, title: string, body: string, kind: 'note' | 'artifact' = 'note'): BlackboardNote {
    // 去重:同作者+同标题+同正文已在黑板上 → 跳过(workflow 重试阶段/成员重复汇报防刷屏)
    const t = title.slice(0, 120);
    const b = body.slice(0, 20000);
    const dup = this.notes.find((n) => n.from === from && n.title === t && n.body === b);
    if (dup) return dup;
    const n: BlackboardNote = { from, kind, title: t, body: b, ts: Date.now() };
    this.notes.push(n);
    if (this.notes.length > 200) this.notes.shift(); // 防 runaway
    return n;
  }

  listNotes(): BlackboardNote[] {
    return this.notes.slice();
  }

  /** 渲染给成员 system prompt 的黑板摘要(省 token:只列标题,正文按需 read) */
  renderDigest(maxChars = 3000): string {
    if (!this.notes.length && !this.cache.size) return '(黑板为空)';
    const lines: string[] = [];
    let used = 0;
    for (let i = this.notes.length - 1; i >= 0 && used < maxChars; i--) {
      const n = this.notes[i];
      const line = `- [${i}] ${n.kind === 'artifact' ? '📦' : '📝'} ${n.title} (by ${n.from})`;
      lines.unshift(line);
      used += line.length;
    }
    const cached = [...this.cache.keys()].slice(-8);
    return `黑板条目(新→旧,kinet_bb_read 用序号取正文):\n${lines.join('\n') || '(无)'}\n已缓存文件(直接引用,勿重复读): ${cached.length ? cached.join(', ') : '无'}`;
  }

  readNote(index: number): BlackboardNote | undefined {
    return index >= 0 ? this.notes[index] : undefined;
  }

  /**
   * 探查缓存:读文件前先过这里。命中且 mtime 未变 → 返回缓存内容(标 from);
   * 未命中/已过期 → 调用方自己 fs 读,然后 putCache 回填。
   */
  getCachedRead(file: string): { content: string; by: string } | undefined {
    const abs = path.resolve(file);
    const hit = this.cache.get(abs);
    if (!hit) return undefined;
    let mtime = 0;
    try {
      mtime = fs.statSync(abs).mtimeMs;
    } catch {
      this.cache.delete(abs);
      return undefined;
    }
    if (mtime !== hit.mtimeMs) {
      this.cache.delete(abs);
      return undefined;
    }
    this.cacheHits += 1;
    return { content: hit.content, by: hit.by };
  }

  putCache(file: string, content: string, by: string): void {
    const abs = path.resolve(file);
    if (content.length > 200_000) return; // 大文件不缓存
    let mtime = 0;
    try {
      mtime = fs.statSync(abs).mtimeMs;
    } catch {
      return;
    }
    this.cache.set(abs, { content, mtimeMs: mtime, by });
    if (this.cache.size > 60) {
      const first = this.cache.keys().next().value;
      if (first) this.cache.delete(first);
    }
  }

  stats(): { notes: number; cachedFiles: number; cacheHits: number } {
    return { notes: this.notes.length, cachedFiles: this.cache.size, cacheHits: this.cacheHits };
  }
}

// ── 注册表:team_id → 黑板;spawn_team(blackboard:true) 创建,closeTeam 清理 ──

const boards = new Map<string, Blackboard>();

export function ensureBoard(teamId: string): Blackboard {
  let b = boards.get(teamId);
  if (!b) {
    b = new Blackboard();
    boards.set(teamId, b);
  }
  return b;
}

export function getBoard(teamId: string): Blackboard | undefined {
  return boards.get(teamId);
}

export function closeBoard(teamId: string): void {
  boards.delete(teamId);
}
