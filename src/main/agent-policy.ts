// agent.policy.json — 声明式策略(OpenShell 式最小版,2026-10 P2)。
// 位置:仓库根 / agent.policy.json(随仓库走,团队可提交共享;用户级放 <userData>/agent.policy.json)。
// 静态校验,不做运行时 syscall 拦截 —— 定位是「确认前的机械闸」:命中 deny 的命令直接拒,
// 不弹 confirm;命中 ask 的强制 confirm(即使工具默认免确认);allow 只是文档化白名单。
//
// schema(全字段可选,文件不存在 = 策略层不参与,行为与旧版完全一致):
// {
//   "version": 1,
//   "deny":   [{ "pattern": "^rm\\s+-rf\\s+/", "reason": "禁止根级递归删除" }],
//   "ask":    [{ "pattern": "gh\\s+release\\s+(create|edit)", "reason": "发布动作须人工确认" }],
//   "allow":  [{ "pattern": "^npm\\s+(run|test|install)", "reason": "常规构建命令" }]
// }
// pattern = JS 正则字符串(大小写不敏感),对完整命令文本匹配。第一条命中的 deny/ask 生效。
// 损坏 JSON / 非法正则 → 策略文件忽略 + console.warn(策略层永不阻断主流程可用性)。

import fs from 'node:fs';
import path from 'node:path';

export interface PolicyRule {
  pattern: string;
  reason?: string;
}
export interface AgentPolicy {
  version?: number;
  deny?: PolicyRule[];
  ask?: PolicyRule[];
  allow?: PolicyRule[];
}

interface CompiledPolicy {
  deny: Array<{ re: RegExp; reason: string }>;
  ask: Array<{ re: RegExp; reason: string }>;
  allow: Array<{ re: RegExp; reason: string }>;
  source: string;
}

let cache: { key: string; policy: CompiledPolicy | null } | null = null;

function compileRules(rules: PolicyRule[] | undefined, kind: string): Array<{ re: RegExp; reason: string }> {
  const out: Array<{ re: RegExp; reason: string }> = [];
  for (const r of rules ?? []) {
    try {
      out.push({ re: new RegExp(r.pattern, 'i'), reason: r.reason || `${kind} 规则命中` });
    } catch (e) {
      console.warn(`[agent-policy] 非法正则(${kind}): ${r.pattern} — ${(e as Error).message}`);
    }
  }
  return out;
}

function findPolicyFile(cwd: string): string | null {
  const candidates = [
    path.join(cwd || process.cwd(), 'agent.policy.json'),
    // 用户级兜底(跨仓库策略,如「任何仓库都禁 curl | sh」)
    (() => { try { const { app } = require('electron') as typeof import('electron'); return path.join(app.getPath('userData'), 'agent.policy.json'); } catch { return null; } })(),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 不存在,看下一个 */ }
  }
  return null;
}

/** 加载(带缓存,按 policy 文件路径+mtime 失效)。文件不存在返回 null = 策略层不参与。 */
export function loadAgentPolicy(cwd: string): CompiledPolicy | null {
  const file = findPolicyFile(cwd);
  if (!file) { cache = null; return null; }
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  const key = `${file}:${mtime}`;
  if (cache?.key === key) return cache.policy;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentPolicy;
    const policy: CompiledPolicy = {
      deny: compileRules(raw.deny, 'deny'),
      ask: compileRules(raw.ask, 'ask'),
      allow: compileRules(raw.allow, 'allow'),
      source: file,
    };
    cache = { key, policy };
    return policy;
  } catch (e) {
    console.warn(`[agent-policy] ${file} 解析失败,策略忽略: ${(e as Error).message}`);
    cache = { key, policy: null };
    return null;
  }
}

export interface PolicyVerdict {
  action: 'deny' | 'ask' | 'allow' | 'none';
  reason?: string;
  source?: string;
}

/**
 * 静态策略检查(shell 工具 confirm 之前调用)。
 * 顺序:deny → ask → allow(未命中 = none,走原有审批流)。
 */
export function checkAgentPolicy(cmd: string, cwd: string): PolicyVerdict {
  const policy = loadAgentPolicy(cwd);
  if (!policy) return { action: 'none' };
  for (const r of policy.deny) {
    if (r.re.test(cmd)) return { action: 'deny', reason: r.reason, source: policy.source };
  }
  for (const r of policy.ask) {
    if (r.re.test(cmd)) return { action: 'ask', reason: r.reason, source: policy.source };
  }
  for (const r of policy.allow) {
    if (r.re.test(cmd)) return { action: 'allow', reason: r.reason, source: policy.source };
  }
  return { action: 'none' };
}
