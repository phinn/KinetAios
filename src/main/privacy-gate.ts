// privacy-gate.ts — 数据出网敏感闸(L1 隐私分层方案的工具层实现)。
// 开关:settings.privacyGateEnabled(默认 false,用户显式打开才生效)。
// 作用点:read_file / shell 两个「把本地内容送进对话(→ 下轮全量发给云端 API)」的出口。
// 命中敏感内容 → 走独立隐私弹窗(main.ts 注入的 confirmFn),用户放行才出去;拒绝则
// 替换为拦截说明,内容不进对话历史 = 不出网。
//
// ⚠️ 为什么不复用 shell 的 confirm 桥:那条链有「本会话不再询问」旁路和 approval=never
// /fullAccess 短路(2026-09 自查实锤)—— 用户对 shell 勾过一次不再询问,隐私闸就全程静默
// 放行,开了等于没开。隐私闸必须独立弹窗、独立 pending 表、不受任何 approval 设置短路。
//
// 规则:①密钥/凭据正则(高置信)②高熵随机串(疑似密钥)③敏感文件名/路径。
// 刻意不做通用 PII(身份证/手机号)—— 误报率不可接受,企业场景规则后续走自定义正则扩展点。
import { getSettings } from './settings';

// ── confirm 桥注入(main.ts 启动时调,避免 main↔tools 循环 import)──
type PrivacyConfirmFn = (msg: string) => Promise<boolean>;
let confirmFn: PrivacyConfirmFn | null = null;
export function setPrivacyConfirm(fn: PrivacyConfirmFn): void {
  confirmFn = fn;
}

// ── 高置信凭据模式 ── 命中任意一条即视为疑似敏感。
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,       // 私钥块
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/,                                  // OpenAI/Stripe 风格
  /\bAKIA[0-9A-Z]{16}\b/,                                             // AWS Access Key ID
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,                                   // Slack token
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,                                     // GitHub token
  /\bAIza[0-9A-Za-z_-]{30,}/,                                         // Google API key
  /GLM_[A-Za-z0-9]{20,}/,                                             // 智谱开放平台 key
  /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./,                 // JWT(三段式)
  /\b[aA]uthorization["']?\s*[:=]\s*["']?[bB]earer\s+[A-Za-z0-9._-]{20,}/, // Bearer 头
];

// 高熵检测:token 化后 Shannon 熵 ≥ 4.2 且长度 ≥ 20 的连续串(疑似密钥特征)。
function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// 从文本里抽疑似高熵 token(按 [A-Za-z0-9_-]{20,} 段切)。
function highEntropyTokens(text: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z0-9_-]{20,}/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[0];
    if (!seen.has(t)) {
      seen.add(t);
      if (shannonEntropy(t) >= 4.2) out.push(t);
    }
  }
  return out.slice(0, 5); // 最多报 5 个,弹窗别刷屏
}

// ── 敏感路径特征 ── 文件名即危险(.env / 密钥文件),这类连内容都不用看。
const SENSITIVE_PATH_RE =
  /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|id_ecdsa|\.npmrc|\.netrc|credentials(\.json)?|secrets?\.(ya?ml|json|txt))$/i;

export interface GateVerdict {
  hit: boolean;
  reasons: string[]; // 给用户弹窗看的理由(每条一行)
}

// 静态检测:给定「正要送进对话的文本」+ 可选来源路径,返回命中理由。
// 纯函数,不弹窗 —— 调用方决定 confirm 还是直接放行。
export function scanOutbound(text: string, sourcePath?: string): GateVerdict {
  const reasons: string[] = [];
  if (sourcePath && SENSITIVE_PATH_RE.test(sourcePath.trim())) {
    reasons.push(`文件本身是敏感凭据文件(${sourcePath.split('/').pop()})`);
  }
  for (const re of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) {
      reasons.push(`疑似密钥/凭据:${m[0].slice(0, 12)}…`);
      break; // 一条高置信命中就够,别罗列
    }
  }
  if (reasons.length === 0) {
    const toks = highEntropyTokens(text);
    if (toks.length > 0) {
      reasons.push(`${toks.length} 处高熵随机串(疑似密钥),如 ${toks[0].slice(0, 16)}…`);
    }
  }
  return { hit: reasons.length > 0, reasons };
}

// 本会话已放行的文件缓存:分页读同一文件不反复弹窗(用户放行过一次即信任整个文件)。
const approvedPaths = new Set<string>();

// 工具层统一入口:开关关闭 → 直接放行;开启且命中 → 独立隐私弹窗。
// 返回 null = 放行(无命中/用户同意/已缓存放行);string = 拦截说明(替换工具结果,内容不出网)。
// 弹窗 5 分钟无响应 auto-deny(main.ts 桥内处理)—— goal 无人值守时不会挂死循环。
export async function privacyGate(text: string, sourcePath?: string): Promise<string | null> {
  const S = getSettings();
  if (!S.privacyGateEnabled) return null; // 开关默认关:不启用不检测
  if (sourcePath && approvedPaths.has(sourcePath)) return null; // 本会话已放行过该文件
  const v = scanOutbound(text, sourcePath);
  if (!v.hit) return null;
  const msg =
    `数据出网拦截:即将发送给 AI 的内容命中敏感规则:\n` +
    v.reasons.map((r) => `· ${r}`).join('\n') +
    `\n\n放行 = 这些内容会进入对话并随下次 API 调用发送到模型端点。允许吗?`;
  if (!confirmFn) return `🔒 已拦截(隐私闸开启,但确认弹窗不可用):${v.reasons[0]}`;
  const ok = await confirmFn(msg);
  if (ok) {
    if (sourcePath) approvedPaths.add(sourcePath); // 放行整文件,后续分页读不再问
    return null;
  }
  return `🔒 已拦截(隐私闸开启):内容命中敏感规则(${v.reasons[0]}),未发送。可在设置中关闭隐私闸或放行后重试。`;
}
