/**
 * trace — 模型调用的录制与离线重放(turn 级"金标轨迹")。
 *
 * 目的:引擎 / prompt / 工具描述一改,想验证编排有没有退化,现在只能花钱重跑真实任务。
 * 这里把每次模型请求(消息 + 工具定义)与响应落盘,之后用 KINET_REPLAY_FILE 重放:
 * 同一个请求命中录制响应,**完全不发网络请求**,可用于回归/排障/diff。
 *
 * 只做两件事,不侵入引擎:
 *   - record:KINET_TRACE_FILE=<path> 时,把 (model, messages, tools, completion) 追加成 JSONL
 *   - replay:KINET_REPLAY_FILE=<path> 时,按 请求哈希 查表返回录制响应,缺失则……
 *     - 默认抛错(严格):宁可失败也不要偷偷联网,否则"离线回归"结论不可信
 *     - KINET_REPLAY_FALLBACK=1 时回落实时调用(适合半录制场景)
 *
 * 请求哈希 = sha256(model + messages + tools)。工具描述改了哈希就变,这是**故意**的:
 * prompt 变了就该是另一个请求,重放命中不了才能暴露"这次改动确实影响了模型输入"。
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatMsg, ConfigSnapshot } from '../shared/types';
import type { Completion, Provider, ToolDef } from './glm';

export type TraceRecord = {
  v: 1;
  ts: number;
  model: string;
  reqHash: string;
  /** 录制时的工作根目录:重放要把工具参数里的绝对路径重定向到新目录 */
  root?: string;
  messages: ChatMsg[];
  tools: string[];
  completion: Completion;
};

const traceFile = (): string | null => process.env.KINET_TRACE_FILE || null;
const replayFile = (): string | null => process.env.KINET_REPLAY_FILE || null;

/** 请求指纹:model + 消息 + 工具定义(含参数 schema)。 */
export function requestHash(model: string, messages: ChatMsg[], tools: ToolDef[]): string {
  const h = createHash('sha256');
  h.update(model);
  h.update('\u0000');
  h.update(normalizeForHash(JSON.stringify(messages)));
  h.update('\u0000');
  h.update(JSON.stringify(tools));
  return h.digest('hex');
}

let replayCache: { file: string; map: Map<string, TraceRecord> } | null = null;
let replayMiss = 0;

/**
 * 抹掉「每次运行都不同、但不影响语义」的片段,否则重放永远命中不了:
 *   - 临时目录路径(eval 每次 mkdtemp,真实会话 cwd 也可能变)
 *   - ISO 时间戳的时分秒(system prompt 里常带当前时间)
 * 只保留日期部分:换天重放本就该 miss(时间相关的回答不可复用)。
 */
function normalizeForHash(s: string): string {
  return s
    .replace(/\/(?:var\/folders|private\/var\/folders|tmp|private\/tmp)\/[^\s"'`\\)\]]+/g, '<TMP>')
    .replace(/(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '$1');
}

function loadReplay(file: string): Map<string, TraceRecord> {
  // 按文件名缓存:测试/长驻进程里可能切换轨迹文件,不能只认第一次
  if (replayCache && replayCache.file === file) return replayCache.map;
  const map = new Map<string, TraceRecord>();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as TraceRecord;
        // 同一请求可被多次录制(温度/时间不同),保留第一条即可保证确定性
        if (rec && rec.reqHash && rec.completion && !map.has(rec.reqHash)) {
          map.set(rec.reqHash, rec);
        }
      } catch { /* 坏行跳过:轨迹是调试产物,不该因为它整批失败 */ }
    }
  }
  replayCache = { file, map };
  return map;
}

/**
 * 把录制时的绝对路径换成当前运行目录。
 * 工具参数(cwd / path)都带绝对路径,不重定向的话重放会写到上次的临时目录,
 * 验收判定必然失败 —— 这是"重放 100% 通过但文件不在"的坑。
 */
function rebase(rec: TraceRecord): Completion {
  const to = process.env.KINET_REPLAY_ROOT;
  if (!to || !rec.root || rec.root === to) return rec.completion;
  try {
    return JSON.parse(JSON.stringify(rec.completion).split(rec.root).join(to)) as Completion;
  } catch {
    return rec.completion;
  }
}

function appendRecord(rec: TraceRecord): void {
  const file = traceFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
  } catch { /* 录制失败不阻断主流程 */ }
}

/** 给 Provider 套一层录制/重放;没有相关环境变量时原样返回,零开销。 */
export function withTrace(inner: Provider): Provider {
  if (!traceFile() && !replayFile()) return inner;
  return {
    async streamComplete(messages, tools, snap: ConfigSnapshot, signal, onToken) {
      const hash = requestHash(snap.model, messages, tools);
      const replay = replayFile();
      if (replay) {
        const rec = loadReplay(replay).get(hash);
        if (rec) {
          const completion = rebase(rec);
          // 一次性把整段文本推给 UI:重放没有真实的增量时序,但最终状态一致
          if (completion.content) onToken(completion.content, 'answer');
          return completion;
        }
        replayMiss++;
        if (process.env.KINET_REPLAY_FALLBACK !== '1') {
          throw new Error(
            `[trace] 重放未命中(reqHash=${hash.slice(0, 12)} model=${snap.model})——`
            + '请求与录制时不一致(改了 prompt/工具/历史),或该步未录制。'
            + '如需允许联网补齐,设 KINET_REPLAY_FALLBACK=1。',
          );
        }
      }
      const completion = await inner.streamComplete(messages, tools, snap, signal, onToken);
      if (traceFile()) {
        appendRecord({
          v: 1, ts: Date.now(), model: snap.model, reqHash: hash,
          root: process.env.KINET_TRACE_ROOT || undefined,
          messages, tools: tools.map((t) => t.function?.name || ''), completion,
        });
      }
      return completion;
    },
  };
}

export function traceStats(): { replayMisses: number; replayed: boolean; recording: boolean } {
  return { replayMisses: replayMiss, replayed: !!replayFile(), recording: !!traceFile() };
}
