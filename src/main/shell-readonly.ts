// ── 只读命令白名单:整条命令全部命中只读前缀才算"只读" ──
// 从 main.ts 提取(2026-11),两个调用方共用同一份判定:
//   ① main.ts 的 confirm —— 只读命令不弹窗(分析任务要跑大量 ls/grep/git status,
//      逐条弹窗会把人变成 agent 循环的瓶颈);
//   ② AgentLoop 的 codemode 引导 —— 判断这次 shell 是"探查"还是"动手",
//      决定要不要提示模型改用脚本一次跑完。
// 白名单只认"确定无副作用"的命令;写操作、重定向、命令替换、任何不在白名单的成员都算非只读。
// 判定放宽 = 少弹窗但可能漏拦写操作;收紧 = 安全但唠叨。两边共用一份,不会各说各话。
export const READONLY_CMD_RE =
  /^(ls|dir|type|more|cat|head|tail|wc|grep|rg|findstr|file|stat|du|df|which|where|echo|pwd|cd|jq|git (status|log|diff|show|branch|blame|shortlog|describe|ls-files)|pip (list|show)|node --version|python --version|python -V|--version)\b/i;

export function isReadOnlyCommand(cmd: string): boolean {
  const s = cmd.trim();
  if (!s) return false;
  // 重定向(写文件)、命令替换(可藏任意命令)→ 一律不算只读
  if (/[<>`]|\$\(/.test(s)) return false;
  // 按 shell 逻辑分隔符拆开,要求每一段都命中白名单(防 "ls && del x" 绕过)
  const parts = s.split(/&&|\|\||&|\||;|\n/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => READONLY_CMD_RE.test(p));
}
