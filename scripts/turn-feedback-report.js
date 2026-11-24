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
//   node scripts/turn-feedback-report.js --prune --apply   # 把候选移进 .archive/(不删)
//   node scripts/turn-feedback-report.js --restore        # 列出已归档
//   node scripts/turn-feedback-report.js --restore <slug|id>  # 搬回 distilled/
//
// 口径:
// - 评分来源是隐式的:用户下一轮带着不满回来(correction)/ 把同一件事再问一遍(reask)/
//   引擎报错或用户点停止(error|aborted)。rating=-1 恒负、只升不降。
// - "技能返工率" = 加载了该技能的 turn 里,有多少最终被记为负。分母是加载轮数。
// - --prune 默认只报告;--apply 才动文件,且只是同一磁盘上 rename 进 .archive/,
//   一个字节都不删。恢复用 --restore。手写技能(~/.kinetaios/skills/<name>)永不触碰,
//   只扫 distilled/ 一层。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function dbPath() {
  // --db / KINET_DB:审计隔离库(如 npm run eval --keep 留下的临时 userData),
  // 否则一律读真实桌面库 —— 避免把评测数据混进真实统计。
  const i = process.argv.indexOf('--db');
  if (i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return path.resolve(process.argv[i + 1]);
  if (process.env.KINET_DB) return path.resolve(process.env.KINET_DB);

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
// 字符串参数(--restore <slug> / --skills-dir <dir>):下一个 token 不是 -- 开头才算。
function strArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : '';
}

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

  // ── 失败归因分布(P2)────────────────────────────────────────
  // fail:<class>[:detail]:class 是"谁的锅",detail 是可定位的细项。
  // 先按 class 汇总(order by 数量),再列 detail —— 看第一层就知道该往哪查。
  const failTags = [...tagCount.entries()].filter(([t]) => t.startsWith('fail:'));
  if (failTags.length) {
    const byClass = new Map();
    const byDetail = new Map();
    for (const [t, n] of failTags) {
      const parts = t.split(':');
      const cls = parts[1] || 'unknown';
      const detail = parts.slice(2).join(':') || '(未细分)';
      byClass.set(cls, (byClass.get(cls) || 0) + n);
      byDetail.set(t, n);
    }
    const clsTotal = [...byClass.values()].reduce((a, b) => a + b, 0);
    console.log('\n  失败归因:');
    for (const [cls, n] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
      const label = {
        tool: '工具', plan: '规划', env: '上游/网络', context: '上下文',
        model: '模型', user: '用户停止', unknown: '未归类',
      }[cls] || cls;
      console.log(`    ${fmt(n, 4)} (${pct(n, clsTotal).toFixed(0).padStart(3)}%)  ${cls.padEnd(8)} ${label}`);
    }
    console.log(`    细项: ${[...byDetail.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join('  ')}`);
    if (byClass.has('env')) {
      console.log('    注:env 类是上游/网络抖动,不应计入能力退化;评估技能/模型时应先剔除。');
    }
  }
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

// ── ③ 淘汰动作的落地件:distilled 路径 + 归档/恢复原语 ──────────
const distilledDir = strArg('skills-dir') || path.join(os.homedir(), '.kinetaios', 'skills', 'distilled');
const ARCHIVE_DIRNAME = '.archive';
const ARCHIVE_INDEX = '_index.jsonl';
const archiveRoot = () => path.join(distilledDir, ARCHIVE_DIRNAME);

/** 归档一个技能目录:同卷 rename + 追加索引行。返回 id;目录不存在返回 ''。 */
function archiveSkill(slug, name, reasons) {
  const src = path.join(distilledDir, slug);
  if (!fs.existsSync(src)) return '';
  fs.mkdirSync(archiveRoot(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let id = `${slug}__${stamp}`;
  let dest = path.join(archiveRoot(), id);
  for (let i = 1; fs.existsSync(dest); i++) {
    id = `${slug}__${stamp}-${i}`;
    dest = path.join(archiveRoot(), id);
  }
  fs.renameSync(src, dest);
  fs.appendFileSync(
    path.join(archiveRoot(), ARCHIVE_INDEX),
    `${JSON.stringify({ id, slug, name, reasons, at: Date.now() })}\n`,
    'utf8',
  );
  return id;
}

function readArchiveIndex() {
  let text = '';
  try {
    text = fs.readFileSync(path.join(archiveRoot(), ARCHIVE_INDEX), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && typeof e.id === 'string') out.push(e);
    } catch { /* 跳过坏行 */ }
  }
  return out.reverse();
}
// ── ④ 恢复(--restore)────────────────────────────────────────
if (flag('restore')) {
  const target = strArg('restore');
  const entries = readArchiveIndex();
  if (!target) {
    console.log(`\n已归档 ${entries.length} 个(${archiveRoot()})\n`);
    if (!entries.length) console.log('  空。');
    for (const e of entries.slice(0, 40)) {
      console.log(`  ${String(e.id).padEnd(46)}${String(e.name).padEnd(26)}${(e.reasons || []).join(' · ')}`);
    }
    console.log('\n  恢复:--restore <slug 或 id>');
    console.log('');
    process.exit(0);
  }
  const hit = entries.find((e) => e.id === target) || entries.find((e) => e.slug === target);
  if (!hit) {
    console.error(`归档里没有:${target}(用 --restore 不带参数看列表)`);
    process.exit(1);
  }
  const src = path.join(archiveRoot(), hit.id);
  const dest = path.join(distilledDir, hit.slug);
  if (!fs.existsSync(src)) { console.error(`归档目录已不存在:${src}`); process.exit(1); }
  if (fs.existsSync(dest)) { console.error(`目标已存在,拒绝覆盖:${dest}`); process.exit(1); }
  fs.renameSync(src, dest);
  console.log(`\n已恢复:${hit.slug} → ${dest}\n`);
  process.exit(0);
}

// ── ⑤ 淘汰候选(默认只报告;--apply 才移进 .archive/)────────────
if (flag('prune')) {
  let entries = [];
  try {
    entries = fs.readdirSync(distilledDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
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
    // 存活期锚"首次见到",不是文件 mtime(与 src/main/skill-archive.ts 同口径):
    // 外部覆盖写会刷新文件 mtime,按它算会把空胎的观察期无限重置。
    // 目录 mtime 只在增删条目时变,取目录/文件时间的早者最稳。
    let firstSeen = mtime;
    try {
      const d = fs.statSync(path.join(distilledDir, e.name));
      firstSeen = Math.min(mtime, d.birthtimeMs > 0 ? d.birthtimeMs : mtime, d.mtimeMs > 0 ? d.mtimeMs : mtime);
    } catch { /* 目录读不了 → 退回文件 mtime */ }
    // 蒸馏 frontmatter 的 name 才是引擎里的名字;目录名是 slug,可能被 slugify 过。
    const raw = fs.readFileSync(file, 'utf8');
    const name = (raw.slice(0, 400).match(/^name:\s*(.+)$/m) || [])[1]?.trim() || e.name;
    // 空胎判据看"正文"字节数(去掉 frontmatter),不是文件大小 —— 与 src/main/skill-archive.ts 同口径。
    bytes = Buffer.byteLength(raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''), 'utf8');
    const rec = use.get(name) || use.get(e.name);
    const ageDays = Math.floor((Date.now() - firstSeen) / 86400_000);
    // 给新技能一个被用到的机会:蒸馏完当天就没人调是正常的(还没遇到同类任务),
    // 不能当淘汰依据 —— 否则每天新产的技能全部秒变"候选",报告就没内容价值了。
    const dead = (!rec || rec.loads === 0) && ageDays >= MIN_AGE_DAYS;
    const bad = rec && rec.loads >= 3 && pct(rec.neg, rec.loads) >= 50;
    // 空胎也给一天观察期(与 src/main/skill-archive.ts 同口径):刚落盘才可能写坏,
    // 写入当秒就搬走会把正在重试的半成品一起收掉。
    const empty = bytes < 200 && ageDays >= 1;
    if (dead || bad || empty) {
      stale.push({ slug: e.name, name, loads: rec?.loads ?? 0, neg: rec?.neg ?? 0, ageDays, bytes, dead, bad });
    }
  }
  console.log(`\n淘汰候选(${stale.length}/${entries.length} 个,${flag('apply') ? '本次会归档' : '只报告'})\n`);
  if (!stale.length) console.log('  没有需要处理的:每个蒸馏技能都被用过,且没有被否。');
  for (const s of stale.sort((a, b) => a.loads - b.loads)) {
    const why = [];
    if (s.dead) why.push(`近 ${days} 天 0 次加载(已存 ${s.ageDays} 天)`);
    if (s.bad) why.push(`否定率 ${pct(s.neg, s.loads).toFixed(0)}%`);
    if (s.bytes < 200) why.push(`正文仅 ${s.bytes}B(疑似空胎)`);
    console.log(`  ${s.slug.padEnd(34)}存 ${String(s.ageDays).padStart(3)} 天  ${why.join(' · ')}`);
  }
  if (flag('apply') && stale.length) {
    const moved = [];
    for (const s of stale) {
      const why = [];
      if (s.dead) why.push(`近 ${days} 天 0 次加载(已存 ${s.ageDays} 天)`);
      if (s.bad) why.push(`否定率 ${pct(s.neg, s.loads).toFixed(0)}%`);
      if (s.bytes < 200) why.push(`正文仅 ${s.bytes}B(疑似空胎)`);
      const id = archiveSkill(s.slug, s.name, why);
      if (id) moved.push(id);
    }
    console.log(`\n  已归档 ${moved.length}/${stale.length} 个 → ${archiveRoot()}`);
    console.log('  文件全部保留,恢复:--restore <slug|id>');
  } else if (stale.length) {
    console.log('\n  处置:--apply 移入 .archive/(不删除,可 --restore 恢复)。');
  }
}
console.log('');
