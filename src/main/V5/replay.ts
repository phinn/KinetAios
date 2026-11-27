// replay.ts — 档②轨迹重放器(修正版 Phylum 的化石执行器官)。
// 成功轨迹 → 参数槽位化模板 → 新任务重放 + 断言 gate:
//   过 = 零 LLM 零 token 交付(种群终态:墓园里安静跑着的化石);
//   败 = 回退 LLM 开荒 + fossil_miss 归因(化石不装死,错得可发现)。
// 槽位重抽是纯字符串启发式,不是程序综合(那是档③,远期)——
// 这里只承诺"重复任务"的高命中率;参数形状变了就诚实地 miss 回退。

import path from 'node:path';
import type { Tool, ToolCtx } from '../tools';
import { INTENT_TOOL_NAMES, type TraceStep, type TraceTemplate } from './phylum-types';
import { checkAssertions } from './express';
import { scanRepo } from '../repo-map';
import { toolTelemetryOf } from '../tool-telemetry';

/** 槽位路径寻址:模板根上的 JSON pointer,如 "steps.0.args.path"。 */
export function slotRead(tpl: { steps: TraceStep[] }, ptr: string): unknown {
  const segs = ptr.split('.');
  let cur: unknown = tpl;
  for (const seg of segs) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function slotWrite(tpl: { steps: TraceStep[] }, ptr: string, v: unknown): void {
  const segs = ptr.split('.');
  let cur: unknown = tpl;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return;
    cur = (cur as Record<string, unknown>)[segs[i]];
  }
  if (cur != null && typeof cur === 'object') (cur as Record<string, unknown>)[segs[segs.length - 1]] = v;
}

/** 抽槽位表:字符串参数按启发式分 kind(路径/URL/query),原值作 fallback。 */
export function extractSlots(steps: TraceStep[]): TraceTemplate['slots'] {
  const slots: TraceTemplate['slots'] = [];
  const seen = new Set<string>();
  const rules: Array<{ kind: TraceTemplate['slots'][number]['kind']; test: RegExp }> = [
    { kind: 'path', test: /^([~/]|\.?\/)|\.(ts|js|json|md|csv|xlsx|txt|log|html)$/ },
    { kind: 'url', test: /^https?:\/\// },
  ];
  for (let i = 0; i < steps.length; i++) {
    for (const [k, v] of Object.entries(steps[i].args)) {
      if (typeof v !== 'string' || !v) continue; // 数字/布尔参数通常是常量,不槽位化
      const ptr = `steps.${i}.args.${k}`;
      if (seen.has(ptr)) continue;
      seen.add(ptr);
      slots.push({ path: ptr, kind: rules.find((r) => r.test.test(v))?.kind ?? 'query', fallback: v });
    }
  }
  return slots;
}

/** 仓库索引兜底缓存:scanRepo 本身有指纹缓存,但每次仍要 walk 全仓 + 逐词 filter。
 *  重放是高频零 token 路径,按 cwd 缓存 30s 的 basename→paths 倒排表,把"每词全量扫描"
 *  降成一次 Map 查表。 */
interface RepoHintIndex { at: number; byBase: Map<string, string[]> }
const REPO_HINT_TTL_MS = 30_000;
const repoHintCache = new Map<string, RepoHintIndex>();

/** 裸词黑名单:这些名字在几乎每个仓库都出现,拿它去绑定文件必绑错(宁可 miss)。 */
const COMMON_BARE = new Set([
  'index', 'main', 'app', 'utils', 'util', 'test', 'tests', 'spec', 'core', 'lib', 'src',
  'types', 'type', 'config', 'readme', 'package', 'setup', 'style', 'styles', 'data', 'api',
]);

function repoHintIndex(cwd: string): RepoHintIndex {
  const key = path.resolve(cwd);
  const now = Date.now();
  const hit = repoHintCache.get(key);
  if (hit && now - hit.at < REPO_HINT_TTL_MS) return hit;
  const idx = scanRepo(key);
  const byBase = new Map<string, string[]>();
  for (const f of idx.files) {
    const name = (f.path.split('/').pop() ?? '').toLowerCase();
    if (!name) continue;
    const stem = name.replace(/\.[^.]+$/, '');
    const push = (k: string): void => {
      const arr = byBase.get(k);
      if (arr) { if (!arr.includes(f.path)) arr.push(f.path); } else byBase.set(k, [f.path]);
    };
    push(name);
    if (stem !== name) push(stem);
  }
  const built = { at: now, byBase };
  repoHintCache.set(key, built);
  return built;
}

/** 该词是否值得拿去仓库索引里绑定文件。
 *  收紧(2026-11-27):必须有形状(路径分隔符 / 扩展名 / 连字符 / 下划线 / 点),或长度≥4 的裸词;
 *  裸常见词(index/main/app/...)不参与 —— 全仓同名会绑错文件,重放宁可 miss 回退。 */
function worthwhileHint(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  const base = (t.split(/[\\/]/).pop() ?? '').trim().toLowerCase();
  if (!base || base.length < 3) return false;
  if (/[\\/._-]/.test(t)) return true;
  return base.length >= 4 && !COMMON_BARE.has(base);
}

/** 路径槽位兜底:在仓库索引里找唯一同名文件(零 LLM)。
 *  只在常规抽取都失败时调用;同名多份 = 不确定,宁可 miss 也不猜。 */
function resolvePathFromRepo(cwd: string | undefined, hints: string[]): string | undefined {
  if (!cwd) return undefined;
  try {
    const idx = repoHintIndex(cwd);
    for (const hint of hints) {
      if (!worthwhileHint(hint)) continue;
      const base = (hint.trim().split(/[\\/]/).pop() ?? '').trim().toLowerCase();
      const hits = idx.byBase.get(base) ?? idx.byBase.get(base.replace(/\.[^.]+$/, '')) ?? [];
      if (hits.length === 1) return hits[0];
    }
  } catch { /* 索引失败 → 保持 miss,不硬闯 */ }
  return undefined;
}

/** 从新任务文本为槽位抽值。返回 undefined = 抽不出(重放方应 miss 回退,不用 fallback 硬闯)。 */
export function fillSlot(task: string, slot: TraceTemplate['slots'][number], cwd?: string): unknown {
  if (slot.kind === 'url') {
    return task.match(/https?:\/\/\S+/)?.[0];
  }
  if (slot.kind === 'path') {
    // 引号里的路径优先(可含空格/无扩展名):新任务常写成 "src/main/index" 或 'a b.ts'
    const quotedAll = [...task.matchAll(/["'`]([^"'`\n]+)["'`]/g)].map((m) => m[1].trim());
    const quoted = quotedAll.find((v) => /[\\/]/.test(v) || /\.\w{1,8}$/.test(v));
    if (quoted) return quoted;
    const inTask = task.match(/[\w./~\\-]+\.(ts|js|json|md|csv|xlsx|txt|log|html)/g);
    if (inTask?.length) return inTask[0];
    // 例子文件名尾部出现在任务里 → 复用原路径(同文件场景)
    const tail = String(slot.fallback).split(/[\\/]/).pop() ?? '';
    if (tail && task.toLowerCase().includes(tail.toLowerCase())) return slot.fallback;
    // 仓库索引兜底:任务只给了文件名/词干、没给扩展名(如「改 foo-bar 的样式」)
    const words = task.match(/[\w.-]{3,}/g) ?? [];
    const resolved = resolvePathFromRepo(cwd, [...quotedAll, ...words]);
    if (resolved) return resolved;
    return undefined;
  }
  // query:任务原文(重放语义 = 把新任务交给同一条已验证的工具链)
  return task.trim();
}

export interface ReplayResult {
  hit: boolean;
  /** 最后一步工具输出(交付给用户) */
  output?: string;
  /** miss 原因(供归因/状态播报) */
  miss?: { reason: 'arg_unfilled' | 'tool_missing' | 'tool_error' | 'assertion_fail'; detail: string; violatedAssertionId?: string };
  steps: number;
}

/** 执行重放:按模板步序调工具(参数=槽位填充),步间过断言 gate。全程零 LLM。 */
export async function replay(
  tpl: TraceTemplate,
  task: string,
  tools: readonly Tool[],
  assertions: TraceTemplate extends never ? never : import('./phylum-types').AssertionGene[],
  ctx: ToolCtx,
  onStep?: (i: number, name: string, output: string) => void,
): Promise<ReplayResult> {
  // 污染防护(2026-11-27):传入的 tpl 是注册表里的**活引用**,slotWrite 直接写它会把
  // 新任务参数覆写进化石档案 —— fillSlot 的 fallback(同文件场景复用锚点)随之漂移,
  // 且 saveTemplates 落盘后污染跨进程永久化。故全程在私有副本上填充,档案不可变。
  // Mutation guard: the caller passes a live registry object; fill all slots on a
  // private clone so the fossil archive stays immutable (persistence would
  // otherwise bake the last task's args into the template forever).
  const plan = structuredClone(tpl);
  let lastOutput = '';
  for (let i = 0; i < plan.steps.length; i++) {
    const st = plan.steps[i];
    // 意图账本工具(旧模板可能含)是审计/闸门,不是任务动作:跳过执行,也不参与槽位填充。
    // 跳过不改变槽位索引(steps.i 依旧指向原步),旧档案可安全重放。
    if ((INTENT_TOOL_NAMES as readonly string[]).includes(st.tool)) continue;
    const tool = tools.find((t) => t.name === st.tool);
    if (!tool) return { hit: false, miss: { reason: 'tool_missing', detail: `化石步 ${i + 1}:工具 ${st.tool} 已不在注册表` }, steps: i };
    // 本模板所有指向这步的槽位填充
    for (const slot of plan.slots) {
      if (!slot.path.startsWith(`steps.${i}.args.`)) continue;
      const v = fillSlot(task, slot, ctx.cwd);
      if (v === undefined || v === '') {
        return { hit: false, miss: { reason: 'arg_unfilled', detail: `槽位无法从任务文本填充:${slot.path}` }, steps: i };
      }
      slotWrite(plan, slot.path, v);
    }
    let args: Record<string, unknown>;
    try { args = st.args; } catch { args = {}; }
    let output: string;
    try {
      output = await tool.run(args, ctx);
    } catch (err) {
      return { hit: false, miss: { reason: 'tool_error', detail: `${st.tool}: ${(err as Error).message}` }, steps: i };
    }
    // 工具把错误当正常字符串返回(不抛异常)时必须同样判 miss:否则「读取失败」这类
    // 结果会被当成成功交付,重放就变成"错得安静"的化石(与 bodyplan 的 trace 口径一致)。
    const tele = toolTelemetryOf(output);
    if (tele.outcome === 'error') {
      return { hit: false, miss: { reason: 'tool_error', detail: `${st.tool}: ${tele.errorSummary ?? '工具报错'}` }, steps: i };
    }
    lastOutput = output;
    onStep?.(i, st.tool, output.slice(0, 400));
    const violated = checkAssertions(assertions, { name: st.tool, output, exitCode: output.startsWith('[exit') ? Number(output.match(/\[exit (\d+)\]/)?.[1] ?? 0) : undefined });
    if (violated) {
      return { hit: false, miss: { reason: 'assertion_fail', detail: `断言 ${violated.id} 拦截化石输出`, violatedAssertionId: violated.id }, steps: i };
    }
  }
  return { hit: true, output: lastOutput, steps: plan.steps.length };
}
