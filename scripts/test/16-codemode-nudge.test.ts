// 回归:codemode 引导(2026-11)。实测 codemode 只占 1.5% 的工具调用、shell 占 68.5%，
// 而每轮平均 50.3 次往返 —— 不是工具缺失，是模型默认逐条发 tool_calls。
// 本文件锁四件事：
//   1) 一轮内「探查」累计 3 次仍未用 codemode → 注入第 1 条引导；累计 6 次 → 第 2 条，封顶 2 条；
//   2) shell 只读命令(ls/grep/git status)算探查 —— shell 是最大头，不判它这套引导等于不生效；
//   3) shell 写命令(rm/mv/重定向)不算探查，不该被催着塞进脚本；
//   4) 开关关闭、或本轮已经用过 codemode → 一条都不注入。
import { assert, test, run } from './harness';
import { runAgentLoop } from '../../src/main/AgentLoop';
import type { ConfigSnapshot } from '../../src/shared/types';
import type { Provider, Completion } from '../../src/main/glm';
import type { Tool, ToolCtx } from '../../src/main/tools';

const snap = { apiProtocol: 'openai', model: 'test-model', apiKey: 'k', baseURL: 'http://localhost' } as unknown as ConfigSnapshot;
const noopCtx = { cwd: process.cwd(), confirm: async () => true } as unknown as ToolCtx;

const NUDGE_MARK = '[系统] 本轮已';

type Mode = 'read_file' | 'shell_ls' | 'shell_rm' | 'codemode';

/** 每步只发一个调用；mode 决定调什么。 */
async function runSteps(opts: {
  mode: Mode;
  nudge?: boolean;
  steps?: number;
  switchToCodemodeAt?: number;
}): Promise<string[][]> {
  const steps = opts.steps ?? 8;
  const seen: string[][] = [];
  let n = 0;
  const provider: Provider = {
    async streamComplete(messages): Promise<Completion> {
      seen.push(messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))));
      n++;
      if (n > steps) {
        return { content: 'done', toolCalls: [], tokensIn: 0, tokensOut: 0, rawAssistant: { role: 'assistant', content: 'done' } };
      }
      const mode: Mode = opts.switchToCodemodeAt != null && n >= opts.switchToCodemodeAt ? 'codemode' : opts.mode;
      const id = `c${n}`;
      const call =
        mode === 'codemode' ? { name: 'codemode', arguments: JSON.stringify({ code: 'return 1' }) }
          : mode === 'shell_ls' ? { name: 'shell', arguments: JSON.stringify({ command: `ls -la /tmp/dir${n}` }) }
            : mode === 'shell_rm' ? { name: 'shell', arguments: JSON.stringify({ command: `rm -rf /tmp/dir${n}` }) }
              : { name: 'read_file', arguments: JSON.stringify({ path: `/tmp/f${n}.txt` }) };
      return {
        content: '',
        toolCalls: [{ id, name: call.name, arguments: call.arguments }],
        tokensIn: 0,
        tokensOut: 0,
        rawAssistant: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: call }] },
      };
    },
  };
  const readFile: Tool = {
    name: 'read_file', description: 'fake', parameters: { type: 'object', properties: {} },
    readOnly: true, async run() { return 'file body'; },
  };
  // shell 故意不标 readOnly —— 与线上定义一致(它确实能写),引导的判定必须自己看命令。
  const shell: Tool = {
    name: 'shell', description: 'fake', parameters: { type: 'object', properties: {} },
    async run() { return 'shell output'; },
  };
  const cm: Tool = {
    name: 'codemode', description: 'fake', parameters: { type: 'object', properties: {} },
    readOnly: true, async run() { return 'script output'; },
  };
  await runAgentLoop({
    provider, tools: [readFile, shell, cm], systemPrompt: 'sys', snapshot: snap, userInput: 'go',
    history: [], ctx: noopCtx, signal: new AbortController().signal, maxTurns: 30,
    policy: {
      trimBudget: 1_000_000, interStepCompactBudget: 1_000_000, truncateThreshold: 1_000_000,
      appendStepSummary: false, stepSummaryMaxChars: 0, stepResultMaxChars: 0, subAgentScope: 'none',
      codemodeNudge: opts.nudge,
    },
    onEvent: () => {},
  });
  return seen;
}

function countNudges(seen: string[][]): number {
  const last = seen[seen.length - 1] ?? [];
  return last.filter((m) => m.includes(NUDGE_MARK)).length;
}

test('只读工具累计 3 次 → 注入第 1 条 codemode 引导', async () => {
  const seen = await runSteps({ mode: 'read_file', steps: 3 });
  // 第 3 次调用执行完才注入 → 第 4 次请求(下标 3)才看得到。
  assert.equal(countNudges(seen), 1, `3 次只读后应有 1 条引导,实际 ${countNudges(seen)}`);
  const firstNudgeAt = seen.findIndex((msgs) => msgs.some((m) => m.includes(NUDGE_MARK)));
  assert.equal(firstNudgeAt, 3, `引导应出现在第 4 次请求(下标 3),实际 ${firstNudgeAt}`);
});

test('累计 6 次 → 第 2 条更强硬的引导,总数封顶 2 条', async () => {
  const seen = await runSteps({ mode: 'read_file', steps: 10 });
  assert.equal(countNudges(seen), 2, `10 次探查应恰好 2 条引导(封顶),实际 ${countNudges(seen)}`);
  const nudges = (seen[seen.length - 1] ?? []).filter((m) => m.includes(NUDGE_MARK));
  assert.ok(nudges.some((m) => m.includes('必须用 codemode')), '第 2 条应是强硬措辞');
  assert.ok(nudges.some((m) => m.includes('tools.read_file')), '第 1 条应给出可照抄的写法');
});

test('shell 只读命令(ls)算探查 → 引导会触发', async () => {
  const seen = await runSteps({ mode: 'shell_ls', steps: 4 });
  assert.equal(countNudges(seen), 1, `ls 这类只读命令应计入探查并触发引导,实际 ${countNudges(seen)}`);
});

test('shell 写命令(rm -rf)不算探查 → 不催着塞进脚本', async () => {
  const seen = await runSteps({ mode: 'shell_rm', steps: 10 });
  assert.equal(countNudges(seen), 0, `写命令不应触发引导,实际 ${countNudges(seen)}`);
});

test('开关关闭(codemodeNudge=false)→ 一条都不注入', async () => {
  const seen = await runSteps({ mode: 'read_file', steps: 10, nudge: false });
  assert.equal(countNudges(seen), 0, `开关关闭时不应有引导,实际 ${countNudges(seen)}`);
});

test('本轮已用过 codemode → 不再注入', async () => {
  const seen = await runSteps({ mode: 'read_file', steps: 10, switchToCodemodeAt: 2 });
  assert.equal(countNudges(seen), 0, `已经用过 codemode 时不应再引导,实际 ${countNudges(seen)}`);
});

run();
