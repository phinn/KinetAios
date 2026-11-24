// agent.policy.json — 声明式策略(OpenShell 式最小版,2026-10 P2)。
// 位置:仓库根 / agent.policy.json(随仓库走,团队可提交共享;用户级放 <userData>/agent.policy.json)。
// 静态校验,不做运行时 syscall 拦截 —— 定位是「确认前的机械闸」:命中 deny 的命令直接拒,
// 不弹 confirm;命中 ask 的强制 confirm(即使工具默认免确认);allow 只是文档化白名单。
//
// schema(全字段可选,文件不存在 = 文件策略层不参与;内置高危规则始终生效):
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

// ── 内置高危规则(2026-11-24)──
// 不依赖任何策略文件:这几类操作一旦删错就没有"重跑一次"的机会,值得每次都让人看一眼。
// 触发它的真实事故(会话 b580efbe,2026-11-23 14:49):agent 想清掉 en-US 里 FAILED 的
// appPreview,脚本写成「遍历整个集合逐个 DELETE」,两条都返回 204 —— 唯一能用的原版预览
// 一起被删了。它在 3 分钟后的备忘录里写「旧 preview 在 1.9.9 容器,被我删了…」;
// 而那个视频从 10-16 就躺在 ~/Documents/kinet/artifacts/kb_preview_video/ 里,
// 它又花了 7 小时重造一个本来就在磁盘上的文件。
// 语义判断(哪条是 FAILED)机器做不对;能机械做的只有一件事:删之前让人看一眼。
const BUILTIN_ASK: Array<{ re: RegExp; reason: string }> = [
  {
    // 远端素材 / 版本 / 内购的删除:不可逆,且删掉的往往正是"线上唯一一份"。
    re: /(?:-X\s*DELETE|--request\s*DELETE|\bDELETE\b)[\s\S]{0,400}?(?:appPreviews|appScreenshots|appStoreVersions|inAppPurchases|appEvents|bundleIds)/i,
    reason: '远端删除不可逆:先确认本地母版还在,并核对这次到底删几个(2026-11-23 删掉过线上唯一可用的预览视频)',
  },
  {
    // for/while 里发删除请求 = 批量删,删几条由数据决定,命令文本本身看不出来。
    re: /(?:for|while)\s[\s\S]{0,240}?\bDELETE\b/i,
    reason: '循环里批量删除:命令文本看不出会删几条,先看清目标范围再放行',
  },
];

/**
 * 静态策略检查(shell 工具 confirm 之前调用)。
 * 顺序:文件 deny → 内置高危 ask → 文件 ask → 文件 allow(未命中 = none,走原有审批流)。
 */
export function checkAgentPolicy(cmd: string, cwd: string): PolicyVerdict {
  const policy = loadAgentPolicy(cwd);
  if (policy) {
    for (const r of policy.deny) {
      if (r.re.test(cmd)) return { action: 'deny', reason: r.reason, source: policy.source };
    }
  }
  // 内置规则排在文件 ask 之前:用户自己写的 allow 白名单不该把"删远端素材"放过去。
  for (const r of BUILTIN_ASK) {
    if (r.re.test(cmd)) return { action: 'ask', reason: r.reason, source: '内置高危规则' };
  }
  if (!policy) return { action: 'none' };
  for (const r of policy.ask) {
    if (r.re.test(cmd)) return { action: 'ask', reason: r.reason, source: policy.source };
  }
  for (const r of policy.allow) {
    if (r.re.test(cmd)) return { action: 'allow', reason: r.reason, source: policy.source };
  }
  return { action: 'none' };
}
