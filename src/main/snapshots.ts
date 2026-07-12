// 文件快照(回滚点):write_file/edit_file 改动前把原内容存到 <cwd>/.kinet-snapshots/<id>.json,
// 用户在快照面板可以一键 restore。文件系统存储(不进 SQLite),快照跟着项目走,可手动删/commit。
// ponytail: 不做 cascade —— restore 一条不影响其它快照,用户可顺序 restore 多条。
import fs from 'node:fs';
import path from 'node:path';

export interface Snapshot {
  id: string;
  convId: string;
  cwd: string;
  absPath: string;
  tool: 'write_file' | 'edit_file';
  contentBefore: string;
  ts: number;
}

export type SnapshotMeta = Omit<Snapshot, 'contentBefore'>;

function dir(cwd: string): string {
  return path.join(cwd, '.kinet-snapshots');
}
function file(cwd: string, id: string): string {
  return path.join(dir(cwd), `${id}.json`);
}
function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 快照是 best-effort:任何 IO 失败都吞掉,绝不阻塞 agent 写文件。
export function takeSnapshot(opts: {
  convId: string;
  cwd: string;
  absPath: string;
  tool: 'write_file' | 'edit_file';
  contentBefore: string;
}): Snapshot | null {
  try {
    const snap: Snapshot = { id: genId(), ...opts, ts: Date.now() };
    fs.mkdirSync(dir(opts.cwd), { recursive: true });
    fs.writeFileSync(file(opts.cwd, snap.id), JSON.stringify(snap), 'utf8');
    return snap;
  } catch {
    return null;
  }
}

export function listSnapshots(cwd: string, convId?: string): SnapshotMeta[] {
  try {
    const files = fs.readdirSync(dir(cwd)).filter((f) => f.endsWith('.json'));
    const snaps: Snapshot[] = [];
    for (const f of files) {
      try {
        snaps.push(JSON.parse(fs.readFileSync(path.join(dir(cwd), f), 'utf8')) as Snapshot);
      } catch {
        /* corrupt snapshot file, skip */
      }
    }
    const filtered = convId ? snaps.filter((s) => s.convId === convId) : snaps;
    return filtered.sort((a, b) => b.ts - a.ts).map(({ contentBefore: _cb, ...meta }) => meta);
  } catch {
    return [];
  }
}

export function restoreSnapshot(cwd: string, id: string): { ok: boolean; error?: string } {
  try {
    const snap = JSON.parse(fs.readFileSync(file(cwd, id), 'utf8')) as Snapshot;
    fs.writeFileSync(snap.absPath, snap.contentBefore, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
