// 轨迹录/放:哈希归一化、重放命中与路径重定向、未命中严格报错。
// 这些是"离线回归可信度"的地基:归一化漏一处 → 永远 miss;不重定向 → 通过但文件写到旧目录。
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { requestHash, withTrace } from '../../src/main/trace';
import type { Completion, Provider, ToolDef } from '../../src/main/glm';

const snap = { model: 'm1', baseURL: 'http://x', apiKey: 'k', apiProtocol: 'openai' } as never;
const msgs = [{ role: 'system', content: 'cwd=/var/folders/aa/bb/T/kinet-eval-1/work at 2026-11-25T07:54:41.503Z' }, { role: 'user', content: 'hi' }] as never;
const tools: ToolDef[] = [{ type: 'function', function: { name: 'write_file', description: 'w', parameters: {} } }];

function completion(partial: Partial<Completion> = {}): Completion {
  return {
    content: '', toolCalls: [], rawAssistant: { role: 'assistant', content: '' } as never,
    tokensIn: 1, tokensOut: 1, ...partial,
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));

test('哈希忽略临时目录与时间戳,但保留模型/工具差异', () => {
  const h1 = requestHash('m1', msgs, tools);
  const msgs2 = JSON.parse(JSON.stringify(msgs));
  msgs2[0].content = 'cwd=/var/folders/cc/dd/T/kinet-eval-9/work at 2026-11-25T09:01:02.001Z';
  assert.equal(requestHash('m1', msgs2 as never, tools), h1, '临时路径/时刻不应改变哈希');
  assert.notEqual(requestHash('m2', msgs, tools), h1, '换模型必须 miss');
  assert.notEqual(requestHash('m1', msgs, []), h1, '工具表变化必须 miss');
});

test('录制后重放命中,并把工具参数路径重定向到新目录', async () => {
  const dir = tmp();
  const trace = path.join(dir, 't.jsonl');
  const oldRoot = '/var/folders/aa/bb/T/kinet-eval-1';
  process.env.KINET_TRACE_FILE = trace;
  process.env.KINET_TRACE_ROOT = oldRoot;
  const rec = completion({
    toolCalls: [{ id: '1', name: 'write_file', arguments: `{"path":"${oldRoot}/work/a.txt","content":"x"}` }],
    rawAssistant: { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'write_file', arguments: `{"path":"${oldRoot}/work/a.txt"}` } }] } as never,
  });
  const inner: Provider = { streamComplete: async () => rec };
  await withTrace(inner).streamComplete(msgs as never, tools, snap, new AbortController().signal, () => {});
  assert.ok(fs.existsSync(trace), '轨迹应落盘');

  delete process.env.KINET_TRACE_FILE;
  delete process.env.KINET_TRACE_ROOT;
  const newRoot = '/var/folders/zz/yy/T/kinet-eval-7';
  process.env.KINET_REPLAY_FILE = trace;
  process.env.KINET_REPLAY_ROOT = newRoot;
  let tokens = '';
  const out = await withTrace({ streamComplete: async () => { throw new Error('不应联网'); } })
    .streamComplete(msgs as never, tools, snap, new AbortController().signal, (t) => { tokens += t; });
  assert.ok(out.toolCalls[0].arguments.includes(newRoot), '工具参数必须指向新根目录');
  assert.ok(!JSON.stringify(out).includes(oldRoot), '不应残留旧路径');
  assert.equal(out.tokensIn, 1, 'usage 原样保留');
});

test('未命中时默认抛错(不许偷偷联网)', async () => {
  const dir = tmp();
  const trace = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(trace, '');
  process.env.KINET_REPLAY_FILE = trace;
  let threw = false;
  try {
    await withTrace({ streamComplete: async () => { throw new Error('不应联网'); } })
      .streamComplete(msgs as never, tools, snap, new AbortController().signal, () => {});
  } catch (e) {
    threw = /重放未命中/.test(String(e));
  }
  assert.ok(threw, '应抛出可读的未命中错误');
});

run();
