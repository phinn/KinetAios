// JobManager — 后台 Job 执行器(V3 deep 路径 Job 化,方案见 docs/V3-后台Job化技术方案.md)。
//
// 职责:job 生命周期(queued→running→done/failed/killed)、受限并发 worker 池、
// 独立 AbortController(与 conv signal 解耦)、checkpoint 持久化(M3)、
// cost 累计与事件转发。执行语义完全在 worker 闭包内(JobManager 不知道 DAG)。
//
// 并发模型:进程内串行队列 + maxConcurrent worker。better-sqlite3 是同步 API,
// 单写者无竞争;事件经 emitter 转发到 conv 事件流,顺序由单 worker 内 await 链保证。

import { randomUUID } from 'node:crypto';
import type { JobInfo, JobKind, JobStatus } from '../shared/types';
import * as store from './store';

export interface JobEmitter {
  /** job 状态/进度变化 → renderer 刷新(Job 列表 + 会话头指示条) */
  emitJob(info: JobInfo): void;
  /** job 产出的事件(status/todo/token/cost)桥接进会话事件流 */
  emitJobEvent(convId: string, turnId: string | null, jobId: string, ev: { type: string; [k: string]: unknown }): void;
}

// worker 闭包:JobManager 给它 signal/checkpointSink,它自己跑业务并返回结果。
// M3 前 checkpoint 不产生;M3 起 executeDAG 每节点迁移时回调 checkpointSink。
export type JobWorker<T = unknown> = (env: {
  signal: AbortSignal;
  checkpointSink: (snapshot: unknown) => void;
  onEvent: (ev: { type: string; [k: string]: unknown }) => void;
  initialCheckpoint: unknown;
}) => Promise<{ result: T; checkpoint?: unknown }>;

interface JobEntry {
  row: store.JobRow;
  worker?: JobWorker;
  ac?: AbortController;
  costUSD: number;
}

const MAX_CONCURRENT_JOBS = 2;
// payload 上限:超过说明 history 快照异常膨胀,拒收比落一个 25MB 行更安全。
const MAX_PAYLOAD_CHARS = 5 * 1024 * 1024;

export class JobManager {
  private jobs = new Map<string, JobEntry>();
  private queue: string[] = [];
  private running = 0;

  constructor(private emit: JobEmitter) {}

  /** 启动 hydrate:崩溃遗留的 running/queued 标 failed(M3 后改 paused 可恢复)。 */
  hydrate(): void {
    // M3: 有 checkpoint 的 v3-deep job → paused(可从断点恢复);其余遗留 → failed。
    // 无 checkpoint 列的行视为无断点。注意必须在 failOrphanJobs 之前抢救,否则全被标 failed。
    for (const row of store.listJobRows(undefined, ['running', 'queued'])) {
      if (row.kind === 'v3-deep' && row.checkpoint) {
        store.updateJobFields(row.id, { status: 'paused', error: 'app 重启,可从断点继续' });
      } else {
        store.updateJobFields(row.id, { status: 'failed', error: 'app 重启,后台任务中断(无断点)' });
      }
    }
    for (const row of store.listJobRows()) {
      if (row.status === 'done' || row.status === 'failed' || row.status === 'killed') {
        this.jobs.set(row.id, { row, costUSD: row.costUSD });
      }
    }
  }

  /** 提交后台 job。onSubmit 成功返回 job id;worker 进入队列等空闲 worker。 */
  submit(opts: {
    convId: string;
    turnId: string | null;
    kind: JobKind;
    title: string;
    payload: unknown;
    worker: JobWorker;
    initialCheckpoint?: unknown;
  }): { ok: true; id: string } | { ok: false; error: string } {
    const payloadStr = JSON.stringify(opts.payload ?? {});
    if (payloadStr.length > MAX_PAYLOAD_CHARS) {
      return { ok: false, error: `job payload 过大(${Math.round(payloadStr.length / 1024 / 1024)}MB > 5MB 上限),请压缩上下文后重试` };
    }
    const now = Date.now();
    const row: store.JobRow = {
      id: randomUUID(),
      convId: opts.convId,
      turnId: opts.turnId,
      kind: opts.kind,
      status: 'queued',
      title: opts.title.slice(0, 60),
      payload: payloadStr,
      checkpoint: opts.initialCheckpoint !== undefined ? JSON.stringify(opts.initialCheckpoint) : null,
      result: null,
      error: null,
      costUSD: 0,
      createdAt: now,
      updatedAt: now,
    };
    store.insertJob(row);
    const entry: JobEntry = { row, worker: opts.worker, costUSD: 0 };
    this.jobs.set(row.id, entry);
    this.queue.push(row.id);
    this.emitJobInfo(row);
    this.pump();
    return { ok: true, id: row.id };
  }

  /** 取消/停止:queued 直接出队标 killed;running abort(执行体在检查点自行收尾)。 */
  kill(id: string, reason?: string): void {
    const entry = this.jobs.get(id);
    if (!entry) return;
    if (entry.row.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
      entry.row.status = 'killed';
      entry.row.error = reason ?? '用户取消';
      store.updateJobFields(id, { status: 'killed', error: entry.row.error });
      this.emitJobInfo(entry.row);
    } else if (entry.row.status === 'running') {
      entry.ac?.abort();
    }
  }

  list(convId?: string): JobInfo[] {
    // 内存为准(热状态),DB 兜底不在此处(hydrate 时已载入终态 job)
    return [...this.jobs.values()]
      .filter((e) => !convId || e.row.convId === convId)
      .sort((a, b) => b.row.createdAt - a.row.createdAt)
      .map((e) => this.toInfo(e));
  }

  get(id: string): JobInfo | undefined {
    const e = this.jobs.get(id);
    return e ? this.toInfo(e) : undefined;
  }

  /** M3: 断点续跑 —— killed/failed 且有 checkpoint 的 job 重新入队,executeDAG 跳过已完成节点。 */
  resume(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry?.worker) return false;
    if (!['killed', 'failed', 'paused'].includes(entry.row.status)) return false;
    if (!entry.row.checkpoint) return false;
    entry.row.status = 'queued';
    entry.row.error = null;
    store.updateJobFields(id, { status: 'queued', error: null });
    this.queue.push(id);
    this.emitJobInfo(entry.row);
    this.pump();
    return true;
  }

  // ── M4b: dispatch fan-out —— 长时 CLI 子任务作为后台 job 运行 ──
  // 与同步 dispatch_agent(5 分钟 timeout / 10MB buffer,agent loop 内联等结果)互补:
  // 适合"编译/全量测试/批量迁移"这类分钟级以上的任务,提交即返回,结果落 jobs.result。
  async submitDispatch(opts: {
    convId: string;
    engine: 'claudeCode' | 'codex';
    prompt: string;
    cwd: string;
    timeoutMs?: number;   // 缺省 30 分钟(同步路径是 5 分钟硬顶)
  }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const { runCliOneShot } = await import('./engines');
    const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
    const submit = this.submit({
      convId: opts.convId,
      turnId: null,
      kind: 'dispatch',
      title: `[${opts.engine}] ${opts.prompt.slice(0, 40)}`,
      payload: { engine: opts.engine, prompt: opts.prompt.slice(0, 2000), cwd: opts.cwd },
      worker: async (env) => {
        // runCliOneShot 自带 5 分钟 timeout —— 长任务绕开它:直接后台 job 内不受该限制,
        // 这里用 job signal + 外层软超时兜底。为复用 CLI 解析,超时取 min(timeoutMs, ...) 由 signal 控制。
        const text = await runCliOneShot(opts.engine, opts.prompt, opts.cwd, env.signal, { timeoutMs });
        return { result: { text } };
      },
    });
    return submit;
  }

  /** 会话删除时级联清理:kill 未完成 job + 删行。 */
  purgeConv(convId: string): void {
    for (const e of this.jobs.values()) {
      if (e.row.convId === convId && (e.row.status === 'queued' || e.row.status === 'running')) {
        this.kill(e.row.id, '会话已删除');
      }
    }
    store.deleteJobsByConv(convId);
  }

  // ── 内部 ──

  private pump(): void {
    while (this.running < MAX_CONCURRENT_JOBS && this.queue.length) {
      const id = this.queue.shift()!;
      const entry = this.jobs.get(id);
      if (!entry || !entry.worker) continue;
      this.start(entry);
    }
  }

  private start(entry: JobEntry): void {
    const row = entry.row;
    const ac = new AbortController();
    entry.ac = ac;
    entry.row.status = 'running';
    store.updateJobFields(row.id, { status: 'running' });
    this.emitJobInfo(entry.row);
    this.running++;

    const checkpointSink = (snapshot: unknown): void => {
      try {
        const cp = JSON.stringify(snapshot);
        entry.row.checkpoint = cp; // 内存行同步:resume 校验读的是内存行
        store.updateJobFields(row.id, { checkpoint: cp });
      } catch { /* checkpoint 写失败不炸执行 */ }
    };
    let initialCheckpoint: unknown;
    try {
      initialCheckpoint = row.checkpoint ? JSON.parse(row.checkpoint) : undefined;
    } catch { initialCheckpoint = undefined; }

    const onEvent = (ev: { type: string; [k: string]: unknown }): void => {
      // cost 事件累计(job 面板实时显示烧钱)
      if (ev.type === 'cost' && typeof ev.usd === 'number') {
        entry.costUSD += ev.usd as number;
        store.updateJobFields(row.id, { costUSD: entry.costUSD });
      }
      this.emit.emitJobEvent(row.convId, row.turnId, row.id, ev);
    };

    entry.worker!({ signal: ac.signal, checkpointSink, onEvent, initialCheckpoint })
      .then(({ result }) => {
        if (ac.signal.aborted) {
          // worker 内部吞了 abort 正常返回 → 仍按 killed 记(kill 语义优先)
          entry.row.status = 'killed';
          entry.row.error = entry.row.error ?? '用户取消';
          store.updateJobFields(row.id, { status: 'killed', error: entry.row.error });
        } else {
          entry.row.status = 'done';
          entry.row.result = JSON.stringify(result ?? null);
          store.updateJobFields(row.id, { status: 'done', result: entry.row.result, costUSD: entry.costUSD });
        }
      })
      .catch((e: unknown) => {
        const msg = (e as Error)?.message ?? String(e);
        // abort 引发的异常(AbortError)是 kill 的正常路径,不算 failed
        if (ac.signal.aborted) {
          entry.row.status = 'killed';
          entry.row.error = reasonOrDefault(entry, '用户取消');
          store.updateJobFields(row.id, { status: 'killed', error: entry.row.error });
        } else {
          entry.row.status = 'failed';
          entry.row.error = msg.slice(0, 2000);
          store.updateJobFields(row.id, { status: 'failed', error: entry.row.error, costUSD: entry.costUSD });
        }
      })
      .finally(() => {
        this.running--;
        this.emitJobInfo(entry.row);
        this.pump();
      });
  }

  private emitJobInfo(row: store.JobRow): void {
    const e = this.jobs.get(row.id);
    this.emit.emitJob(e ? this.toInfo(e) : this.toInfo({ row, costUSD: row.costUSD }));
  }

  private toInfo(e: JobEntry): JobInfo {
    return {
      id: e.row.id,
      convId: e.row.convId,
      turnId: e.row.turnId,
      kind: e.row.kind as JobKind,
      status: e.row.status as JobStatus,
      title: e.row.title,
      error: e.row.error,
      costUSD: e.costUSD,
      createdAt: e.row.createdAt,
      updatedAt: e.row.updatedAt,
    };
  }
}

function reasonOrDefault(entry: JobEntry, fallback: string): string {
  return entry.row.error ?? fallback;
}

// ── 进程级单例访问(main.ts 初始化后各处 import 使用)──
let instance: JobManager | null = null;
export function initJobManager(emit: JobEmitter): JobManager {
  instance = new JobManager(emit);
  instance.hydrate();
  return instance;
}
export function jobManager(): JobManager {
  if (!instance) throw new Error('JobManager 未初始化(main.ts initJobManager)');
  return instance;
}
