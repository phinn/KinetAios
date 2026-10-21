/**
 * SQL INSERT 列数一致性冒烟 — 防止「列 N 个 vs VALUES ?N±1 个」错位再犯。
 * 2026-10-21 实锤:931d622 给 conversations 加 loop_ralph 列时 VALUES 多写一个 ?,
 * typecheck 对 SQL 字符串天然失明,clear-goal 等 IPC 在运行时抛
 * SqliteError: 21 values for 20 columns,UI 全部静默无反应。
 *
 * 规则:每条 INSERT INTO t(...) VALUES(...) 的列数 == (问号数 + 字面量个数)。
 * ponytail: 字面量按逗号粗 split,字符串含逗号会误报 —— 本库无此形态,出现了再升级。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = walk('src/main');
const re = /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/g;
let checked = 0;
const bad: string[] = [];

for (const f of files) {
  const src = readFileSync(f, 'utf-8');
  for (const m of src.matchAll(re)) {
    checked++;
    const table = m[1];
    const cols = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    const items = m[3].split(',').map((s) => s.trim()).filter(Boolean);
    const qs = items.filter((s) => s === '?').length;
    const literals = items.length - qs;
    if (cols.length !== qs + literals) {
      const line = src.slice(0, m.index).split('\n').length;
      bad.push(`${f}:${line} ${table}: 列 ${cols.length} vs VALUES ${qs}?+${literals}字面量=${qs + literals}`);
    }
  }
}

if (bad.length) {
  console.error(`✗ ${bad.length}/${checked} 条 INSERT 列数错位:`);
  for (const b of bad) console.error(' ', b);
  process.exit(1);
}
console.log(`✓ ${checked} 条 INSERT 列数/VALUES 全部一致`);
