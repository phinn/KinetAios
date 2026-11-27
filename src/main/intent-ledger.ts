// Intent 账本 + 完成证据闸(2026-11)。
//
// 要解决的问题:模型说"做完了"的成本是零。它会跳过测试、跳过视觉验收、
// 在类型错误还红着的时候宣布完成 —— 用户只能自己再查一遍,agent 的交付没有可信度。
//
// 这里把"完成"变成不可自述的硬事实:
//   1. 用户的目标 + 验收契约落进 intents 表(不是聊天记录里的软文本);
//   2. 证据只从 conv_events 计算 —— 本轮改过文件,就必须在最后一次编辑之后
//      出现通过的诊断 / 测试 / 视觉验收;没有任何通过证据 → intent_done 直接拒绝;
//   3. 失败证据同样入账:最后一次通过之后又有失败,等于没通过。
//
// 判定全部是纯函数(assessEvidence / canComplete),不依赖 Electron,可直接单测。
import * as store from './store';
import type { EventRow, IntentEvidenceRow, IntentRow } from './store';
import type { ConvEvent, IntentInfo } from '../shared/types';
import type { AssertionDsl, CheckFailure, LastToolOutput } from './assertions';
import { describeCheck, evaluateChecks, parseExitCode } from './assertions';

export type EvidenceKind = 'diagnostics' | 'test' | 'visual' | 'answer';

export interface EvidenceItem {
  kind: EvidenceKind;
  ok: boolean;
  tool: string;
  seq: number;
  at: number;
  detail: string;
}

export interface EvidenceReport {
  /** 本轮是否改动过文件(write_file / edit_file 且未失败) */
  hasEdits: boolean;
  lastEditSeq: number | null;
  lastEditTool: string | null;
  /** 最后一次编辑之后(含同一次编辑内嵌的自动检查)的全部证据,按发生顺序 */
  items: EvidenceItem[];
  /** 在最后一次「通过」之后出现的失败 —— 有它就不能完成 */
  blocking: EvidenceItem[];
  ok: boolean;
  /** 不通过时的可执行原因(直接回给模型) */
  reasons: string[];
}

export const KIND_LABEL: Record<EvidenceKind, string> = {
  diagnostics: '类型/静态诊断',
  test: '受影响的测试',
  visual: '视觉验收',
  answer: '助手答复',
};

const EDIT_TOOLS = new Set(['write_file', 'edit_file']);
const VERIFY_TOOLS = new Set(['diagnostics', 'verify_visual']);

// 自动闸的结论就写在这几个前缀里(auto-test.ts / auto-visual.ts / diagnostics.ts 的渲染格式)。
// 只扫编辑工具与验收入口的结果 —— 不扫 read_file 等任意输出,避免把日志里引用的
// "✅ 自动测试"当成真实证据(否则把测试日志读一遍就能骗过闸门)。
const RE_DIAG_OK = /✅ (?:自动诊断|诊断通过)/;
const RE_DIAG_FAIL = /⚠️ (?:自动诊断|诊断发现|诊断未正常完成)/;
const RE_TEST_OK = /🧪 自动测试[^\n]*:(?:通过|.*本次未新增)/;
const RE_TEST_FAIL = /⚠️ 自动测试/;
const RE_VISUAL_OK = /(?:👁 自动视觉验收:通过|✅ 视觉验收通过)/;
const RE_VISUAL_FAIL = /(?:⚠️ 自动视觉验收未通过|❌ 视觉验收未通过)/;
const RE_EDIT_FAIL = /(?:写入失败|编辑失败|拒绝覆盖|沙箱模式|缺少 path)/;

function firstLineMatching(text: string, re: RegExp): string {
  const line = text.split('\n').find((l) => re.test(l));
  return (line ?? '').trim().slice(0, 200);
}

/** 从单条工具结果里认出证据(可能是多条:一次编辑同时附了诊断与测试结论)。 */
function detectEvidence(name: string, result: string): Array<{ kind: EvidenceKind; ok: boolean; detail: string }> {
  const out: Array<{ kind: EvidenceKind; ok: boolean; detail: string }> = [];
  if (RE_DIAG_OK.test(result)) out.push({ kind: 'diagnostics', ok: true, detail: firstLineMatching(result, RE_DIAG_OK) });
  else if (RE_DIAG_FAIL.test(result)) out.push({ kind: 'diagnostics', ok: false, detail: firstLineMatching(result, RE_DIAG_FAIL) });
  if (RE_TEST_OK.test(result)) out.push({ kind: 'test', ok: true, detail: firstLineMatching(result, RE_TEST_OK) });
  else if (RE_TEST_FAIL.test(result)) out.push({ kind: 'test', ok: false, detail: firstLineMatching(result, RE_TEST_FAIL) });
  if (RE_VISUAL_OK.test(result)) out.push({ kind: 'visual', ok: true, detail: firstLineMatching(result, RE_VISUAL_OK) });
  else if (RE_VISUAL_FAIL.test(result)) out.push({ kind: 'visual', ok: false, detail: firstLineMatching(result, RE_VISUAL_FAIL) });
  // 显式诊断工具返回"未检测到可用工具"不是通过,也不是失败 —— 不入账,避免假证据。
  void name;
  return out;
}

/**
 * 从事件行计算证据报告。rows 应为「该意图生命周期内」的事件(创建到现在),
 * 这样"上一轮改完、这一轮只喊完成"也会被拦住。
 */
export function assessEvidence(rows: EventRow[]): EvidenceReport {
  let lastEditSeq: number | null = null;
  let lastEditTool: string | null = null;
  let lastAnswer: { seq: number; at: number; text: string } | null = null;
  const items: EvidenceItem[] = [];

  for (const row of rows) {
    const ev = row.data as ConvEvent;
    if (ev.type === 'assistant/message') {
      const text = String(ev.text ?? '');
      if (text.trim()) lastAnswer = { seq: row.seq, at: row.ts, text };
      continue;
    }
    if (ev.type !== 'tool/call') continue;
    const name = String(ev.name ?? '');
    const result = String(ev.result ?? '');
    const failed = ev.outcome === 'error' || (EDIT_TOOLS.has(name) && RE_EDIT_FAIL.test(result));
    if (EDIT_TOOLS.has(name) && !failed) {
      lastEditSeq = row.seq;
      lastEditTool = name;
    }
    if (!EDIT_TOOLS.has(name) && !VERIFY_TOOLS.has(name)) continue;
    for (const d of detectEvidence(name, result)) {
      items.push({ ...d, tool: name, seq: row.seq, at: row.ts });
    }
  }

  const hasEdits = lastEditSeq !== null;
  const sinceEdit = hasEdits ? items.filter((i) => i.seq >= (lastEditSeq as number)) : items;
  const verification = sinceEdit.filter((i) => i.kind !== 'answer');

  if (!hasEdits) {
    // 没改文件的任务(问答/检索/分析):答复是唯一可核验的产出。
    // 注意 Direct 引擎的 assistant/message 在 done 时才落库,本工具调用期间往往还看不到 ——
    // 因此"暂无答复"不拦,真空白由轮次本身暴露;硬闸只针对"改过文件却没有验收"。
    if (lastAnswer) {
      sinceEdit.push({
        kind: 'answer', ok: true, tool: 'assistant', seq: lastAnswer.seq, at: lastAnswer.at,
        detail: `答复 ${lastAnswer.text.trim().length} 字符`,
      });
    }
  }

  // 最后一次通过之后的失败才算 blocking(先失败后修好是正常过程)。
  const lastOkSeq = verification.filter((i) => i.ok).reduce<number | null>((m, i) => (m === null || i.seq > m ? i.seq : m), null);
  const blocking = verification.filter((i) => !i.ok && (lastOkSeq === null || i.seq >= lastOkSeq));

  const reasons: string[] = [];
  if (hasEdits && !verification.some((i) => i.ok)) {
    reasons.push(
      '本次意图改动了文件,但没有任何可核验的通过证据。改完后必须运行 diagnostics 或 verify_visual'
      + '(或等编辑附带的自动诊断 / 自动测试通过)再声明完成。',
    );
  }
  if (blocking.length) {
    const labels = [...new Set(blocking.map((b) => KIND_LABEL[b.kind]))].join('、');
    reasons.push(`最后一次编辑之后仍有未通过的检查:${labels}。先修复这些问题,再重新验收。`);
  }

  return {
    hasEdits,
    lastEditSeq,
    lastEditTool,
    items: sinceEdit,
    blocking,
    ok: reasons.length === 0,
    reasons,
  };
}

// ── 契约断言(2026-11)──
// 证据闸只回答"有没有可核验的通过检查",这里的断言回答"检查的是不是用户要的那件事"。
// 输出类断言绑定「意图生命周期内最后一次 shell」——与证据闸"最后编辑之后必须有检查"同口径。

export interface IntentAssertionReport {
  /** 断言条数(0 = 未设置,直接放行) */
  checks: number;
  pass: boolean;
  failed: CheckFailure[];
  /** 判定所依据的最后一次 shell 命令(预览),拒绝文案里回给模型 */
  lastShell: string | null;
}

/** 从事件流取最后一次 shell 输出,逐条判定契约断言。纯函数(read-only 磁盘访问)。 */
export function evaluateIntentAssertions(
  assertions: ReadonlyArray<AssertionDsl>,
  cwd: string,
  rows: EventRow[],
): IntentAssertionReport {
  if (!assertions.length) return { checks: 0, pass: true, failed: [], lastShell: null };

  // 绑定策略(2026-11-27 A 修复):不再绑"最后一次 shell"——验收命令通过后,
  // 模型随手跑的无关 shell(如 ls 报错)会把 exit_code_eq:0 断言翻红。
  // 改绑"最后一次**退出码为 0** 的 shell"作为验收基准;输出类断言只扫通过命令,
  // 非零退出的输出不进 regex_contains(避免把报错日志当证据)。
  // Binding strategy: bind to the LAST SUCCESSFUL (exit 0) shell, not merely the
  // last one — stray failing commands after acceptance must not veto the gate.
  let last: { output: string; exitCode?: number; command: string | null } | null = null;
  for (const row of rows) {
    const ev = row.data as ConvEvent;
    if (ev.type !== 'tool/call' || ev.name !== 'shell') continue;
    const output = String(ev.result ?? '');
    // 退出码解析(2026-11-27 收紧):事件层 50k 截断历史上会把尾部 [exit:N] 丢掉,
    // 旧逻辑用 outcome==='ok' fallback 会把真实失败判通过。
    // 现在:截断注记在场且解析不到退出码 = 未知 → 跳过该事件(不作为验收基准),
    // 宁可让模型重跑命令,不可放水。未截断且 outcome=ok → 退出码 0。
    // Exit-code resolution: a truncated event without [exit:N] has unknown code
    // and is skipped as evidence; only untruncated ok events are trusted as 0.
    const truncated = output.includes('…[事件存证截断');
    const exitCode = parseExitCode(output) ?? (ev.outcome === 'ok' && !truncated ? 0 : undefined);
    let command: string | null = null;
    try {
      const parsed = JSON.parse(String(ev.args ?? '{}')) as { command?: unknown };
      if (typeof parsed.command === 'string') command = parsed.command;
    } catch { /* args 非 JSON:只影响文案,不影响判定 */ }
    // 只把「退出码已知且为 0」的 shell 作为验收基准;非零退出/退出码未知的跳过。
    if (exitCode === 0) last = { output, exitCode, command };
  }

  // 一个通过 shell 都没有 → 断言无从判定,全部 not-ok(文案说明原因)。
  const lastTool: LastToolOutput = last
    ? { name: 'shell', output: last.output, exitCode: last.exitCode }
    : { name: '', output: '', exitCode: undefined };
  const verdict = evaluateChecks(assertions, cwd, lastTool);
  if (!last) {
    return {
      checks: assertions.length, pass: false,
      failed: assertions.map((c) => ({
        id: c.type, actual: '事件流里没有任何退出码为 0 的 shell 命令可作验收基准',
        describe: describeCheck(c, cwd),
      })),
      lastShell: null,
    };
  }
  return { checks: assertions.length, pass: verdict.pass, failed: verdict.failed, lastShell: last.command ?? null };
}

/**
 * 「完成必须带证据」的判定(纯函数)。report 来自 assessEvidence,
 * 已包含本轮证据;budget 超支 / 契约断言未过也在这里拦。
 */
export function canComplete(
  intent: Pick<IntentRow, 'status' | 'contract' | 'budgetUSD' | 'spentUSD'>,
  report: EvidenceReport,
  assertions?: Pick<IntentAssertionReport, 'pass' | 'failed' | 'checks' | 'lastShell'>,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (intent.status !== 'open') reasons.push(`意图当前状态是 ${intent.status},不能再次完成。`);
  if (intent.contract.trim().length < 4) reasons.push('意图缺少可验收的契约:先补 contract(什么算完成)。');
  if (!report.ok) reasons.push(...report.reasons);
  // 只有"改过文件"的意图才要求通过证据;纯问答没有可跑的诊断,答复在轮末产生。
  if (report.hasEdits && !report.items.some((i) => i.ok)) reasons.push('没有任何通过证据(items 里没有 ok=true 的条目)。');
  if (intent.budgetUSD > 0 && intent.spentUSD > intent.budgetUSD) {
    reasons.push(`已花费 $${intent.spentUSD.toFixed(4)} 超出预算 $${intent.budgetUSD.toFixed(4)}。`);
  }
  if (assertions && assertions.checks > 0 && !assertions.pass) {
    const detail = assertions.failed
      .map((f) => `${f.id}(${f.describe} — 实际: ${f.actual})`)
      .join('、');
    const basis = assertions.lastShell ? `(判定基于最后一次 shell: ${assertions.lastShell.slice(0, 120)})` : '(意图生命周期内没有 shell 调用)';
    reasons.push(`契约断言未通过:${detail}${basis}。先把产物/命令调整到满足断言,再重新调用 intent_done。`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** 该意图创建以来的 turn/meta 成本合计(用于 spent_usd)。 */
export function refreshIntentSpend(intentId: string): number {
  const intent = store.getIntent(intentId);
  if (!intent) return 0;
  const spent = store.sumTurnCostSince(intent.convId, intent.createdAt);
  store.updateIntent(intentId, { spentUSD: spent });
  return spent;
}

/** 把证据写进账本(失败证据也写 —— 拒绝理由是审计的一部分)。同一证据重复入账会被去重。 */
export function recordEvidence(intentId: string, report: EvidenceReport): IntentEvidenceRow[] {
  const persisted: IntentEvidenceRow[] = [];
  const seen = new Set(store.listIntentEvidence(intentId).map((e) => `${e.kind}|${e.ref ?? ''}`));
  for (const item of report.items) {
    if (item.kind === 'answer') continue; // 答复每轮都有,入账只会刷屏
    const ref = JSON.stringify({ tool: item.tool, seq: item.seq });
    if (seen.has(`${item.kind}|${ref}`)) continue;
    seen.add(`${item.kind}|${ref}`);
    persisted.push(store.addIntentEvidence({
      intentId,
      kind: item.kind,
      ref,
      ok: item.ok,
      detail: item.detail,
      at: item.at,
    }));
  }
  return persisted;
}

export function formatIntent(intent: IntentRow, evidence: IntentEvidenceRow[]): string {
  const passed = evidence.filter((e) => e.ok).length;
  const failed = evidence.length - passed;
  const lines = [
    `#${intent.id} [${intent.status}] ${intent.title || '(无标题)'}`,
    `契约: ${intent.contract || '(未设置)'}`,
  ];
  if (intent.assertions.length) {
    const shown = intent.assertions.slice(0, 3).map((a) => describeCheck(a, '')).join('; ');
    lines.push(`断言: ${intent.assertions.length} 条 — ${shown}${intent.assertions.length > 3 ? ' …' : ''}`);
  }
  lines.push(
    `预算: ${intent.budgetUSD > 0 ? `$${intent.budgetUSD.toFixed(4)}` : '未设'} · 已花: $${intent.spentUSD.toFixed(4)}`,
    `证据: ${passed} 条通过${failed ? ` / ${failed} 条失败` : ''}`,
  );
  for (const e of evidence.slice(-8)) {
    lines.push(`  ${e.ok ? '✅' : '⚠️'} [${KIND_LABEL[e.kind as EvidenceKind] ?? e.kind}] ${e.detail}`);
  }
  return lines.join('\n');
}

export function formatIntentList(intents: IntentRow[]): string {
  if (!intents.length) return '当前会话还没有意图。先用 intent action=start 建立「目标 + 验收契约」。';
  return intents.map((it) => {
    const icon = it.status === 'done' ? '✅' : it.status === 'dropped' ? '🗑' : '▫️';
    return `${icon} #${it.id} ${it.title || '(无标题)'} — ${it.contract.slice(0, 80)}${it.contract.length > 80 ? '…' : ''}`;
  }).join('\n');
}

/**
 * 渲染层视图:最近 20 个意图 + 证据明细。
 * 只读:open 意图的 spent 现场按事件流重算,不回写(避免"看一眼就改库")。
 */
export function intentViews(convId: string): IntentInfo[] {
  return store.listIntents(convId, { limit: 20 }).map((it) => {
    const evidence = store.listIntentEvidence(it.id, 200);
    const passed = evidence.filter((e) => e.ok).length;
    const failed = evidence.length - passed;
    const spent = it.status === 'open' ? store.sumTurnCostSince(it.convId, it.createdAt) : it.spentUSD;
    return {
      id: it.id,
      convId: it.convId,
      title: it.title,
      contract: it.contract,
      status: it.status,
      budgetUSD: it.budgetUSD,
      spentUSD: spent,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
      passed,
      failed,
      evidence: evidence.map((e) => ({ kind: e.kind, ok: e.ok, detail: e.detail, at: e.at })),
    };
  });
}

// 体系提示:固定文本(不随文件/会话变化),不破坏 prompt 缓存。
export const INTENT_LEDGER_HINT =
  '\n\n# 意图账本(交付契约)\n'
  + '开始任何非平凡任务(改代码 / 做页面 / 写文档 / 多步修复)前,先调 intent(action="start", title=一句话目标, contract=可验收的完成定义)。'
  + ' 完成前调 intent_done:它不会相信你的口头结论,而是从本轮事件流核对证据 —— 改过文件就必须有诊断 / 测试 / 视觉验收的通过记录,'
  + '否则会被拒绝并告诉你还缺什么。被拒绝时补做检查,不要重复调用同一句"已完成"。'
  + ' 契约能写成可执行断言的就一起传 assertions(如 [{type:"file_exists",path:"dist/x.html"}] / [{type:"exit_code_eq",value:0}]);'
  + '完成时逐条判定,失败会指出哪条、实际值是什么。';
