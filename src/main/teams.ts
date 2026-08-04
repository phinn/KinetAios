// AgentTeams(P2):多 agent 团队协作。
// 设计目标:让 LLM 能在主流程中"派一个团队干活",团队由 N 个 named agent 组成,
// 每个 member 有独立 history、独立的工具调用上下文。Member 之间通过 broadcast / send 通信。
//
// 简化的 MVP 设计:
// - 每个 team 挂在主 conv 下,team_id = "conv:<convId>:team:<ts>"
// - 每个 member 是只读 sub-agent(复用 dispatch_agent 的 readOnlyTools + SUBAGENT_PROMPT)
// - member history 持久化到 SQLite(team_members.history JSON 列),跨多轮团队对话保留
// - 不再起多进程:team 调度的 LLM 调用在主 process 串行执行(避免 LLM 风暴)
// - 主流程调度 team_send / team_broadcast:把消息发给指定 member,member 看到自己 history + 这条 user,
//   跑一次 LLM,把回答写回 history,返回结果给主流程
//
// 不做的:
// - member 之间实时通信(不需要 — broadcast 已经够用,LLM 自己用 recall_fact 共享关键数据)
// - member 写文件(全部只读,降低权限复杂度)
// - 跨主会话共享 team(每个主 conv 独立)

import type { ChatMsg } from '../shared/types';
import { priceUSD } from './glm';
import type { Provider } from './glm';
import { runAgentLoop } from './AgentLoop';
import * as store from './store';
import { readOnlyTools } from './tools';
import { SUBAGENT_PROMPT } from './engines';

const TEAM_TIMEOUT_MS = 3 * 60 * 1000; // 单次 member 回答 3 分钟超时

/**
 * 解析 member history(JSON 字符串 → ChatMsg[]),失败回退空数组。
 */
export function parseMemberHistory(raw: string | null): ChatMsg[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatMsg[]) : [];
  } catch {
    return [];
  }
}

/**
 * 跑一个 member 的回答:把它当前 history + 新 user message 喂给 LLM,返回新 history + 最终文本。
 * 复用 SUBAGENT_PROMPT(只读工具 + 文本汇报)。
 * 不持久化,调用方负责 upsertTeamMember。
 */
export async function runMember(opts: {
  member: store.TeamMember;
  userMessage: string;
  provider: Provider;
  snap: import('../shared/types').ConfigSnapshot;
  signal: AbortSignal;
  onEvent?: (e: { type: 'token' | 'tool' | 'cost'; text?: string; name?: string; usd?: number; tokens?: number }) => void;
  cwd: string;
  confirm: (cmd: string) => Promise<boolean>;
  convId: string;
}): Promise<{ newHistory: ChatMsg[]; answer: string; tokensIn: number; tokensOut: number }> {
  const { member, userMessage, provider, snap, signal, onEvent, cwd, confirm, convId } = opts;
  const history = parseMemberHistory(member.history);

  // 超时控制
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TEAM_TIMEOUT_MS);
  if (signal.aborted) ac.abort();
  else signal.addEventListener('abort', () => ac.abort(), { once: true });

  const memberPrompt = `# 团队成员身份\n你是 team "${member.team_id}" 中的成员 **${member.name}**(${member.role})。\n\n` +
    `# 团队领导指令\n${userMessage}\n\n` +
    `# 你的任务\n完成上述指令并用简洁中文汇报结论。不要假设其他成员的进度。`;

  const out = await runAgentLoop({
    provider,
    tools: readOnlyTools(),
    systemPrompt: SUBAGENT_PROMPT, // 复用 sub-agent 系统提示(只读工具 + 文本汇报)
    snapshot: snap,
    userInput: memberPrompt,
    history,
    ctx: { cwd, confirm, convId },
    signal: ac.signal,
    maxTurns: 8,
    onEvent: (e) => {
      if (!onEvent) return;
      if (e.type === 'token') onEvent({ type: 'token', text: e.text });
      else if (e.type === 'tool') onEvent({ type: 'tool', name: e.name });
      else if (e.type === 'cost') onEvent({ type: 'cost', usd: e.usd, tokens: e.tokens });
    },
  });

  clearTimeout(timer);

  const answer = out
    .filter((m) => m.role === 'assistant' && typeof m.content === 'string')
    .map((m) => m.content)
    .join('\n')
    .trim();

  // 估算 token 数(mvp 简化:用 priceUSD 同口径)
  const tokensIn = out.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const tokensOut = answer.length;

  return { newHistory: out, answer, tokensIn, tokensOut };
}

/**
 * 计算单次 member 调用的 USD 成本(给 UI 显示)。
 * ponytail: 价格快照由 provider 配置决定;这里用 priceUSD 简单估算。
 */
export function memberCostUSD(snap: import('../shared/types').ConfigSnapshot, tokensIn: number, tokensOut: number): number {
  return priceUSD(snap.model, tokensIn, tokensOut);
}