// 后台 Job(M1)+ 断点续跑(M3)+ 受限并发(M4)回归测试。
// 覆盖:JobManager 生命周期/并发池/kill/resume、executeDAG checkpoint 恢复与并发上限。
import assert from 'node:assert/strict';
import { test, run } from './harness';
import { JobManager, initJobManager } from '../../src/main/JobManager';
import { executeDAG } from '../../src/main/V3/dag-executor';
import type { DAGPlan, DAGNode } from '../../src/main/V3/dag-planner';
import type { Provider, Completion, ConfigSnapshot, EngineContextPolicy, AgentEvent, ChatMsg } from '../shared/types';
import type { Tool, ToolCtx } from '../../src/main/tools';
import * as store from '../../src/main/store';

store.initStore();

const snap = { apiProtocol: 'openai', model: 'test-model', apiKey: 'k', baseURL: 'http://localhost' } as unknown as ConfigSnapshot;
const noopCtx = { cwd: process.cwd(), confirm: async () => true } as unknown as ToolCtx;
const POLICY: EngineContextPolicy = {
  trimBudget: 1000, interStepCompactBudget: 0, truncateThreshold: 100,
  appendStepSummary: false, stepSummaryMaxChars: 0, stepResultMaxChars: 4000, subAgentScope: 'none',
};
const dummyTool: Tool = {
  name: 'dummy_read', description: '测试只读工具',
  parameters: { type: 'object', properties: {} }, readOnly: true, run: async () => 'ok',
};
const EMPTY_TOOLS: Tool[] = [];
function textComp(text: string): Completion {
  return { content: text, toolCalls: [], tokensIn: 0, tokensOut: 0, rawAssistant: { role: 'assistant', content: text } as ChatMsg };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeManager(): { jm: JobManager; events: Array<{ convId: string; jobId: string; ev: Record<string, unknown> }> } {
  const events: Array<{ convId: string; jobId: string; ev: Record<string, unknown> }> = [];
  const jm = new JobManager({
    emitJob: () => {},
    emitJobEvent: (convId, _turnId, jobId, ev) => events.push({ convId, jobId, ev }),
  });
  return { jm, events };
}

// ── M1: 生命周期 ──

test('JobManager:submit → running → done,result 落库', async () => {
  const { jm } = makeManager();
  const r = jm.submit({
    convId: 'c1', turnId: null, kind: 'v3-deep', title: '测试任务', payload: {},
    worker: async () => ({ result: { answer: '完成' } }),
  });
  assert.ok(r.ok);
  await sleep(50);
  const info = jm.get(r.id)!;
  assert.equal(info.status, 'done');
  assert.equal(store.getJob(r.id)!.result, JSON.stringify({ answer: '完成' }));
});

test('JobManager:worker 抛错 → failed,error 落库', async () => {
  const { jm } = makeManager();
  const r = jm.submit({
    convId: 'c1', turnId: null, kind: 'v3-deep', title: '失败任务', payload: {},
    worker: async () => { throw new Error('boom'); },
  });
  assert.ok(r.ok);
  await sleep(50);
  assert.equal(jm.get(r.id)!.status, 'failed');
  assert.match(jm.get(r.id)!.error!, /boom/);
});

test('JobManager:queued 状态 kill → 直接 killed,worker 不再执行', async () => {
  // 占满 worker 池(并发 2)→ 第 3 个留在 queued → kill 它
  const { jm } = makeManager();
  const release: Array<() => void> = [];
  const gate = () => new Promise<void>((res) => release.push(res));
  for (let i = 0; i < 2; i++) {
    jm.submit({ convId: 'c', turnId: null, kind: 'v3-deep', title: `占位${i}`, payload: {}, worker: async () => { await gate(); return { result: null }; } });
  }
  const r3 = jm.submit({ convId: 'c', turnId: null, kind: 'v3-deep', title: '排队者', payload: {}, worker: async () => ({ result: 1 }) });
  assert.ok(r3.ok);
  assert.equal(jm.get(r3.id)!.status, 'queued');
  jm.kill(r3.id, '测试取消');
  assert.equal(jm.get(r3.id)!.status, 'killed');
  for (const fn of release) fn(); // 放行占位任务
  await sleep(30);
  assert.equal(jm.get(r3.id)!.status, 'killed', '已 kill 的 job 不应被执行');
});

test('JobManager:worker 池并发上限 = 2', async () => {
  let concurrent = 0, peak = 0;
  const jm = new JobManager({ emitJob: () => {}, emitJobEvent: () => {} });
  const subs = [];
  for (let i = 0; i < 5; i++) {
    subs.push(jm.submit({
      convId: 'c', turnId: null, kind: 'v3-deep', title: `t${i}`, payload: {},
      worker: async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await sleep(30);
        concurrent--;
        return { result: null };
      },
    }));
  }
  await sleep(250);
  assert.ok(peak <= 2, `并发峰值 ${peak} 应 ≤ 2`);
});

test('JobManager:cost 事件累计到 JobInfo', async () => {
  const { jm } = makeManager();
  const r = jm.submit({
    convId: 'c', turnId: null, kind: 'v3-deep', title: '计费', payload: {},
    worker: async ({ onEvent }) => {
      onEvent({ type: 'cost', usd: 0.01 });
      onEvent({ type: 'cost', usd: 0.02 });
      return { result: null };
    },
  });
  await sleep(50);
  assert.equal(jm.get(r.id)!.costUSD >= 0.03 - 1e-9, true);
});

// ── M3: checkpoint 断点续跑 ──

function mkNode(id: string, deps: string[] = []): DAGNode {
  return { id, title: `步骤${id}`, action: `做${id}`, tools: ['dummy_read'], parallelizable: false, deps, status: 'pending', retryCount: 0 };
}
function textProvider(): { provider: Provider; calls: string[] } {
  const calls: string[] = [];
  const provider: Provider = {
    async streamComplete(_m, _d, _s, _sig): Promise<Completion> {
      calls.push('x');
      return textComp(`done-${calls.length}`);
    },
  };
  return { provider, calls };
}

test('executeDAG:节点完成触发 onCheckpoint,含 completed 集与 history', async () => {
  const { provider } = textProvider();
  const plan: DAGPlan = { goal: 'g', nodes: [mkNode('a'), mkNode('b', ['a'])], summary: 's' };
  const checkpoints: unknown[] = [];
  const r = await executeDAG({
    plan, provider, tools: [dummyTool], systemPrompt: 'sys', snapshot: snap, ctx: noopCtx,
    signal: new AbortController().signal, policy: POLICY, history: [],
    onEvent: () => {},
    onCheckpoint: (cp) => checkpoints.push(JSON.parse(JSON.stringify(cp))),
  });
  assert.equal(r.completedNodeIds.size, 2);
  assert.ok(checkpoints.length >= 2, '每个节点完成都应存档');
  const last = checkpoints[checkpoints.length - 1] as { completedNodeIds: string[]; history: ChatMsg[] };
  assert.deepEqual(last.completedNodeIds.sort(), ['a', 'b']);
  assert.ok(last.history.length > 0);
});

test('executeDAG:initialCheckpoint 恢复 → 跳过已完成节点,只跑剩余', async () => {
  const { provider, calls } = textProvider();
  const plan: DAGPlan = { goal: 'g', nodes: [mkNode('a'), mkNode('b', ['a']), mkNode('c', ['a'])], summary: 's' };
  const checkpoint = { completedNodeIds: ['a'], history: [{ role: 'user', content: '✅ 步骤[a] 完成(断点存档)' } as ChatMsg] };
  const r = await executeDAG({
    plan, provider, tools: [dummyTool], systemPrompt: 'sys', snapshot: snap, ctx: noopCtx,
    signal: new AbortController().signal, policy: POLICY, history: [],
    onEvent: () => {},
    initialCheckpoint: checkpoint,
  });
  assert.equal(r.completedNodeIds.size, 3);
  // 'a' 已在断点中 → 不会再产生新的模型调用专门跑 a(b、c 各一次)
  assert.ok(calls.length >= 2, '至少执行 b/c 两个节点');
});

test('JobManager:kill(带 checkpoint)→ resume → 只跑剩余部分', async () => {
  const { jm, events } = makeManager();
  let started = 0;
  let releaseRun: (() => void) | null = null;
  const firstGate = new Promise<void>((res) => { releaseRun = res; });
  let sawCheckpoint: unknown;
  const r = jm.submit({
    convId: 'c', turnId: null, kind: 'v3-deep', title: '断点任务', payload: {},
    worker: async ({ signal, checkpointSink, initialCheckpoint, onEvent }) => {
      started++;
      if (started === 1) {
        // 第一段:产出一个 checkpoint 后挂起等 kill
        checkpointSink({ completedNodeIds: ['a'], history: [{ role: 'user', content: 'a 完成' }] });
        sawCheckpoint = initialCheckpoint;
        await firstGate;
        signal.aborted; // kill 后这里恢复,直接抛 abort 语义
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      // 第二段(resume):从 initialCheckpoint 继续
      const cp = initialCheckpoint as { completedNodeIds: string[] } | undefined;
      assert.ok(cp && cp.completedNodeIds.includes('a'), 'resume 时应拿到断点');
      onEvent({ type: 'status', text: '续跑完成' });
      return { result: { answer: '全部完成' }, checkpoint: cp };
    },
  });
  assert.ok(r.ok);
  await sleep(30);
  assert.equal(jm.get(r.id)!.status, 'running');
  jm.kill(r.id, '测试取消');
  releaseRun!();
  await sleep(30);
  assert.equal(jm.get(r.id)!.status, 'killed');
  // resume:checkpoint 已在 DB(kill 前已 sink)
  assert.ok(store.getJob(r.id)!.checkpoint, 'checkpoint 应已落库');
  const ok = jm.resume(r.id);
  assert.equal(ok, true);
  await sleep(50);
  assert.equal(jm.get(r.id)!.status, 'done');
  assert.equal(started, 2);
  assert.ok(store.getJob(r.id)!.result!.includes('全部完成'));
  assert.ok(events.some((e) => (e.ev as { text?: string }).text === '续跑完成'));
  void sawCheckpoint;
});

test('JobManager:resume 无 checkpoint 的 job → 拒绝', async () => {
  const { jm } = makeManager();
  const r = jm.submit({ convId: 'c', turnId: null, kind: 'v3-deep', title: '无断点', payload: {}, worker: async () => { throw new Error('x'); } });
  await sleep(30);
  assert.equal(jm.resume(r.ok ? r.id : ''), false);
});

// ── M4: 同层受限并发 ──

test('executeDAG:dagConcurrency 限制同层并行峰值', async () => {
  let cur = 0, peak = 0;
  const provider: Provider = {
    async streamComplete(): Promise<Completion> {
      cur++; peak = Math.max(peak, cur);
      await sleep(20);
      cur--;
      return textComp('ok');
    },
  };
  const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => mkNode(id));
  const plan: DAGPlan = { goal: 'g', nodes, summary: 's' };
  const r = await executeDAG({
    plan, provider, tools: [dummyTool], systemPrompt: 'sys', snapshot: snap, ctx: noopCtx,
    signal: new AbortController().signal, policy: { ...POLICY, dagConcurrency: 2 }, history: [],
    onEvent: () => {},
  });
  assert.equal(r.completedNodeIds.size, 5);
  assert.ok(peak <= 2, `并行峰值 ${peak} 应 ≤ dagConcurrency(2)`);
});

// ── M1 收尾: hydrate 孤儿 job ──

test('JobManager:hydrate 把遗留 running/queued 清理(v3-deep 无断点 → failed)', async () => {
  store.insertJob({
    id: 'orphan-1', convId: 'c', turnId: null, kind: 'v3-deep', status: 'running',
    title: '孤儿', payload: '{}', checkpoint: null, result: null, error: null,
    costUSD: 0, createdAt: Date.now(), updatedAt: Date.now(),
  });
  const jm = initJobManager({ emitJob: () => {}, emitJobEvent: () => {} });
  await sleep(10);
  assert.equal(jm.get('orphan-1')!.status, 'failed');
});

void run();
