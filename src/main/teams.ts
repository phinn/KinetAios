// AgentTeams(P2):多 agent 团队协作。
// 设计目标:让 LLM 能在主流程中"派一个团队干活",团队由 N 个 named agent 组成,
// 每个 member 有独立 history、独立的工具调用上下文。Member 之间通过 broadcast / send 通信。
//
// 架构:
// - 每个 team 挂在主 conv 下,team_id = "conv:<convId>:team:<ts>"
// - 每个 member 是只读 sub-agent(复用 dispatch_agent 的 readOnlyTools + SUBAGENT_PROMPT)
// - member history 持久化到 SQLite(team_members.history JSON 列),跨多轮团队对话保留
// - broadcast 时 member 并行执行(Promise.allSettled),team_send 时单 member 执行
// - 实时事件通过 TeamEvent 发射到 renderer(独立 IPC 通道,不走 AgentEvent)
//
// 不做的:
// - member 之间实时通信(不需要 — broadcast 已经够用,LLM 自己用 recall_fact 共享关键数据)
// - member 写文件(全部只读,降低权限复杂度)
// - 跨主会话共享 team(每个主 conv 独立)

import type { ChatMsg, TeamEvent } from '../shared/types';
import { priceUSD } from './glm';
import type { Provider } from './glm';
import { runAgentLoop } from './AgentLoop';
import * as store from './store';
import { readOnlyTools } from './tools';
import { SUBAGENT_PROMPT, SUBAGENT_TIMEOUT_MS } from './engines';

const TEAM_TIMEOUT_MS = SUBAGENT_TIMEOUT_MS; // 单次 member 回答超时(与 dispatch_agent 对齐,8min)

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

/** Member 执行选项 — runMember / runMembersParallel 共用 */
export interface MemberRunOpts {
  provider: Provider;
  snap: import('../shared/types').ConfigSnapshot;
  signal: AbortSignal;
  cwd: string;
  confirm: (cmd: string) => Promise<boolean>;
  convId: string;
  /** 跨项目记忆开关(会话级,false = member 的 recall 只看本会话) */
  crossProjectMemory?: boolean;
  /** Team 事件回调(发射到 renderer) */
  onTeamEvent?: (memberName: string, ev: TeamEvent) => void;
}

/**
 * 跑一个 member 的回答:把它当前 history + 新 user message 喂给 LLM,返回新 history + 最终文本。
 * 复用 SUBAGENT_PROMPT(只读工具 + 文本汇报)。
 * 不持久化,调用方负责 upsertTeamMember。
 */
export async function runMember(opts: {
  member: store.TeamMember;
  userMessage: string;
  runOpts: MemberRunOpts;
}): Promise<{ newHistory: ChatMsg[]; answer: string; tokensIn: number; tokensOut: number }> {
  const { member, userMessage, runOpts } = opts;
  const { provider, snap, signal, cwd, confirm, convId, onTeamEvent } = runOpts;
  const history = parseMemberHistory(member.history);

  // 超时控制。必须在结束后 removeEventListener,防止 dead listener 堆积在 parent signal 上。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TEAM_TIMEOUT_MS);
  const onParentAbort = (): void => ac.abort();
  if (signal.aborted) ac.abort();
  else signal.addEventListener('abort', onParentAbort, { once: true });

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
    ctx: { cwd, confirm, convId, crossProjectMemory: opts.runOpts.crossProjectMemory },
    signal: ac.signal,
    // maxTurns 不传 → AgentLoop 读用户全局设置(0 = 无限),与主 agent 行为一致
    onEvent: (e) => {
      if (!onTeamEvent) return;
      if (e.type === 'token') onTeamEvent(member.name, { type: 'memberToken', memberName: member.name, text: e.text });
      else if (e.type === 'tool') onTeamEvent(member.name, { type: 'memberTool', memberName: member.name, toolName: e.name, toolResult: '' });
      else if (e.type === 'cost') onTeamEvent(member.name, { type: 'memberCost', memberName: member.name, usd: e.usd, tokens: e.tokens });
    },
  });

  clearTimeout(timer);
  signal.removeEventListener('abort', onParentAbort); // 清理 parent signal listener

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
 * 并行跑多个 member(broadcast 场景)。每个 member 独立 AbortController + 独立超时。
 * 返回 memberName → answer 的 Map。失败的 member answer 为错误信息。
 */
export async function runMembersParallel(opts: {
  members: store.TeamMember[];
  message: string;
  runOpts: MemberRunOpts;
}): Promise<Map<string, { answer: string; newHistory: ChatMsg[]; tokensIn: number; tokensOut: number; error?: string }>> {
  const { members, message, runOpts } = opts;
  const results = await Promise.allSettled(
    members.map(async (m) => {
      runOpts.onTeamEvent?.(m.name, { type: 'memberStatus', memberName: m.name, status: 'running' });
      try {
        const r = await runMember({ member: m, userMessage: message, runOpts });
        runOpts.onTeamEvent?.(m.name, { type: 'memberDone', memberName: m.name, answer: r.answer });
        runOpts.onTeamEvent?.(m.name, { type: 'memberStatus', memberName: m.name, status: 'done' });
        return { name: m.name, answer: r.answer, newHistory: r.newHistory, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
      } catch (e) {
        const errMsg = (e as Error)?.message ?? String(e);
        runOpts.onTeamEvent?.(m.name, { type: 'memberStatus', memberName: m.name, status: 'failed' });
        // 失败时保留原有 history(不清空),避免丢失 member 累积的对话上下文
        const oldHistory = parseMemberHistory(m.history);
        return { name: m.name, answer: `错误: ${errMsg}`, newHistory: oldHistory, tokensIn: 0, tokensOut: 0, error: errMsg };
      }
    }),
  );
  const map = new Map<string, { answer: string; newHistory: ChatMsg[]; tokensIn: number; tokensOut: number; error?: string }>();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const v = r.value;
      map.set(v.name, { answer: v.answer, newHistory: v.newHistory, tokensIn: v.tokensIn, tokensOut: v.tokensOut, error: v.error });
    }
  }
  return map;
}

/**
 * 计算单次 member 调用的 USD 成本(给 UI 显示)。
 * ponytail: 价格快照由 provider 配置决定;这里用 priceUSD 简单估算。
 */
export function memberCostUSD(snap: import('../shared/types').ConfigSnapshot, tokensIn: number, tokensOut: number): number {
  return priceUSD(snap.model, tokensIn, tokensOut);
}