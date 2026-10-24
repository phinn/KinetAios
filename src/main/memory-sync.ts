/**
 * memory-sync — 记忆 Git 仓库同步(memory as code)。
 *
 * 设计(2026-10-22,用户拍板 Git 方案):
 * - 真相源仍是本地 SQLite;导出物是文本视图:lessons.md(项目教训,按 scope_cwd 分区) +
 *   facts.ndjson(memories 表全量)+ blocks.json(memory_blocks 常驻块)。
 * - 同步 = 写出文本 → 在配置的 git 仓库里 commit + push;push 前先 pull。
 * - 双向:pull 到远端变更后把远端条目并回 SQLite(幂等:memories 按 id UPSERT、
 *   lessons 走 addLesson 去重、blocks 按 updated_at LWW + 字数上限)。
 * - L2(对话原文/history)默认不导出 —— 隐私分级:L0 lessons 明文、L1 facts/blocks、L2 不出本地。
 * - gitee/github 皆可:就是个 git remote,凭证复用系统 git credential(用户已 push 过该仓库即可)。
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MemorySyncSettings, MemorySyncResult, MemoryRow } from '../shared/types';

// ── git 调用:execFile(无 shell,参数数组,免注入)──
function git(
  repoDir: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repoDir, ...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') });
      },
    );
  });
}

/** 从 remote URL 推导本地镜像目录名(只保留安全字符,防路径穿越) */
function repoDirName(remote: string): string {
  const safe = remote.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-64);
  return `memory-sync-${safe}`;
}

export interface MemoryStoreApi {
  /** memories 全量(id 去重后的追加式事实流) */
  exportMemories(): import('../shared/types').MemoryRow[];
  /** 按 id 批量并入 memories(已存在的 id 跳过 —— 追加式事实流,本地为准) */
  importMemories(rows: import('../shared/types').MemoryRow[]): number;
  /** memory_blocks 常驻块 */
  exportBlocks(): Array<{ label: string; value: string; updatedAt: number }>;
  /** 按 updated_at 新者胜并入 block(字数上限由 store 内部裁) */
  importBlock(label: string, value: string, updatedAt: number): boolean;
  /** 全量会话行(id/engine/cwd/title/goal/direct_history/updated_at/…,跨设备接续对话用) */
  exportConversations(): Array<Record<string, unknown>>;
  /** 按 id 幂等导入会话行,返回新导入条数(已存在跳过,本地为准) */
  importConversations(rows: Array<Record<string, unknown>>): number;
  /** 全量 turn 行(conv_id + data 整 turn JSON),FTS 回填在导入侧做 */
  exportTurns(): Array<{ id: string; conv_id: string; data: string; created_at: number }>;
  /** 按 turn id 幂等导入 + 回填 FTS history/history_conv,返回新导入条数 */
  importTurns(rows: Array<{ id: string; conv_id: string; data: string; created_at: number }>): number;
}

// ── 导出文本渲染 ─────────────────────────────────────────────

/** lessons.md:按 scope_cwd 分区的人类可读视图;头部 meta 行承载机器可读字段 */
function renderLessonsMd(rows: import('../shared/types').MemoryRow[]): string {
  const lessons = rows.filter((r) => r.kind === 'lesson');
  const byScope = new Map<string, import('../shared/types').MemoryRow[]>();
  for (const l of lessons) {
    const k = l.scopeCwd ?? '(global)';
    if (!byScope.has(k)) byScope.set(k, []);
    byScope.get(k)!.push(l);
  }
  const out: string[] = ['# Lessons(项目教训,自动生成 — 勿手编此头部)', ''];
  for (const [scope, list] of [...byScope.entries()].sort()) {
    out.push(`## ${scope}`, '');
    for (const l of list.sort((a, b) => b.createdAt - a.createdAt)) {
      // meta 行:机器导入用(精确内容可能含换行,base64 防解析歧义)
      const b64 = Buffer.from(l.content, 'utf8').toString('base64');
      out.push(`- [lesson id=${l.id} imp=${l.importance} at=${Math.round(l.createdAt)}](${b64}) ${l.content.split('\n')[0]}`);
    }
    out.push('');
  }
  return out.join('\n') + '\n';
}

/** facts.ndjson:memories 全量(每行一个 JSON) */
function renderFactsNdjson(rows: MemoryRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function parseFactsNdjson(text: string): MemoryRow[] {
  const out: MemoryRow[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as MemoryRow;
      if (o && typeof o.id === 'string' && typeof o.content === 'string') out.push(o);
    } catch { /* 跳过坏行,不炸整库 */ }
  }
  return out;
}

// ── 主流程:同步 ─────────────────────────────────────────────

/** 延迟取 store(避免模块加载顺序问题:store 依赖 electron app ready) */
function storeApi(): MemoryStoreApi {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const s = require('./store') as typeof import('./store');
  return {
    exportMemories: () => s.exportMemoryRows(),
    importMemories: (rows) => s.importMemoryRows(rows),
    exportBlocks: () => s.exportMemoryBlocksData().map((b) => ({ label: b.label, value: b.value, updatedAt: b.updatedAt })),
    importBlock: (label, value, updatedAt) => {
      const cur = s.loadMemoryBlock(label);
      if (!cur) return false;
      if ((cur.updatedAt ?? 0) >= updatedAt) return false; // 本地不旧,不覆盖
      const r = s.updateMemoryBlock(label, value);
      return r.ok;
    },
    exportConversations: () => s.exportConversations(),
    importConversations: (rows) => s.importConversations(rows),
    exportTurns: () => s.exportTurns().map((t) => ({ id: t.id, conv_id: t.convId, data: t.data, created_at: t.ts })),
    importTurns: (rows) => s.importTurns(rows.map((t) => ({ id: t.id, convId: t.conv_id, data: t.data, ts: t.created_at }))),
  };
}

/** 供 IPC 调用:cfg + userData 根目录,自动补 store 实现 */
export async function memorySyncRun(cfg: MemorySyncSettings): Promise<MemorySyncResult> {
  const { app } = require('electron') as typeof import('electron');
  return memorySync(cfg, app.getPath('userData'), storeApi());
}

/** 连通性测试:只 clone/fetch,不写不推 */
export async function memorySyncTest(cfg: MemorySyncSettings): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    const { execFile: ef } = await import('node:child_process');
    const args = ['ls-remote', cfg.remote, cfg.branch || 'main'];
    return await new Promise((resolve) => {
      ef('git', args, { timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: String(stderr ?? err.message).slice(0, 300) });
        else resolve({ ok: true, detail: stdout.trim() ? '远端可达' : `远端可达,分支 ${cfg.branch || 'main'} 不存在(空仓库也可,首次同步会创建)` });
      });
    });
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

/**
 * 执行一次同步:导出 → clone/pull → 合并(远端行并回本地)→ commit → push。
 * 幂等性:memories 按 id 去重(importMemories 跳过已存在 id),重复同步无副作用。
 */
export async function memorySync(
  cfg: MemorySyncSettings,
  workDir: string, // userData 根(镜像仓库放 userData/memory-sync-<name>/)
  store: MemoryStoreApi,
): Promise<MemorySyncResult> {
  const result: MemorySyncResult = { ok: false, pushed: false, imported: 0, commits: 0, exported: 0, error: undefined, steps: [] };
  const log = (step: string, detail: string) => { result.steps.push({ step, detail, at: new Date().toISOString() }); };
  try {
    const baseDir = path.join(workDir, 'memory-sync');
    const dir = path.join(baseDir, repoDirName(cfg.remote));
    const branch = cfg.branch || 'main';

    // 1) 确保镜像仓库存在(clone 一次,后续复用)
    let hasRepo = false;
    try {
      const st = await fs.stat(path.join(dir, '.git'));
      hasRepo = st.isDirectory();
    } catch { hasRepo = false; }
    if (!hasRepo) {
      await fs.mkdir(baseDir, { recursive: true });
      log('clone', cfg.remote);
      const r = await git(baseDir, ['clone', '-b', branch, cfg.remote, path.basename(dir)], 120_000);
      if (!r.ok) {
        // 分支不存在(空仓库常见)→ 退化为普通 clone 再带 -b 创建
        const r2 = await git(baseDir, ['clone', cfg.remote, path.basename(dir)], 120_000);
        if (!r2.ok) throw new Error(`git clone 失败: ${r2.stderr.slice(0, 400)}`);
        await git(dir, ['checkout', '-b', branch]);
      }
    }

    // 2) pull 远端最新(push 前必拉,双端互推不炸)
    await git(dir, ['fetch', 'origin']);
    const st = await git(dir, ['rev-parse', '--verify', `origin/${branch}`]);
    if (st.ok) {
      await git(dir, ['reset', '--hard', `origin/${branch}`]); // 镜像无本地未推内容,硬复位安全
      // 3) 读远端文件,把远端条目并回本地 SQLite(远端→本地方向)
      try {
        const factsText = await fs.readFile(path.join(dir, 'facts.ndjson'), 'utf8');
        const remoteRows = parseFactsNdjson(factsText);
        result.imported = store.importMemories(remoteRows);
        if (result.imported > 0) log('import', `${result.imported} 条远端记忆并入本地`);
        // blocks:远端 updated_at 更新才覆盖(块级 LWW)
        try {
          const blocksText = await fs.readFile(path.join(dir, 'blocks.json'), 'utf8');
          const remoteBlocks = JSON.parse(blocksText) as Array<{ label: string; value: string; updatedAt: number }>;
          if (Array.isArray(remoteBlocks)) {
            let n = 0;
            for (const b of remoteBlocks) if (store.importBlock(b.label, b.value, b.updatedAt)) n++;
            if (n > 0) log('blocks', `${n} 个记忆块远端较新,已覆盖本地`);
          }
        } catch { /* 远端还没有 blocks.json,首推 */ }
        // lessons.md 里的 lesson 不单独导回 —— facts.ndjson 是全量真相,md 只是视图
        // 4b) 会话 + turns:跨设备接续对话(2026-10-24)。幂等:conv/turn 都按 id 跳过已存在。
        try {
          const convText = await fs.readFile(path.join(dir, 'conversations.ndjson'), 'utf8');
          const remoteConvs = convText.trim() ? convText.trim().split('\n')
            .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
            .filter((o): o is Record<string, unknown> => !!o) : [];
          const nc = store.importConversations(remoteConvs);
          if (nc > 0) log('convs', `${nc} 个远端会话并入本地`);
          const turnText = await fs.readFile(path.join(dir, 'turns.ndjson'), 'utf8');
          const remoteTurns = turnText.trim() ? turnText.trim().split('\n')
            .map((l) => { try { return JSON.parse(l) as { id: string; conv_id: string; data: string; created_at: number }; } catch { return null; } })
            .filter((o): o is { id: string; conv_id: string; data: string; created_at: number } => !!o) : [];
          const nt = store.importTurns(remoteTurns);
          if (nt > 0) log('turns', `${nt} 个远端轮次并入本地(FTS 已回填,可跨设备检索)`);
        } catch { /* 远端还没有 conversations.ndjson,首推 */ }
      } catch { /* 远端尚无 facts.ndjson,首推 */ }
    }

    // 4) 重新导出本地(含刚并入的远端内容 + 本地新增),写文件
    const rows = store.exportMemories();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'facts.ndjson'), renderFactsNdjson(rows), 'utf8');
    await fs.writeFile(path.join(dir, 'lessons.md'), renderLessonsMd(rows), 'utf8');
    await fs.writeFile(path.join(dir, 'blocks.json'),
      JSON.stringify(store.exportBlocks(), null, 2), 'utf8');
    // 会话 + turns 原文(ndjson;turns.data 是 saveTurn 的整 turn JSON,还原=直接 INSERT)
    const convs = store.exportConversations();
    const turns = store.exportTurns();
    await fs.writeFile(path.join(dir, 'conversations.ndjson'),
      convs.map((c) => JSON.stringify(c)).join('\n') + (convs.length ? '\n' : ''), 'utf8');
    await fs.writeFile(path.join(dir, 'turns.ndjson'),
      turns.map((t) => JSON.stringify(t)).join('\n') + (turns.length ? '\n' : ''), 'utf8');
    result.exported = rows.length + convs.length + turns.length;

    // 5) commit(有变更才提交)
    await git(dir, ['add', '-A']);
    const diff = await git(dir, ['status', '--porcelain']);
    if (diff.stdout.trim()) {
      const machine = require('node:os').hostname().replace(/[^a-zA-Z0-9.-]/g, '');
      const cr = await git(dir, ['commit', '-m', `memory-sync: ${new Date().toISOString()} @${machine} (${rows.length} memories)`]);
      if (cr.ok) { result.commits = 1; log('commit', 'done'); }
      else log('commit', `no-commit: ${cr.stderr.slice(0, 200)}`);
    } else {
      log('commit', 'no changes');
    }

    // 6) push(无 remote 或网络失败不阻塞整体 ok=false 只在硬错时)
    const hasRemote = (await git(dir, ['remote'])).stdout.trim().length > 0;
    if (hasRemote && result.commits > 0) {
      const pr = await git(dir, ['push', 'origin', `HEAD:${branch}`], 120_000);
      if (pr.ok) { result.pushed = true; log('push', 'ok'); }
      else {
        // 远端有新提交 → 下轮同步会 pull;此处如实报错给 UI
        throw new Error(`git push 失败(远端可能有新提交,稍后重试会自动合并): ${pr.stderr.slice(0, 300)}`);
      }
    }
    result.ok = true;
    return result;
  } catch (e) {
    result.error = (e as Error)?.message ?? String(e);
    return result;
  }
}

// ── 自动同步定时器(autoSyncMinutes>0 才启;失败静默,下轮再试)──
let autoTimer: ReturnType<typeof setInterval> | null = null;
let lastRunAt = 0;

/**
 * 挂自动同步 tick(每分钟查一次,到点执行)。main.ts 在 whenReady 后调一次;
 * settings 保存后调 restartMemorySyncAuto 应用新周期。
 */
export function startMemorySyncAuto(
  getCfg: () => MemorySyncSettings | undefined,
  workDir: string,
  store: MemoryStoreApi,
): void {
  if (autoTimer) return;
  autoTimer = setInterval(() => {
    const cfg = getCfg();
    if (!cfg?.remote || !cfg.autoSyncMinutes || cfg.autoSyncMinutes <= 0) return;
    if (Date.now() - lastRunAt < cfg.autoSyncMinutes * 60_000) return;
    lastRunAt = Date.now();
    void memorySync(cfg, workDir, store).catch(() => { /* 静默:失败下轮再试,不打断用户 */ });
  }, 60_000);
  // 挂上后立即重置节流点,避免启动即跑(留给用户手动首推)
  lastRunAt = Date.now();
}

/** settings 变更后重置节流(新周期立即生效;不需要重建 interval,tick 自查 cfg) */
export function restartMemorySyncAuto(): void {
  lastRunAt = Date.now();
}
