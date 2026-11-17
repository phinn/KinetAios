// 回归:turn 内折叠必须「滞后 + 单调」,否则自动前缀缓存每步失效。
// 背景(2026-11 全库 token 审计,14,980 次调用 / 298 turn):
//   旧实现每步只多折一条 → 每步推一次折叠边界 → 22.7% 的调用落在「部分失效」桶,
//   单周 71M 输入 token 按全价重算(占全部未命中量 42%),前序上下文 p50=81K(正好压在 80K 触发线)。
// 本文件锁三件事:
//   1) 滞后:破线一次折到目标线以下,之后若干步视图字节不变、folded 报 0;
//   2) 单调:已折叠的消息永不还原成原文(包括写类工具的大参数);
//   3) 保窗:最近 keep 条工具结果在任何情况下都有原文。
import { assert, test, run } from './harness';
import { foldOldToolResults, newFoldCursor, estTokenCount, runAgentLoop } from '../../src/main/AgentLoop';
import type { ChatMsg, ConfigSnapshot } from '../../src/shared/types';
import type { Provider, Completion } from '../../src/main/glm';
import type { Tool, ToolCtx } from '../../src/main/tools';

const BIG = 'y'.repeat(2000); // 单条结果 ~2K 字符 ≈ 1.5K token
// 触发线 55K / 目标线 30K:目标线必须高于「保窗(keep=6)+ 摘要行」自身体积,否则永远折不到。
const TRIGGER = 55_000;
const TARGET = 30_000;

/** 一段 assistant(tool_calls) + tool 结果。body 为工具输出正文。 */
function pair(i: number, body = BIG, toolName = 'read_file', args?: string): ChatMsg[] {
  const id = `call_${i}`;
  const a = args ?? JSON.stringify({ path: `/tmp/f${i}.txt` });
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: toolName, arguments: a } }] },
    { role: 'tool', tool_call_id: id, content: body },
  ];
}

function mkHistory(n: number): ChatMsg[] {
  const out: ChatMsg[] = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < n; i++) out.push(...pair(i));
  return out;
}

const FOLD = { trigger: TRIGGER, target: TARGET };

// 端到端测试用的最小依赖(与 20-ctx-detect.test.ts 同款)
const snap = { apiProtocol: 'openai', model: 'test-model', apiKey: 'k', baseURL: 'http://localhost' } as unknown as ConfigSnapshot;
const noopCtx = { cwd: process.cwd(), confirm: async () => true } as unknown as ToolCtx;

test('滞后:破线一次折到目标线以下,不逐条推进', () => {
  const msgs = mkHistory(60);
  assert.ok(estTokenCount(msgs) > TRIGGER * 1.5, '构造的历史要足够大');
  const cursor = newFoldCursor();
  const r = foldOldToolResults(msgs, undefined, { ...FOLD, cursor });
  assert.ok(r.folded > 0, '破线必须折叠');
  const before = estTokenCount(msgs);
  const after = estTokenCount(r.view);
  // 计划阶段按「每条工具结果的省量」累加估算,saved 不含 assistant 批次摘要行回补的文本,
  // 所以视图口径会比目标线高一点(实测 <1%)。给 5% 容差,锁的是「一次折到位」而非精确值。
  assert.ok(after <= TARGET * 1.05, `一次折到目标线以下:${after} 应 <= ${TARGET}(原 ${before})`);
  // 不是只剩一条:确实批量折了
  assert.ok(r.folded > 5, `应成批折叠(实际 ${r.folded} 条)`);
});

test('滞后:折叠后继续长几步,视图逐字节不变且 folded 报 0', () => {
  const cursor = newFoldCursor();
  const msgs = mkHistory(60);
  const first = foldOldToolResults(msgs, undefined, { ...FOLD, cursor });
  const snapLen = msgs.length;
  // 追加 3 个小步(key 500 字符,远不够再破线)
  const grown = [...msgs];
  for (let i = 100; i < 103; i++) grown.push(...pair(i, 'z'.repeat(500)));
  const second = foldOldToolResults(grown, undefined, { ...FOLD, cursor });
  assert.equal(second.folded, 0, '未再破线 → 不得新增折叠(否则等于每步推一次边界)');
  // 前缀逐字节一致(缓存命中的前提)
  for (let k = 0; k < snapLen; k++) {
    assert.deepEqual(second.view[k], first.view[k], `第 ${k} 条消息在冻结期内被改写了`);
  }
  assert.equal(second.view.length, grown.length, '尾部新增消息照常带上');
});

test('单调:反复长大只前进不后退,已折叠的永不还原', () => {
  const cursor = newFoldCursor();
  let msgs = mkHistory(60);
  let prev = foldOldToolResults(msgs, undefined, { ...FOLD, cursor }).view;
  let folds = 0;
  for (let round = 0; round < 20; round++) {
    msgs = [...msgs, ...pair(200 + round)];
    const r = foldOldToolResults(msgs, undefined, { ...FOLD, cursor });
    folds += r.folded;
    // 上一轮已折叠的条目,内容必须原样保持折叠态
    for (let k = 0; k < prev.length; k++) {
      const wasFolded = typeof prev[k].content === 'string' && prev[k].content.startsWith('[已折叠');
      if (!wasFolded) continue;
      const now = typeof r.view[k].content === 'string' ? (r.view[k].content as string) : '';
      assert.ok(now.startsWith('[已折叠'), `第 ${k} 条折叠态被还原(回涨 = 反向改写前缀)`);
      assert.equal(now, prev[k].content, `第 ${k} 条折叠文本被改写`);
    }
    prev = r.view;
  }
  assert.ok(folds > 0, '持续长大应持续有过折叠');
});

test('保窗:最近 keep 条工具结果永远有原文', () => {
  const msgs = mkHistory(60);
  const r = foldOldToolResults(msgs, undefined, { ...FOLD, cursor: newFoldCursor(), keep: 6 });
  const toolMsgs = msgs.map((m, k) => ({ m, k })).filter((x) => x.m.role === 'tool');
  for (const { m, k } of toolMsgs.slice(-6)) {
    assert.deepEqual(r.view[k], m, '保窗内的工具结果不得被折叠');
  }
});

test('写类工具大参数:裁一次永久生效,不随窗口滑动回涨', () => {
  const bigArgs = JSON.stringify({ path: '/tmp/out.txt', content: 'w'.repeat(6000) });
  const msgs: ChatMsg[] = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 12; i++) msgs.push(...pair(i));
  // 一条带文本正文的 write_file 调用(不会被 assistantFullyFolded 整批折叠)
  const wid = 'call_write';
  const wIdx = msgs.length;
  msgs.push({
    role: 'assistant',
    content: '写入结果文件。',
    tool_calls: [{ id: wid, type: 'function', function: { name: 'write_file', arguments: bigArgs } }],
  });
  msgs.push({ role: 'tool', tool_call_id: wid, content: BIG });
  for (let i = 20; i < 46; i++) msgs.push(...pair(i));

  const cursor = newFoldCursor();
  const r1 = foldOldToolResults(msgs, undefined, { ...FOLD, cursor });
  const args1 = r1.view[wIdx].tool_calls?.[0].function.arguments ?? '';
  assert.ok(args1.length < 500, `大参数应被裁成摘要行(实际 ${args1.length} 字符)`);
  assert.equal(r1.view[wIdx].tool_calls?.[0].id, wid, 'tool_call_id 必须保留,否则协议非法');

  // 再长一步:参数不得回涨成原文
  const grown = [...msgs, ...pair(300)];
  const r2 = foldOldToolResults(grown, undefined, { ...FOLD, cursor });
  assert.equal(r2.view[wIdx].tool_calls?.[0].function.arguments, args1, '参数裁切必须单调');
});

test('无 cursor(跨 turn 预算路径):退化为无状态折叠,仍保 keep 条', () => {
  const msgs = mkHistory(60);
  const r = foldOldToolResults(msgs, undefined); // 默认 80K 触发,这里超了
  const toolMsgs = msgs.map((m, k) => ({ m, k })).filter((x) => x.m.role === 'tool');
  assert.equal(r.folded, toolMsgs.length - 6, '除最近 6 条外全折(旧行为)');
  for (const { m, k } of toolMsgs.slice(-6)) assert.deepEqual(r.view[k], m);
});

test('小上下文零感知:未破线不折叠、不产生差异', () => {
  const msgs = mkHistory(2);
  const r = foldOldToolResults(msgs, undefined, { ...FOLD, cursor: newFoldCursor() });
  assert.equal(r.folded, 0);
  assert.equal(r.view, msgs, '未破线应原样返回同一数组');
});

// ─────────────────────────────────────────────────────────────────────────────
// 开关回归:settings.foldHysteresisEnabled 关掉时 target 传 0,必须精确回到旧行为
// (可折区内全部折掉、边界随新消息前移)。这是现场出问题时的退路,不能悄悄失效。
// ─────────────────────────────────────────────────────────────────────────────
test('开关关闭(target=0)= 旧行为:可折区全折,folded 明显多于滞后模式', () => {
  const msgs = mkHistory(60);
  const on = foldOldToolResults(msgs, undefined, { trigger: TRIGGER, target: TARGET });
  const off = foldOldToolResults(msgs, undefined, { trigger: TRIGGER, target: 0 });
  const toolCount = msgs.filter((m) => m.role === 'tool').length;
  assert.equal(off.folded, toolCount - 6, `旧行为应为「除最近 keep 条外全部折叠」:${off.folded} vs ${toolCount - 6}`);
  assert.ok(off.folded > on.folded, `关掉滞后应折更多:off=${off.folded} on=${on.folded}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 端到端 A/B:同一段 ReAct 轨迹,只切 foldTargetTokens(0 = 旧「每步推一条边界」),
// 统计「相邻两次 API 调用之间前缀从第几条开始变」—— 前缀被改写 = 缓存从该点往后全废。
// ─────────────────────────────────────────────────────────────────────────────
async function runSteps(target: number): Promise<{ steps: number; rewrites: number }> {
  const seen: string[][] = [];
  let n = 0;
  const provider: Provider = {
    async streamComplete(messages): Promise<Completion> {
      seen.push(messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))));
      n++;
      const id = `c${n}`;
      const args = JSON.stringify({ command: `echo ${n}` });
      return {
        content: '',
        toolCalls: [{ id, name: 'shell', arguments: args }],
        tokensIn: 0,
        tokensOut: 0,
        rawAssistant: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'shell', arguments: args } }] },
      };
    },
  };
  const shell: Tool = {
    name: 'shell',
    description: 'fake',
    parameters: { type: 'object', properties: {} },
    readOnly: true,
    async run() { return 'o'.repeat(600); },
  };
  await runAgentLoop({
    provider, tools: [shell], systemPrompt: 'sys', snapshot: snap, userInput: 'go',
    history: [], ctx: noopCtx, signal: new AbortController().signal, maxTurns: 24,
    policy: {
      trimBudget: 200_000, interStepCompactBudget: 200_000, truncateThreshold: 1_000_000,
      appendStepSummary: false, stepSummaryMaxChars: 0, stepResultMaxChars: 0, subAgentScope: 'none',
      foldTriggerTokens: 6_000, foldTargetTokens: target,
    },
    onEvent: () => {},
  });
  let rewrites = 0;
  for (let i = 1; i < seen.length; i++) {
    const a = seen[i - 1];
    const b = seen[i];
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    if (k < a.length) rewrites++; // 不是纯追加 → 前缀中段被改写
  }
  return { steps: seen.length, rewrites };
}

test('A/B:滞后折叠把前缀改写次数压到旧实现的 1/N', async () => {
  const oldRun = await runSteps(0); // 旧行为:除保窗外全折,每步推一条边界
  const newRun = await runSteps(3_000); // 新行为:破线一次折到 3K,之后冻结
  assert.equal(oldRun.steps, newRun.steps, '两次跑同样步数才可比');
  assert.ok(oldRun.rewrites >= 6, `旧实现应几乎每步都改写(实际 ${oldRun.rewrites}/${oldRun.steps})`);
  assert.ok(
    newRun.rewrites * 2.5 <= oldRun.rewrites,
    `滞后折叠应显著减少改写:新 ${newRun.rewrites} vs 旧 ${oldRun.rewrites}(共 ${newRun.steps} 步)`,
  );
});

run();
