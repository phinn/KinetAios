// Intent 账本 + 完成证据闸(2026-11):
// A) 证据只从事件流计算,模型自述不算;B) 最后一次通过之后的失败会让完成失败;
// C) 没改文件的问答用"助手答复"作为可核验产出;D) 账本落库 + 成本归集。
import { assert, test, run } from './harness';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../../src/main/store';
import {
  assessEvidence, canComplete, evaluateIntentAssertions, recordEvidence, refreshIntentSpend, formatIntent, intentViews, INTENT_LEDGER_HINT,
} from '../../src/main/intent-ledger';
import { evaluateChecks, parseAssertions, parseExitCode } from '../../src/main/assertions';
import { evaluateAcceptance } from '../../src/main/V5/ralph-accept';
import type { BodyPlanResult } from '../../src/main/V5/bodyplan';
import { runBodyPlan } from '../../src/main/V5/bodyplan';
import { GENOME_SCHEMA_VERSION, type Genome } from '../../src/main/V5/phylum-types';
import type { Tool } from '../../src/main/tools';
import { t, LANGS } from '../../src/shared/i18n';
import type { EventRow } from '../../src/main/store';
import type { ConvEvent } from '../../src/shared/types';

store.initStore();

let seqCounter = 0;
function row(data: ConvEvent, turnId = 't1'): EventRow {
  seqCounter += 1;
  return { seq: seqCounter, turnId, type: data.type, data, ts: 1_000_000 + seqCounter };
}
function tool(name: string, result: string, outcome?: 'ok' | 'error'): EventRow {
  return row({ type: 'tool/call', name, args: '{}', result, outcome });
}
function editOk(): EventRow {
  return tool('write_file', '已写入 /tmp/a.ts (10 字节)');
}
function diagPass(): EventRow {
  return tool('write_file', '已写入 /tmp/a.ts\n\n✅ 自动诊断(tsc 类型检查):无错误');
}

test('无文件改动 + 有答复:证据通过(kind=answer)', () => {
  seqCounter = 0;
  const r = assessEvidence([tool('web_fetch', 'HTTP 200 OK'), row({ type: 'assistant/message', text: '根据文档,答案是 X。' })]);
  assert.equal(r.hasEdits, false);
  assert.equal(r.ok, true, r.reasons.join(';'));
  assert.ok(r.items.some((i) => i.kind === 'answer' && i.ok));
});

test('无文件改动且尚未产生答复:不拦(答复在轮末落库)', () => {
  seqCounter = 0;
  const r = assessEvidence([tool('web_fetch', 'HTTP 200 OK')]);
  assert.equal(r.hasEdits, false);
  assert.equal(r.ok, true, '硬闸只针对"改过文件却没验收"');
});

test('改文件后自动诊断通过:完成放行', () => {
  seqCounter = 0;
  const r = assessEvidence([editOk(), diagPass(), row({ type: 'assistant/message', text: '已修好。' })]);
  assert.equal(r.hasEdits, true);
  assert.equal(r.ok, true, r.reasons.join(';'));
  assert.ok(r.items.some((i) => i.kind === 'diagnostics' && i.ok));
});

test('改文件后没有任何检查证据:拒绝(答复不能顶替)', () => {
  seqCounter = 0;
  const r = assessEvidence([editOk(), row({ type: 'assistant/message', text: '完成了。' })]);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('没有任何可核验的通过证据')), r.reasons.join(';'));
});

test('跨轮也照样拦:上一轮改过文件、这一轮没改就想完成 → 拒绝', () => {
  seqCounter = 0;
  const lifetime = [
    editOk(),
    row({ type: 'assistant/message', text: '改好了。' }, 't1'),
    row({ type: 'assistant/message', text: '已完成。' }, 't2'), // 新一轮没有任何编辑
  ];
  const r = assessEvidence(lifetime);
  assert.equal(r.hasEdits, true, 'lastEdit 来自意图生命周期,不是当前轮');
  assert.equal(r.ok, false);
});

test('先失败后通过:通过(失败不算 blocking)', () => {
  seqCounter = 0;
  const r = assessEvidence([
    editOk(),
    tool('write_file', '已写入 /tmp/a.ts\n\n⚠️ 自动诊断(tsc 类型检查):1 个问题\n  a.ts:1  error'),
    diagPass(),
  ]);
  assert.equal(r.ok, true, r.reasons.join(';'));
  assert.equal(r.blocking.length, 0);
});

test('通过之后又失败:blocking → 拒绝', () => {
  seqCounter = 0;
  const r = assessEvidence([
    editOk(),
    diagPass(),
    tool('write_file', '已写入 /tmp/a.ts\n\n⚠️ 自动测试(unit):1 个失败 (1.2s)\n  a.test.ts > x'),
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
  assert.ok(r.reasons.some((x) => x.includes('仍有未通过的检查')), r.reasons.join(';'));
});

test('失败的编辑不计入 lastEdit;其后的成功诊断单独成立', () => {
  seqCounter = 0;
  const r = assessEvidence([
    tool('write_file', '写入失败: EACCES', 'error'),
    row({ type: 'assistant/message', text: '这个文件没有写权限。' }),
  ]);
  assert.equal(r.hasEdits, false);
  assert.equal(r.ok, true, r.reasons.join(';'));
});

test('read_file 结果里的"自动测试通过"不算证据(防日志造假)', () => {
  seqCounter = 0;
  const r = assessEvidence([
    editOk(),
    tool('read_file', '日志:🧪 自动测试(unit):通过 (0.1s)'),
  ]);
  assert.equal(r.ok, false, '只有编辑/验收入口的结果才允许作为证据');
});

test('verify_visual 通过可作为证据', () => {
  seqCounter = 0;
  const r = assessEvidence([
    editOk(),
    tool('verify_visual', '✅ 视觉验收通过\n标准:无横向滚动条'),
  ]);
  assert.equal(r.ok, true, r.reasons.join(';'));
});

test('canComplete:契约过短 / 超预算 / 无证据 → 拒绝', () => {
  seqCounter = 0;
  const pass = assessEvidence([editOk(), diagPass()]);
  const base = { status: 'open' as const, contract: 'npm test 全绿', budgetUSD: 1, spentUSD: 0.2 };
  assert.equal(canComplete(base, pass).ok, true);
  assert.equal(canComplete({ ...base, contract: '好' }, pass).ok, false);
  assert.equal(canComplete({ ...base, spentUSD: 2 }, pass).ok, false);
  const empty = assessEvidence([editOk(), row({ type: 'assistant/message', text: '完成了。' })]);
  assert.equal(canComplete(base, empty).ok, false);
  assert.equal(canComplete({ ...base, status: 'done' }, pass).ok, false);
});

test('账本落库:建意图 → 记录证据 → 成本归集 → 完成', () => {
  const convId = 'conv-intent-db';
  const intent = store.createIntent({ convId, title: '修登录 bug', contract: 'npm test 全绿', budgetUSD: 5 });
  store.appendEvent(convId, 'turn-x', { type: 'tool/call', name: 'write_file', args: '{}', result: '已写入 a.ts', outcome: 'ok' });
  store.appendEvent(convId, 'turn-x', { type: 'tool/call', name: 'write_file', args: '{}', result: '✅ 自动诊断(tsc):无错误', outcome: 'ok' });
  store.appendEvent(convId, 'turn-x', { type: 'turn/meta', costUSD: 0.42, tokensIn: 100, tokensOut: 50 });

  const report = assessEvidence(store.loadEventsSince(convId, intent.createdAt));
  assert.equal(report.ok, true, report.reasons.join(';'));
  const written = recordEvidence(intent.id, report);
  assert.equal(written.length, 1, '只把诊断证据入账(答复/重复项不入)');
  recordEvidence(intent.id, report);
  assert.equal(store.listIntentEvidence(intent.id).length, 1, '重复记录同一证据应去重');

  const spent = refreshIntentSpend(intent.id);
  assert.equal(spent, 0.42, '成本从 turn/meta 事件归集');
  assert.equal(store.getIntent(intent.id)?.spentUSD, 0.42);

  const fresh = store.getIntent(intent.id)!;
  assert.ok(formatIntent(fresh, store.listIntentEvidence(intent.id)).includes('修登录 bug'));
  assert.equal(store.latestOpenIntent(convId)?.id, intent.id);
  store.updateIntent(intent.id, { status: 'done' });
  assert.equal(store.latestOpenIntent(convId), null, 'done 后不再是 open');
  assert.equal(store.listIntents(convId).length, 1);
});

test('intentViews:证据计数与花费现场计算,只读不回写', () => {
  const convId = 'conv-intent-view';
  const it = store.createIntent({ convId, title: '视图', contract: '测试通过', budgetUSD: 2 });
  store.addIntentEvidence({ intentId: it.id, kind: 'test', ok: true, detail: '通过' });
  store.addIntentEvidence({ intentId: it.id, kind: 'visual', ok: false, detail: '未通过' });
  store.appendEvent(convId, 'turn-v', { type: 'turn/meta', costUSD: 0.5, tokensIn: 1, tokensOut: 1 });
  const views = intentViews(convId);
  assert.equal(views.length, 1);
  assert.equal(views[0].passed, 1);
  assert.equal(views[0].failed, 1);
  assert.ok(Math.abs(views[0].spentUSD - 0.5) < 1e-9);
  assert.equal(store.getIntent(it.id)?.spentUSD, 0, '只读视图不能回写 spent_usd');
});

test('i18n:intent.* 四语言齐全,参数可替换', () => {
  for (const { id } of LANGS) {
    for (const key of ['intent.title', 'intent.open', 'intent.done', 'intent.dropped']) {
      assert.notEqual(t(id, key), key, `${id} 缺少 ${key}`);
    }
    assert.ok(t(id, 'intent.evidence', { n: 3 }).includes('3'), `${id} 的 intent.evidence 未替换 {n}`);
    assert.ok(t(id, 'intent.spent', { v: '0.42' }).includes('0.42'), `${id} 的 intent.spent 未替换 {v}`);
  }
});

test('INTENT_LEDGER_HINT:固定文本,给出建账与完成口径', () => {
  assert.ok(INTENT_LEDGER_HINT.includes('intent_done'), '必须提示完成要走 intent_done');
  assert.ok(INTENT_LEDGER_HINT.includes('intent(action="start"'), '必须提示先建意图账');
  assert.ok(INTENT_LEDGER_HINT.includes('证据'), '必须说明完成要靠证据');
  assert.ok(INTENT_LEDGER_HINT.includes('assertions'), '必须提示契约可写成可执行断言');
});

test('V5 bodyplan:systemSuffix 进个体 system,toolCtx 把 convId/turnId 传给工具', async () => {
  let systemText = '';
  const seen: { convId?: string; turnId?: string } = {};
  const probe: Tool = {
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', properties: {} },
    readOnly: true,
    async run(_args, ctx) {
      seen.convId = ctx.convId;
      seen.turnId = ctx.turnId;
      return 'ok';
    },
  };
  let calls = 0;
  const chat = async (messages: Array<{ role: string; content: unknown }>) => {
    systemText = String(messages[0]?.content ?? '');
    calls += 1;
    return calls === 1
      ? { content: '', toolCalls: [{ id: 'c1', name: 'probe', arguments: '{}' }], rawAssistant: { role: 'assistant', content: '' }, tokensIn: 1, tokensOut: 1 }
      : { content: '完成', toolCalls: [], rawAssistant: { role: 'assistant', content: '完成' }, tokensIn: 1, tokensOut: 1 };
  };
  const genome: Genome = {
    version: GENOME_SCHEMA_VERSION, genomeId: 'g-test', lineage: 'l-test', signature: 's-test',
    routing: { maxSteps: 3, granularity: 1, successPrior: 0.5 },
    affinity: {}, assertions: [], generation: 0, bornAt: 1,
  };
  const r = await runBodyPlan({
    task: 'do it',
    cwd: process.cwd(),
    body: { tools: [probe], removedTools: [], maxSteps: 3, instinctPrompt: '', assertions: [] },
    genome,
    chat,
    tools: [probe],
    systemSuffix: INTENT_LEDGER_HINT,
    toolCtx: { convId: 'conv-v5', turnId: 'turn-9' },
  });
  assert.equal(r.success, true, r.detail);
  assert.ok(systemText.includes('意图账本'), '体系提示必须真的进了个体 system');
  assert.equal(seen.convId, 'conv-v5', 'intent_done 依赖 convId,必须透传到工具 ctx');
  assert.equal(seen.turnId, 'turn-9');
});

function shellRow(command: string, result: string, outcome?: 'ok' | 'error'): EventRow {
  seqCounter += 1;
  return {
    seq: seqCounter, turnId: 't1', type: 'tool/call', ts: 1_000_000 + seqCounter,
    data: { type: 'tool/call', name: 'shell', args: JSON.stringify({ command }), result, outcome },
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-intent-'));
}

test('parseExitCode:兼容真实 shell 的 [exit 0] 与实验 runner 的 [exit:0]', () => {
  assert.equal(parseExitCode('ok\n[exit 0]\n'), 0);
  assert.equal(parseExitCode('bad\n[exit 1]\n'), 1);
  assert.equal(parseExitCode('[exit:0]'), 0);
  assert.equal(parseExitCode('no marker'), undefined);
});

test('parseAssertions:拒绝未知类型 / 缺字段 / 坏正则 / 超限', () => {
  assert.equal(parseAssertions([
    { type: 'file_exists', path: 'dist/x.html' },
    { type: 'exit_code_eq', value: 0 },
    { type: 'regex_file_contains', path: 'a.md', pattern: '完成' },
  ]).ok, true);
  assert.equal(parseAssertions([{ type: 'nope' }]).ok, false);
  assert.equal(parseAssertions([{ type: 'file_exists' }]).ok, false);
  assert.equal(parseAssertions([{ type: 'regex_contains', pattern: '(' }]).ok, false);
  assert.equal(parseAssertions(Array.from({ length: 7 }, () => ({ type: 'output_not_empty' }))).ok, false);
  assert.equal(parseAssertions(undefined).ok, true);
});

test('文件类断言:直接读盘判定,失败给出实际值', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'report.md'), '第一行\n完成:yes\n');
  const last = { name: 'shell', output: '', exitCode: undefined };
  const pass = evaluateChecks([
    { type: 'file_exists', path: 'report.md' },
    { type: 'regex_file_contains', path: 'report.md', pattern: '完成:yes' },
    { type: 'file_line_count_gt', path: 'report.md', value: 1 },
  ], dir, last);
  assert.equal(pass.pass, true);
  const fail = evaluateChecks([{ type: 'file_exists', path: 'missing.md' }], dir, last);
  assert.equal(fail.pass, false);
  assert.ok(fail.failed[0].actual.includes('不存在'), fail.failed[0].actual);
});

test('输出类断言:绑定意图生命周期内最后一次 shell', () => {
  seqCounter = 0;
  const rows = [
    shellRow('npm test', 'all good\n[exit 0]\n', 'ok'),
    shellRow('npm test', '1 failing\n[exit 1]\n', 'error'),
  ];
  const bad = evaluateIntentAssertions([{ type: 'exit_code_eq', value: 0 }], process.cwd(), rows);
  assert.equal(bad.pass, false);
  assert.equal(bad.lastShell, 'npm test');
  assert.equal(bad.failed[0].actual, '退出码 1');
  assert.equal(evaluateIntentAssertions([{ type: 'regex_contains', pattern: 'all good' }], process.cwd(), [rows[0]]).pass, true);
  const noShell = evaluateIntentAssertions([{ type: 'output_not_empty' }], process.cwd(), []);
  assert.equal(noShell.pass, false);
  assert.equal(noShell.lastShell, null);
  assert.ok(noShell.failed[0].actual.includes('为空'), noShell.failed[0].actual);
});

test('canComplete:契约断言未过 → 拒绝,并给出条目与依据', () => {
  seqCounter = 0;
  const report = assessEvidence([editOk(), diagPass()]);
  const base = { status: 'open' as const, contract: 'npm test 全绿', budgetUSD: 0, spentUSD: 0 };
  const fail = evaluateIntentAssertions(
    [{ type: 'exit_code_eq', value: 0 }], process.cwd(), [shellRow('npm test', 'x\n[exit 1]\n', 'error')],
  );
  const v = canComplete(base, report, fail);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.includes('契约断言未通过') && r.includes('A1')), v.reasons.join(';'));
  assert.ok(v.reasons.some((r) => r.includes('npm test')), '拒绝文案应回显最后一次 shell 命令');
  const ok = canComplete(base, report, evaluateIntentAssertions([], process.cwd(), []));
  assert.equal(ok.ok, true, ok.reasons.join(';'));
});

test('账本落库:assertions 往返(含清空)', () => {
  const convId = 'conv-intent-assert';
  const it = store.createIntent({
    convId, title: '出报告', contract: 'report.md 存在且含完成标记',
    assertions: [{ type: 'file_exists', path: 'report.md' }],
  });
  const fresh = store.getIntent(it.id)!;
  assert.equal(fresh.assertions.length, 1);
  assert.equal((fresh.assertions[0] as { path?: string }).path, 'report.md');
  assert.ok(formatIntent(fresh, []).includes('断言: 1 条'));
  store.updateIntent(it.id, { assertions: [] });
  assert.equal(store.getIntent(it.id)!.assertions.length, 0);
});

test('evaluateAcceptance:真实 shell 的 [exit 0] 也能过 V5 验收(修前只认 [exit:0])', () => {
  const r = evaluateAcceptance(
    { assertions: [{ type: 'exit_code_eq', value: 0 }] },
    process.cwd(),
    { lastOutput: 'ok\n[exit 0]\n' } as unknown as BodyPlanResult,
  );
  assert.equal(r.pass, true);
});

run();
