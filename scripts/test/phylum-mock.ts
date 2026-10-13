// phylum-mock.ts — 确定性 ChatFn 脚本(测试专用):按脚本顺序返回 tool_call 或 final 文本。

import type { ChatMsg } from '../../src/shared/types';
import type { Completion, ToolCall } from '../../src/main/glm';

export type MockTurn =
  | { toolName: string; args: Record<string, unknown> }
  | { content: string };

let seq = 0;

/** 生成按顺序消费脚本的 ChatFn;脚本耗尽后返回 done('script exhausted')。 */
export function scriptChat(script: MockTurn[]): (messages: ChatMsg[], toolDefs: unknown[]) => Promise<Completion> {
  let i = 0;
  return async () => {
    const turn = script[i++];
    if (!turn) return done('script exhausted');
    if ('content' in turn) return done(turn.content);
    const call: ToolCall = { id: `mock-${++seq}`, name: turn.toolName, arguments: JSON.stringify(turn.args) };
    return {
      content: '',
      toolCalls: [call],
      rawAssistant: {
        role: 'assistant', content: '',
        tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }],
      },
      tokensIn: 100, tokensOut: 20,
    };
  };
}

function done(text: string): Completion {
  return { content: text, toolCalls: [], rawAssistant: { role: 'assistant', content: text }, tokensIn: 50, tokensOut: 10 };
}
