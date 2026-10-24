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
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
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

// ── ndjson 流式读写(2026-10-24):库 GB 级,整文件进内存/整串拼接都会撞 V8 字符串上限 ──

/** 逐行读 ndjson(按需创建 readstream;文件不存在时不产生任何行) */
async function* ndjsonLines(file: string): AsyncGenerator<string> {
  let stream: import('node:fs').ReadStream | null = null;
  try {
    stream = createReadStream(file, { encoding: 'utf8' });
    const rl = (require('node:readline') as typeof import('node:readline')).createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) yield line;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
  } finally {
    stream?.destroy();
  }
}

/** 逐行写 ndjson:write(line) 由调用方回调,内部攒 8MB 批量刷盘,单行不落大字符串 */
async function writeNdjson(file: string, produce: (write: (line: string) => void) => void): Promise<void> {
  const out = createWriteStream(file, { encoding: 'utf8' });
  let buf = '';
  const write = (line: string): void => {
    buf += line + '\n';
    if (buf.length >= 8 * 1024 * 1024) { out.write(buf); buf = ''; }
  };
  produce(write);
  if (buf) out.write(buf);
  await new Promise<void>((resolve, reject) => { out.end(() => resolve()); out.on('error', reject); });
}

// turns 专用:分片 + gzip。教训(2026-10-24):7023 turns 全量单文件 881MB,
// gitee pre-receive 单文件 100MB 配额直接拒收整个 push("exceeds quota 100MB")。
// 按累计字节切片(行序稳定 → 旧片内容不变 → git blob 复用,只有尾片有新存储),
// 每片 gzip(turn JSON 压缩率 ~31%,远端仓库长期体积同比例省)。
const TURN_SHARD_BYTES = 64 * 1024 * 1024; // 预留余量:gitee 硬上限 100MB

const shardName = (base: string, n: number): string => `${base}-${String(n).padStart(4, '0')}.ndjson.gz`;

/** 列出 dir 下某 base 的全部分片文件名(字典序 = 分片序),含旧版裸 ndjson 单文件 */
async function listShards(dir: string, base: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names
    .filter((f) => f === `${base}.ndjson` || (f.startsWith(`${base}-`) && (f.endsWith('.ndjson.gz') || f.endsWith('.ndjson'))))
    .sort();
}

/** 分片 + gzip 逐行写:先清旧版全部文件(单文件/旧分片),再按 64MB 累计切片,返回片数 */
async function writeNdjsonSharded(dir: string, base: string,
                                  produce: (write: (line: string) => void) => void): Promise<number> {
  for (const f of await listShards(dir, base)) await fs.rm(path.join(dir, f), { force: true });
  const createGzip = (require('node:zlib') as typeof import('node:zlib')).createGzip;
  let n = 0;
  const outs: Array<import('node:fs').WriteStream> = []; // 全部片要等 finish 才算落盘(git add 前)
  let failErr: Error | null = null;
  const openShard = (): { gz: import('node:zlib').Gzip } => {
    const out = createWriteStream(path.join(dir, shardName(base, n + 1)));
    const gz = createGzip();
    gz.pipe(out); // 数据流:gzip 变换流(源) → 文件(汇);方向反了会 no-op/崩
    gz.on('error', (e) => { failErr = failErr ?? e; });
    out.on('error', (e) => { failErr = failErr ?? e; });
    outs.push(out);
    return { gz };
  };
  let { gz } = openShard();
  let used = 0;
  let buf = '';
  const write = (line: string): void => {
    const len = Buffer.byteLength(line) + 1;
    // 满片换新(空片时即便单行超限也直接写,单行本身不会到 64MB 量级)
    if (used > 0 && used + len > TURN_SHARD_BYTES) {
      if (buf) { gz.write(buf); buf = ''; }
      gz.end();
      n++;
      ({ gz } = openShard());
      used = 0;
    }
    buf += line + '\n';
    used += len;
    if (buf.length >= 8 * 1024 * 1024) { gz.write(buf); buf = ''; }
  };
  produce(write);
  if (buf) gz.write(buf);
  gz.end();
  await new Promise<void>((resolve) => {
    let done = 0;
    for (const o of outs) {
      o.on('finish', () => { if (++done === outs.length) resolve(); });
    }
  });
  if (failErr) throw failErr;
  return n + 1;
}

/** 逐行读全部分片(自动解压;按文件名序拼回完整行序) */
async function* ndjsonShardedLines(dir: string, base: string): AsyncGenerator<string> {
  const createGunzip = (require('node:zlib') as typeof import('node:zlib')).createGunzip;
  for (const f of await listShards(dir, base)) {
    const isGz = f.endsWith('.gz');
    const input = createReadStream(path.join(dir, f));
    const stream = isGz ? input.pipe(createGunzip()) : input;
    const rl = (require('node:readline') as typeof import('node:readline')).createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) yield line;
    }
  }
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
  /** 全量会话行,惰性流式(generator;库 GB 级禁止一次性数组化,V8 字符串上限会炸) */
  exportConversations(): Generator<Record<string, unknown>>;
  /** 导入单条远端会话行,返回是否新建(已存在跳过,本地为准) */
  importConversationRow(row: Record<string, unknown>): boolean;
  /** 全量 turn 行,惰性流式(conv_id + data 整 turn JSON) */
  exportTurns(): Generator<{ id: string; conv_id: string; data: string; created_at: number }>;
  /** 导入单行远端 turn(ndjson 一行)+ 回填 FTS,返回是否新建 */
  importTurnsLine(line: string): boolean;
  /** turns 总行数(导出进度分母) */
  countTurns(): number;
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
    exportConversations: () => s.exportConversationsIter(),
    importConversationRow: (row) => s.importConversationRow(row),
    exportTurns: () => (function* () {
      for (const t of s.exportTurns()) yield { id: t.id, conv_id: t.conv_id, data: t.data, created_at: t.created_at };
    })(),
    importTurnsLine: (line) => s.importTurnsLine(line),
    countTurns: () => s.countTurns(),
  };
}

/** 供 IPC 调用:cfg + userData 根目录,自动补 store 实现 */
export async function memorySyncRun(
  cfg: MemorySyncSettings,
  onProgress?: (phase: string, p?: number) => void,
): Promise<MemorySyncResult> {
  const { app } = require('electron') as typeof import('electron');
  const s = require('./store') as typeof import('./store');
  return memorySync(cfg, app.getPath('userData'), storeApi(), {
    onProgress,
    turnsTotal: s.countTurns(),
  });
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
 * opts.onProgress:阶段进度(phase + 0~1),UI 状态栏实时显示;opts.turnsTotal 支撑 turns 导出百分比。
 */
export async function memorySync(
  cfg: MemorySyncSettings,
  workDir: string, // userData 根(镜像仓库放 userData/memory-sync-<name>/)
  store: MemoryStoreApi,
  opts?: { onProgress?: (phase: string, p?: number) => void; turnsTotal?: number },
): Promise<MemorySyncResult> {
  const result: MemorySyncResult = { ok: false, pushed: false, imported: 0, commits: 0, exported: 0, error: undefined, steps: [] };
  const log = (step: string, detail: string) => { result.steps.push({ step, detail, at: new Date().toISOString() }); };
  const prog = opts?.onProgress ?? (() => {});
  try {
    const baseDir = path.join(workDir, 'memory-sync');
    const dir = path.join(baseDir, repoDirName(cfg.remote));
    const branch = cfg.branch || 'main';

    // 1) 确保镜像仓库存在(clone 一次,后续复用)
    prog('clone');
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
    prog('pull');
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
        // 4b) 会话 + turns:跨设备接续对话(2026-10-24)。流式逐行导入(库 GB 级,禁止整文件进内存)。
        // 幂等:conv/turn 都按 id 跳过已存在。
        try {
          prog('import-convs');
          let nc = 0;
          for await (const line of ndjsonLines(path.join(dir, 'conversations.ndjson'))) {
            try { if (store.importConversationRow(JSON.parse(line) as Record<string, unknown>)) nc++; } catch { /* 脏行跳过 */ }
          }
          if (nc > 0) log('convs', `${nc} 个远端会话并入本地`);
          prog('import-turns', 0);
          let nt = 0;
          for await (const line of ndjsonShardedLines(dir, 'turns')) {
            if (store.importTurnsLine(line)) { nt++; if (nt % 500 === 0) prog('import-turns', nt / Math.max(1, opts?.turnsTotal ?? nt)); }
          }
          prog('import-turns', 1);
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
    // 会话 + turns 原文。conversations 单文件 ndjson 流式逐行写;
    // turns 分片+gzip(单文件 881MB 超 gitee 100MB 配额,push 被远端拒收的根因)。
    // join()/writeFile 整串在 GB 级库上撞 V8 字符串上限,必须流式。
    prog('export-convs');
    const convPath = path.join(dir, 'conversations.ndjson');
    let convCount = 0;
    await writeNdjson(convPath, (write) => {
      for (const c of store.exportConversations()) { write(JSON.stringify(c)); convCount++; }
    });
    prog('export-turns', 0);
    const turnsTotal = opts?.turnsTotal ?? 0;
    let turnCount = 0;
    await writeNdjsonSharded(dir, 'turns', (write) => {
      for (const t of store.exportTurns()) {
        write(JSON.stringify(t)); turnCount++;
        if (turnsTotal > 0 && turnCount % 500 === 0) prog('export-turns', turnCount / turnsTotal);
      }
    });
    prog('export-turns', 1);
    result.exported = rows.length + convCount + turnCount;

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
      prog('push');
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
