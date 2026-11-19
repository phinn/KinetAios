// 一次性清理:FTS history 里的工具输出行(role='shell')。
//
// 背景(2026-11-19 库体检):history 表 837MB 中 shell 占 406,277 条 / 293MB = 97.6%,
// 而 user(0.6MB) + assistant(6.6MB) 才是用户真正要搜的内容。工具输出的正文在
// conv_events(tool/call, 50k 上限)已有全量存证,FTS 这份是第三份冗余拷贝。
// 代码侧已停止写入(见 TaskManager persist 的 'tool' 分支),本脚本清理历史存量。
//
// 用法:
//   node scripts/purge-fts-shell.mjs            # 只看统计,不动库
//   node scripts/purge-fts-shell.mjs --apply    # 删除 shell 行 + FTS optimize
//   node scripts/purge-fts-shell.mjs --apply --vacuum   # 追加 VACUUM(真正归还磁盘)
//
// 注意:
//   1. 先退出 KinetAios —— SQLite WAL 下 app 持锁时删除会 SQLITE_BUSY。
//   2. 删除本身只标记页为空闲,文件不会变小;要见磁盘数字下降必须 --vacuum。
//      VACUUM 需要约等于库大小的临时空间(3GB 库 → 3GB 空闲),耗时数分钟。
//   3. 可中断重跑:只删 role='shell' 的行,重复执行是幂等的。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DB = process.env.KINET_DB || path.join(os.homedir(), 'Library/Application Support/KinetAios/history.db');
const APPLY = process.argv.includes('--apply');
const VACUUM = process.argv.includes('--vacuum');
const BATCH = 5000;

if (!fs.existsSync(DB)) {
  console.error(`库不存在: ${DB}`);
  process.exit(1);
}

const db = new DatabaseSync(DB);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function stat() {
  const byRole = db.prepare(
    `SELECT role, COUNT(*) AS n, SUM(LENGTH(content)) AS bytes FROM history GROUP BY role ORDER BY bytes DESC;`,
  ).all();
  const total = byRole.reduce((s, r) => s + (r.bytes ?? 0), 0);
  return { byRole, total };
}

const before = stat();
const shellRows = before.byRole.find((r) => r.role === 'shell');

console.log(`库: ${DB}`);
console.log(`文件大小: ${mb(fs.statSync(DB).size)}`);
console.log('\n当前 FTS history 构成:');
for (const r of before.byRole) {
  const pct = before.total ? ((r.bytes / before.total) * 100).toFixed(1) : '0.0';
  console.log(`  ${String(r.role).padEnd(10)} ${String(r.n).padStart(8)} 行  ${mb(r.bytes ?? 0).padStart(10)}  ${pct}%`);
}
if (!shellRows) {
  console.log('\n没有 shell 行,无需清理。');
  process.exit(0);
}
console.log(`\n待删除: ${shellRows.n} 行 / ${mb(shellRows.bytes ?? 0)}`);

if (!APPLY) {
  console.log('\n[预览模式] 未改动任何数据。加 --apply 执行删除。');
  process.exit(0);
}

// 分批删除:一次 40 万行的单事务会长时间占住写锁,且失败后全量回滚。
// 逐批提交 —— 中途 Ctrl-C 也是干净的(已删批次不回滚,重跑继续)。
let deleted = 0;
const pickBatch = db.prepare(
  `SELECT rowid AS rid FROM history WHERE role='shell' ORDER BY rowid LIMIT ${BATCH};`,
);
const delFts = db.prepare('DELETE FROM history WHERE rowid = ?;');
const delMap = db.prepare('DELETE FROM history_conv WHERE id = ?;');

for (;;) {
  const batch = pickBatch.all();
  if (!batch.length) break;
  db.exec('BEGIN');
  try {
    for (const { rid } of batch) {
      delFts.run(rid);
      delMap.run(rid);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  deleted += batch.length;
  if (deleted % (BATCH * 10) === 0 || batch.length < BATCH) {
    process.stdout.write(`\r已删除 ${deleted.toLocaleString()} 行…`);
  }
}
console.log(`\n删除完成: ${deleted.toLocaleString()} 行`);

// FTS5 的 optimize 合并段文件,让删除后的碎片归拢(否则查询仍要扫过空段)。
// 这一步不缩文件,但能让后续 VACUUM 更有效、查询更快。
console.log('FTS optimize…');
db.exec(`INSERT INTO history(history) VALUES('optimize');`);

if (VACUUM) {
  const free = db.prepare('PRAGMA freelist_count;').get()?.freelist_count ?? 0;
  const pageSize = db.prepare('PRAGMA page_size;').get()?.page_size ?? 4096;
  console.log(`空闲页: ${free.toLocaleString()} 页 ≈ ${mb(free * pageSize)}`);
  console.log('VACUUM 中(3GB 库约需数分钟,请勿中断)…');
  db.exec('VACUUM;');
  console.log(`VACUUM 完成,文件大小: ${mb(fs.statSync(DB).size)}`);
} else {
  console.log('未 VACUUM —— 空间已标记为空闲但文件未缩小。要真正归还磁盘,重跑并加 --vacuum。');
}

const after = stat();
console.log('\n清理后 FTS history 构成:');
for (const r of after.byRole) {
  console.log(`  ${String(r.role).padEnd(10)} ${String(r.n).padStart(8)} 行  ${mb(r.bytes ?? 0).padStart(10)}`);
}
db.close();
