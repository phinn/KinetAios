// P1 烟囱:DedupeGuard + relayResumePrompt 离线单元验证
// 从编译产物直接 require,构造最小 ToolCtx 跑场景
process.env.KINET_SMOKE = '1';
const { execToolForSmoke } = (() => {
  // AgentLoop.ts 没导出 execute —— 用正则烟囱不可靠,这里走编译后 dist 模块内部不可达。
  // 改为集成式:mock provider + runAgentLoop 全链路,让模型连续 4 次调同一命令,观察第 4 次被拦。
  return {};
})();
import { runAgentLoop } from './dist/main/AgentLoop.js';
// getSettings 在烟囱里走真 settings.json 的 maxTurns —— 用户天花板从文件读,先探明当前值
import { getSettings } from './dist/main/settings.js';

let pass = 0, fail = 0;
const chk = (name, ok, extra='') => { ok ? pass++ : fail++; console.log((ok?'✓':'✗')+' '+name+(extra?' | '+extra:'')); };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ── 场景 1:DedupeGuard ──
  // mock provider:返回预设的 tool_calls 序列,第 5 轮返回文本结束
  const scripted = [
    { toolCalls: [{ id: 'c1', name: 'shell', arguments: JSON.stringify({ command: 'ls /nowhere' }) }] },
    { toolCalls: [{ id: 'c2', name: 'shell', arguments: JSON.stringify({ command: 'ls /nowhere' }) }] },
    { toolCalls: [{ id: 'c3', name: 'shell', arguments: JSON.stringify({ command: 'ls /nowhere' }) }] },
    { toolCalls: [{ id: 'c4', name: 'shell', arguments: JSON.stringify({ command: 'ls /nowhere' }) }] },
    { toolCalls: [{ id: 'c5', name: 'shell', arguments: JSON.stringify({ command: 'ls /nowhere' }) }] },
    { text: 'done' },
  ];
  let round = 0;
  const toolResults = [];
  const mockProvider = {
    async streamComplete(messages, tools, snap, signal, onToken) {
      const script = scripted[Math.min(round++, scripted.length - 1)];
      const toolCalls = script.toolCalls || [];
      for (const tc of toolCalls) onToken('');
      return {
        content: script.text || '',
        toolCalls,
        tokensIn: 10, tokensOut: 10,
        rawAssistant: { role: 'assistant', content: script.text || null, tool_calls: toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) },
      };
    },
  };
  const fakeShell = {
    name: 'shell', description: 'shell',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    async run(args) { const r = `RESULT:${args.command}`; toolResults.push(r); return r; },
  };
  const events = [];
  const messages = [{ role: 'user', content: 'test loop' }];
  const out = await runAgentLoop({
    provider: mockProvider,
    tools: [fakeShell],
    systemPrompt: 'test',
    messages,
    snapshot: { apiProtocol: 'openai', model: 'mock', baseURL: '', apiKey: '' },
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    ctx: { cwd: '/tmp', confirm: async () => true, prompt: 'test', signal: new AbortController().signal, convId: undefined },
    history: [],
    userInput: '',
    maxTurns: 10,
  });
  // 预期:第 4 次同参 shell 不再真执行 → toolResults 里同一命令最多 3 条真实执行(第4次起被拦)
  const realRuns = toolResults.filter(r => r === 'RESULT:ls /nowhere').length;
  chk('DedupeGuard: 同参 shell 真执行 ≤3 次(第4次拦截)', realRuns <= 3, `实际真执行 ${realRuns} 次,共 ${toolResults.length} 条结果`);
  const dupeNotice = out.some(m => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('完全相同'));
  chk('DedupeGuard: 拦截消息含上次结果回贴+升级指令', dupeNotice, '检查词:完全相同/上次执行结果/不要重复/换');

  // ── 场景 2:relay 接力(子进程跑,用 KINET_SMOKE_MAXTURNS 把用户天花板压到 5)──
  // 主进程 settings 可能已被 require 缓存,所以接力验证放独立子进程最干净。
  {
    const { execSync } = await import('node:child_process');
    let out = '';
    try {
      out = execSync('KINET_SMOKE_MAXTURNS=5 node .chimney-p1-relay.mjs', { encoding: 'utf8', cwd: process.cwd(), timeout: 60_000 });
    } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
    const relayOk = /RELAY_GREEN/.test(out);
    chk('relay: 天花板耗尽 → 自动接力(+30轮) → wrapUp', relayOk, out.trim().split('\n').slice(-3).join(' | '));
  }

  // ── 场景 3:内部路线上限(opts.maxTurns < userMax)不接力 ──
  // mock 永不完成 → cap=2 耗尽后必须走 wrapUp 收尾而非 relay 扩容(路由预算不破坏)
  {
    let innerRound = 0;
    const mk = () => ({ role: 'assistant', content: 'x', tool_calls: [] });
    const innerProvider = {
      async streamComplete(messages) {
        innerRound++;
        const tcs = [{ id: 'i' + innerRound, name: 'shell', arguments: '{"command":"echo x"}' }];
        return { content: 'x', toolCalls: tcs, rawAssistant: { role: 'assistant', content: 'x', tool_calls: tcs.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) }, tokensIn: 10, tokensOut: 5 };
      },
    };
    const fakeShell2 = { name: 'shell', description: 'f', parameters: { type: 'object', properties: { command: { type: 'string' } } }, run: async () => 'OK' };
    const innerEvents = [];
    await runAgentLoop({
      provider: innerProvider, tools: [fakeShell2], systemPrompt: 't',
      messages: [{ role: 'user', content: 'x' }], history: [], userInput: 'x',
      snapshot: { apiProtocol: 'openai', model: 'mock', baseURL: '', apiKey: '' },
      signal: new AbortController().signal,
      onEvent: (e) => innerEvents.push(e),
      ctx: { cwd: '/tmp', confirm: async () => true, prompt: 't', signal: new AbortController().signal },
      maxTurns: 2,
    });
    const relayed = innerEvents.some((e) => e.type === 'status' && String(e.text || '').includes('接力'));
    chk('内部上限: 不接力(2轮耗尽 → wrapUp 收尾,总调用 ≤3)', !relayed && innerRound <= 3, `调用 ${innerRound} 次,relay=${relayed}`);
  }

  console.log(`\n${fail === 0 ? 'SMOKE_ALL_GREEN' : 'SMOKE_FAIL'}: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('SMOKE_ERR:', e && e.stack || e); process.exit(2); });
