// relay 接力烟囱(子进程):KINET_SMOKE_MAXTURNS=5 由父进程注入。
// mock provider 每轮都回一个 tool_call(模拟长任务),wrapUp 时打 RELAY 标记。
// 预期:i=0..4 正常跑(5轮),第5轮后触发 relay → status 事件 → +30 轮继续跑到 mock 让它完成(第 8 轮返回最终文本)→ wrapUp。
process.env.KINET_SMOKE = '1';
const { runAgentLoop } = await import('./dist/main/AgentLoop.js');

const mkProvider = () => ({
  async streamComplete(messages, tools, snap, signal, onToken) {
    const raw = (content, toolCalls) => ({ role: 'assistant', content, tool_calls: toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) });
    // 数 user 轮:第 8+ 轮(relay 后)让模型收尾
    const toolMsgs = messages.filter((m) => m.role === 'tool').length;
    const relayMsgs = messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[系统] 已达轮数上限')).length;
    if (toolMsgs >= 7 && relayMsgs > 0) {
      const content = '任务完成:全部步骤已执行。';
      return { content, toolCalls: [], rawAssistant: raw(content, []), tokensIn: 10, tokensOut: 5 };
    }
    const content = relayMsgs > 0 ? `relay 后继续第 ${toolMsgs + 1} 步` : `step ${toolMsgs + 1}`;
    const tcs = [{ id: 'c' + toolMsgs, name: 'shell', arguments: JSON.stringify({ command: 'echo step' + (toolMsgs + 1) }) }];
    return { content, toolCalls: tcs, rawAssistant: raw(content, tcs), tokensIn: 10, tokensOut: 5 };
  },
});

const fakeShell = {
  name: 'shell', description: 'fake',
  parameters: { type: 'object', properties: { command: { type: 'string' } } },
  run: async (args) => `OK:${args.command}`,
};

const events = [];
const out = await runAgentLoop({
  provider: mkProvider(),
  tools: [fakeShell],
  systemPrompt: 't',
  messages: [{ role: 'user', content: '长任务' }],
  history: [],
  userInput: '长任务',
  snapshot: { apiProtocol: 'openai', model: 'mock', baseURL: '', apiKey: '' },
  signal: new AbortController().signal,
  onEvent: (e) => events.push(e),
  ctx: { cwd: '/tmp', confirm: async () => true, prompt: 'relay-smoke', signal: new AbortController().signal, engine: undefined, convId: undefined },
  maxTurns: undefined,
});

const relayStatus = events.find((e) => e.type === 'status' && String(e.text || '').includes('接力'));
// runAgentLoop 返回 dropTransient(messages) 数组 → 最终文本 = 最后一条 assistant 的 content
const msgs = Array.isArray(out) ? out : [];
const lastAssistant = [...msgs].reverse().find((m) => m && m.role === 'assistant');
const answer = (lastAssistant && (typeof lastAssistant.content === 'string' ? lastAssistant.content : '')) || (typeof out === 'string' ? out : '');
console.log(`relayStatus=${relayStatus ? 'YES' : 'NO'}`);
console.log(`finalContains=${answer.includes('任务完成') ? 'YES' : 'NO'} (answer=${JSON.stringify(answer).slice(0, 80)})`);
if (relayStatus && answer.includes('任务完成')) {
  console.log('RELAY_GREEN: 接力触发 + 任务最终完成');
} else {
  console.log('RELAY_RED: ' + JSON.stringify({ relayStatus: relayStatus && relayStatus.text, events: events.map((e) => e.type) }));
  process.exit(1);
}
