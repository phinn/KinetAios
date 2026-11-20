// 条件等待引擎(2026-11-19):替代裸 sleep 的轮询原语。
// 背景(真实数据):近30天 shell 里「命令就是 sleep N」的调用 2287 次、合计 40.1 小时;
// 含 sleep 的脚本 6747 次、67.2 小时 —— 一个月 720 小时里有 107 小时在盲等。
// 更糟的是 sleep 175 这类会直接撞上 120s 工具超时(近30天 680 次超时),白等一场还失败。
//
// 设计原则:
//   ① 只做"探测",不做"动作" —— 探测不改世界,所以可以高频轮询、可以并行;
//   ② 命中即返回并带回证据(匹配到的日志行/端口握手/文件大小),模型不用再补一次 tail/ps;
//   ③ 超时也要带回"最后看到了什么" —— 让模型能判断是该延长、该换思路,还是本来就失败了;
//   ④ 全程异步 sleep,不阻塞事件循环(主进程要处理 IPC/UI)。
// / Condition-based waiting: probe-only (hence safe to poll fast and run in parallel), returns
// the evidence on hit, the last observation on timeout, and never blocks the event loop.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';

export type WaitKind =
  | 'port_open'
  | 'log_match'
  | 'file_exists'
  | 'file_absent'
  | 'file_stable'
  | 'process_exit'
  | 'command_ok';

/** 全部合法条件类型(单一来源:工具 schema 的 enum、参数校验、报错文案都取这一份)。 */
export const WAIT_KINDS: WaitKind[] = [
  'port_open',
  'log_match',
  'file_exists',
  'file_absent',
  'file_stable',
  'process_exit',
  'command_ok',
];

/** 从参数反推条件类型 —— 用来兜住"模型忘了写 until"。
 *
 *  实测两次失败都是 `{"pattern":"…","target":"…/test.log","timeout_s":300}`,没有 until。
 *  可意图其实毫无歧义:pattern 只有 log_match 用,target 是文件路径 —— 报错纯属自伤,
 *  而模型拿到的只是"参数不对",于是重填一次,又一轮往返。
 *
 *  只做能唯一确定的推断,不猜:
 *    · 给了 pattern            → log_match(pattern 是它的专属参数)
 *    · target 是 host:port/端口 → port_open
 *  其余(file_exists vs file_absent、process_exit 的进程名)确实二义,保持报错。 */
export function inferWaitKind(args: Record<string, unknown>): WaitKind | '' {
  const raw = String(args.until ?? '').trim();
  if (WAIT_KINDS.includes(raw as WaitKind)) return raw as WaitKind;
  if (args.pattern) return 'log_match';
  const t = String(args.target ?? '').trim();
  if (/^(?:[\w.-]+:)?\d{2,5}$/.test(t)) return 'port_open';
  return '';
}

export interface WaitSpec {
  kind: WaitKind;
  target: string;
  pattern?: string;
  timeoutMs: number;
  pollMs: number;
  /** command_ok 的执行器(由调用方注入:那里有确认/策略/沙箱闸) */
  runCommand?: (cmd: string) => Promise<{ ok: boolean; out: string }>;
  signal?: AbortSignal;
}

export interface WaitResult {
  ok: boolean;
  /** 条件已达成 / 超时 / 被中止 */
  reason: 'hit' | 'timeout' | 'aborted' | 'bad_spec';
  waitedMs: number;
  polls: number;
  /** 命中证据(日志行、端口、进程状态…),超时时是最后一次观察 */
  detail: string;
  /** 超时时的补充上下文(如日志尾部),命中时为空 */
  context?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function parsePort(target: string): { host: string; port: number } | null {
  const t = target.trim().replace(/^https?:\/\//, '');
  const m = /^([^:\s]+):(\d+)$/.exec(t) ?? /^(\d+)$/.exec(t);
  if (!m) return null;
  const port = Number(m[2] ?? m[1]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: m[2] ? m[1] : '127.0.0.1', port };
}

/** TCP 握手探测:能连上即"端口就绪"(比 grep 进程名可靠 —— 进程在跑但没监听等于没就绪)。 */
function probePort(host: string, port: number, timeoutMs = 1000): Promise<{ hit: boolean; detail: string }> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (hit: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ hit, detail });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true, `${host}:${port} 已可连接`));
    sock.once('timeout', () => done(false, `${host}:${port} 连接超时(端口未监听或防火墙丢弃)`));
    sock.once('error', (e: NodeJS.ErrnoException) => {
      done(false, `${host}:${port} ${e.code === 'ECONNREFUSED' ? '连接被拒绝(端口未监听)' : (e.message ?? String(e))}`);
    });
    sock.connect(port, host);
  });
}

/** 读文件尾部(只读尾部,避免把几百 MB 日志整个读进内存)。 */
function readTail(p: string, maxBytes = 200_000): string {
  let fd: number | undefined;
  try {
    const st = fs.statSync(p);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    if (len <= 0) return '';
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.slice(-n).join('\n');
}

async function probeProcessGone(name: string): Promise<{ hit: boolean; detail: string }> {
  const isWin = process.platform === 'win32';
  const [cmd, args] = isWin
    ? (['tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH']] as const)
    : (['pgrep', ['-fl', name]] as const);
  return new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: 5000 }, (err, stdout) => {
      const out = String(stdout ?? '').trim();
      const running = isWin ? !/no tasks|没有运行/i.test(out) && out.length > 0 : !err && out.length > 0;
      if (running) return resolve({ hit: false, detail: `${name} 仍在运行:${tailLines(out, 3)}` });
      return resolve({ hit: true, detail: `${name} 已退出` });
    });
  });
}

/** 单次探测。返回 hit=条件是否已满足,detail=本次观察结果。 */
export async function probeOnce(spec: WaitSpec): Promise<{ hit: boolean; detail: string }> {
  switch (spec.kind) {
    case 'port_open': {
      const p = parsePort(spec.target);
      if (!p) return { hit: false, detail: `端口格式无法解析:「${spec.target}」(要 host:port 或 port)` };
      return probePort(p.host, p.port);
    }
    case 'log_match': {
      const text = readTail(spec.target);
      if (!text) {
        return {
          hit: false,
          detail: fs.existsSync(spec.target) ? `日志暂无内容:${spec.target}` : `日志文件还不存在:${spec.target}`,
        };
      }
      let re: RegExp;
      try {
        re = new RegExp(spec.pattern ?? '.', 'i');
      } catch (e) {
        return { hit: false, detail: `正则无效:${(e as Error).message}` };
      }
      const hits = text.split('\n').filter((l) => re.test(l));
      return hits.length
        ? { hit: true, detail: `命中 ${hits.length} 行(尾部)::\n${hits.slice(-20).join('\n')}` }
        : { hit: false, detail: `日志里还没有匹配 /${spec.pattern}/ 的行(当前尾部 ${tailLines(text, 3).length} 字符)` };
    }
    case 'file_exists': {
      try {
        const st = fs.statSync(spec.target);
        return { hit: true, detail: `${spec.target} 已存在(${st.isDirectory() ? '目录' : `${st.size} 字节`})` };
      } catch {
        return { hit: false, detail: `${spec.target} 还不存在` };
      }
    }
    case 'file_absent': {
      try {
        fs.statSync(spec.target);
        return { hit: false, detail: `${spec.target} 仍然存在` };
      } catch {
        return { hit: true, detail: `${spec.target} 已不存在` };
      }
    }
    case 'file_stable': {
      // 大小与 mtime 连续两次不变且至少 1 秒没动 → 视为写完(下载/导出落盘的通用判据)
      try {
        const a = fs.statSync(spec.target);
        return { hit: false, detail: `__stable_probe__${a.size}:${a.mtimeMs}` };
      } catch {
        return { hit: false, detail: `${spec.target} 还不存在` };
      }
    }
    case 'process_exit':
      return probeProcessGone(spec.target);
    case 'command_ok': {
      if (!spec.runCommand) return { hit: false, detail: 'command_ok 未注入执行器' };
      const r = await spec.runCommand(spec.target);
      return { hit: r.ok, detail: r.ok ? `命令退出码 0:${spec.target}` : `命令仍失败:\n${tailLines(r.out, 8)}` };
    }
    default:
      return { hit: false, detail: `未知条件类型:${String(spec.kind)}` };
  }
}

/**
 * 轮询直到条件满足 / 超时 / 被中止。
 * file_stable 需要跨轮比较,单独处理(其余条件都是无状态探测)。
 */
export async function waitFor(spec: WaitSpec): Promise<WaitResult> {
  const start = Date.now();
  let polls = 0;
  let last = '';
  let prevSig = '';
  const kindOk = WAIT_KINDS.includes(spec.kind);
  if (!kindOk || !spec.target) {
    return {
      ok: false, reason: 'bad_spec', waitedMs: 0, polls: 0,
      detail: `条件参数不完整(until=${spec.kind || '空'}, target=${spec.target || '空'})`
        + `\n可用 until:${WAIT_KINDS.join(' / ')}`
        + `\n→ 其实可以省略 until:给了 pattern 就是 log_match,target 是 host:port 就是 port_open。`,
    };
  }
  while (Date.now() - start < spec.timeoutMs) {
    if (spec.signal?.aborted) {
      return { ok: false, reason: 'aborted', waitedMs: Date.now() - start, polls, detail: last || '已被用户中止' };
    }
    const r = await probeOnce(spec);
    polls++;
    if (spec.kind === 'file_stable') {
      const sig = r.detail.startsWith('__stable_probe__') ? r.detail.slice('__stable_probe__'.length) : '';
      if (sig && sig === prevSig) {
        return { ok: true, reason: 'hit', waitedMs: Date.now() - start, polls, detail: `${spec.target} 已停止变化(大小/时间戳连续 ${(spec.pollMs * 2 / 1000).toFixed(1)}s 未变)` };
      }
      prevSig = sig;
      last = sig ? `${spec.target} 仍在写入(当前 ${sig.split(':')[0]} 字节)` : r.detail;
    } else if (r.hit) {
      return { ok: true, reason: 'hit', waitedMs: Date.now() - start, polls, detail: r.detail };
    } else {
      last = r.detail;
    }
    const remain = spec.timeoutMs - (Date.now() - start);
    if (remain <= 0) break;
    await sleep(Math.min(spec.pollMs, remain));
  }
  // 超时:把"最后看到了什么"带回去 —— 只看"超时"两个字,模型只能重试;看到日志尾部才能改判断。
  const ctx = spec.kind === 'log_match' ? tailLines(readTail(spec.target), 12) : '';
  return {
    ok: false,
    reason: 'timeout',
    waitedMs: Date.now() - start,
    polls,
    detail: last || '条件始终未满足(无观察结果)',
    context: ctx || undefined,
  };
}

/** 把等待结果渲染成给模型看的文本(含下一步建议)。 */
export function formatWaitResult(spec: WaitSpec, r: WaitResult): string {
  const head = `${spec.kind}(${spec.target}${spec.pattern ? `, /${spec.pattern}/` : ''})`;
  if (r.ok) {
    return `✅ 条件达成:${head}\n等待 ${(r.waitedMs / 1000).toFixed(1)}s(轮询 ${r.polls} 次)\n${r.detail}`;
  }
  if (r.reason === 'aborted') {
    return `⏹ 已中止等待:${head}(等了 ${(r.waitedMs / 1000).toFixed(1)}s)\n${r.detail}`;
  }
  if (r.reason === 'bad_spec') {
    return `❌ wait_for 参数不对:${r.detail}\n可用 until:port_open / log_match / file_exists / file_absent / file_stable / process_exit / command_ok`;
  }
  return (
    `⏳ 等待超时:${head}(等了 ${(r.waitedMs / 1000).toFixed(1)}s,轮询 ${r.polls} 次)\n` +
    `最后观察:${r.detail}\n` +
    (r.context ? `日志尾部:\n${r.context}\n` : '') +
    `下一步(别再原样重试):\n` +
    `1) 目标进程可能压根没启动 → 先用 shell 确认(ps/lsof/日志首行),再决定是否重启;\n` +
    `2) 只是还需要更久 → 调大 timeout_s(上限 900)重试一次;\n` +
    `3) 条件写错了 → 换判据(例如端口通但服务未就绪时,改 log_match 盯 ready 关键字)。`
  );
}
