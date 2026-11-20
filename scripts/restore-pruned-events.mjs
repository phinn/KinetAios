#!/usr/bin/env node
/**
 * 从旧备份补回被早期「一刀切」清理删掉的事件 —— 只补唯一副本类,冗余副本不补。
 *
 * 背景(2026-11-20):
 *   11-19 那次把事件保留期从 90 天缩到 30 天,一次删除约 48 万条 / 321MB,其中包含
 *   10-21 之前的**全部** tool/call(完整参数+返回的唯一存证)、turn/meta(成本明细)、
 *   turn/status(路由轨迹)、compaction/spill(压缩前原文)。这些在事件流里没有第二份,
 *   删掉即不可恢复 —— 唯一天然的副本是 11-19 16:01 的停机备份。
 *
 * 本脚本做的是纯增量恢复:把备份里有、当前库没有的行按**原 seq** 插回去,
 *   - seq 是 AUTOINCREMENT 主键,原样沿用才能保证同一会话内回放顺序不变;
 *   - 只补 RETAINED 类型(与 src/main/store.ts 的 RETAINED_EVENT_TYPES 对齐),
 *     user/message、assistant/message 属于与 turns 表同源的重复副本,不补;
 *   - 冲突(同 seq 已被占用)一律跳过并计数,绝不覆盖现有行。
 *
 * 用法:
 *   node scripts/restore-pruned-events.mjs                  # 预演(只读,打印可补数量)
 *   node scripts/restore-pruned-events.mjs --apply          # 真正写入(必须先退出 app)
 *   node scripts/restore-pruned-events.mjs --backup <path>  # 指定备份文件
 */
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'KinetAios');
const DB = path.join(DB_DIR, 'history.db');

// 与 src/main/store.ts 的 RETAINED_EVENT_TYPES 保持一致(唯一副本,删了不可恢复)。
const RETAINED = [
  'tool/call',
  'compaction/spill',
  'turn/meta',
  'turn/status',
  'turn/error',
  'legis/compile',
  'context/edit',
  'goal/set',
  'goal/clear',
  'goal/complete',
  'goal/limit',
  'goal/supervisor',
  'goal/failover',
  'session/started',
  'team/status',
  'team/tool',
  'team/done',
];

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const bakArg = argv.indexOf('--backup');
const mb = (n) => (n / 1e6).toFixed(1) + 'MB';

function fail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

// app 是否在跑 —— 权威判据是「谁打开了这个库」,不是进程名。
//   · lsof 无匹配时退出码是 1(不是 0),所以必须看 stdout,不能靠退出码。
//   · 按进程名匹配会两头出错:dev 模式下 Electron 的 argv 只是一个 "."(漏检);
//     而残留的 `npm run dev` 终端里带着项目路径(误判成 app 还在跑)。
//     所以进程名只在 lsof 不可用时兜底,且只匹配 Electron 可执行文件本身。
function appRunning() {
  try {
    const out = execSync(`lsof -F p ${JSON.stringify(DB)} 2>/dev/null; true`, { encoding: 'utf8' });
    return /^p\d+/m.test(out);
  } catch {
    try {
      const out = execSync('pgrep -fl "Electron.app/Contents/MacOS/Electron" || true', { encoding: 'utf8' });
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }
}

function pickBackup() {
  if (bakArg >= 0 && argv[bakArg + 1]) {
    const p = path.resolve(argv[bakArg + 1]);
    if (!fs.existsSync(p)) fail(`备份不存在: ${p}`);
    return p;
  }
  const cands = fs
    .readdirSync(DB_DIR)
    .filter((f) => /^history\.db\.(bak-|backup-)/.test(f) && !/-(wal|shm|journal)$/.test(f))
    .map((f) => {
      const p = path.join(DB_DIR, f);
      return { p, st: fs.statSync(p) };
    })
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  if (!cands.length) fail('没找到 history.db.bak-* / history.db.backup-* 备份文件');
  return cands[0].p;
}

if (!fs.existsSync(DB)) fail(`当前库不存在: ${DB}`);
const BAK = pickBackup();
console.log(`当前库: ${DB}  (${mb(fs.statSync(DB).size)})`);
console.log(`备份  : ${BAK}  (${mb(fs.statSync(BAK).size)})`);
const running = appRunning();
console.log(`app   : ${running ? '⚠️ 运行中(执行 --apply 前必须先完全退出)' : '未运行'}`);
console.log(`模式  : ${APPLY ? '写入(--apply)' : '预演(只读,不改库)'}\n`);

if (APPLY && running) {
  fail('KinetAios 还在运行(有进程持有 history.db)。请先完全退出 app 再执行 --apply。');
}
if (APPLY) {
  // 写之前留一份现场(不复用旧备份,避免"用脏快照覆盖干净快照")
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const snapshot = `${DB}.pre-restore-${stamp}`;
  console.log(`现场快照 → ${path.basename(snapshot)} ……`);
  fs.copyFileSync(DB, snapshot);
  for (const suffix of ['-wal', '-shm']) {
    const f = DB + suffix;
    if (fs.existsSync(f) && fs.statSync(f).size > 0) fs.copyFileSync(f, snapshot + suffix);
  }
  console.log('快照完成', `(${mb(fs.statSync(snapshot).size)})\n`);
}

const db = new DatabaseSync(DB, { readOnly: !APPLY });
db.exec(`ATTACH DATABASE '${BAK.replace(/'/g, "''")}' AS bak`);

const ph = RETAINED.map(() => '?').join(',');
const WHERE = `b.type IN (${ph}) AND NOT EXISTS (SELECT 1 FROM main.conv_events a WHERE a.seq = b.seq)`;

// ① 预演:按类型列出可补回的量
const rows = db
  .prepare(
    `SELECT b.type, COUNT(*) n, SUM(LENGTH(b.data)) bytes
       FROM bak.conv_events b
      WHERE ${WHERE}
      GROUP BY b.type ORDER BY bytes DESC`,
  )
  .all(...RETAINED);

if (!rows.length) {
  console.log('没有可补回的事件 —— 当前库已经是完整的。');
  process.exit(0);
}

let tn = 0;
let tb = 0;
console.log('type'.padEnd(20), 'n'.padStart(9), 'size'.padStart(10));
for (const r of rows) {
  console.log(String(r.type).padEnd(20), String(r.n).padStart(9), mb(r.bytes).padStart(10));
  tn += r.n;
  tb += r.bytes;
}
console.log('─'.repeat(42));
console.log('合计'.padEnd(19), String(tn).padStart(9), mb(tb).padStart(10));

// ② 安全核对:同 seq 但内容不同 = 说明两个库的 seq 语义已经漂移,不能按原 seq 插
const conf = db
  .prepare(
    `SELECT COUNT(*) n FROM bak.conv_events b JOIN main.conv_events a ON a.seq = b.seq
      WHERE b.type IN (${ph}) AND (a.ts != b.ts OR a.type != b.type)`,
  )
  .get(...RETAINED).n;
console.log(`\n同 seq 内容冲突行: ${conf}  ${conf ? '← 有冲突,脚本会跳过这些行,不会覆盖' : '(无)'}`);

const orphans = db
  .prepare(
    `SELECT COUNT(*) n FROM bak.conv_events b
       LEFT JOIN main.conversations c ON c.id = b.conv_id
      WHERE ${WHERE} AND c.id IS NULL`,
  )
  .get(...RETAINED).n;
console.log(`会话已不存在的孤儿行: ${orphans}  ${orphans ? '← 不会插入(会话都删了,恢复也没人看)' : '(无)'}`);

if (!APPLY) {
  console.log('\n预演结束,未改动数据库。确认无误后(先退出 app)执行:');
  console.log('  node scripts/restore-pruned-events.mjs --apply');
  process.exit(0);
}

// ③ 写入:单条 INSERT…SELECT,整体一个事务;OR IGNORE 作双保险
const started = Date.now();
db.exec('BEGIN IMMEDIATE');
let inserted = 0;
try {
  inserted = Number(
    db
      .prepare(
        `INSERT OR IGNORE INTO main.conv_events(seq, conv_id, turn_id, type, data, ts)
         SELECT b.seq, b.conv_id, b.turn_id, b.type, b.data, b.ts
           FROM bak.conv_events b
          WHERE ${WHERE}
            AND b.conv_id IN (SELECT id FROM main.conversations)`,
      )
      .run(...RETAINED).changes,
  );
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  fail(`写入失败已回滚: ${e.message}`);
}

console.log(`\n✅ 已补回 ${inserted} 行,耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

// ④ 校验:事件总数 + 时间边界 + 完整性
const after = db.prepare('SELECT COUNT(*) n, MIN(ts) a FROM main.conv_events').get();
console.log(`事件总数: ${after.n}  最早: ${new Date(after.a).toISOString().slice(0, 10)}`);
for (const r of db
  .prepare(`SELECT type, COUNT(*) n, MIN(ts) a FROM main.conv_events WHERE type IN (${ph}) GROUP BY type ORDER BY n DESC`)
  .all(...RETAINED)) {
  console.log('  ', String(r.type).padEnd(18), String(r.n).padStart(8), '最早', new Date(r.a).toISOString().slice(0, 10));
}
const chk = db.prepare('PRAGMA quick_check;').get();
console.log('quick_check:', Object.values(chk)[0]);
console.log('\n建议接着执行 VACUUM 回收补入后的空闲页:');
console.log(`  sqlite3 "${DB}" "VACUUM;"   # 或 npm 里已有的运维脚本`);
