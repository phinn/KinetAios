// 图片模态 400 自愈链路钉板测试(2026-11-09 阿里 TokenPlan glm-5.3 事故):
// ①图片模态 400 → 剥图换占位 → 重试一次成功;②已实锤纯文本模型后,后续截图只走文字回执,
// 不再进 image_url(防连环 400 死循环);③回执文本告知模型图片已落盘可 read_file。
// Img-modality 400 self-heal: strip images → retry once; after that, screenshots
// return text receipts only (no image_url parts) for the rest of the turn.
import { strict as assert } from 'node:assert';
import { runAgentLoop, isImageModalityError } from '../../src/main/AgentLoop';
import { GLMError } from '../../src/main/glm';
import type { Tool, ToolCtx } from '../../src/main/tools';
import type { ChatMsg, ConfigSnapshot } from '../../src/shared/types';
import type { Completion, Provider } from '../../src/main/glm';
import { run, test } from './harness';

const snap = {
  apiProtocol: 'openai', model: 'test-model', apiKey: 'k', baseURL: 'http://localhost',
} as unknown as ConfigSnapshot;
const noopCtx = { cwd: process.cwd(), confirm: async () => true } as unknown as ToolCtx;

// 拦截 provider 收到的 messages。script:每次调用一个行为(fail=抛 GLMError 图片模态 400 / ok=返回 Completion)
function mkProvider(script: ({ fail: 'img400' } | { ok: Completion })[], seen: ChatMsg[][]): Provider {
  let call = 0;
  return {
    async streamComplete(messages: ChatMsg[]): Promise<Completion> {
      const step = script[Math.min(call, script.length - 1)];
      call++;
      seen.push(structuredClone(messages) as ChatMsg[]);
      if ('fail' in step) throw new GLMError('http', 400, 'The current model only supports text modality and does not support image input');
      return step.ok;
    },
  };
}

const PLAIN_OK: Completion = { content: 'done', toolCalls: [], tokensIn: 0, tokensOut: 0, rawAssistant: { role: 'assistant', content: 'done' } };

// ── ① 剥图重试一次 ────────────────────────────────────────────
test('行为:图片模态 400 → 剥图重试一次成功,status 提示降级', async () => {
  const seen: ChatMsg[][] = [];
  const provider = mkProvider([{ fail: 'img400' }, { ok: PLAIN_OK }], seen);
  const img: ChatMsg = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo' } }, { type: 'text', text: '看图' }] };
  const events: { type: string; text?: string }[] = [];
  await runAgentLoop({
    provider, tools: [], systemPrompt: 'sys', snapshot: snap,
    userInput: '看图', history: [img], ctx: noopCtx, signal: new AbortController().signal,
    policy: { trimBudget: 100000, interStepCompactBudget: 0, truncateThreshold: 100000, appendStepSummary: false, stepSummaryMaxChars: 0, stepResultMaxChars: 0, subAgentScope: 'none' },
    onEvent: (e) => events.push(e as never),
  });
  assert.equal(seen.length, 2, `剥图后应重试一次(共 2 次调用,实际 ${seen.length})`);
  const retryMsg = seen[1].findLast((m) => m.role === 'user' && Array.isArray(m.content));
  assert.ok(retryMsg, '重试请求里应有 user 消息');
  const parts = retryMsg!.content as { type: string; text?: string }[];
  assert.ok(parts.every((p) => p.type !== 'image_url'), '重试请求里不应再有 image_url');
  assert.ok(parts.some((p) => p.type === 'text' && p.text?.includes('图片已移除')), '剥图后应有占位文本');
  assert.ok(events.some((e) => e.type === 'status' && (e.text ?? '').includes('不支持图片输入')), '应有降级 status 提示');
  assert.ok(events.some((e) => e.type === 'done'), '回合应正常完成');
});

// ── ② textOnly 实锤后新截图只走文字回执 ────────────────────────
test('行为:textOnly 实锤后,新截图 tool 消息不带 image_url,回执说明图片未发送', async () => {
  const seen: ChatMsg[][] = [];
  // 序列:①首次带图(用户消息直接带图)→ 400 → 剥图重试 ②返 screenshot 调用 ③截完收文字回执 → done
  const shotCall = { id: 'sc1', name: 'screenshot', arguments: '{}' };
  const withShot: Completion = { content: '', toolCalls: [shotCall], tokensIn: 0, tokensOut: 0, rawAssistant: { role: 'assistant', content: '', tool_calls: [] } };
  const provider = mkProvider([{ fail: 'img400' }, { ok: withShot }, { ok: PLAIN_OK }], seen);
  const img: ChatMsg = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo' } }, { type: 'text', text: '看图后截图' }] };
  let fired = 0;
  const shotTool: Tool = {
    name: 'screenshot', description: 'take a screenshot', inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    async run(): Promise<string> {
      fired++;
      return '__IMAGE_BASE64__:iVBORw0KGgoAAAANSUhEUgAAAAE\nSAVE: /tmp/shot.png\nMD5: abc123';
    },
  };
  const events: { type: string; text?: string }[] = [];
  await runAgentLoop({
    provider, tools: [shotTool], systemPrompt: 'sys', snapshot: snap,
    userInput: '看图后截图', history: [img], ctx: noopCtx, signal: new AbortController().signal,
    policy: { trimBudget: 100000, interStepCompactBudget: 0, truncateThreshold: 100000, appendStepSummary: false, stepSummaryMaxChars: 0, stepResultMaxChars: 0, subAgentScope: 'none' },
    onEvent: (e) => events.push(e as never),
  });
  assert.ok(fired === 1, `截图工具应被调用 1 次(实际 ${fired})`);
  // 剥图后的每一次请求都不应再带 image_url
  const imgAfterStrip = seen.slice(1).some((msgs) => msgs.some((m) => Array.isArray(m.content) && (m.content as { type: string }[]).some((p) => p.type === 'image_url')));
  assert.ok(!imgAfterStrip, 'textOnly 实锤后所有请求都不应再出现 image_url');
  // ③ tool 回执含落盘说明文字
  const toolMsg = seen.at(-1)?.findLast((m) => m.role === 'tool');
  assert.ok(toolMsg, '最后一次请求应含 tool 回执消息');
  const content = typeof toolMsg!.content === 'string' ? toolMsg!.content : JSON.stringify(toolMsg!.content);
  assert.ok(String(content).includes('纯文本模态') && String(content).includes('read_file'), `回执应说明纯文本降级+read_file 路径(实际: ${String(content).slice(0, 80)})`);
  assert.ok(events.some((e) => e.type === 'done'), '回合应正常完成');
});

// ── ③ 判定函数单元 ────────────────────────────────────────────
test('单元:isImageModalityError 只认 400+模态措辞', () => {
  assert.ok(isImageModalityError(new GLMError('http', 400, 'The current model only supports text modality and does not support image input')));
  assert.ok(isImageModalityError(new GLMError('http', 400, '当前模型仅支持文本模态,不支持图片输入')));
  assert.ok(!isImageModalityError(new GLMError('http', 429, 'The current model only supports text modality')));
  assert.ok(!isImageModalityError(new GLMError('http', 400, 'totally unrelated')));
  assert.ok(!isImageModalityError(new Error('400 The current model only supports text modality')));
});

void run;
