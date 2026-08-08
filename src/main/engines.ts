// Engine abstraction + the three engines. Ported from Swift ClaudeCodeEngine/CodexEngine and
// the Direct logic that lived in TaskManager. Three real engines now → the interface is worth it.
//
// CLI spawn note (Windows): npm-global bins ship as .cmd shims. Node refuses to spawn .cmd/.bat
// directly (CVE-2024-27980), so .cmd/.bat go through shell:true. Direct .exe / unix bins spawn
// without a shell → clean argv, no prompt-injection surface. ponytail: prompt-arg via shell:true
// on Windows isn't bulletproof against cmd metachars; user authors the prompt, acceptable for MVP.
import { spawn, execSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentEvent, ChatMsg, Conversation, EngineKind, SandboxMode } from '../shared/types';
import { resolveEnginePolicy } from '../shared/types';
import { runAgentLoop, compactHistory } from './AgentLoop';
import { currentProvider, priceUSD, type Provider } from './glm';
import * as store from './store';
import { allTools, readOnlyTools, type SpawnScopeConfig, type ToolCtx, type SubEngine } from './tools';
import { getSettings, snapshot } from './settings';
import { t } from '../shared/i18n';
import { mcp } from './mcp';
import { getBrand } from './brand';
import { pluginSystemPrompts } from './plugins';

export const baseSystemPrompt = `你是 ${getBrand().productName},运行在用户 Windows 电脑上的 AI 助手。你能执行 shell 命令、读文件、写文件、搜索网页、抓取网页、搜索历史记忆来帮用户完成任务。
该用工具就果断用,不要只给步骤。需要回忆过去做过/聊过的事,用 recall_memory 搜历史。

【读大文件】read_file 支持按行范围读取:read_file(path, start_line=100, end_line=200)。
- 不传行范围时读全文,上限 50000 字符(超出会提示用 start_line 继续读)
- 文件超过 2MB 用 shell(head/sed/grep)按需读
- 先用 grep 定位关键行号,再用 read_file 精准读那一段,避免一次性读全文被截断

【网页搜索】有两步:
1. web_search("关键词") → 搜索引擎返回标题/摘要/链接列表
2. web_fetch(url) → 抓取具体网页的正文(自动走 Jina Reader 去噪,返回干净 Markdown)
需要查最新信息、技术文档、不确定的事实时,先用 web_search 搜,再 web_fetch 深读。

【重要】写文件的唯一正确方式是 write_file 工具(path + content 直传)。
- write_file 没有长度限制,几 KB、几十 KB、几百 KB 都可以一次性写入
- 永远不要因为"内容太长"而改用 shell echo/cat/heredoc,或 powershell Set-Content,或 base64 decode
- 那些 shell/powershell 方式在 JSON+shell 双层转义下几乎必崩
- 一旦决定要写文件,直接 write_file 一次到位

【输出路径】生成的文件(HTML / CSV / 报告等)默认写到当前工作目录(cwd)或其子目录。
执行 shell 前会请求用户确认。Windows 上 shell 走 cmd.exe。回复用中文,简洁。

【记忆管理】你的记忆分三层:
1. **Memory Blocks**(结构化常驻记忆):每轮注入到上下文,包含 user_profile / project_context / active_goals。你发现记忆过时或需要补充时,用 memory_replace 更新、memory_append 追加。
2. **长期记忆**(自动提取):系统每轮自动从对话中提取关于用户的事实。需要回忆时用 recall_memory 搜历史。
3. **会话摘要**(episodic):每次会话结束自动生成摘要,下次可看到"最近做了什么"。`;

// 来源渠道上下文:当会话由飞书/企信机器人创建时,注入来源提示,
// 让 Agent 知道自己在聊天频道里运行,回复会自动发送到当前对话。
// / Source channel hint: injected when the conversation was created by a bot bridge.
// Tells the Agent it's inside a chat channel and replies are auto-delivered.
export function sourceHintSection(conv?: Conversation): string {
  if (!conv) return '';
  if (conv.feishuKey) {
    return '\n\n# 📱 运行环境:飞书频道\n你当前在飞书频道中运行。你的回复会自动发送到当前对话,无需任何 Webhook URL、App ID/Secret 或 chat_id。\n如果用户说"发到飞书""发给我",那意味着直接回复即可——你已经在飞书频道里了。\n你产出的图片和文件也会自动上传并发送到频道。\n\n## 📎 发送已有文件\n如果用户要求你发送磁盘上已有的文件(如"把 xxx.png 发给我"),请使用 `feishu_send_file` 工具,传入文件路径即可。不要用 write_file 重新写入二进制文件(会破坏原数据)。';
  }
  if (conv.wecomKey) {
    return '\n\n# 📱 运行环境:企业微信\n你当前在企业微信中运行。你的回复会自动发送到当前对话,无需任何额外配置。\n如果用户说"发到企微""发给我",那意味着直接回复即可——你已经在企业微信里了。';
  }
  return '';
}

// 替身画像注入:从 settings 读 persona,返回带标题前缀的 section(空则空字符串)。
// 三引擎共用:Direct 拼到 systemPrompt,Claude Code 进 --append-system-prompt,Codex 前置拼到 prompt。
// conv.personaEnabled === false 时跳过(会话级开关,默认开)。
export function personaSection(conv?: Conversation): string {
  if (conv?.personaEnabled === false) return '';
  const persona = getSettings().persona?.trim();
  if (!persona) return '';
  return `\n\n# 🧬 替身画像(用户做事风格)\n以下是用户本人的做事风格画像。请在回答风格、方案选择、代码风格上尽量贴合画像描述,就像用户本人在操作一样:\n\n${persona}`;
}

// 子 agent 系统提示(Direct 的 dispatch_agent 用)。只读工具,完成后文本汇报。
export const SUBAGENT_PROMPT = `你是子 agent,在主 agent 派发下独立完成一个子任务。
你只有只读工具(read_file / grep / glob / web_search / web_fetch / recall_memory / recall_fact)—— 不能写文件、不能起 shell、不能再派发子任务。
聚焦完成给定目标,结束后用简洁中文文本汇报结果(结论 / 找到的东西 / 关键路径),不要寒暄。`;

/**
 * P1:resolveSpawnHistory — 按 scope 策略把 parent history 转成一段文本。
 * 返回 historyText:拼到子 agent userInput 末尾作为"父会话上下文"参考。
 * 不传 ChatMsg[] 给 runAgentLoop(避免子 agent 看到父级 tool_calls/role 错位)。
 *
 * mode 语义:
 * - 'none':空字符串(子 agent 完全独立)。
 * - 'last_n_turns(n)':取 parent history 末尾最近 n 个 user 消息 + 它们对应的 assistant 回复。
 *   简单按"role=user"的边界切,tool 消息作为该轮 assistant 的证据保留。
 * - 'summary_only':直接调 LLM 做全文摘要(不借 compactHistory),失败回退 last_n_turns(3)。
 * - 'full_history':全量 history,做长度检查(>8000 字符走 compactHistory)。
 */
export async function resolveSpawnHistory(opts: {
  scope: SpawnScopeConfig;
  parentHistory: ChatMsg[];
  provider: Provider;
  snap: import('../shared/types').ConfigSnapshot;
  signal: AbortSignal;
  onEvent: (e: AgentEvent) => void;
}): Promise<{ historyText: string }> {
  const { scope, parentHistory, provider, snap, signal, onEvent } = opts;
  if (scope.mode === 'none') return { historyText: '' };
  if (!parentHistory || parentHistory.length === 0) return { historyText: '' };

  if (scope.mode === 'last_n_turns') {
    const n = Math.max(1, Math.min(scope.n, 10));
    // 从尾向头扫描,收集最近 n 个 user 消息 + 它们之间的所有消息(含 tool / assistant)。
    const reversed = [...parentHistory].reverse();
    const collected: ChatMsg[] = [];
    let userCount = 0;
    for (const m of reversed) {
      collected.push(m);
      if (m.role === 'user') {
        userCount++;
        if (userCount >= n) break;
      }
    }
    collected.reverse();
    return { historyText: chatHistoryToText(collected, n) };
  }

  if (scope.mode === 'summary_only') {
    // 直接用 LLM 做全文摘要(而非借 compactHistory 间接模拟,后者保留尾部真实消息会混入)。
    // 将 parentHistory 转文本 → 截断 → 一次 streamComplete 摘要。
    try {
      const transcript = parentHistory
        .filter((m) => !m._memory && !m._pinned && m.role !== 'system')
        .map((m) => {
          if (m.role === 'tool') return `[工具结果] ${typeof m.content === 'string' ? m.content.slice(0, 200) : ''}`;
          if (m.role === 'assistant') {
            const text = typeof m.content === 'string' ? m.content.slice(0, 400) : '';
            const tc = Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => c.function.name).join(', ') : '';
            return `[助手${tc ? `:${tc}` : ''}] ${text}`;
          }
          return `[用户] ${typeof m.content === 'string' ? m.content.slice(0, 400) : ''}`;
        })
        .join('\n');
      if (!transcript.trim()) return { historyText: '' };
      // 截断到 10K(子 agent 只需摘要,不需要完整原文)
      const trimmed = transcript.length > 10_000 ? transcript.slice(0, 10_000) + '\n…[截断]' : transcript;
      const sys = '你是对话摘要器。把下面这段父会话压成一段简洁中文摘要,保留:任务目标、关键决策、已确定的结论、重要的文件路径/命令/技术栈。丢掉寒暄与一次性细节。直接输出摘要正文,不要标题。';
      const comp = await provider.streamComplete(
        [{ role: 'system', content: sys }, { role: 'user', content: trimmed }],
        [], snap, signal, () => {},
      );
      const summary = comp.content?.trim();
      if (onEvent && (comp.tokensIn > 0 || comp.tokensOut > 0)) {
        const { priceUSD } = await import('./glm');
        onEvent({ type: 'cost', usd: priceUSD(snap.model, comp.tokensIn, comp.tokensOut), tokens: comp.tokensIn + comp.tokensOut });
      }
      return { historyText: summary ? `【父会话摘要】\n${summary}` : '' };
    } catch {
      // 摘要失败 → 回退 last_n_turns(3)
      const fallback = [...parentHistory].slice(-6);
      return { historyText: chatHistoryToText(fallback, 3) };
    }
  }

  if (scope.mode === 'full_history') {
    // 全量 history → 检查长度,太长就摘要
    const totalChars = parentHistory.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
    if (totalChars > 8000) {
      try {
        const summarized = await compactHistory(parentHistory, 8000, provider, snap, signal, onEvent);
        return { historyText: chatHistoryToText(summarized, parentHistory.length) + '\n(已摘要)' };
      } catch {
        return { historyText: chatHistoryToText(parentHistory.slice(-10), 10) + '\n(摘要失败,只保留尾部)' };
      }
    }
    return { historyText: chatHistoryToText(parentHistory, parentHistory.length) };
  }

  return { historyText: '' };
}

// ChatMsg[] → 简洁的纯文本(供 historyText 用)。
// 跳过 _memory / _pinned 标的消息(它们是参考,不是子 agent 应该看到的"对话")。
// tool 消息合并到对应 assistant 消息下,标 [工具: name]。
function chatHistoryToText(msgs: ChatMsg[], n: number): string {
  const lines: string[] = [`(父会话最近 ${n} 轮)`];
  for (const m of msgs) {
    if (m._memory || m._pinned) continue;
    if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content.slice(0, 300) : '[多模态]';
      lines.push(`  [工具结果] ${text}${text.length >= 300 ? '…' : ''}`);
    } else if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : '[多模态]';
      const tc = Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => c.function.name).join(', ') : '';
      lines.push(`[助手${tc ? ` 调用:${tc}` : ''}] ${text.slice(0, 600)}${text.length >= 600 ? '…' : ''}`);
    } else if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : '[多模态]';
      lines.push(`[用户] ${text.slice(0, 400)}${text.length >= 400 ? '…' : ''}`);
    } else if (m.role === 'system') {
      continue; // 跳过 system
    }
  }
  return lines.join('\n');
}

export interface EngineRunOpts {
  conv: Conversation;
  memoryBlock: string;
  rulesBlock?: string; // KINET.md 内容(app UI 维护的项目规则,三套引擎都要遵守)
  contextBlock?: string; // KINET-CONTEXT.md(项目级背景知识,所有任务共享)
  skillBlock?: string; // Direct only: body of a /<skill> the user invoked this turn
  refBlock?: string; // 跨会话引用内容(@conv:xxx 解析后的被引用会话输出)
  signal: AbortSignal;
  onEvent: (e: AgentEvent) => void;
}

export interface Engine {
  readonly name: EngineKind;
  run(opts: EngineRunOpts): Promise<void>;
}

// 项目规则文件注入 system prompt —— 约定大于配置。
// 优先级: KinetAios.md > AGENTS.md > CLAUDE.md（第一个找到的即用，不合并）
export function loadProjectRules(cwd: string): string {
  for (const name of ['KinetAios.md', 'AGENTS.md', 'CLAUDE.md']) {
    try {
      const body = fs.readFileSync(path.join(cwd, name), 'utf8');
      if (body.trim()) return `\n\n# 项目规则(${name})\n${body.slice(0, 8000)}`;
    } catch {
      /* 不存在 → 试下一个 */
    }
  }
  return '';
}

// KINET.md(app UI 维护的项目规则)。三套引擎都注入,与 AGENTS.md/CLAUDE.md 区分:
// 后者是外部工具约定,直接读;前者是本 app 的「规则 tab」写的,要主动注入到 CC/Codex。
export function loadRulesBlock(cwd: string): string {
  try {
    const body = fs.readFileSync(path.join(cwd, 'KINET.md'), 'utf8');
    if (body.trim()) return `\n\n# 项目规则(KINET.md)\n${body.slice(0, 8000)}`;
  } catch {
    /* 不存在 → 空 */
  }
  return '';
}

// KINET-CONTEXT.md(项目级背景知识:架构、技术栈、约定来源等)。同 cwd 的所有任务共享,
// 与 KINET.md 区分:后者是「必须遵守的规则」,前者是「关于这个项目的事实」。三套引擎都注入。
export function loadContextBlock(cwd: string): string {
  try {
    const body = fs.readFileSync(path.join(cwd, 'KINET-CONTEXT.md'), 'utf8');
    if (body.trim()) return `\n\n# 项目背景(KINET-CONTEXT.md)\n${body.slice(0, 12000)}`;
  } catch {
    /* 不存在 → 空 */
  }
  return '';
}

// Direct = the built-in ReAct loop (AgentLoop) talking to the GLM/OpenAI/Anthropic provider.
class DirectEngine implements Engine {
  readonly name = 'direct' as const;
  constructor(private confirm: (cmd: string) => Promise<boolean>) {}
  async run({ conv, memoryBlock, rulesBlock, contextBlock, skillBlock, refBlock, signal, onEvent }: EngineRunOpts): Promise<void> {
    const prompt = conv.turns[conv.turns.length - 1]?.prompt ?? '';
    // Per-conversation model (Direct only). If the conversation has a profileId, use that profile's
    // config; otherwise fall back to global settings + per-conversation model override.
    const base = snapshot(conv.profileId);
    const snap = { ...base, model: conv.model || base.model };
    console.log('[DirectEngine] profileId=%s baseURL=%s model=%s proto=%s', conv.profileId, snap.baseURL, snap.model, snap.apiProtocol);
    const provider = currentProvider(snap);
    // ctx.spawn:dispatch_agent 起子任务 —— 复用 runAgentLoop,独立 history、只读工具、maxTurns 限 8。
    // 子任务事件只转发 cost(也花钱)+ tool(带前缀供 UI 观感),吞掉 token 防刷屏。
    // P1:支持 scope 参数,按需注入 parent history。scope 切片逻辑由 resolveSpawnHistory 集中处理。
    const ctx: ToolCtx = {
      cwd: conv.cwd,
      confirm: this.confirm,
      signal,
      convId: conv.id,
      sandbox: getSettings().sandbox,
      // P2:AgentTeams 调度。broadcast 时并行,team_send 时单 member。结果拼成文本返回给主 LLM。
      teamRun: async ({ teamId, memberNames, message }) => {
        const { runMember, runMembersParallel, memberCostUSD } = await import('./teams');
        const { emitTeamEvent } = await import('./main');

        const runOpts = {
          provider, snap, signal,
          cwd: conv.cwd,
          confirm: this.confirm,
          convId: conv.id,
          onTeamEvent: (memberName: string, ev: import('../shared/types').TeamEvent) => {
            emitTeamEvent(teamId, ev);
          },
        };

        if (memberNames.length <= 1) {
          // 单 member:串行执行
          const name = memberNames[0];
          if (!name) return '';
          const m = store.loadTeamMember(teamId, name);
          if (!m) return `[${name}] (member 不存在)`;
          try {
            emitTeamEvent(teamId, { type: 'memberStatus', memberName: name, status: 'running' });
            const r = await runMember({ member: m, userMessage: message, runOpts });
            store.upsertTeamMember({ ...m, history: JSON.stringify(r.newHistory), last_message: message, last_result: r.answer, status: 'done', updated_at: Date.now() / 1000 });
            const usd = memberCostUSD(snap, r.tokensIn, r.tokensOut);
            onEvent({ type: 'cost', usd, tokens: r.tokensIn + r.tokensOut });
            emitTeamEvent(teamId, { type: 'memberDone', memberName: name, answer: r.answer });
            emitTeamEvent(teamId, { type: 'memberStatus', memberName: name, status: 'done' });
            return `### ${m.name} (${m.role})\n${r.answer || '(无回答)'}\n`;
          } catch (e) {
            store.upsertTeamMember({ ...m, last_message: message, last_result: `错误: ${(e as Error)?.message}`, status: 'failed', updated_at: Date.now() / 1000 });
            emitTeamEvent(teamId, { type: 'memberStatus', memberName: name, status: 'failed' });
            return `### ${m.name}\n错误: ${(e as Error)?.message}\n`;
          }
        }

        // 多 member(broadcast):并行
        const members = memberNames.map(n => store.loadTeamMember(teamId, n)).filter((m): m is NonNullable<typeof m> => m !== null);
        const results = await runMembersParallel({ members, message, runOpts });
        const parts: string[] = [];
        let totalUsd = 0;
        let totalTokens = 0;
        for (const m of members) {
          const r = results.get(m.name);
          if (!r) { parts.push(`### ${m.name}\n(无结果)\n`); continue; }
          store.upsertTeamMember({ ...m, history: JSON.stringify(r.newHistory), last_message: message, last_result: r.answer, status: r.error ? 'failed' : 'done', updated_at: Date.now() / 1000 });
          totalUsd += memberCostUSD(snap, r.tokensIn, r.tokensOut);
          totalTokens += r.tokensIn + r.tokensOut;
          parts.push(`### ${m.name} (${m.role})\n${r.answer || '(无回答)'}\n`);
        }
        if (totalUsd > 0) onEvent({ type: 'cost', usd: totalUsd, tokens: totalTokens });
        return parts.join('\n');
      },
      spawn: async ({ prompt: sub, signal: childSignal, engine, model, scope }) => {
        // 跨引擎子任务:claudeCode / codex 走 CLI one-shot(只读,不递归)。
        // ponytail: 不复用 ClaudeCodeEngine/CodexEngine 的 stream-json 解析,直接 execFile + 取 stdout。
        if (engine === 'claudeCode' || engine === 'codex') {
          return await runCliOneShot(engine, sub, conv.cwd, childSignal);
        }
        // 子 agent model 覆盖:若指定了 model,构建新 snap + provider;否则复用主 agent 的。
        const subSnap = model ? { ...snap, model } : snap;
        const subProvider = model ? currentProvider(subSnap) : provider;
        // 超时保护:合并主 signal + 3 分钟 timeout,防止 API hang 导致 dispatch_agent 永久阻塞。
        const subAc = new AbortController();
        const subTimer = setTimeout(() => subAc.abort(), 3 * 60 * 1000);
        if (childSignal.aborted) subAc.abort();
        else childSignal.addEventListener('abort', () => subAc.abort(), { once: true });
        // P1:解析 scope → 实际要注入的 history + 拼接后 prompt。
        // 子任务的 SUBAGENT_PROMPT 末尾追加一段 history 摘要 + parent 上下文,作为事实锚点参考。
        // 注意:不直接传 ChatMsg[] history 给 runAgentLoop(避免子 agent 的 response 模型看到父级 tool_calls),
        // 而是把它转成一段文本注入 userInput(子 agent 当成 user 上下文读)。
        const scopeResolved = scope ?? { mode: 'none' as const };
        const resolved = await resolveSpawnHistory({
          scope: scopeResolved,
          parentHistory: conv.directHistory,
          provider: subProvider,
          snap: subSnap,
          signal: subAc.signal,
          onEvent,
        });
        const finalPrompt = resolved.historyText
          ? `${sub}\n\n---\n# 父会话上下文(只读参考,不要修改或依赖)\n${resolved.historyText}\n---`
          : sub;
        const out = await runAgentLoop({
          provider: subProvider,
          tools: readOnlyTools(),
          systemPrompt: SUBAGENT_PROMPT,
          snapshot: subSnap,
          userInput: finalPrompt,
          history: [], // P1:scope 切片已合并到 userInput,这里保持空 history
          ctx: { cwd: conv.cwd, confirm: this.confirm, convId: conv.id },
          signal: subAc.signal,
          maxTurns: 8,
          onEvent: (e) => {
            if (e.type === 'cost') onEvent(e);
            else if (e.type === 'tool') onEvent({ type: 'status', text: `[子任务] ${e.name}` });
          },
        });
        clearTimeout(subTimer);
        const text = out
          .filter((m) => m.role === 'assistant' && typeof m.content === 'string')
          .map((m) => m.content)
          .join('\n')
          .trim();
        return text || '(子任务无文本输出)';
      },
    };
    // A skill invoked via /<name> rides ahead of memory so the active instruction is prominent.
    const skillSection = skillBlock ? `\n\n# 当前 Skill 指令(用户通过 / 调用,请遵循)\n${skillBlock}` : '';
    // 会话目标(通过 /goal 设置):注入 systemPrompt 顶部,跨轮持续生效,引导整个会话方向。
    // goal 模式:agent 自动循环执行直到完成 goal。模型判断完成后在回答末尾输出 [GOAL_COMPLETE]。
    const goalSection = conv.goal ? `\n\n# 🎯 会话目标\n你当前的核心目标是:\n${conv.goal}\n请在每一步操作中都朝这个目标推进。如果用户的新请求偏离目标,可以提醒并征求确认。\n**当你确认目标已经完成时,在回答的最末尾输出 \`[GOAL_COMPLETE]\` 标记。**` : '';
    const refSection = refBlock ?? '';
    const rulesSection = loadProjectRules(conv.cwd);
    // KINET.md(app UI 维护的项目规则)紧跟 loadProjectRules 之后,与 AGENTS.md/CLAUDE.md 并列。
    // 内置工具 + 系统里配置的 MCP 工具(最多等 2s 让连接就绪)。
    const tools = [...allTools(), ...(await mcp.directTools(2000))];
    // memoryBlock 走 history[0] 注入(见 runAgentLoop 的 memMsg),不拼进 systemPrompt ——
    // 这样 base+rules+context 跨轮稳定 → Anthropic cache_control 不被记忆变化打穿。
    // refBlock 拼到 userInput 后面(每轮动态,不进 systemPrompt → 不破坏缓存)。
    // 跨引擎上下文(切到 Direct 时自动注入,首次消费后清除)
    const crossCtx = conv.crossEngineContext;
    if (crossCtx) {
      conv.crossEngineContext = null; // 消费一次即可
    }
    const userInput = [prompt, refSection || null, crossCtx || null].filter(Boolean).join('\n\n');
    // 从策略包取 trim/interStepCompact/truncate 阈值,统一收口到 ENGINE_POLICIES。
    // v1 direct 默认轻量;hifi 模式 resolveEnginePolicy 已自动翻倍。
    const policy = resolveEnginePolicy('direct', conv.contextMode);
    const updated = await runAgentLoop({
      provider,
      tools,
      systemPrompt: baseSystemPrompt + personaSection(conv) + sourceHintSection(conv) + goalSection + skillSection + rulesSection + (rulesBlock ?? '') + (contextBlock ?? '') + pluginSystemPrompts('direct', prompt),
      memoryBlock,
      snapshot: snap,
      userInput,
      history: conv.directHistory,
      ctx,
      signal,
      contextMode: conv.contextMode,
      hifiContextBudget: getSettings().hifiContextBudget,
      policy, // P0-1:把策略传给 runAgentLoop,内部不再 if/else
      onEvent,
    });
    // abort 后 signal 已触发 → compactHistory 的摘要 LLM 调用也会被 abort(catch 后丢 head)。
    // 所以 abort 路径跳过 compactHistory,直接用 finalizeAbortedMessages 返回的完整 messages。
    if (!signal.aborted) {
      // P0-fix: interStepCompactBudget 现在有显式值(30K),不再需要 || fallback。
      // v1 单轮 ReAct 结束后压缩:历史 <30K 保留尾部,超出才调 LLM 摘要。
      conv.directHistory = await compactHistory(updated, policy.interStepCompactBudget, provider, snap, signal, onEvent);
    } else {
      conv.directHistory = updated;
    }
  }
}

// MARK: CLI spawn helpers (shared by Claude Code + Codex)

const CLAUDE_PERM: Record<SandboxMode, string> = {
  readOnly: 'plan',
  workspaceWrite: 'acceptEdits',
  fullAccess: 'bypassPermissions',
};
const CODEX_SANDBOX: Record<SandboxMode, string> = {
  readOnly: 'read-only',
  workspaceWrite: 'workspace-write',
  fullAccess: 'danger-full-access',
};

// PATH augmented with common install dirs so a GUI-launched app (sparse PATH) can still find CLIs.
export function binEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extra =
    process.platform === 'win32'
      ? [path.join(home, 'AppData', 'Roaming', 'npm'), path.join(home, '.npm-global')]
      : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.local', 'bin')];
  const base = process.env.PATH || '';
  return { ...process.env, PATH: base + path.delimiter + extra.join(path.delimiter) };
}

const execFileAsync = promisify(execFile);

// 跨引擎子任务(dispatch_agent engine=claudeCode/codex)的 one-shot CLI 调用:
// 不走 stream-json 解析,直接 execFile + 全量 stdout。CLI 失败/超时返回错误文本而非抛错(子任务不应阻塞主流程)。
// ponytail: maxBuffer 10MB;再大就走流式(目前没遇到)。codex exec 默认输出 JSON,模型自己解析。
export async function runCliOneShot(engine: 'claudeCode' | 'codex', prompt: string, cwd: string, signal: AbortSignal): Promise<string> {
  const bin = resolveBin(engine === 'claudeCode' ? 'claude' : 'codex');
  if (!bin.found) return `(${engine} CLI 不在 PATH,跳过子任务)`;
  // 安全:Windows 上 .cmd 走 shell:true,prompt 如果含 &|> 等 cmd 元字符会导致命令注入。
  // 改为通过 stdin 传入 prompt,argv 只传 flag(不带用户/LLM 内容)。
  // Security: on Windows .cmd shims go through shell:true, so prompt content in argv risks
  // command injection (&|> etc). Pipe prompt via stdin instead, argv has only flags.
  const useStdin = bin.shell;
  const args = useStdin
    ? (engine === 'claudeCode' ? ['-p'] : ['exec'])
    : (engine === 'claudeCode' ? ['-p', prompt] : ['exec', prompt]);
  try {
    // timeout 5 分钟:CLI 子任务可能跑很久(大代码库分析),但不能无限等。
    // execFile 的 timeout 到期后会杀进程,防止 dispatch_agent engine=claudeCode/codex 永久 hang。
    const { stdout } = await execFileAsync(bin.cmd, args, {
      cwd,
      env: binEnv(),
      signal,
      timeout: 5 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
      ...(bin.shell ? { shell: true } : {}),
      ...(useStdin ? { input: prompt } : {}),
    });
    const text = stdout.trim();
    return text || '(子任务无文本输出)';
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return `(子任务出错: ${msg})`;
  }
}

type ResolvedBin = { cmd: string; shell: boolean; found: boolean };

// Find a CLI: known absolute locations first, then `where`/`command -v` on PATH.
function resolveBin(name: string): ResolvedBin {
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
        path.join(home, 'AppData', 'Roaming', 'npm', `${name}.cmd`),
        path.join(home, '.npm-global', `${name}.cmd`),
      ]
    : [`/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`, path.join(home, '.npm-global', 'bin', name), path.join(home, '.local', 'bin', name)];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return { cmd: c, shell: isWin && /\.(cmd|bat)$/i.test(c), found: true };
    } catch {
      /* try next */
    }
  }
  try {
    const out = execSync(isWin ? `where ${name}` : `command -v ${name}`, {
      env: binEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = out.split(/\r?\n/)[0];
    if (first) return { cmd: first, shell: isWin && /\.(cmd|bat)$/i.test(first), found: true };
  } catch {
    /* not on PATH */
  }
  return { cmd: name, shell: false, found: false };
}

// Spawn a resolved bin, stream stdout+stderr line-by-line, kill on abort. Resolves to exit code.
function runBin(
  bin: ResolvedBin,
  args: string[],
  opts: { cwd: string; signal: AbortSignal; onLine: (line: string) => void },
): Promise<number> {
  return new Promise((resolve) => {
    const spawnOpts: import('node:child_process').SpawnOptions = {
      cwd: opts.cwd || undefined,
      env: binEnv(),
      windowsHide: true,
      ...(bin.shell ? { shell: true } : {}),
    };
    const child = spawn(bin.cmd, args, spawnOpts);
    let buf = '';
    const onChunk = (d: Buffer | string): void => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        opts.onLine(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    const onAbort = (): void => {
      try {
        if (process.platform === 'win32' && child.pid != null) {
          // .cmd shims spawn cmd.exe as the direct child; child.kill() only kills cmd.exe and
          // leaves the underlying claude/codex process running (and billable). /T kills the tree.
          execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true });
        } else {
          child.kill();
        }
      } catch {
        /* already gone */
      }
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => {
      opts.signal.removeEventListener('abort', onAbort);
      resolve(-1);
    });
    child.on('close', (code) => {
      opts.signal.removeEventListener('abort', onAbort); // 清理 listener,防止 AbortSignal 上堆积 dead listeners
      if (buf.trim()) opts.onLine(buf);
      resolve(code ?? 0);
    });
  });
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '{}';
  } catch {
    return '{}';
  }
}

// MARK: Claude Code (claude -p --output-format stream-json). Verbatim port of the Swift parser.
class ClaudeCodeEngine implements Engine {
  readonly name = 'claudeCode' as const;
  async run({ conv, memoryBlock, rulesBlock, contextBlock, refBlock, signal, onEvent }: EngineRunOpts): Promise<void> {
    const basePrompt = conv.turns[conv.turns.length - 1]?.prompt ?? '';
    // 跨引擎上下文:切到 Claude Code 时注入(首次消费后清除)
    const crossCtx = conv.crossEngineContext;
    if (crossCtx) conv.crossEngineContext = null;
    const prompt = [basePrompt, refBlock || null, crossCtx || null].filter(Boolean).join('\n\n');
    const cwd = conv.cwd;
    const s = getSettings();
    const permissionMode = s.planMode ? 'plan' : CLAUDE_PERM[s.sandbox];
    const bin = resolveBin('claude');
    if (!bin.found) {
      onEvent({ type: 'error', message: t(s.lang, 'eng.claudeNotFound') });
      return;
    }
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', permissionMode,
      '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep',
      '--add-dir', cwd,
    ];
    if (conv.engineSessionId) args.push('--resume', conv.engineSessionId);
    // KINET.md 规则 + KINET-CONTEXT.md 背景 + memory —— 同一个 flag 只能传一次,顺序拼接。
    // goal 不注入 CLI 引擎:Claude Code / Codex 自带 CLAUDE.md / AGENTS.md 等机制管理目标。
    const append = personaSection(conv) + sourceHintSection(conv) + (rulesBlock ?? '') + (contextBlock ?? '') + memoryBlock;
    if (append.trim()) args.push('--append-system-prompt', append);

    let sawResult = false;
    const pending = new Map<string, { name: string; args: string }>();
    const onLine = (line: string): void => {
      let obj: Record<string, any>;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      const type: string = obj.type;
      if (type === 'system') {
        const sub = obj.subtype;
        if (sub === 'init' && obj.session_id) onEvent({ type: 'sessionStarted', id: obj.session_id });
        else if (sub === 'api_retry')
          onEvent({ type: 'status', text: t(s.lang, 'eng.apiRetry', { error: obj.error ?? '', status: obj.error_status ?? '', attempt: obj.attempt ?? 0, max: obj.max_retries ?? 0 }) });
        else if (sub === 'status' && obj.status === 'requesting') onEvent({ type: 'status', text: t(s.lang, 'eng.requesting') });
      } else if (type === 'stream_event') {
        const delta = obj.event?.delta;
        if (delta?.type === 'text_delta' && delta.text) onEvent({ type: 'token', text: delta.text });
      } else if (type === 'assistant') {
        const content = obj.message?.content;
        if (Array.isArray(content))
          for (const b of content)
            if (b.type === 'tool_use') pending.set(b.id ?? '', { name: b.name ?? '', args: safeStringify(b.input ?? {}) });
      } else if (type === 'user') {
        const content = obj.message?.content;
        if (Array.isArray(content))
          for (const b of content)
            if (b.type === 'tool_result') {
              const txt = Array.isArray(b.content)
                ? b.content.map((x: Record<string, any>) => x.text || '').join('')
                : typeof b.content === 'string'
                  ? b.content
                  : '';
              const p = pending.get(b.tool_use_id ?? '');
              if (p) {
                pending.delete(b.tool_use_id ?? '');
                onEvent({ type: 'tool', name: p.name, args: p.args, result: txt });
              } else onEvent({ type: 'tool', name: 'tool', args: '', result: txt });
            }
      } else if (type === 'result') {
        sawResult = true;
        // total_cost_usd is the cost of THIS `claude -p` invocation (one per turn, even with
        // --resume), so += accumulates correctly across turns. No per-turn token breakdown is
        // reported here, so the turn's tokensIn/Out stay 0 (only the $ total is known).
        const c = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : Number(obj.total_cost_usd);
        if (!Number.isNaN(c)) onEvent({ type: 'cost', usd: c, tokens: 0 });
        const isErr = obj.is_error === true || (typeof obj.subtype === 'string' && obj.subtype.startsWith('error'));
        if (isErr) onEvent({ type: 'error', message: obj.result ?? obj.subtype ?? t(s.lang, 'eng.claudeError') });
        else onEvent({ type: 'done' });
      }
    };

    await runBin(bin, args, { cwd, signal, onLine });
    if (signal.aborted) return; // user cancelled — not an error
    if (!sawResult) onEvent({ type: 'error', message: t(s.lang, 'eng.claudeNoResult') });
  }
}

// MARK: Codex (codex exec --json). Verbatim port of the Swift parser.
class CodexEngine implements Engine {
  readonly name = 'codex' as const;
  async run({ conv, memoryBlock, rulesBlock, contextBlock, refBlock, signal, onEvent }: EngineRunOpts): Promise<void> {
    const basePrompt = conv.turns[conv.turns.length - 1]?.prompt ?? '';
    // 跨引擎上下文:切到 Codex 时注入(首次消费后清除)
    const crossCtx = conv.crossEngineContext;
    if (crossCtx) conv.crossEngineContext = null;
    const prompt = [basePrompt, refBlock || null, crossCtx || null].filter(Boolean).join('\n\n');
    const cwd = conv.cwd;
    const s = getSettings();
    const sandboxKind: SandboxMode = s.planMode ? 'readOnly' : s.sandbox;
    const bin = resolveBin('codex');
    if (!bin.found) {
      onEvent({ type: 'error', message: t(s.lang, 'eng.codexNotFound') });
      return;
    }
    // codex has no --append-system-prompt flag → rules + context + memory 前置拼到 prompt。
    // goal 不注入 CLI 引擎:Claude Code / Codex 自带目标管理机制。
    const head = [personaSection(conv).trim(), sourceHintSection(conv).trim(), (rulesBlock ?? '').trim(), (contextBlock ?? '').trim(), (memoryBlock ?? '').trim()].filter(Boolean).join('\n\n---\n\n');
    const fullPrompt = head ? `${head}\n\n---\n\n${prompt}` : prompt;
    // exec-level flags (--json/-C/--add-dir/-s/--skip-git-repo-check) MUST precede the resume subcommand,
    // else clap parses them as resume args and exits status=2.
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '--add-dir', cwd, '-s', CODEX_SANDBOX[sandboxKind]];
    if (conv.engineSessionId) args.push('resume', conv.engineSessionId);
    args.push(fullPrompt);

    let sawTurnEnd = false;
    const stderrTail: string[] = [];
    // codex emits agent_message both as a top-level event and inside item.completed (same text).
    // Dedup by text so the answer isn't doubled. Token fragments differ, so this only catches repeats.
    const seenAgentText = new Set<string>();
    const emitMsg = (text: string): void => {
      if (text && !seenAgentText.has(text)) {
        seenAgentText.add(text);
        onEvent({ type: 'token', text });
      }
    };
    const onLine = (line: string): void => {
      let obj: Record<string, any>;
      try {
        obj = JSON.parse(line);
      } catch {
        const t = line.trim();
        if (t) {
          stderrTail.push(t);
          if (stderrTail.length > 8) stderrTail.shift();
        }
        return;
      }
      switch (obj.type as string) {
        case 'thread.started':
          if (obj.thread_id) onEvent({ type: 'sessionStarted', id: obj.thread_id });
          break;
        case 'turn.started':
          onEvent({ type: 'status', text: t(s.lang, 'eng.requesting') });
          break;
        case 'item.completed': {
          const item = obj.item;
          const it = item?.type;
          if (it === 'agent_message' && typeof item.text === 'string') emitMsg(item.text);
          else if (it === 'command_execution')
            onEvent({
              type: 'tool',
              name: 'shell',
              args: item.command ?? '',
              result: (item.aggregated_output ?? '') + (item.exit_code != null ? ` (exit ${item.exit_code})` : ''),
            });
          else if (it === 'patch_applied') onEvent({ type: 'tool', name: 'patch', args: item.path ?? item.command ?? '', result: '已应用' });
          break;
        }
        case 'agent_message':
          if (typeof obj.message === 'string') emitMsg(obj.message);
          break;
        case 'command_executed': {
          const argv = obj.command?.argv;
          const name = argv?.[0] ?? 'shell';
          const a = Array.isArray(argv) ? argv.slice(1).map(String).join(' ') : '';
          const out = (obj.stdout ?? '') + (obj.stderr ? `\n[stderr]${obj.stderr}` : '');
          onEvent({ type: 'tool', name, args: a, result: out });
          break;
        }
        case 'patch_applied':
          onEvent({ type: 'tool', name: 'patch', args: obj.path ?? '', result: '已应用' });
          break;
        case 'turn.completed': {
          sawTurnEnd = true;
          const num = (v: unknown): number => (typeof v === 'number' ? v : parseInt(String(v), 10) || 0);
          const cost = obj.total_cost_usd ?? obj.cost_usd;
          const inT = num(obj.usage?.input_tokens);
          const outT = num(obj.usage?.output_tokens);
          if (typeof cost === 'number') {
            onEvent({ type: 'cost', usd: cost, tokens: obj.tokens_used ?? inT + outT, tokensIn: inT, tokensOut: outT });
          } else if (obj.usage && inT + outT > 0) {
            // No cost field → estimate from token counts. Codex's own model isn't known here, so
            // this falls back to the Direct model's rate (rough — prefer when Codex reports cost).
            const usd = priceUSD(getSettings().model, inT, outT);
            onEvent({ type: 'cost', usd, tokens: inT + outT, tokensIn: inT, tokensOut: outT });
          }
          onEvent({ type: 'done' });
          break;
        }
        case 'turn.failed':
          sawTurnEnd = true;
          onEvent({ type: 'error', message: obj.error?.message ?? (typeof obj.error === 'string' ? obj.error : t(s.lang, 'eng.codexFailed')) });
          break;
        case 'error':
          if (obj.message) onEvent({ type: 'status', text: t(s.lang, 'eng.codexMsg', { msg: obj.message }) });
          break;
      }
    };

    const code = await runBin(bin, args, { cwd, signal, onLine });
    if (signal.aborted) return;
    if (!sawTurnEnd) {
      const tail = stderrTail.length ? ' — ' + stderrTail.join(' | ') : '';
      // CLI 版本不兼容时的友好提示(flag 改名/移除等)。
      const versionHint = /unknown flag|unrecognized|unexpected argument/i.test(tail)
        ? '\n💡 可能是 Codex CLI 版本不兼容,请检查并更新 codex 后重试。'
        : '';
      onEvent({ type: 'error', message: t(s.lang, 'eng.codexNoResult', { code, tail }) + versionHint });
    }
  }
}

import { DirectV2Engine } from './DirectV2Engine';
import { DirectV3Engine } from './V3';

export function buildEngines(confirm: (cmd: string) => Promise<boolean>): Map<EngineKind, Engine> {
  return new Map<EngineKind, Engine>([
    ['direct', new DirectEngine(confirm)],
    ['directV2', new DirectV2Engine(confirm)],
    ['directV3', new DirectV3Engine(confirm)],
    ['claudeCode', new ClaudeCodeEngine()],
    ['codex', new CodexEngine()],
  ]);
}
