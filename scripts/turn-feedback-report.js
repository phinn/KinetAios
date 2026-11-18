#!/usr/bin/env node
// turn_feedback 账本 + 技能返工率:验证「隐式反馈」到底有没有在记,以及哪些技能该淘汰。
//
// 为什么需要它:turn_feedback 表从建库起就是 0 行 —— 有表有字段、代码里零引用。
// 结果是能力进化(技能淘汰 / 基因选择)手里没有任何成败标签,只能靠"感觉"决定留谁。
// 2026-11-18 补上写入路径(TaskManager.gradeLastTurn + error/abort 硬信号),本脚本负责审计:
//   ①信号真的在进吗 ②记在哪一类原因上 ③按技能聚合后谁是净负资产
//
// 用法:
//   node scripts/turn-feedback-report.js              # 近 30 天
//   node scripts/turn-feedback-report.js --days 7     # 近 7 天
//   node scripts/turn-feedback-report.js --prune      # 额外列淘汰候选(distilled 目录)
//
// 口径:
// - 评分来源是隐式的:用户下一轮带着不满回来(correction)/ 把同一件事再问一遍(reask)/
//   引擎报错或用户点停止(error|aborted)。rating=-1 恒负、只升不降。
// - "技能返工率" = 加载了该技能的 turn 里,有多少最终被记为负。分母是加载轮数。
// - --prune 只报告不删文件:技能目录在用户 home 下,删之前必须由人确认。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function dbPath() {
  const rel = path.join('KinetAios', 'history.db');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', rel);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), rel);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), rel);
}

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? Number(process.argv[i + 1]) : dflt;
}
const flag = (name) => process.argv.includes(`--${name}`);

function q(db, sql) {
  const out = execFileSync('sqlite3', [`file:${db}?mode=ro`, '-separator', '|', sql], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return out.trim().split('\n').filter(Boolean).map((l) => l.split('|'));
}

const db = process.argv.includes('--db') ? process.argv[process.argv.indexOf('--db') + 1] : dbPath();
if (!fs.existsSync(db)) {
  console.error(`找不到 history.db:${db}\n如果应用装在自定义目录,用 --db <path> 指定。`);
  process.exit(1);
}

const days = arg('days', 30);
// 判定"从未被用过"的最小存活天数(见下方 dead 判据)。
const MIN_AGE_DAYS = 7;
const SINCE_MS = Date.now() - days * 86400_000;
const hasTs = q(db, 'pragma table_info(turn_feedback);').some((r) => r[1] === 'ts');
const TS_EXPR = hasTs ? 'coalesce(ts,0)' : '0';
const fmt = (n, w = 6) => String(n).padStart(w);
const pct = (n, d) => (d ? (100 * n) / d : 0);

// ── ① 账本概况 ────────────────────────────────────────────────
const total = Number((q(db, 'select count(*) from turn_feedback;')[0] || ['0'])[0]);
console.log(`\nturn_feedback 账本(全部 ${total} 条,统计窗口 ${days} 天)\n`);
if (!total) {
  // 账本空不等于没东西可看:技能返工率/淘汰候选仍然要跑(分母是 load_skill 调用,不依赖反馈)。
  console.log('  还没有任何记录。');
  console.log('  写入点在 TaskManager:sendCore 里 gradeLastTurn(纠正/重问)+ 终态 error/aborted。');
  console.log('  表是空的 = 代码还没跑过新版本,或这段时间用户一次都没返工(不太可能)。');
}

if (total) {
  const tagRows = q(db, `select coalesce(tags,''), count(*) from turn_feedback group by 1 order by 2 desc;`);
  const tagCount = new Map();
  for (const [tags, n] of tagRows) {
    for (const t of tags.split(',').map((s) => s.trim()).filter(Boolean)) {
      tagCount.set(t, (tagCount.get(t) || 0) + Number(n));
    }
  }
  const ratingRows = q(db, 'select coalesce(rating,0), count(*) from turn_feedback group by 1 order by 1;');
  console.log(`  rating 分布: ${ratingRows.map(([r, n]) => `${r}×${n}`).join('  ')}`);
  console.log(`  tag 分布: ${[...tagCount.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join('  ') || '(空)'}`);
}

const byDay = q(db, `
  select date(${TS_EXPR}/1000,'unixepoch','localtime') d, count(*) n
  from turn_feedback
  where ${TS_EXPR} >= ${SINCE_MS}
  group by 1 order by 1 desc limit 14;
`).reverse();
if (byDay.length) {
  console.log(`\n  逐日负样本(${byDay.length} 天有记录):`);
  console.log(`    ${byDay.map(([d, n]) => `${d.slice(5)}:${n}`).join('  ')}`);
}

// ── ② 按技能聚合返工率 ─────────────────────────────────────────
const rows = q(db, `
  select t.id,
         json_extract(json_extract(s.value,'$.args'),'$.name') nm
  from turns t, json_each(t.data,'$.steps') s
  where t.created_at >= ${SINCE_MS}
    and json_extract(s.value,'$.name')='load_skill'
    and json_extract(json_extract(s.value,'$.args'),'$.name') is not null;
`);
const fbIds = new Set(q(db, `select turn_id from turn_feedback where ${TS_EXPR} >= ${SINCE_MS};`).map((r) => r[0]));
const use = new Map();
for (const [turnId, nm] of rows) {
  const rec = use.get(nm) || { loads: 0, neg: 0, lastTurn: '' };
  rec.loads++;
  if (fbIds.has(turnId)) rec.neg++;
  rec.lastTurn = turnId;
  use.set(nm, rec);
}
const sorted = [...use.entries()].sort((a, b) => b[1].loads - a[1].loads);
if (sorted.length) {
  console.log(`\n技能返工率(近 ${days} 天,${rows.length} 次 load_skill / ${use.size} 个技能)\n`);
  console.log(`  ${'skill'.padEnd(30)}${fmt('加载').padStart(7)}${fmt('被否').padStart(7)}${fmt('否定率').padStart(9)}`);
  for (const [nm, r] of sorted.slice(0, 20)) {
    const mark = r.loads >= 3 && pct(r.neg, r.loads) >= 50 ? '  ← 净负' : '';
    console.log(`  ${String(nm).padEnd(30)}${fmt(r.loads)}${fmt(r.neg)}${(pct(r.neg, r.loads).toFixed(0) + '%').padStart(9)}${mark}`);
  }
} else {
  console.log(`\n  近 ${days} 天没有 load_skill 调用记录。`);
}

// ── ③ 淘汰候选(只报告,不动文件)──────────────────────────────
const distilledDir = path.join(os.homedir(), '.kinetaios', 'skills', 'distilled');
if (flag('prune')) {
  let entries = [];
  try {
    entries = fs.readdirSync(distilledDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    console.log(`\n  没有蒸馏目录:${distilledDir}`);
  }
  const stale = [];
  for (const e of entries) {
    const file = path.join(distilledDir, e.name, 'SKILL.md');
    let mtime = 0;
    let bytes = 0;
    try {
      const st = fs.statSync(file);
      mtime = st.mtimeMs;
      bytes = st.size;
    } catch {
      continue;
    }
    // 蒸馏 frontmatter 的 name 才是引擎里的名字;目录名是 slug,可能被 slugify 过。
    const head = fs.readFileSync(file, 'utf8').slice(0, 400);
    const name = (head.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || e.name;
    const rec = use.get(name) || use.get(e.name);
    const ageDays = Math.floor((Date.now() - mtime) / 86400_000);
    // 给新技能一个被用到的机会:蒸馏完当天就没人调是正常的(还没遇到同类任务),
    // 不能当淘汰依据 —— 否则每天新产的技能全部秒变"候选",报告就没内容价值了。
    const dead = (!rec || rec.loads === 0) && ageDays >= MIN_AGE_DAYS;
    const bad = rec && rec.loads >= 3 && pct(rec.neg, rec.loads) >= 50;
    if (dead || bad || bytes < 200) {
      stale.push({ slug: e.name, name, loads: rec?.loads ?? 0, neg: rec?.neg ?? 0, ageDays, bytes, dead, bad });
    }
  }
  console.log(`\n淘汰候选(${stale.length}/${entries.length} 个,只报告不删除)\n`);
  if (!stale.length) console.log('  没有需要处理的:每个蒸馏技能都被用过,且没有被否。');
  for (const s of stale.sort((a, b) => a.loads - b.loads)) {
    const why = [];
    if (s.dead) why.push(`近 ${days} 天 0 次加载(已存 ${s.ageDays} 天)`);
    if (s.bad) why.push(`否定率 ${pct(s.neg, s.loads).toFixed(0)}%`);
    if (s.bytes < 200) why.push(`正文仅 ${s.bytes}B(疑似空胎)`);
    console.log(`  ${s.slug.padEnd(34)}存 ${String(s.ageDays).padStart(3)} 天  ${why.join(' · ')}`);
  }
  console.log('\n  处置建议:确认后手工移入 ~/.kinetaios/skills/distilled/.archive/(不要直接删)。');
}
console.log('');
