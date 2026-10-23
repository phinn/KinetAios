/* 冒烟: tool-spill 落盘→grep 回捞(真模块)+ lessons 存取 SQL 语义(真 better-sqlite3)。
 * 用法(已验证;勿用裸 npx tsx —— 系统 node ABI(127)与 electron 编译的 better-sqlite3(125)不匹配):
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron \
 *     "$(npm exec -c 'node -p "require.resolve(\"tsx/dist/cli.mjs\")"')" scripts/smoke-spill-lessons.ts
 * 注: electron 在 node 下 import 只是 stub(app=undefined),tool-spill 因 KINET_TOOL_OUTPUT_DIR
 * 已设不会走 app.getPath,故可直接测真函数。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.KINET_TOOL_OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-spill-'));

// ── 1. 真模块: spillToolOutput 落盘 → grepToolOutput 回捞 ──
import { spillToolOutput, grepToolOutput, TOOL_OUTPUT_SPILL_THRESHOLD } from '../src/main/tool-spill';

const secret = 'THE_SECRET_TOKEN_ZZ9=alpha-bravo';
const body = Array.from({ length: 900 }, (_, i) =>
  i === 450 ? `line ${i}: ${secret}` : `line ${i}: filler filler ${'x'.repeat(20)}`,
).join('\n');
const f = spillToolOutput('conv-test', 'Bash', body);
if (!f) throw new Error('大输出应落盘返回路径');
const hits = grepToolOutput('conv-test', 'SECRET_TOKEN_ZZ9', { context: 2, maxHits: 10 });
if (!hits.includes('alpha-bravo')) throw new Error(`回捞失败: ${hits.slice(0, 200)}`);
if (spillToolOutput('conv-test', 'Bash', 'tiny') !== null) throw new Error('小输出不应落盘');
if (TOOL_OUTPUT_SPILL_THRESHOLD !== 8000) throw new Error('阈值意外变动');
// file 过滤参数
const miss = grepToolOutput('conv-test', 'SECRET_TOKEN_ZZ9', { context: 1, maxHits: 5, file: '/nonexistent.txt' });
if (!miss.includes('未匹配') && !miss.includes('no match') && !miss.startsWith('溢出文件')) {
  console.log(`(file 过滤行为: ${miss.slice(0, 80)})`);
}
console.log('✅ tool-spill: 真模块落盘→grep 回捞 OK');

// ── 2. lessons SQL 语义(与 store.loadLessons 同构,真 better-sqlite3)──
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-db-'));
const Database = require('better-sqlite3');
const db = new Database(path.join(dbDir, 't.db'));
db.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, kind TEXT, content TEXT, conversation_id TEXT, scope_cwd TEXT, importance INTEGER, created_at INTEGER);`);
const ins = db.prepare(`INSERT INTO memories (id, kind, content, conversation_id, scope_cwd, importance, created_at) VALUES (?,?,?,?,?,?,?)`);
ins.run('l1', 'lesson', 'VFR 录屏 duration 缩水,验内容用帧数', 'c1', '/repo/a', 8, 1792400000);
ins.run('l2', 'lesson', '全局教训: pkill -f 自杀', null, null, 9, 1792300000);
ins.run('l3', 'lesson', '别的仓库的教训不可见', 'c2', '/repo/b', 10, 1792500000);
const lessonsForA = db.prepare(
  `SELECT id FROM memories WHERE kind='lesson' AND (scope_cwd IS NULL OR scope_cwd = ?)
   ORDER BY (scope_cwd IS NOT NULL) DESC, importance DESC, created_at DESC;`,
).all('/repo/a') as Array<{ id: string }>;
const ids = lessonsForA.map((l) => l.id);
if (!(ids.includes('l1') && ids.includes('l2') && !ids.includes('l3'))) {
  throw new Error(`/repo/a 应命中 l1+l2 不含 l3, got ${JSON.stringify(ids)}`);
}
// 仓库级优先占位: l1(repo) 排在 l2(全局) 前
if (ids[0] !== 'l1') throw new Error(`仓库级应排前, got ${JSON.stringify(ids)}`);
console.log('✅ lessons: cwd 范围过滤 + 仓库级优先 OK');

fs.rmSync(process.env.KINET_TOOL_OUTPUT_DIR, { recursive: true, force: true });
fs.rmSync(dbDir, { recursive: true, force: true });
console.log('smoke done');
