// wait_for 条件等待(2026-11-19)
// 由来:近30天 shell 里「命令就是 sleep N」2287 次 / 40.1 小时,含 sleep 的脚本 6747 次 /
// 67.2 小时;sleep 175 这类还会直接撞上 120s 工具超时(近30天 680 次)。模型没有"等条件"
// 的原语,只能睡满固定时长。这里钉住各条件的判定与"命中带证据、超时带最后观察"的契约。
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { waitFor, probeOnce, formatWaitResult, type WaitSpec } from '../../src/main/wait-for';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-wait-'));
const base = (over: Partial<WaitSpec>): WaitSpec => ({
  kind: 'file_exists', target: '', timeoutMs: 3000, pollMs: 150, ...over,
});

test('port_open:服务起来就命中,且带回端口握手证据', async () => {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  try {
    const r = await waitFor(base({ kind: 'port_open', target: `127.0.0.1:${port}` }));
    assert(r.ok, `应命中,实际 ${r.detail}`);
    assert(r.detail.includes('可连接'), `应带回握手证据,实际 ${r.detail}`);
  } finally { srv.close(); }
});

test('port_open:端口没监听 → 超时且说明原因(不是空话)', async () => {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  srv.close();
  await new Promise((r) => setTimeout(r, 100));
  const r = await waitFor(base({ kind: 'port_open', target: `127.0.0.1:${port}`, timeoutMs: 600, pollMs: 100 }));
  assert(!r.ok && r.reason === 'timeout');
  assert(/拒绝|超时/.test(r.detail), `应说明连接状态,实际 ${r.detail}`);
  assert(r.polls >= 2, `应轮询多次,实际 ${r.polls}`);
});

test('log_match:文件后写到也能等到,命中回吐命中行', async () => {
  const log = path.join(dir, 'build.log');
  fs.writeFileSync(log, 'compiling...\n');
  setTimeout(() => fs.appendFileSync(log, 'BUILD SUCCEEDED\n'), 250);
  const r = await waitFor(base({ kind: 'log_match', target: log, pattern: 'BUILD SUCCEEDED' }));
  assert(r.ok, `应命中,实际 ${r.detail}`);
  assert(r.detail.includes('BUILD SUCCEEDED'), `应带回命中行(省一次 tail),实际 ${r.detail}`);
});

test('log_match:超时仍带回日志尾部(让模型能改判断)', async () => {
  const log = path.join(dir, 'stuck.log');
  fs.writeFileSync(log, 'line-a\nline-b\nerror: linker failed\n');
  const r = await waitFor(base({ kind: 'log_match', target: log, pattern: 'READY', timeoutMs: 500, pollMs: 120 }));
  assert(!r.ok && r.reason === 'timeout');
  assert((r.context ?? '').includes('linker failed'), `超时应带日志尾部,实际 ${r.context}`);
});

test('file_exists / file_absent:两个方向都对', async () => {
  const f = path.join(dir, 'out.bin');
  const miss = await waitFor(base({ kind: 'file_exists', target: f, timeoutMs: 300, pollMs: 100 }));
  assert(!miss.ok && miss.detail.includes('还不存在'), `应如实说不存在,实际 ${miss.detail}`);
  fs.writeFileSync(f, 'hello');
  const hit = await waitFor(base({ kind: 'file_exists', target: f }));
  assert(hit.ok && hit.detail.includes('5 字节'), `应带回大小,实际 ${hit.detail}`);
  fs.unlinkSync(f);
  const gone = await waitFor(base({ kind: 'file_absent', target: f }));
  assert(gone.ok, `删除后应命中,实际 ${gone.detail}`);
});

test('file_stable:写完后停止变化才命中(下载场景)', async () => {
  const f = path.join(dir, 'dl.part');
  fs.writeFileSync(f, 'a');
  const p = waitFor(base({ kind: 'file_stable', target: f, timeoutMs: 3000, pollMs: 150 }));
  await new Promise((r) => setTimeout(r, 120));
  fs.appendFileSync(f, 'bb'); // 模拟还在写入
  const r = await p;
  assert(r.ok, `最终应命中,实际 ${r.detail}`);
  assert(r.detail.includes('停止变化'), `应说明判据,实际 ${r.detail}`);
});

test('command_ok:注入执行器,失败转成功也能等到', async () => {
  let n = 0;
  const r = await waitFor(base({
    kind: 'command_ok', target: 'test -f /x',
    timeoutMs: 3000, pollMs: 100,
    runCommand: async () => ({ ok: ++n >= 3, out: 'not yet' }),
  }));
  assert(r.ok, `第 3 次应命中,实际 ${r.detail}`);
  assert(n === 3, `应恰好轮询 3 次,实际 ${n}`);
});

test('probeOnce:参数错误不抛异常,返回可读原因', async () => {
  const r = await probeOnce(base({ kind: 'port_open', target: '不是端口' }));
  assert(!r.hit && r.detail.includes('无法解析'), `应给可读原因,实际 ${r.detail}`);
  const bad = await waitFor(base({ kind: 'port_open', target: '' }));
  assert(!bad.ok && bad.reason === 'bad_spec', '空 target 应判 bad_spec');
});

test('formatWaitResult:命中/超时两种文案都给出可执行下一步', () => {
  const spec = base({ kind: 'log_match', target: '/tmp/a.log', pattern: 'OK' });
  const ok = formatWaitResult(spec, { ok: true, reason: 'hit', waitedMs: 1200, polls: 3, detail: '命中 1 行' });
  assert(ok.includes('✅') && ok.includes('条件达成') && ok.includes('1.2s'), ok);
  const to = formatWaitResult(spec, { ok: false, reason: 'timeout', waitedMs: 120000, polls: 60, detail: '还没匹配', context: 'tail...' });
  assert(to.includes('⏳') && to.includes('最后观察'), to);
  assert(to.includes('别再原样重试'), `应阻止无脑重试,实际 ${to}`);
});

run();
