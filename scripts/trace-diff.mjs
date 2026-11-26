#!/usr/bin/env node
// 轨迹反事实对比 CLI —— 同一个任务两次运行,差在哪一步、差多少成本/失败。
//
// 用法:
//   node scripts/trace-diff.mjs a.json b.json                # 两个轨迹 JSON(事件数组或归一化轨迹)
//   node scripts/trace-diff.mjs --conv <convA> --conv <convB>  # 直接读本机 history.db 的两个会话
//   node scripts/trace-diff.mjs --conv A --conv B --db /path/to/history.db
//
// 设计:对比逻辑只维护在 src/main/trace-compare.ts 一处;这里用 esbuild 现场打包后 require,
// 避免 CLI 与主进程各写一份规则导致口径漂移。
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

function bundleCompareModule() {
  const out = path.join(os.tmpdir(), `kinet-trace-compare-${process.pid}.cjs`);
  const esbuild = path.join(root, 'node_modules', '.bin', 'esbuild');
  execFileSync(esbuild, [
    path.join(root, 'src/main/trace-compare.ts'),
    '--bundle', '--platform=node', '--format=cjs',
    `--outfile=${out}`, '--log-level=error', '--legal-comments=none',
  ], { stdio: 'inherit' });
  const mod = require(out);
  fs.rmSync(out, { force: true });
  return mod;
}

function defaultDbPath() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'KinetAios', 'history.db');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'KinetAios', 'history.db');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'KinetAios', 'history.db');
}

function rowsFromDb(dbPath, convId, cmp) {
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`);
  // 动态 import:node:sqlite 在旧 Node 上不存在,只有走 --conv 时才需要。
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT seq, turn_id, type, data, ts FROM conv_events WHERE conv_id=? ORDER BY seq;').all(convId);
      const events = [];
      for (const r of rows) {
        try {
          events.push({ seq: Number(r.seq), turnId: String(r.turn_id), type: String(r.type), data: JSON.parse(String(r.data)), ts: Number(r.ts) });
        } catch { /* 坏行跳过 */ }
      }
      return cmp.traceFromEvents(events, `conv:${convId}`);
    } finally {
      db.close();
    }
  });
}

function traceFromJsonFile(file, cmp) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) {
    // 事件数组(conv_events 导出)→ 归一化
    const events = parsed.map((r, i) => ({
      seq: Number(r.seq ?? i + 1),
      turnId: String(r.turnId ?? r.turn_id ?? ''),
      type: String(r.type ?? r.data?.type ?? ''),
      data: r.data ?? r,
      ts: Number(r.ts ?? 0),
    }));
    return cmp.traceFromEvents(events, parsed.id ?? path.basename(file));
  }
  if (parsed && Array.isArray(parsed.steps)) return { id: parsed.id ?? path.basename(file), ...parsed };
  throw new Error(`${file} 不是可识别的轨迹(需要事件数组或含 steps 的对象)`);
}

async function main() {
  const argv = process.argv.slice(2);
  const convs = [];
  let dbPath = null;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--conv') convs.push(argv[++i]);
    else if (a === '--db') dbPath = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/trace-diff.mjs <a.json> <b.json>\n      node scripts/trace-diff.mjs --conv <convA> --conv <convB> [--db <history.db>]');
      return;
    } else files.push(a);
  }

  const cmp = bundleCompareModule();
  let a;
  let b;
  if (convs.length === 2) {
    const db = dbPath || defaultDbPath();
    [a, b] = await Promise.all([rowsFromDb(db, convs[0], cmp), rowsFromDb(db, convs[1], cmp)]);
  } else if (files.length === 2) {
    a = traceFromJsonFile(files[0], cmp);
    b = traceFromJsonFile(files[1], cmp);
  } else {
    console.error('需要两条轨迹: <a.json> <b.json> 或 --conv A --conv B');
    process.exit(2);
  }
  console.log(cmp.formatTraceDiff(cmp.compareTraces(a, b)));
}

main().catch((e) => {
  console.error(`❌ ${e?.message ?? e}`);
  process.exit(1);
});
