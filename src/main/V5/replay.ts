// replay.ts — 档②轨迹重放器(修正版 Phylum 的化石执行器官)。
// 成功轨迹 → 参数槽位化模板 → 新任务重放 + 断言 gate:
//   过 = 零 LLM 零 token 交付(种群终态:墓园里安静跑着的化石);
//   败 = 回退 LLM 开荒 + fossil_miss 归因(化石不装死,错得可发现)。
// 槽位重抽是纯字符串启发式,不是程序综合(那是档③,远期)——
// 这里只承诺"重复任务"的高命中率;参数形状变了就诚实地 miss 回退。

import type { Tool, ToolCtx } from '../tools';
import type { TraceStep, TraceTemplate } from './phylum-types';
import { checkAssertions } from './express';

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

/** 从新任务文本为槽位抽值。返回 undefined = 抽不出(重放方应 miss 回退,不用 fallback 硬闯)。 */
export function fillSlot(task: string, slot: TraceTemplate['slots'][number]): unknown {
  if (slot.kind === 'url') {
    return task.match(/https?:\/\/\S+/)?.[0];
  }
  if (slot.kind === 'path') {
    const inTask = task.match(/[\w./~\\-]+\.(ts|js|json|md|csv|xlsx|txt|log|html)/g);
    if (inTask?.length) return inTask[0];
    // 例子文件名尾部出现在任务里 → 复用原路径(同文件场景)
    const tail = String(slot.fallback).split(/[\\/]/).pop() ?? '';
    if (tail && task.toLowerCase().includes(tail.toLowerCase())) return slot.fallback;
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
  let lastOutput = '';
  for (let i = 0; i < tpl.steps.length; i++) {
    const st = tpl.steps[i];
    const tool = tools.find((t) => t.name === st.tool);
    if (!tool) return { hit: false, miss: { reason: 'tool_missing', detail: `化石步 ${i + 1}:工具 ${st.tool} 已不在注册表` }, steps: i };
    // 本模板所有指向这步的槽位填充
    for (const slot of tpl.slots) {
      if (!slot.path.startsWith(`steps.${i}.args.`)) continue;
      const v = fillSlot(task, slot);
      if (v === undefined || v === '') {
        return { hit: false, miss: { reason: 'arg_unfilled', detail: `槽位无法从任务文本填充:${slot.path}` }, steps: i };
      }
      slotWrite(tpl, slot.path, v);
    }
    let args: Record<string, unknown>;
    try { args = st.args; } catch { args = {}; }
    let output: string;
    try {
      output = await tool.run(args, ctx);
    } catch (err) {
      return { hit: false, miss: { reason: 'tool_error', detail: `${st.tool}: ${(err as Error).message}` }, steps: i };
    }
    lastOutput = output;
    onStep?.(i, st.tool, output.slice(0, 400));
    const violated = checkAssertions(assertions, { name: st.tool, output, exitCode: output.startsWith('[exit') ? Number(output.match(/\[exit (\d+)\]/)?.[1] ?? 0) : undefined });
    if (violated) {
      return { hit: false, miss: { reason: 'assertion_fail', detail: `断言 ${violated.id} 拦截化石输出`, violatedAssertionId: violated.id }, steps: i };
    }
  }
  return { hit: true, output: lastOutput, steps: tpl.steps.length };
}
