// Intent 账本 + 完成证据闸(2026-11):
// A) 证据只从事件流计算,模型自述不算;B) 最后一次通过之后的失败会让完成失败;
// C) 没改文件的问答用"助手答复"作为可核验产出;D) 账本落库 + 成本归集。
import { assert, test, run } from './harness';
import * as store from '../../src/main/store';
import {
  assessEvidence, canComplete, recordEvidence, refreshIntentSpend, formatIntent,
} from '../../src/main/intent-ledger';
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

run();
