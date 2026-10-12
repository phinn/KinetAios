// V4 Recall — 断言失败时唤回 LLM(出场 #2..n)
//
// 最小故障现场(设计文档 §5.5):只注入「失败节点 + 断言失败详情 + plan 摘要」,
// 不带全量 execHistory —— LLM 不重新读几百步历史,只裁决"为什么没完成"。
// 单发 streamComplete(空 tools,与 supervisorComplete 同模式),输出为
// RecallPatch JSON(abort / 换 action / 换 script / 修断言)。
// Minimal fault site: failed node + assertion detail + plan summary only.

import type { ChatMsg, AgentEvent, ConfigSnapshot } from '../../shared/types';
import type { Provider } from '../glm';
import { isTransientError } from '../AgentLoop';
import type { LegisPlan, RecallPatch } from './plan';

const RECALL_SYSTEM = `你是 Kaios v4(Legis)引擎被唤回的立法者。你先前提交的计划图在执行中断言失败。
你只会收到最小故障现场(不是全部执行历史)。你的职责:给出最小修复补丁。

判定优先级:
1. 失败是环境性的(路径错/命令语法/文件未生成) → 修 newAction 或 newScript
2. 断言标准本身写错(过严/检查错文件) → newAsserts 修正断言
3. 确实不可修 → abort: true(必须给出充分理由)
4. 修复成本高于收益 → abort: true + 理由

必须只输出一个 JSON 对象(无其它文字):
{"abort": false, "nodeId": "s1", "reason": "一句话",
 "newAction": "新的节点执行指令(可选)",
 "newScript": [{"tool": "shell", "args": {"command": "..."}}](可选,仅只读工具+shell),
 "newAsserts": [{"type": "exitZero", "value": ""}](可选)}
`;

export interface RecallOpts {
  provider: Provider;
  snap: ConfigSnapshot;
  signal: AbortSignal;
  plan: LegisPlan;
  input: {
    trigger: string;
    nodeId?: string;
    nodeTitle?: string;
    failureDetail: string;
    planSummary: string;
    attempt: number;
  };
  onEvent: (e: AgentEvent) => void;
}

/**
 * 唤回立法者(429 退避内嵌:AgentLoop 的 isTransientError 判定 + 指数退避)。
 * 返回 RecallPatch;调用方(executor)按补丁更新节点后续跑。
 * 返回 null = 唤回失败(网络/模型),按"无补丁"处理。
 */
export async function recall(opts: RecallOpts): Promise<RecallPatch> {
  const { provider, snap, signal, plan, input, onEvent } = opts;

  const node = input.nodeId ? plan.nodes.find((n) => n.id === input.nodeId) : undefined;
  const faultSite = [
    `## 触发\n${input.trigger}(第 ${input.attempt} 次唤回)`,
    input.nodeId ? `## 失败节点\n[${input.nodeId}] ${node?.title ?? input.nodeTitle ?? ''}\naction: ${node?.action ?? '(未知)'}` : '',
    `## 断言失败详情\n${input.failureDetail}`,
    `## 计划摘要\n${input.planSummary}`,
    `## 全部节点状态\n${plan.nodes.map((n) => `[${n.id}] ${n.title}`).join('\n')}`,
    '\n给出最小修复补丁(只输出 JSON)。',
  ].filter(Boolean).join('\n\n');

  onEvent({ type: 'status', text: `⚖️ v4: 唤回立法者(${input.trigger},第 ${input.attempt} 次)` });

  const messages: ChatMsg[] = [
    { role: 'system', content: RECALL_SYSTEM },
    { role: 'user', content: faultSite },
  ];

  // 429/瞬态退避(60s/120s,最多 2 次重试;abort 立即返回)
  const delays = [60_000, 120_000];
  for (let attempt = 0; ; attempt++) {
    try {
      const comp = await provider.streamComplete(messages, [], snap, signal, () => {});
      const patch = parseRecallPatch(comp.content ?? '');
      if (patch) return patch;
      // JSON 解析失败 → 保守 abort(带原因)
      return { abort: true, reason: `唤回输出无法解析为补丁: ${(comp.content ?? '').slice(0, 150)}` };
    } catch (e) {
      if (signal.aborted) {
        return { abort: true, reason: '唤回被用户中止' };
      }
      if (isTransientError(e) && attempt < delays.length) {
        onEvent({ type: 'status', text: `⏸️ v4: 唤回遇限流,退避 ${Math.round(delays[attempt]! / 1000)}s 后重试` });
        await sleepAbortable(delays[attempt]!, signal);
        if (signal.aborted) return { abort: true, reason: '唤回退避期间被中止' };
        continue;
      }
      return { abort: true, reason: `唤回失败: ${(e as Error)?.message ?? String(e)}` };
    }
  }
}

/** 容错解析:截取首个大括号平衡段 JSON.parse。 */
export function parseRecallPatch(text: string): RecallPatch | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    return {
      abort: raw.abort === true,
      reason: typeof raw.reason === 'string' ? raw.reason : undefined,
      nodeId: typeof raw.nodeId === 'string' ? raw.nodeId : undefined,
      newAction: typeof raw.newAction === 'string' ? raw.newAction : undefined,
      newScript: Array.isArray(raw.newScript) ? (raw.newScript as unknown[]) as RecallPatch['newScript'] : undefined,
      newAsserts: Array.isArray(raw.newAsserts) ? (raw.newAsserts as unknown[]) as RecallPatch['newAsserts'] : undefined,
    };
  } catch {
    return null;
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
