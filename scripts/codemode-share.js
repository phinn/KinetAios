#!/usr/bin/env node
// codemode 使用率度量:从 history.db 的 conv_events 统计「每轮工具调用里 codemode 占多少」。
//
// 为什么需要它:2026-11 审计发现 codemode 只占 1.5%(458 / 29,390),而 shell 独占 66%,
// 平均每轮 50.3 次往返。把占比拉到 15% 是压往返次数最直接的一刀 —— 但改完提示词/引导之后
// 必须能验证它到底有没有生效,否则就是自我安慰。
//
// 用法:
//   node scripts/codemode-share.js             # 最近 14 天,逐日
//   node scripts/codemode-share.js --days 30   # 最近 30 天
//   node scripts/codemode-share.js --top 12    # 顺带看工具构成
//
// 口径说明:
// - 只统计 type='tool/call' 的事件(codemode 脚本内部的嵌套调用不进本表 → 分子分母口径一致)。
// - 日期按本地时区,ts 兼容秒/毫秒两种历史写法。
// - 目标线 15% 是 2026-11 定的目标,不是结论;低于它说明引导还没起效。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TARGET_PCT = 15;

function dbPath() {
  const rel = path.join('KinetAios', 'history.db');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', rel);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), rel);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), rel);
}

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}

function q(db, sql) {
  const out = execFileSync('sqlite3', [`file:${db}?mode=ro`, '-separator', '|', sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.trim().split('\n').filter(Boolean).map((l) => l.split('|'));
}

const db = arg('db', 0) ? process.argv[process.argv.indexOf('--db') + 1] : dbPath();
if (!fs.existsSync(db)) {
  console.error(`找不到 history.db:${db}\n如果应用装在自定义目录,用 --db <path> 指定。`);
  process.exit(1);
}

const days = arg('days', 14);
const topN = arg('top', 0);
const TS = "case when ts>1e11 then ts/1000.0 else ts end";
const DAY = `date(${TS},'unixepoch','localtime')`;
const NAME = "json_extract(data,'$.name')";

const rows = q(db, `
  select ${DAY} d,
         count(*) total,
         sum(case when ${NAME}='codemode' then 1 else 0 end) cm
  from conv_events
  where type='tool/call'
  group by 1
  order by 1 desc
  limit ${days};
`).reverse();

if (!rows.length) {
  console.error('history.db 里还没有 tool/call 事件(应用跑过一轮才有数据)。');
  process.exit(1);
}

const fmt = (n, w = 6) => String(n).padStart(w);
const pct = (n, d) => (d ? (100 * n) / d : 0);

console.log(`\ncodemode 占比(最近 ${days} 天,目标 ${TARGET_PCT}%)\n`);
console.log(`  ${'日期'.padEnd(12)}${fmt('调用').padStart(8)}${fmt('codemode').padStart(10)}${fmt('占比').padStart(9)}   条形`);
let sumT = 0;
let sumC = 0;
for (const [d, t, c] of rows) {
  const total = Number(t);
  const cm = Number(c);
  sumT += total;
  sumC += cm;
  const p = pct(cm, total);
  // 条形:1 格 = 2%,超目标的段用 █ 标出
  const cells = Math.min(40, Math.round(p / 2));
  const bar = '█'.repeat(cells) + '·'.repeat(Math.max(0, Math.round(TARGET_PCT / 2) - cells));
  console.log(`  ${d.padEnd(12)}${fmt(total)}${fmt(cm)}${(p.toFixed(1) + '%').padStart(9)}   ${bar}`);
}

const share = pct(sumC, sumT);
console.log(`\n  合计 ${sumT} 次调用,codemode ${sumC} 次 → ${share.toFixed(1)}%`);
console.log(`  距目标 ${TARGET_PCT}% ${share >= TARGET_PCT ? '已达标' : `还差 ${(TARGET_PCT - share).toFixed(1)} 个百分点(按当前总量约需 ${Math.ceil((TARGET_PCT / 100) * sumT) - sumC} 次 codemode)`}`);

if (topN > 0) {
  const tools = q(db, `
    select coalesce(${NAME},'(unknown)') nm, count(*) n
    from conv_events
    where type='tool/call'
      and ${TS} > strftime('%s','now') - ${days} * 86400
    group by 1 order by 2 desc limit ${topN};
  `);
  const tTotal = tools.reduce((a, [, n]) => a + Number(n), 0);
  console.log(`\n  工具构成(最近 ${days} 天,${tTotal} 次):`);
  for (const [nm, n] of tools) {
    console.log(`    ${nm.padEnd(22)}${fmt(n, 7)}  ${pct(Number(n), tTotal).toFixed(1)}%`);
  }
}
console.log('');
