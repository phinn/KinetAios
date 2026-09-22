// 一次性回填脚本:为 memories 表缺 embedding 的记录补算向量。
// 背景:2026-09-22 修复 glm.embed 的 anthropic 守卫误杀智谱 /api/anthropic 端点前,
// 所有记忆从未有向量(0/18577),embedding 召回链静默失效。
// 用法:ZHIPU_API_KEY=xxx node scripts/backfill-memory-embeddings.mjs [--dry]
// 批量 32 条/请求,embedding-3,限速 3 req/s,可中断重跑(只补缺失的)。
// 用 node:sqlite(内置,Node 22.5+):better-sqlite3 是 Electron ABI,node 直跑会 NODE_MODULE_VERSION 冲突。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const DB = path.join(os.homedir(), 'Library/Application Support/KinetAios/history.db');
const KEY = process.env.ZHIPU_API_KEY;
if (!KEY) { console.error('缺 ZHIPU_API_KEY'); process.exit(1); }

const db = new DatabaseSync(DB);
const rows = db.prepare(`
  SELECT m.id, m.content FROM memories m
  LEFT JOIN memory_embeddings e ON e.memory_id = m.id
  WHERE e.memory_id IS NULL ORDER BY m.created_at ASC;`).all();
console.log(`待回填: ${rows.length} 条`);
if (process.argv.includes('--dry')) process.exit(0);

const ins = db.prepare('INSERT OR REPLACE INTO memory_embeddings(memory_id, vec, model, created_at) VALUES(?,?,?,?);');
const model = 'embedding-3';
const BATCH = 32;
let done = 0, fail = 0;
const toBlob = (arr) => Buffer.from(new Float32Array(arr).buffer);
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const texts = batch.map((r) => r.content.slice(0, 2000)); // embedding-3 上限 8k token,截断保平安
  try {
    const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
    const json = await resp.json();
    const vecs = json.data ?? [];
    if (vecs.length !== batch.length) throw new Error(`返回 ${vecs.length} 条 != 请求 ${batch.length} 条`);
    for (let j = 0; j < batch.length; j++) {
      ins.run(batch[j].id, toBlob(vecs[j].embedding), model, Date.now() / 1000);
    }
    done += batch.length;
  } catch (e) {
    fail += batch.length;
    console.error(`\n批次 ${i}-${i + batch.length} 失败: ${e.message}`);
    if (/HTTP 4/.test(e.message)) { console.error('4xx 退出(大概率 key 问题)'); break; }
    await new Promise((r) => setTimeout(r, 3000)); // 失败退避
  }
  process.stdout.write(`\r${done}/${rows.length}(失败 ${fail})`);
  await new Promise((r) => setTimeout(r, 350)); // ~3 req/s
}
console.log(`\n完成: 成功 ${done} / 失败 ${fail}`);
