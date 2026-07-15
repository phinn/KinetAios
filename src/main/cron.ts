// 最小 cron:5 字段(min hour dom mon dow),支持 * / N / */N / a,b / a-b。
// ponytail ceiling:不处理 L、W、#、年、秒。够日常定时任务用,要高级换 node-cron。
// 调度器:setInterval 每分钟 tick 一次,扫所有任务,匹配的派发。
import { app } from 'electron';

export interface CronTask {
  id: string;
  cron: string;          // 5 字段
  prompt: string;        // 任务描述
  cwd?: string;          // 工作目录(可选)
  enabled: boolean;
  lastRun?: number;      // ms timestamp
  createdAt: number;
}

type Field = (n: number, date: Date) => boolean;

// 解析单字段(* / 数字 / a-b / a,b / */N)
function parseField(spec: string, min: number, max: number): Field {
  if (spec === '*') return () => true;
  // */N
  let m = /^\/(\d+)$/.exec(spec);
  if (m) {
    const step = parseInt(m[1], 10);
    return (n) => (n - min) % step === 0;
  }
  // 列表 / 范围组合:1,3,5-10,15
  const set = new Set<number>();
  for (const part of spec.split(',')) {
    const stepMatch = /^(\d+)-(\d+)\/(\d+)$/.exec(part);
    const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
    if (stepMatch) {
      const a = parseInt(stepMatch[1], 10);
      const b = parseInt(stepMatch[2], 10);
      const step = parseInt(stepMatch[3], 10);
      for (let i = a; i <= b; i += step) set.add(i);
    } else if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      for (let i = a; i <= b; i++) set.add(i);
    } else {
      const n = parseInt(part, 10);
      if (!Number.isNaN(n)) set.add(n);
    }
  }
  return (n) => set.has(n);
}

// dow:JS getDay() 0=Sunday。cron 也用 0=Sunday,直接对齐。
export function parseCron(expr: string): { ok: true; match: (d: Date) => boolean } | { ok: false; error: string } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { ok: false, error: 'cron 必须 5 个字段:分 时 日 月 周' };
  const [minF, hourF, domF, monF, dowF] = parts;
  try {
    const fMin = parseField(minF, 0, 59);
    const fHour = parseField(hourF, 0, 23);
    const fDom = parseField(domF, 1, 31);
    const fMon = parseField(monF, 1, 12);
    const fDow = parseField(dowF, 0, 6);
    return {
      ok: true,
      match: (d: Date) => fMin(d.getMinutes(), d) && fHour(d.getHours(), d) && fDom(d.getDate(), d) && fMon(d.getMonth() + 1, d) && fDow(d.getDay(), d),
    };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

let timer: NodeJS.Timeout | null = null;
let tasks: CronTask[] = [];
let dispatcher: ((task: CronTask) => void) | null = null;

// 给 cron 表的 store 注入持久化钩子,避免循环依赖。TaskManager 启动后 setDispatcher。
export function setDispatcher(fn: (task: CronTask) => void): void {
  dispatcher = fn;
}

export function setCronTasks(list: CronTask[]): void {
  tasks = list;
}

export function getCronTasks(): CronTask[] {
  return tasks;
}

export function startCronScheduler(): void {
  if (timer) return;
  // 每分钟 tick,对齐到下一分钟边界附近(setInterval drift 不影响,匹配的是绝对时间)。
  timer = setInterval(() => tick(new Date()), 60_000);
  // 启动立刻 tick 一次,补上 app 关闭期间错过的时间(只跑最近 1 分钟内的)。
  tick(new Date());
}

function tick(now: Date): void {
  if (!dispatcher) return;
  for (const t of tasks) {
    if (!t.enabled) continue;
    const parsed = parseCron(t.cron);
    if (!parsed.ok) continue;
    // 同一分钟内只触发一次:lastRun 不在同一分钟才允许。
    if (t.lastRun && sameMinute(t.lastRun, now.getTime())) continue;
    if (parsed.match(now)) {
      t.lastRun = now.getTime();
      try {
        dispatcher(t);
      } catch (e) {
        console.warn('cron dispatch failed', e);
      }
    }
  }
}

function sameMinute(aMs: number, bMs: number): boolean {
  return Math.floor(aMs / 60_000) === Math.floor(bMs / 60_000);
}

export function stopCronScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// 提供给 store/UI:验证 cron 字符串
export function validateCron(expr: string): { ok: boolean; error?: string } {
  return parseCron(expr);
}

// 进程退出兜底:不必显式 stop,Electron 退出会清。
// 留个 noop 让 TS 不嫌 unused。
export const _cronMeta = { startedAt: () => app.getPath('userData') };
