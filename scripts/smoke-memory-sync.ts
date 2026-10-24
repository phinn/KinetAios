/**
 * memory-sync 冒烟 — 本地 bare 仓库模拟双机互同步全链路。
 * ① A 机导出+push → ② B 机(空库)pull+导入,断言条目数一致 → ③ B 机再 push →
 * ④ A 机再同步,断言幂等(不重复导入、不产生空 commit 风暴)。
 * 跑法:npx tsx scripts/smoke-memory-sync.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memorySync, type MemoryStoreApi } from '../src/main/memory-sync';
import type { MemoryRow } from '../src/shared/types';

const dir = mkdtempSync(join(tmpdir(), 'memsync-smoke-'));
const bare = join(dir, 'remote.git');
const workA = join(dir, 'a');

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

async function main(): Promise<void> {
  try {
    // 远端 bare 仓库(gitee/github 的本地替身)
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'pipe' });

    // A 机"SQLite":3 条 memories + 2 lessons + 1 block
    const memA: MemoryRow[] = [
      { id: 'm1', content: '用户主力技术栈 TypeScript', createdAt: 1, conversationId: null, importance: 5, kind: 'fact', triggerKw: null, strikes: 0, struckAt: null, scopeCwd: null },
      { id: 'm2', content: 'typecheck 后必须 build', createdAt: 2, conversationId: null, importance: 7, kind: 'lesson', triggerKw: null, strikes: 0, struckAt: null, scopeCwd: '/proj/a' },
      { id: 'm3', content: '禁止 pkill -f KinetAios', createdAt: 3, conversationId: null, importance: 9, kind: 'lesson', triggerKw: null, strikes: 0, struckAt: null, scopeCwd: null },
    ];
    const blocksA = new Map([['user_profile', '# 用户画像\n- 短指令']]);
    const mkStore = (mems: MemoryRow[], importedIds: string[]): MemoryStoreApi => ({
      exportMemories: () => mems,
      importMemories: (rows) => {
        let n = 0;
        for (const r of rows) if (!mems.some((m) => m.id === r.id)) { mems.push(r); importedIds.push(r.id); n++; }
        return n;
      },
      exportBlocks: () => [...blocksA.entries()].map(([label, value]) => ({ label, value, updatedAt: 42 })),
      importBlock: (label, value) => { blocksA.set(label, blocksA.get(label)?.length! >= value.length ? blocksA.get(label)! : value); return true; },
    });
    const importedA: string[] = [];
    const storeA = mkStore(memA, importedA);
    const cfg = { remote: bare, branch: 'main', autoSyncMinutes: 0 };

    // ① A 机首同步(clone 空 bare → 导出 → commit → push)
    const r1 = await memorySync(cfg, workA, storeA);
    if (!r1.ok || !r1.pushed) fail(`① A 机首同步失败: ${r1.error ?? JSON.stringify(r1.steps)}`);
    if (!existsSync(join(workA, 'memory-sync', 'memory-sync-' + bare.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-64), 'lessons.md'))) {
      fail('① 未产出 lessons.md');
    }
    console.log(`✓ ① A 机首同步 ok exported=${r1.exported} commits=${r1.commits}`);

    // ② B 机(空库)同步:应把 A 的 3 条全部导入
    const memB: MemoryRow[] = [];
    const importedB: string[] = [];
    const storeB = mkStore(memB, importedB);
    const r2 = await memorySync(cfg, join(dir, 'b'), storeB);
    if (!r2.ok) fail(`② B 机同步失败: ${r2.error ?? JSON.stringify(r2.steps)}`);
    if (memB.length !== 3) fail(`② B 机导入后应有 3 条,实际 ${memB.length}`);
    if (importedB.length !== 3) fail(`② B 机实际导入 ${importedB.length} 条,应 3`);
    if (!blocksBHas(storeB, 'user_profile')) fail('② blocks 未导入');
    // 回归(2026-10-24):store.exportBlocks 映射曾把列名写错(SELECT content,实际列是 value)
    // 且 .map 把 value.content 又抄一遍 —— 双重错配。这里断言导出值非空,锁死该类 bug。
    const bval = storeB.exportBlocks().find((b) => b.label === 'user_profile')?.value ?? '';
    if (!bval.includes('短指令')) fail(`② blocks 导出值丢失(拿到空/错值): ${JSON.stringify(bval)}`);
    console.log(`✓ ② B 机拉到 3 条 memories + blocks,imported=${r2.imported}`);

    // ③ B 机加一条,再 push
    memB.push({ id: 'm4', content: 'B 机独有:KinetLoop 勿启动', createdAt: 4, conversationId: null, importance: 5, kind: 'fact', triggerKw: null, strikes: 0, struckAt: null, scopeCwd: null });
    const r3 = await memorySync(cfg, join(dir, 'b'), storeB);
    if (!r3.ok || !r3.pushed) fail(`③ B 机二推失败: ${r3.error}`);

    // ④ A 机再同步:拉到 m4,且自身 3 条不重复导入(importedA 仍空)
    const r4 = await memorySync(cfg, workA, storeA);
    if (!r4.ok) fail(`④ A 机回拉失败: ${r4.error}`);
    if (memA.length !== 4) fail(`④ A 机应有 4 条,实际 ${memA.length}`);
    if (importedA.length !== 1 || importedA[0] !== 'm4') fail(`④ A 机应恰好导入 m4,实际 ${JSON.stringify(importedA)}`);

    // ⑤ 幂等:连续同步第 3 次,memories 不涨、facts.ndjson 行数稳定
    const before = memA.length;
    await memorySync(cfg, workA, storeA);
    await memorySync(cfg, workA, storeA);
    if (memA.length !== before) fail(`⑤ 幂等破坏:${before} → ${memA.length}`);
    const mirror = join(workA, 'memory-sync', 'memory-sync-' + bare.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-64));
    const ndjson = readFileSync(join(mirror, 'facts.ndjson'), 'utf8').trim().split('\n');
    if (ndjson.length !== 4) fail(`⑤ facts.ndjson 应 4 行,实际 ${ndjson.length}`);

    console.log('✓ ④⑤ 双向回拉 + 幂等全部通过');
    console.log('\nPASS 5/5 — memory-sync 双机互同步全链路 ✓');
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    fail((e as Error).stack ?? String(e));
  }
}

main().catch((e) => {
  fail((e as Error).stack ?? String(e));
});

function blocksBHas(s: MemoryStoreApi, label: string): boolean {
  return s.exportBlocks().some((b) => b.label === label && b.value.length > 0);
}
