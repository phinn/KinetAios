// Trust Dial v1(2026-11)—— 把「这个动作该不该自动放行」变成可解释的判定。
//
// 现实问题:二值 approve(always/never)两头都不对 —— always 会在 rm -rf 上弹窗
// 直到用户条件反射点"允许";never 又让人守着每一个读文件。用户真正想要的是
// 「读随便跑、可回滚的写看历史错误率、不可逆的必须问」。
//
// v1 边界(刻意保守):
//   - 纯函数,只产出建议 + 理由,**不改变现有 confirm 行为**(没有任何自动放行接线);
//   - 不信任模型自述的"这是只读命令":shell 一律按命令文本分类,拿不准就升级为不可逆;
//   - 历史错误率只对"可回滚写"生效,且样本 <5 次不给自动结论。
import type { UsageStats } from '../shared/types';

export type ActionClass = 'read' | 'reversible_write' | 'irreversible' | 'system';

export interface ActionProfile {
  tool: string;
  action: ActionClass;
  risk: 'none' | 'low' | 'medium' | 'high';
  reason: string;
}

export interface ToolStat {
  calls: number;
  measured: number;
  errors: number;
  rate: number;
}

export interface TrustVerdict extends ActionProfile {
  decision: 'auto' | 'ask';
  decideReason: string;
}

const READ_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'repo_map', 'diagnostics', 'usage_stats', 'grep_tool_output',
  'web_fetch', 'web_search', 'recall_memory', 'recall_fact', 'git_diff', 'skill_check',
  'job_result', 'cron_list', 'wait_for', 'ask_user', 'screenshot', 'screenshot_window',
  'verify_visual', 'browser_snapshot', 'browser_screenshot', 'browser_tabs', 'browser_cookie',
]);

const REVERSIBLE_WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'remember_fact', 'memory_append', 'memory_replace',
  'lesson_manage', 'todo_write', 'intent', 'intent_done', 'team_broadcast', 'team_send', 'team_close',
]);

const SYSTEM_TOOLS = new Set([
  'mouse_click', 'mouse_scroll', 'mouse_drag', 'keyboard_type', 'keyboard_key',
  'browser_navigate', 'browser_click', 'browser_type', 'browser_select', 'browser_eval',
  'browser_upload', 'ax_script', 'dispatch_agent', 'workflow_run', 'workflow_job',
  'spawn_team', 'remote_agent',
]);

const OUTBOUND_TOOLS = new Set([
  'feishu_send_file', 'wecom_send_file', 'video_gen', 'cron_manage',
  'wecom_approval_list', 'wecom_approval_detail',
]);

// shell 的破坏性特征:命中即不可逆。宁可多问一次,也不要在用户机器上不可撤销。
const SHELL_DESTRUCTIVE = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bgit\s+(?:push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--|branch\s+-D)\b/i,
  /\bnpm\s+publish\b/i,
  /\bsudo\b/i,
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /\b(?:del|erase|rmdir)\b/i,
  /\bDROP\s+(?:TABLE|DATABASE)\b/i,
  /\btruncate\s+table\b/i,
  /\bcurl[^|]*\|\s*(?:ba|z|fi)?sh\b/i,
  /\bchmod\s+-R\b/i,
  /\bmkfs\b/i,
  />\s*\/dev\/(?:sd|disk)/i,
];

// 明确读取型命令:只有全部片段都像读操作,才允许降到 read。
const SHELL_READONLY = /^(?:\s*(?:cd\s+\S+\s*&&\s*)?)(?:git\s+(?:status|log|diff|show|branch|remote|rev-parse|describe)|ls|ll|cat|head|tail|wc|grep|rg|find|pwd|echo|which|type|node\s+(?:-v|--version)|npm\s+(?:ls|list|run\s+typecheck)|npx\s+tsc\s+--noEmit|python3?\s+--version|uname|whoami|date)\b/;

/** shell 命令细分类:破坏性 > 明确只读 > 其余(未知副作用)。 */
export function classifyShellCommand(command: string): Pick<ActionProfile, 'action' | 'risk' | 'reason'> {
  const cmd = String(command ?? '').trim();
  if (!cmd) return { action: 'irreversible', risk: 'medium', reason: '空命令或无法解析,按不可逆处理' };
  const hit = SHELL_DESTRUCTIVE.find((re) => re.test(cmd));
  if (hit) {
    return { action: 'irreversible', risk: 'high', reason: `命中破坏性命令特征 ${hit.source}` };
  }
  // 重定向/管道进解释器都可能产生副作用,即使主体是 cat。
  if (/(?:^|[^>])>[^>&]|\|\s*(?:ba|z|fi)?sh\b/.test(cmd)) {
    return { action: 'irreversible', risk: 'medium', reason: '包含写重定向或管道执行,无法确认无副作用' };
  }
  if (SHELL_READONLY.test(cmd)) {
    return { action: 'read', risk: 'none', reason: '命令为只读查询(status/log/diff/ls/cat 等)' };
  }
  return { action: 'irreversible', risk: 'medium', reason: '命令可能产生未知副作用(非明确只读)' };
}

/** 动作分类:只看工具名 + 参数,不信任模型对"这是只读"的自述。 */
export function classifyAction(tool: string, args: Record<string, unknown> = {}): ActionProfile {
  const name = String(tool ?? '').trim();
  if (name === 'shell') {
    const cmd = String(args.command ?? args.cmd ?? '');
    const shell = classifyShellCommand(cmd);
    return { tool: name, ...shell };
  }
  if (READ_TOOLS.has(name)) return { tool: name, action: 'read', risk: 'none', reason: '只读工具' };
  if (REVERSIBLE_WRITE_TOOLS.has(name)) {
    return { tool: name, action: 'reversible_write', risk: 'low', reason: '可回滚的写(文件/记忆/清单,可用快照或 git 恢复)' };
  }
  if (SYSTEM_TOOLS.has(name)) return { tool: name, action: 'system', risk: 'high', reason: '直接操作桌面/浏览器/子代理,影响面超出工作目录' };
  if (OUTBOUND_TOOLS.has(name)) return { tool: name, action: 'irreversible', risk: 'high', reason: '对外发送或不可撤回的副作用(消息/发布/生成)' };
  return { tool: name, action: 'irreversible', risk: 'medium', reason: '未分类工具,按不可逆处理' };
}

/**
 * 给出信任建议。stat 是该工具近期遥测(usageStats().tools 中同名项);
 * 只有「可回滚写」会根据历史错误率放宽,其余一律按最小信任。
 */
export function decideTrust(profile: ActionProfile, stat?: ToolStat): TrustVerdict {
  if (profile.action === 'read') {
    return { ...profile, decision: 'auto', decideReason: '只读操作,无副作用' };
  }
  if (profile.action === 'reversible_write') {
    if (!stat || stat.measured < 5) {
      return { ...profile, decision: 'ask', decideReason: '历史样本不足(<5 次有效调用),先确认一次' };
    }
    if (stat.rate > 0.15) {
      return { ...profile, decision: 'ask', decideReason: `近期失败率 ${(stat.rate * 100).toFixed(1)}%(阈值 15%),需要人工确认` };
    }
    return { ...profile, decision: 'auto', decideReason: `可回滚 + 近期失败率 ${(stat.rate * 100).toFixed(1)}% 低于阈值` };
  }
  return {
    ...profile,
    decision: 'ask',
    decideReason: profile.action === 'system' ? '系统级操作始终需要确认' : '不可逆操作始终需要确认',
  };
}

/** 从 usageStats 结果里取某工具的历史表现。 */
export function findToolStat(stats: UsageStats | null | undefined, tool: string): ToolStat | undefined {
  const t = stats?.tools?.find((x) => x.name === tool);
  return t ? { calls: t.calls, measured: t.measured, errors: t.errors, rate: t.rate } : undefined;
}

export function formatTrustReport(profile: ActionProfile, verdict: TrustVerdict, stat?: ToolStat): string {
  const classLabel: Record<ActionClass, string> = {
    read: '只读', reversible_write: '可回滚写', irreversible: '不可逆', system: '系统级',
  };
  const lines = [
    `工具: ${profile.tool}`,
    `分类: ${classLabel[profile.action]}(风险 ${profile.risk})`,
    `建议: ${verdict.decision === 'auto' ? '自动放行(建议)' : '询问用户(建议)'}`,
    `理由: ${verdict.decideReason}`,
    `分类依据: ${profile.reason}`,
  ];
  if (stat) lines.push(`近期遥测: ${stat.calls} 次调用 / ${stat.errors} 次失败 / 失败率 ${(stat.rate * 100).toFixed(1)}%`);
  lines.push('注意: 这是建议,不改变当前确认策略(Trust Dial v1 未接线自动放行)。');
  return lines.join('\n');
}
