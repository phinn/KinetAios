// Tools: shell / read_file / write_file / web_fetch / recall_memory. Port of Swift Tool.swift.
// shell runs cross-platform via child_process.exec (cmd.exe on Windows, /bin/sh elsewhere).
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import type { Provider, ToolDef } from './glm';
import * as store from './store';
import { takeSnapshot } from './snapshots';
import type { ChatMsg, ConfigSnapshot, SandboxMode } from '../shared/types';
import { compactHistory } from './AgentLoop';

// Sanitize error messages before returning to the LLM — strip absolute paths and stack traces
// that could leak system info. The LLM only needs the gist (permission denied / not found / etc.).
// 错误信息脱敏:去掉绝对路径(可能含用户名/目录结构)和堆栈,只留可读部分。
function sanitizeError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  return msg
    .replace(/(?:\/[\w.@-]+)+\/?/g, '<path>') // 绝对路径 → <path>
    .replace(/(?:[A-Z]:\\[^<>:"|?*\r\n]*)/g, '<path>') // Windows 路径
    .replace(/at .+:\d+:\d+/g, '') // 堆栈行
    .trim()
    .slice(0, 300);
}

// Shell-quote a string for safe interpolation into a command (used by custom tools).
// 双引号包裹 + 转义特殊字符,防止 LLM 注入 shell 命令。
function shellQuote(s: string): string {
  return '"' + String(s).replace(/(["$`\\])/g, '\\$1') + '"';
}

// SSRF 防护:判断 hostname 是否为内网/本地/保留地址。
// 覆盖:IPv4 私有段(10/8、172.16/12、192.168/16)、loopback(127/8)、link-local(169.254/16)、
// CGNAT(100.64/10)、0.0.0.0/8、IPv6 loopback/ULA、.local mDNS、metadata 元数据端点。
function isPrivateHost(host: string): boolean {
  // IPv6 方括号剥离
  const h = host.replace(/^\[|\]$/g, '');
  // IPv4 数字提取(去掉 IPv6 映射前缀 ::ffff:)
  const v4Match = h.match(/^(?:::ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const ip = v4Match[1];
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 127) return true;                         // 0.0.0.0/8、127.0.0.0/8 (loopback)
    if (a === 10) return true;                                      // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;              // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                       // 192.168.0.0/16
    if (a === 169 && b === 254) return true;                       // 169.254.0.0/16 (link-local + cloud metadata)
    if (a === 100 && b >= 64 && b <= 127) return true;             // 100.64.0.0/10 (CGNAT)
    return false;
  }
  // IPv6 loopback / ULA
  if (h === '::1' || h === '::' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;       // IPv6 ULA fc00::/7
  if (h.startsWith('fe80')) return true;                            // IPv6 link-local
  // 主机名
  if (h === 'localhost') return true;
  if (h.endsWith('.local')) return true;
  if (h.endsWith('.internal')) return true;
  return false;
}

// 检查一个已解析的 IP 地址字符串是否为私有/保留地址。
// 与 isPrivateHost 不同,此函数接收 DNS 解析后的实际 IP,防止 DNS rebinding 攻击。
function isPrivateIP(ip: string): boolean {
  // IPv4
  const v4Match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4Match) {
    const [a, b] = [Number(v4Match[1]), Number(v4Match[2])];
    if (a === 0 || a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80')) return true;
  // IPv6 表达的 IPv4 地址(::ffff:x.x.x.x)
  const mapped = lower.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIP(mapped[1]);
  return false;
}

// SSRF 强化检查:解析 DNS → 验证所有解析结果 IP 都不是内网地址。
// 防止 DNS rebinding:攻击者第一次解析为公网 IP(通过 hostname 检查),实际 fetch 时解析到内网。
async function assertSafeHost(hostname: string): Promise<{ ok: boolean; reason?: string }> {
  const h = hostname.toLowerCase();
  // 第一层:hostname 字符串检查(快速路径)
  if (isPrivateHost(h)) return { ok: false, reason: `安全限制:不允许访问内网地址(${h})` };
  // 如果是 IP 字面量,不需要 DNS 解析
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h.includes(':')) {
    if (isPrivateIP(h)) return { ok: false, reason: `安全限制:不允许访问内网地址(${h})` };
    return { ok: true };
  }
  // 第二层:DNS 解析 → 检查所有 A/AAAA 记录
  try {
    const addrs = await dns.resolve4(h).catch(() => [] as string[]);
    const addrs6 = await dns.resolve6(h).catch(() => [] as string[]);
    const all = [...addrs, ...addrs6];
    if (all.length === 0) return { ok: true }; // 解析不到 → 让 fetch 自己报错
    for (const ip of all) {
      if (isPrivateIP(ip)) return { ok: false, reason: `安全限制:${h} 解析到内网地址(${ip}),拒绝访问` };
    }
  } catch {
    // DNS 解析失败 → 让 fetch 处理(不是 SSRF,只是域名不存在)
  }
  return { ok: true };
}

// Context threaded into every tool.run — cwd for relative paths + the shell confirm callback.
// spawn/signal only used by dispatch_agent (Direct injects them so it can start a sub-agent loop);
// every other tool ignores them。convId 用作快照 scope(write_file/edit_file 改前存原文)。
export type SubEngine = 'direct' | 'claudeCode' | 'codex';
// sub-agent 的 history 注入策略(P1)。默认 'none' = 完全独立,最便宜。
// last_n_turns(n) = 取 parent 最近 n 轮 user/assistant 注入子 agent 头部。
// summary_only = 跑一次 LLM 摘要 parent history 注入子 agent(成本高,慎用)。
// full_history = parent 全量 history 注入子 agent(可能很贵)。
export type SpawnScope = 'none' | 'last_n_turns' | 'summary_only' | 'full_history';
export type SpawnScopeConfig =
  | { mode: 'none' }
  | { mode: 'last_n_turns'; n: number }
  | { mode: 'summary_only' }
  | { mode: 'full_history' };

export interface ToolCtx {
  cwd: string;
  confirm: (cmd: string) => Promise<boolean>;
  spawn?: (a: {
    prompt: string;
    signal: AbortSignal;
    engine?: SubEngine;
    // 子 agent 用的模型(仅 Direct 引擎生效)。不传 = 复用主 agent 的 model。
    model?: string;
    // P1:子 agent 拿到多少 parent history。默认 'none'(完全独立)。
    scope?: SpawnScopeConfig;
    // parent history:spawn 实现方用来按 scope 切片,不传给子 agent 自身。
    parentHistory?: ChatMsg[];
    // parent provider/snap:仅 summary_only 需要(调 LLM 摘要时用)。
    parentProvider?: Provider;
    parentSnap?: ConfigSnapshot;
  }) => Promise<string>;
  // P2:AgentTeams 调度。给定 teamId + memberNames + message,实现方负责跑每个 member 并把结果串成文本。
  // broadcast 时返回多成员拼接结果;send 单成员时返回该成员结果。
  teamRun?: (a: { teamId: string; memberNames: string[]; message: string }) => Promise<string>;
  signal?: AbortSignal;
  convId?: string;
  sandbox?: SandboxMode; // 沙箱级别:readOnly 拦截写工具,workspaceWrite 限制 cwd 内写
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly?: boolean; // 只读工具可同轮并发执行;写工具(shell/write_file/edit_file)留空 → 串行
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string>;
}

// OpenAI function-calling definition.
export function toolDef(t: Tool): ToolDef {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

// Shared shell runner (the shell tool uses it). exec picks the platform shell automatically:
// process.env.ComSpec (cmd.exe) on Windows, /bin/sh on unix. Raised maxBuffer so big outputs survive.
// 120s default — 30s killed real work (npm install / builds). Still bounded so a runaway can't hang.
//
// Windows 编码修复:cmd.exe 默认 codepage 936 (GBK),中文输出 toString('utf8') 会乱码。
// 修复策略:Windows 下用 `chcp 65001` 切换到 UTF-8 codepage,再用 execFile 直接捕获 Buffer,
// 通过 decodeBuffer 转码(复用 read_file 的编码检测逻辑)。
export function shellExec(command: string, cwd: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<string> {
  // Windows:前缀 chcp 65001 切换 codepage,避免 GBK 中文乱码
  const isWin = process.platform === 'win32';
  const finalCmd = isWin ? `chcp 65001 >nul 2>nul & ${command}` : command;

  return new Promise((resolve) => {
    const child = exec(
      finalCmd,
      { cwd: cwd || undefined, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          resolve(`[超时(${Math.round(timeoutMs / 1000)}s),已终止。]\n`);
          return;
        }
        // Windows 下即使 chcp 65001,某些程序仍输出 GBK(如 dir、ipconfig)。
        // 如果 stdout 含乱码特征(替换字符 \uFFFD),尝试从 latin1 重新解码。
        let out = (stdout || '') + (stderr || '');
        if (isWin && out.includes('\uFFFD')) {
          // 乱码检测:可能是因为 child 进程输出了非 UTF-8 字节但被 exec 以 utf8 强解码
          // 此时无法可靠恢复原始字节,但至少 chcp 65001 前缀已覆盖大多数场景
        }
        const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code ?? 1 : 0;
        if (err && code !== 0) out = `[exit ${code}] ${out}`;
        if (!out.trim()) out = '(无输出)\n';
        resolve(out);
      },
    );
    // 支持 abort:用户点"停止"时杀掉正在跑的子进程。
    // 必须在 child 正常退出时 removeEventListener,否则 dead listener 永久挂在 AbortSignal 上。
    if (signal) {
      if (signal.aborted) child.kill('SIGKILL');
      else {
        const onAbort = (): void => { void child.kill('SIGKILL'); };
        signal.addEventListener('abort', onAbort, { once: true });
        child.on('close', () => signal.removeEventListener('abort', onAbort));
      }
    }
  });
}

const shell: Tool = {
  name: 'shell',
  description: '在用户电脑上执行 shell 命令(文件操作、git、系统信息等)。执行前会请求用户确认。Windows 上走 cmd.exe,其它系统走 /bin/sh。',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
    required: ['command'],
  },
  async run(args, ctx) {
    const cmd = (args.command as string) ?? '';
    const ok = await ctx.confirm(cmd);
    if (!ok) return `❌ 用户拒绝执行: ${cmd}`;
    const out = await shellExec(cmd, ctx.cwd, 120_000, ctx.signal);
    return out.length > 20000 ? out.slice(0, 20000) + '\n…[输出过长,已截断]' : out; // 防止大输出撑爆对话上下文
  },
};

// ── 编码检测 ──
// Windows 上大量文件是 GBK/GB18030/Big5/Shift_JIS 编码,直接 toString('utf8') 会产生乱码。
// 用 BOM + 启发式判断,再通过 TextDecoder 转成 UTF-8 字符串。
// TextDecoder 是 Node 内置(无需 iconv-lite),原生支持 gb18030/gbk/big5/shift_jis/euc-kr 等。
function decodeBuffer(buf: Buffer): string {
  // 1. BOM 检测(最可靠)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8'); // UTF-8 BOM,跳过 3 字节
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2)); // UTF-16 LE BOM
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2)); // UTF-16 BE BOM
  }

  // 2. 纯 ASCII → 直接 toString
  let isAscii = true;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) { isAscii = false; break; }
  }
  if (isAscii) return buf.toString('utf8');

  // 3. UTF-8 验证:逐字节检查是否符合 UTF-8 编码规则
  if (isValidUtf8(buf)) return buf.toString('utf8');

  // 4. 非 UTF-8 → 按平台猜编码
  // GB18030 是 GBK/GB2312 超集,覆盖简体中文;Big5 覆盖繁体;Shift_JIS 覆盖日文。
  // 启发式:看高频双字节区间分布(粗略,够用)。
  const enc = guessEncoding(buf);
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    // TextDecoder 不支持该编码 → 最后兜底当 utf8(可能有乱码但不崩溃)
    return buf.toString('utf8');
  }
}

// 严格 UTF-8 校验:逐字节验证多字节序列的合法范围。
function isValidUtf8(buf: Buffer): boolean {
  const len = buf.length;
  let i = 0;
  while (i < len) {
    const b = buf[i];
    if (b <= 0x7f) { i++; continue; }         // ASCII
    if (b >= 0xc2 && b <= 0xdf) {              // 2-byte
      if (i + 1 >= len) return false;
      if ((buf[i + 1] & 0xc0) !== 0x80) return false;
      i += 2;
    } else if (b >= 0xe0 && b <= 0xef) {       // 3-byte
      if (i + 2 >= len) return false;
      if ((buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80) return false;
      i += 3;
    } else if (b >= 0xf0 && b <= 0xf4) {       // 4-byte
      if (i + 3 >= len) return false;
      if ((buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80 || (buf[i + 3] & 0xc0) !== 0x80) return false;
      i += 4;
    } else {
      return false; // 非法 UTF-8 起始字节
    }
  }
  return true;
}

// 启发式编码猜测:统计各编码特征字节的出现频率。
// GBK/GB18030: 第一字节 0x81-0xFE,第二字节 0x40-0x7E 或 0x80-0xFE
// Big5:        第一字节 0xA1-0xF9,第二字节 0x40-0x7E 或 0xA1-0xFE
// Shift_JIS:   第一字节 0x81-0x9F 或 0xE0-0xFC,第二字节 0x40-0x7E 或 0x80-0xFC
function guessEncoding(buf: Buffer): string {
  let gbkScore = 0;
  let big5Score = 0;
  let sjisScore = 0;
  const len = Math.min(buf.length, 8192); // 只看前 8KB
  let i = 0;
  while (i + 1 < len) {
    const b0 = buf[i];
    const b1 = buf[i + 1];
    if (b0 <= 0x7f) { i++; continue; } // ASCII,跳过

    // GBK/GB18030 匹配
    if (b0 >= 0x81 && b0 <= 0xfe && ((b1 >= 0x40 && b1 <= 0x7e) || (b1 >= 0x80 && b1 <= 0xfe))) {
      gbkScore++;
      i += 2;
      continue;
    }
    // Big5 匹配
    if (b0 >= 0xa1 && b0 <= 0xf9 && ((b1 >= 0x40 && b1 <= 0x7e) || (b1 >= 0xa1 && b1 <= 0xfe))) {
      big5Score++;
      i += 2;
      continue;
    }
    // Shift_JIS 匹配
    if ((b0 >= 0x81 && b0 <= 0x9f || b0 >= 0xe0 && b0 <= 0xfc) && ((b1 >= 0x40 && b1 <= 0x7e) || (b1 >= 0x80 && b1 <= 0xfc))) {
      sjisScore++;
      i += 2;
      continue;
    }
    i++;
  }
  // 取最高分,默认 GB18030(GBK 超集,最通用)
  if (big5Score > gbkScore && big5Score > sjisScore) return 'big5';
  if (sjisScore > gbkScore && sjisScore > big5Score) return 'shift_jis';
  return 'gb18030';
}

const readFile: Tool = {
  name: 'read_file',
  readOnly: true,
  description: '读取本地文件内容(UTF-8 文本)。可选 start_line/end_line 按行范围读取大文件。不传行范围则读全文(上限 50000 字符)。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径或相对路径' },
      start_line: { type: 'number', description: '起始行号(1-based,含)。不传则从头读。' },
      end_line: { type: 'number', description: '结束行号(1-based,含)。不传则读到末尾。' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const p = expandPath((args.path as string) ?? '', ctx.cwd);
    if (!p) return '缺少 path';
    // 沙箱检查:readOnly 模式限制读取范围在 cwd 内(防止 LLM 读 ~/.ssh/id_rsa 等)
    if (ctx.sandbox === 'readOnly') {
      const guard = sandboxCheck(ctx.sandbox, p, ctx.cwd, false);
      if (guard) return guard;
    }
    const startLine = args.start_line ? Math.max(1, Math.floor(Number(args.start_line))) : 1;
    const endLine = args.end_line ? Math.max(1, Math.floor(Number(args.end_line))) : undefined;
    try {
      const stat = fs.statSync(p);
      // 防止 read_file 大文件(PDF/图片等二进制)把主进程读 OOM —— 之前没限制是崩溃主因。
      if (stat.size > 2 * 1024 * 1024) return `文件过大(${(stat.size / 1024 / 1024).toFixed(1)}MB),read_file 上限 2MB。改用 shell 按需读(如 head/sed/grep)。`;
      // 二进制检测:先读 Buffer,前 8KB 有 null byte → 拒绝(避免 utf8 解码二进制产生乱码)。
      const buf = fs.readFileSync(p);
      const checkLen = Math.min(buf.length, 8192);
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0) return `二进制文件(非文本),read_file 不支持。改用 shell 工具(如 xxd/head/strings)。`;
      }
      // 编码检测:BOM → ASCII → UTF-8 校验 → 启发式(GBK/Big5/Shift_JIS)。
      // Windows 上大量文件是 GBK 编码,直接 toString('utf8') 会产生乱码。
      const body = decodeBuffer(buf);

      // 按行范围读取(如果指定了 start_line / end_line)。
      const lines = body.split('\n');
      const totalLines = lines.length;

      // 有行范围 → 切片(1-based → 0-based)。
      if (startLine > 1 || endLine !== undefined) {
        const sIdx = startLine - 1;
        const eIdx = endLine !== undefined ? Math.min(endLine, totalLines) : totalLines;
        if (sIdx >= totalLines) return `起始行 ${startLine} 超出文件总行数 ${totalLines}。`;
        const slice = lines.slice(sIdx, eIdx);
        // 带行号前缀输出,方便模型引用具体行。
        const numbered = slice.map((line, i) => `${sIdx + i + 1}: ${line}`).join('\n');
        const rangeEnd = sIdx + slice.length;
        const suffix = rangeEnd < totalLines
          ? `\n\n[行 ${startLine}-${rangeEnd}/${totalLines},还有 ${totalLines - rangeEnd} 行未读。用 start_line=${rangeEnd + 1} 继续读]`
          : `\n\n[行 ${startLine}-${rangeEnd}/${totalLines},文件读完]`;
        return numbered + suffix;
      }

      // 无行范围 → 全文(上限 50000 字符,之前 20000 太小,常导致文件读不全)。
      if (body.length <= 50000) return body;

      // 超长文件:提示模型用行范围分页读。
      const truncated = body.slice(0, 50000);
      const linesInTruncated = truncated.split('\n').length;
      return truncated + `\n\n…[文件共 ${totalLines} 行,已显示前 ${linesInTruncated} 行(50000 字符上限)。用 start_line=${linesInTruncated + 1} 继续读后续内容]`;
    } catch {
      return `读不到: ${p}`;
    }
  },
};

// write_file takes path+content directly — avoids the echo/cat/heredoc escaping hell.
const writeFile: Tool = {
  name: 'write_file',
  description:
    '把字符串写入本地文件(覆盖)。**所有文件写入都必须用这个工具**,无论多大(几 KB、几十 KB、几百 KB 都可以一次性写入),工具本身没有长度限制。绝对禁止用 shell echo/cat/heredoc 或 python 写文件 —— 那些方式会因为 JSON/shell 双层转义出错。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径或相对路径' },
      content: { type: 'string', description: '要写入的完整内容' },
    },
    required: ['path', 'content'],
  },
  async run(args, ctx) {
    const p = expandPath((args.path as string) ?? '', ctx.cwd);
    const content = (args.content as string) ?? '';
    if (!p) return '缺少 path';
    // 沙箱检查:readOnly 拦截写;workspaceWrite 限制 cwd 内。
    const guard = sandboxCheck(ctx.sandbox, p, ctx.cwd, true);
    if (guard) return guard;
    try {
      // 写前快照(仅当文件已存在,新文件没东西可存)。best-effort,失败不阻塞。
      if (ctx.convId && fs.existsSync(p)) {
        try {
          const before = decodeBuffer(fs.readFileSync(p));
          takeSnapshot({ convId: ctx.convId, cwd: ctx.cwd, absPath: p, tool: 'write_file', contentBefore: before });
        } catch { /* snapshot 失败不影响主流程 */ }
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      return `已写入 ${p} (${Buffer.byteLength(content, 'utf8')} 字节)`;
    } catch (e) {
      return `写入失败: ${sanitizeError(e)}`;
    }
  },
};

// ── 网页工具:web_fetch + web_search ──────────────────────────
// B+C 方案适配大陆网络:Jina Reader 和 Google/DDG 在大陆被墙,
// 回退链路改为:Bing 中国版(搜索) + 原生 fetch + 正则去噪(抓取)。

// 通用浏览器 headers — 很多站点拒绝默认 Node fetch UA。
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

// 从 HTML 中提取正文:去掉 script/style/nav/footer 等噪声,保留文字。
// Simple Readability — 不引外部依赖,用正则做基础去噪 + 文本提取。
function extractTextFromHTML(html: string): string {
  let s = html;
  // 移除噪声标签及其内容
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  s = s.replace(/<header[\s\S]*?<\/header>/gi, '');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // 块级标签 → 换行
  s = s.replace(/<(?:p|div|br|h[1-6]|li|tr|blockquote|pre)[^>]*>/gi, '\n');
  // 去所有剩余标签
  s = s.replace(/<[^>]+>/g, '');
  // HTML entities
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  // 压缩空白
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// 尝试 Jina Reader(大陆可能被墙,15s 超时后静默回退)。
// 成功返回正文文本,失败返回 null。
async function tryJinaReader(targetUrl: string): Promise<string | null> {
  try {
    const jinaUrl = `https://r.jina.ai/${targetUrl}`;
    const jinaResp = await fetch(jinaUrl, {
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' },
      signal: AbortSignal.timeout(12_000),
    });
    if (jinaResp.ok) {
      const text = await jinaResp.text();
      if (text.length > 200) {
        return text.length > 16_000 ? text.slice(0, 16_000) + '\n…[截断]' : text;
      }
    }
  } catch {
    // 超时/连接失败 → 静默
  }
  return null;
}

const webFetch: Tool = {
  name: 'web_fetch',
  readOnly: true,
  description: '抓取一个 http(s) URL 的正文内容(GET)。优先返回干净的 Markdown/纯文本(去广告/导航/脚本噪声)。',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
    required: ['url'],
  },
  async run(args, ctx) {
    const s = (args.url as string) ?? '';
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return `非法 URL: ${s}`;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `非法 URL: ${s}`;
    // SSRF 防护:阻止访问内网/本地地址
    const host = url.hostname.toLowerCase();
    const safe = await assertSafeHost(host);
    if (!safe.ok) {
      return safe.reason ?? `安全限制:不允许访问内网地址(${host})`;
    }

    const timeout = ctx?.signal ?? AbortSignal.timeout(25_000);

    // ── 路径 1: Jina Reader(如果可达,返回干净 Markdown)──
    const jinaResult = await tryJinaReader(s);
    if (jinaResult) return jinaResult;

    // ── 路径 2: 原生 fetch + 正则去噪 ──
    try {
      const resp = await fetch(s, { headers: BROWSER_HEADERS, signal: timeout, redirect: 'follow' });
      const raw = await resp.text();
      const ct = resp.headers.get('content-type') ?? '';

      // JSON / 纯文本 → 直接用
      if (ct.includes('application/json') || ct.includes('text/plain')) {
        const body = raw.length > 500_000 ? raw.slice(0, 500_000) + '\n…[截断]' : raw;
        const trimmed = body.length > 12_000 ? body.slice(0, 12_000) + '\n…[截断]' : body;
        return `[HTTP ${resp.status}]\n${trimmed}`;
      }

      // HTML → 提取正文
      const extracted = extractTextFromHTML(raw);
      const trimmed = extracted.length > 12_000 ? extracted.slice(0, 12_000) + '\n…[截断]' : extracted;
      return `[HTTP ${resp.status}]\n${trimmed}`;
    } catch (e) {
      return `抓取失败: ${sanitizeError(e)}`;
    }
  },
};

// web_search: 多搜索引擎回退,适配大陆网络。
// 回退顺序:搜狗(大陆直连,相关性最好) → Bing RSS(结构化) → Bing 中国版 HTML → DuckDuckGo。
// 模型不需要关心用了哪个引擎,只看结果。
const webSearch: Tool = {
  name: 'web_search',
  readOnly: true,
  description: '用搜索引擎搜索关键词,返回相关结果的标题、摘要和链接(通常 8-10 条)。先用此工具找到有用链接,再用 web_fetch 抓取详情。适合查询最新信息、技术文档、新闻等。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      max_results: { type: 'number', description: '最大返回条数(默认 8,最大 15)' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const q = String(args.query ?? '').trim();
    if (!q) return '请提供搜索关键词。';
    const maxResults = Math.min(Number(args.max_results ?? 8), 15);
    const signal = ctx?.signal ?? AbortSignal.timeout(20_000);

    const format = (results: Array<{ title: string; snippet: string; url: string }>) =>
      `搜索「${q}」返回 ${results.length} 条结果:\n\n${results
        .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`)
        .join('\n\n')}`;

    // ── 引擎 1: 搜狗(大陆直连;实测相关性最好) ──
    // Bing 在大陆网络下被地域重写:英文 query 混入中文市场结果("M2 MacBook" →
    // 广义货币供应量/BMW M2),小模型拿到的全是垃圾。搜狗对中英文 query 都准。
    try {
      const results = await sogouSearch(q, maxResults, signal);
      if (results.length > 0) return format(results);
    } catch {
      // 搜狗失败 → 尝试下一个引擎
    }

    // ── 引擎 2: Bing RSS(结构化 XML,干净 URL + 真实摘要) ──
    try {
      const results = await bingRssSearch(q, maxResults, signal);
      if (results.length > 0) return format(results);
    } catch {
      // RSS 失败 → 尝试下一个引擎
    }

    // ── 引擎 3: Bing 中国版 HTML(大陆直连备用) ──
    try {
      const results = await bingSearch(q, maxResults, signal);
      if (results.length > 0) return format(results);
    } catch {
      // Bing HTML 失败 → 尝试下一个引擎
    }

    // ── 引擎 4: DuckDuckGo HTML(大陆需翻墙,最后备用) ──
    try {
      const results = await ddgSearch(q, maxResults, signal);
      if (results.length > 0) return format(results);
    } catch {
      // DDG 也失败
    }

    return `搜索「${q}」失败:所有搜索引擎均不可用。可能是网络限制,尝试用 web_fetch 直接抓取已知 URL。`;
  },
};

// 搜狗搜索 —— 解析 www.sogou.com/web?query=... 结果页。
// 结果在 <h3 class="vr-title"><a href="/link?url=...">;href 是中转跳转,
// 需请求中转页解析 window.location.replace("真实URL")。
// 摘要结构不稳,取不到就空,靠 web_fetch 兜底 —— 标题+URL 对模型已够选条目。
async function sogouSearch(query: string, maxResults: number, signal: AbortSignal): Promise<Array<{ title: string; snippet: string; url: string }>> {
  const resp = await fetch(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`, {
    headers: { ...BROWSER_HEADERS, Referer: 'https://www.sogou.com/' },
    signal,
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error(`Sogou HTTP ${resp.status}`);
  const html = await resp.text();
  // 搜狗无结果/风控页:无 vr-title 块 → 返回空,自然回退到下一引擎
  const items = [...html.matchAll(/<h3[^>]*vr-title[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].slice(0, maxResults);
  if (!items.length) return [];

  // 中转 URL 解析:每个结果多一次请求,并发执行(串行 8 条会拖到数秒)
  const resolved = await Promise.all(items.map(async (m): Promise<{ title: string; url: string } | null> => {
    const title = m[2].replace(/<[^>]+>/g, '').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
    let link = m[1].replace(/&amp;/g, '&');
    if (link.startsWith('/')) link = 'https://www.sogou.com' + link;
    if (!/^https?:\/\/www\.sogou\.com\/link/.test(link)) return { title, url: link }; // 直链(微信公众号等)
    try {
      const r = await fetch(link, {
        headers: { ...BROWSER_HEADERS, Referer: 'https://www.sogou.com/' },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      const loc = r.headers.get('location'); // 情况 A: 302
      if (loc && /^https?:/.test(loc)) return { title, url: loc };
      const t = await r.text(); // 情况 B: 200 + JS redirect 页
      const jm = t.match(/window\.location\.replace\("([^"]+)"\)/) ?? t.match(/URL='?([^"'>]+)/i);
      if (jm && /^https?:/.test(jm[1])) return { title, url: jm[1] };
    } catch { /* 单条解析失败丢弃 */ }
    return null;
  }));
  return resolved.filter((r): r is { title: string; url: string } => !!r && !!r.title)
    .map((r) => ({ title: r.title, snippet: '', url: r.url }));
}

// Bing RSS 搜索 —— global.bing.com/search?format=rss 返回结构化 XML:
// 每个 <item> 含干净的 <title>/<link>(真实 URL,无 ck/a 跳转)/<description>(摘要)。
// RSS 端点不受 HTML 页面地域重写影响,英文 query 不会混入中文市场结果。
async function bingRssSearch(query: string, maxResults: number, signal: AbortSignal): Promise<Array<{ title: string; snippet: string; url: string }>> {
  const rssUrl = `https://global.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(maxResults + 5, 20)}&format=rss`;
  const resp = await fetch(rssUrl, {
    headers: { ...BROWSER_HEADERS, 'Accept': 'application/rss+xml,application/xml,text/xml,*/*' },
    signal,
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error(`Bing RSS HTTP ${resp.status}`);
  const xml = await resp.text();

  const results: Array<{ title: string; snippet: string; url: string }> = [];
  const items = xml.split(/<item>/i);
  for (let i = 1; i < items.length && results.length < maxResults; i++) {
    const item = items[i].split(/<\/item>/i)[0];
    const title = (item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const link = (item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? '').trim();
    const snippet = (item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? '')
      .replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
    if (!title || !link || !/^https?:/.test(link)) continue;
    results.push({ title, snippet, url: link });
  }
  return results;
}

// Bing 中国版搜索解析 —— 解析 cn.bing.com/search?q=... 的 HTML 结果页。
// b_algo 块含 <h2><a href> 标题</a></h2> 和 <p class="b_lineclamp*"> 摘要。
async function bingSearch(query: string, maxResults: number, signal: AbortSignal): Promise<Array<{ title: string; snippet: string; url: string }>> {
  const bingUrl = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(maxResults + 5, 20)}&setlang=zh-CN`;
  const resp = await fetch(bingUrl, {
    headers: { ...BROWSER_HEADERS, 'Referer': 'https://cn.bing.com/' },
    signal,
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error(`Bing HTTP ${resp.status}`);
  const html = await resp.text();

  const results: Array<{ title: string; snippet: string; url: string }> = [];
  // 按 b_algo 分割结果块
  const blocks = html.split('class="b_algo"');
  for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
    const block = blocks[i];
    // 提取 <h2 ...><a ... href="URL">标题</a></h2>
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const url = titleMatch[1];
    const title = titleMatch[2].replace(/<[^>]+>/g, '').trim();
    if (!title || !url || url.startsWith('javascript:')) continue;

    // 提取摘要:<p class="b_lineclamp*"> 或 <div class="b_caption">
    const snippetMatch = block.match(/<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ').trim()
      : '';

    results.push({ title, snippet, url });
  }
  return results;
}

// DuckDuckGo HTML 搜索解析 —— 解析 html.duckduckgo.com/html/?q=... 的结果页。
async function ddgSearch(query: string, maxResults: number, signal: AbortSignal): Promise<Array<{ title: string; snippet: string; url: string }>> {
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(ddgUrl, {
    headers: { ...BROWSER_HEADERS, 'Referer': 'https://duckduckgo.com/' },
    signal,
  });
  if (!resp.ok) throw new Error(`DDG HTTP ${resp.status}`);
  const html = await resp.text();

  const results: Array<{ title: string; snippet: string; url: string }> = [];
  const blocks = html.split(/class="result\s/);
  for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
    const block = blocks[i];
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    let link = titleMatch[1];
    const uddgMatch = link.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      link = decodeURIComponent(uddgMatch[1]);
    } else if (link.startsWith('//')) {
      link = 'https:' + link;
    }
    const title = titleMatch[2].replace(/<[^>]+>/g, '').trim();
    if (!title || !link) continue;

    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim()
      : '';

    results.push({ title, snippet, url: link });
  }
  return results;
}

const recallMemory: Tool = {
  name: 'recall_memory',
  readOnly: true,
  description: '语义搜索用户的历史(长期记忆 + 会话摘要 + 历史对话)。先走 embedding cosine 召回(语义近似),无 embedding 时回退 FTS5 关键词(支持中文 bigram 分词)。搜索范围:episodic_memories(会话摘要)、memories(长期事实)、history(对话原文)、知识图谱三元组。需要回忆过去做过/聊过什么时用。',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: '搜索关键词或语义描述' } },
    required: ['query'],
  },
  async run(args) {
    const q = (args.query as string) ?? '';
    // 三级检索:embedding cosine(facts)→ FTS5 召回 + embedding 重排(history)→ 关键词兜底。
    // ponytail ceiling:embedding 只覆盖 memories 表(facts);history 表用 FTS5 召回 + embedding 重排(无存储,实时算)。
    try {
      // Stage 1:语义召回 facts(embedding cosine top-K)
      const embedRows = store.listMemoryEmbeddings();
      if (embedRows.length) {
        const { embed } = await import('./glm');
        const { snapshot } = await import('./settings');
        const snap = snapshot();
        const qVecArr = await embed([q], snap);
        if (qVecArr[0]?.length) {
          const qVec = new Float32Array(qVecArr[0]);
          const scored = embedRows
            .map((r) => ({ memoryId: r.memoryId, content: r.content, score: store.cosine(qVec, r.vec) }))
            .filter((r) => r.score > 0.2)
            .sort((a, b) => b.score - a.score)
            .slice(0, 20);
          if (scored.length >= 3) {
            // 命中的记忆 touch 一下(更新 lastUsed + useCount → 衰减权重 / 时间线统计才有数据)。
            for (const s of scored) {
              try { store.touchMemoryUsed(s.memoryId); } catch { /* non-blocking */ }
            }
            const body = scored
              .map((m, i) => {
                const cut = m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content;
                return `[${i + 1}] (score ${m.score.toFixed(2)}) ${cut}`;
              })
              .join('\n');
            // 知识图谱三元组也参与检索
            const tripleHits = store.searchMemoryTriples(q, 5);
            const tripleBody = tripleHits.length
              ? '\n\n## 知识图谱\n' + tripleHits.map((t, i) => `[${i + 1}] ${t.subject} → ${t.predicate} → ${t.object}`).join('\n')
              : '';
            // 会话摘要也参与检索(即使 embedding 命中充足,摘要通常信息密度更高)
            const episodeHits = store.searchEpisodicMemories(q, 5);
            const episodeBody = episodeHits.length
              ? '\n\n## 会话摘要\n' + episodeHits.map((e, i) => `[${i + 1}] ${e.summary.slice(0, 300)}`).join('\n')
              : '';
            return `语义命中 ${scored.length} 条记忆:\n${body}${tripleBody}${episodeBody}`;
          }
        }
      }
    } catch (e) {
      console.warn('[recall] embed path failed, fallback to FTS5:', (e as Error)?.message);
    }
    // Stage 2:FTS5 召回(宽)+ embedding 重排(准)—— 对 history 表(对话原文)。
    // 无 embedding 或 facts 语义命中 <3 条时走此路径。
    const memHits = store.searchMemories(q, 20);
    // 知识图谱三元组也参与检索(之前只写不读)
    const tripleHits = q ? store.searchMemoryTriples(q, 10) : [];
    // FTS5 fallback —— 覆盖对话历史(role/content 全文索引)。
    // FTS5 特殊字符(" * NEAR 等)可能导致语法错误 → try/catch
    let hits: Array<{ role: string; content: string }> = [];
    try {
      hits = store.search(q, 30); // 多取一些供重排
    } catch {
      // FTS5 语法错误 → 用转义后的查询重试
      hits = store.search(q.replace(/["*]/g, ' '), 30);
    }
    // 对 FTS5 结果做 embedding 重排(如果有 embedding 接口)——提升语义精确度。
    if (hits.length > 3) {
      try {
        const { embed } = await import('./glm');
        const { snapshot } = await import('./settings');
        const snap = snapshot();
        const hitTexts = hits.map((h) => h.content.slice(0, 500));
        const hitVecs = await embed(hitTexts, snap);
        const qVecArr = await embed([q], snap);
        if (qVecArr[0]?.length) {
          const qVec = new Float32Array(qVecArr[0]);
          hits = hits
            .map((h, i) => ({
              h,
              score: hitVecs[i]?.length ? store.cosine(qVec, new Float32Array(hitVecs[i])) : 0,
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 20)
            .map((x) => x.h);
        }
      } catch {
        // embedding 重排失败 → 保持 FTS5 原始顺序
      }
    }
    // 会话摘要(episodic_memories)— 之前完全漏搜,是召回率低的主因之一
    const episodeHits = q ? store.searchEpisodicMemories(q, 10) : [];

    // 合并结果:episodic(会话摘要) + memories(长期记忆) + triples(知识图谱) + history(对话历史)
    const allResults: Array<{ source: string; content: string }> = [
      ...episodeHits.map((e) => {
        const cut = e.summary.length > 300 ? e.summary.slice(0, 300) + '…' : e.summary;
        return { source: '摘要', content: cut };
      }),
      ...memHits.map((m) => {
        const cut = m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content;
        return { source: '记忆', content: cut };
      }),
      ...tripleHits.map((t) => ({
        source: '图谱',
        content: `${t.subject} → ${t.predicate} → ${t.object}`,
      })),
      ...hits.map((m) => {
        const preview = m.content.replace(/\n/g, ' ');
        const cut = preview.length > 200 ? preview.slice(0, 200) + '…' : preview;
        return { source: m.role, content: cut };
      }),
    ];
    if (!allResults.length) return `没有匹配「${q}」的历史。`;
    const body = allResults
      .map((m, i) => `[${i + 1}] (${m.source}) ${m.content}`)
      .join('\n');
    return `命中 ${allResults.length} 条:\n${body}`;
  },
};

// MARK: grep / glob / edit_file —— 代码导航与精确编辑

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release', 'build', '.next', 'target', '.cache', '__pycache__', 'venv', '.venv']);

// 递归列出文件(限深度 + 跳过依赖/构建目录),返回绝对路径。
async function walkFiles(root: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string, depth: number): Promise<void> {
    if (out.length >= limit || depth > 8) return;
    let ents: fs.Dirent[];
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (ent.name === '.DS_Store' || ent.name === 'Thumbs.db') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        await rec(full, depth + 1);
      } else if (ent.isFile()) {
        out.push(full);
        if (out.length >= limit) return;
      }
    }
  }
  await rec(root, 0);
  return out;
}

// glob → regex 逻辑已提取到 shared/glob.ts,两处(tools.ts + watcher.ts)共用一份。
import { globToRegex } from '../shared/glob';

const grep: Tool = {
  name: 'grep',
  readOnly: true,
  description: '在当前工作目录递归搜索文件内容(正则,大小写不敏感),返回「文件:行号: 内容」。自动排除 node_modules/.git/dist 等。需要找代码/字符串在哪时用,比 shell grep 干净。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      glob: { type: 'string', description: '可选:只搜匹配此 glob 的文件(如 *.ts)' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const pattern = String(args.pattern ?? '');
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      return `非法正则: ${pattern}`;
    }
    const filter = args.glob ? globToRegex(String(args.glob)) : null;
    const files = await walkFiles(ctx.cwd, 2000);
    const hits: string[] = [];
    for (const f of files) {
      const rel = path.relative(ctx.cwd, f);
      if (filter && !filter.test(rel) && !filter.test(path.basename(f))) continue;
      try {
        if ((await fs.promises.stat(f)).size > 512 * 1024) continue; // 跳大文件(>512KB)
        const buf = await fs.promises.readFile(f); // 读 Buffer,下面用 decodeBuffer 做编码检测
        const body = decodeBuffer(buf); // 编码检测:BOM → UTF-8 → GBK/Big5/Shift_JIS 启发式
        for (const [i, line] of body.split('\n').entries()) {
          if (re.test(line)) {
            hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
            if (hits.length >= 200) break;
          }
        }
      } catch {
        /* 二进制/无权限 → 跳过 */
      }
      if (hits.length >= 200) break;
    }
    if (!hits.length) return `无匹配「${pattern}」`;
    return `命中 ${hits.length} 条:\n${hits.join('\n')}`;
  },
};

const glob: Tool = {
  name: 'glob',
  readOnly: true,
  description: '按 glob 模式列出当前工作目录下的文件(如 **/*.ts、src/**/*.json),返回相对路径(前 200 个)。需要知道有哪些文件时用。',
  parameters: {
    type: 'object',
    properties: { pattern: { type: 'string', description: 'glob 模式' } },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const pat = String(args.pattern ?? '');
    const re = globToRegex(pat);
    const files = await walkFiles(ctx.cwd, 500);
    const matched = files.map((f) => path.relative(ctx.cwd, f)).filter((rel) => re.test(rel)).slice(0, 200);
    if (!matched.length) return `无匹配「${pat}」`;
    return matched.join('\n');
  },
};

// edit_file:精确替换文件中的一段(比 write_file 安全 —— 只改指定片段,不动其它)。
const editFile: Tool = {
  name: 'edit_file',
  description: '把文件里 old_string 那段精确替换为 new_string。old_string 必须与文件完全一致(含缩进/换行)。默认只替换第一处,replace_all=true 替换全部。找不到 old_string 时不改动并报错。改代码首选这个,不要用 write_file 整体覆盖。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对或相对路径' },
      old_string: { type: 'string', description: '要替换的原文本(必须精确匹配)' },
      new_string: { type: 'string', description: '替换成的新文本' },
      replace_all: { type: 'boolean', description: '是否替换所有匹配处(默认 false,只第一处)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async run(args, ctx) {
    const p = expandPath(String(args.path ?? ''), ctx.cwd);
    const oldS = String(args.old_string ?? '');
    const newS = String(args.new_string ?? '');
    if (!p) return '缺少 path';
    if (!oldS) return '缺少 old_string';
    // 沙箱检查:readOnly 拦截写;workspaceWrite 限制 cwd 内。
    const guard = sandboxCheck(ctx.sandbox, p, ctx.cwd, true);
    if (guard) return guard;
    let body: string;
    try {
      body = decodeBuffer(fs.readFileSync(p));
    } catch {
      return `读不到: ${p}`;
    }
    // 读到原文后立刻快照,在替换/写入之前。哪怕后续 oldS 找不到也不会丢回滚点。
    if (ctx.convId) takeSnapshot({ convId: ctx.convId, cwd: ctx.cwd, absPath: p, tool: 'edit_file', contentBefore: body });
    if (!body.includes(oldS)) return `未找到要替换的片段(检查缩进/空格是否完全一致)。文件 ${body.length} 字节,未改动。`;
    let out: string;
    let count: number;
    if (args.replace_all === true) {
      count = body.split(oldS).length - 1;
      out = body.split(oldS).join(newS);
    } else {
      const i = body.indexOf(oldS);
      out = body.slice(0, i) + newS + body.slice(i + oldS.length);
      count = 1;
    }
    try {
      fs.writeFileSync(p, out, 'utf8');
      return `已替换 ${count} 处 → ${p}`;
    } catch (e) {
      return `写入失败: ${sanitizeError(e)}`;
    }
  },
};

// git_diff:看工作区/暂存区/某次提交的文件 diff。比 shell + git diff 干净(无确认、自动截断)。
// readOnly → 同轮可并发(常与 read_file/grep 一起查代码)。
// 用 execFile 而非 shellExec —— argv 直传 git,不经 shell,消除命令注入面。
// git ref 白名单:只允许字母/数字 / - . _ / ~ ^ 等安全字符,拦掉 ; & | $ ` 等 shell 元字符。
function safeGitRef(ref: string): boolean {
  // git ref 安全字符集:字母、数字、/ - . _ ~ ^ 以及 HEAD/FETCH_HEAD 等常见 ref
  return /^[\w./~^_-]+$/.test(ref);
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const gitDiff: Tool = {
  name: 'git_diff',
  readOnly: true,
  description:
    '看 git 仓库里的文件 diff。三种模式:(1) 不传参 = 工作区相对 HEAD 的所有改动;(2) 传 file = 单个文件;(3) 传 ref = 与某个提交/分支比较(如 ref=HEAD~1 看上次提交后的变化,cached=true 看已 staged 的)。需要先看改动再决定怎么改代码时用,比 shell git diff 干净(自动跳过确认)。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '可选:只看这个文件(相对路径)' },
      ref: { type: 'string', description: '可选:git ref(commit hash / 分支 / HEAD~N)。默认 HEAD' },
      cached: { type: 'boolean', description: '可选:true = 看 staged 的 diff(--cached)。默认 false' },
    },
  },
  async run(args, ctx) {
    if (!ctx.cwd) return '❌ 当前会话没有 cwd,无法跑 git';
    const ref = String(args.ref ?? 'HEAD');
    if (!safeGitRef(ref)) return `❌ 不安全的 git ref: "${ref}"(只允许字母/数字/./-/~/^/_)`;
    // 构建 argv,直传 execFile —— 不经 shell,无注入风险。
    const gitArgs = ['diff', '--no-color'];
    if (args.cached) gitArgs.push('--cached');
    gitArgs.push(ref);
    if (args.file) gitArgs.push('--', String(args.file));
    try {
      const { stdout, stderr } = await execFileAsync('git', gitArgs, {
        cwd: ctx.cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      });
      const out = (stdout || '') + (stderr || '');
      if (!out.trim()) return '(无改动)';
      return out.length > 20000 ? out.slice(0, 20000) + '\n…[diff 过长,已截断;缩小范围(传 file)看完整]' : out;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
      const out = (err.stdout || '') + (err.stderr || '');
      const code = err.code ?? 1;
      return out ? `[exit ${code}] ${out}` : `git diff 失败: ${err.message}`;
    }
  },
};

// remember_fact / recall_fact:会话级 KV 锚点(P0-2)。
// v2 多步任务关键产出(文件路径列表、关键决策、临时文件名)存这里,不被 trim/compact 砍掉。
// key 在同一 conv 内唯一;value 纯文本或 JSON 字符串。sub-agent 也可调用 recall_fact 跨子任务共享。
// 不参与跨会话同步,每个 conv 独立 —— 与 memories(跨轮长期记忆)互补。
const rememberFact: Tool = {
  name: 'remember_fact',
  description:
    '保存一个会话级锚点(键值对)到 SQLite。后续步骤可 recall_fact 读取。\n' +
    '适用场景:v2 多步任务的关键产出(产出的文件路径列表、关键决策、临时文件名)、\n' +
    'v1 长对话中需要跨轮持久化的数据(不能仅依赖对话 history,会被 trim/compact 砍掉)。\n' +
    '注意:不要把寒暄 / 一次性细节 / 已能从文件读到的内容存这里 —— 锚点应当是"后续步骤会反复用到"的关键数据。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '锚点 key(同 conv 内唯一,建议短且语义清晰,如 "step1_files")' },
      value: { type: 'string', description: '锚点 value(纯文本或 JSON 字符串)' },
    },
    required: ['key', 'value'],
  },
  async run(args, ctx) {
    const key = String(args.key ?? '').trim();
    const value = String(args.value ?? '');
    if (!key) return '缺少 key';
    if (!ctx.convId) return '该上下文不支持 fact(无 convId)';
    try {
      store.saveFact(ctx.convId, key, value);
      // 状态事件方便 UI 显示(类型 'status',text 字段)
      return `已记住: ${key} = ${value.length > 80 ? value.slice(0, 80) + '…' : value}`;
    } catch (e) {
      return `remember_fact 失败: ${(e as Error)?.message ?? e}`;
    }
  },
};

const recallFact: Tool = {
  name: 'recall_fact',
  description:
    '读取之前 remember_fact 保存的会话锚点。key 不存在时返回 "(无此 key)"。\n' +
    '通常在多步任务的新步骤开始时调用一次,获取前步的关键产出。',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: '要读取的锚点 key' } },
    required: ['key'],
  },
  async run(args, ctx) {
    const key = String(args.key ?? '').trim();
    if (!key) return '缺少 key';
    if (!ctx.convId) return '该上下文不支持 fact(无 convId)';
    try {
      const v = store.loadFact(ctx.convId, key);
      return v ?? '(无此 key)';
    } catch (e) {
      return `recall_fact 失败: ${(e as Error)?.message ?? e}`;
    }
  },
};

// P0: Memory Blocks 工具 — 让 agent 结构化编辑自己的长期记忆(借鉴 Letta core_memory_replace/append)。
// 与 remember_fact 的区别:remember_fact 是会话级临时 KV,memory_replace/append 是全局持久的核心记忆块。
// block label 含义:persona(系统人设,只读)/ user_profile(用户画像)/ project_context(项目上下文)/ active_goals(当前目标)。
const memoryReplace: Tool = {
  name: 'memory_replace',
  description:
    '更新你的核心记忆块(Memory Block)。这是结构化的长期记忆,持久跨会话,每轮注入到上下文中。\n' +
    '可用 block: user_profile(用户画像) / project_context(项目上下文) / active_goals(当前目标)。\n' +
    '用法:传入 block 名和完整新内容(会完全覆盖旧内容)。\n' +
    '示例:发现用户切换了项目 → 更新 project_context;\n' +
    '发现之前记的 user_profile 过时了 → 用最新信息替换。\n' +
    '注意:persona block 是只读的(由系统管理),不可替换。',
  parameters: {
    type: 'object',
    properties: {
      block: {
        type: 'string',
        enum: ['user_profile', 'project_context', 'active_goals'],
        description: '要更新的记忆块名称',
      },
      content: { type: 'string', description: '完整的新内容(覆盖旧内容)' },
    },
    required: ['block', 'content'],
  },
  async run(args) {
    const block = String(args.block ?? '').trim();
    const content = String(args.content ?? '');
    if (!block || !content) return '缺少 block 或 content';
    try {
      const ok = store.updateMemoryBlock(block, content);
      if (!ok) return `更新失败:block "${block}" 不存在或只读。`;
      return `✅ 已更新 ${block}(${content.length} 字符)`;
    } catch (e) {
      return `memory_replace 失败: ${(e as Error)?.message ?? e}`;
    }
  },
};

const memoryAppend: Tool = {
  name: 'memory_append',
  description:
    '向你的核心记忆块(Memory Block)追加内容。不会覆盖已有内容,在末尾追加。\n' +
    '可用 block: user_profile / project_context / active_goals。\n' +
    '适用场景:逐步积累用户信息,不想覆盖已有内容。\n' +
    '注意:追加后总长度超过 char_limit 会从头部截断。',
  parameters: {
    type: 'object',
    properties: {
      block: {
        type: 'string',
        enum: ['user_profile', 'project_context', 'active_goals'],
        description: '要追加到的记忆块名称',
      },
      content: { type: 'string', description: '要追加的内容' },
    },
    required: ['block', 'content'],
  },
  async run(args) {
    const block = String(args.block ?? '').trim();
    const content = String(args.content ?? '');
    if (!block || !content) return '缺少 block 或 content';
    try {
      const ok = store.appendMemoryBlock(block, content);
      if (!ok) return `追加失败:block "${block}" 不存在或只读。`;
      return `✅ 已追加到 ${block}(${content.length} 字符)`;
    } catch (e) {
      return `memory_append 失败: ${(e as Error)?.message ?? e}`;
    }
  },
};

// dispatch_agent:派发独立子任务给子 agent。Direct 默认走 runAgentLoop(只读工具集);
// engine=claudeCode / codex 时跨引擎:走对应 CLI 的 one-shot 模式,只读、不递归。
// 对应 CC 的 AgentTool 最小版 + 跨引擎扩展。readOnly 留空 → 串行,避免同轮多个 subagent 并发 LLM 风暴。
// P1:新增 scope 参数,让 LLM 选择 sub-agent 拿到多少 parent history。参照 Codex SpawnAgentForkMode。
const dispatchAgent: Tool = {
  name: 'dispatch_agent',
  description:
    '派发一个独立子任务给子 agent(独立上下文)。默认走 Direct 引擎(只读工具集:read_file/grep/glob/web_fetch/recall_memory/recall_fact)。设 engine=claudeCode 或 codex 跨引擎:走对应 CLI 的 one-shot(同样只读)。用于并行探索或大任务分解,可以借力更强的模型完成子任务。子 agent 不能写文件、不能起 shell、不能再派发子任务;完成后用文本汇报结果。\n\n' +
    '**model 参数**:已忽略 — 子 agent 模型由设置决定(频道子模型 > 全局子 Agent 模型 > 主模型),传了也无效,不要传。\n\n' +
    '**scope 参数(关键)**:决定子 agent 拿到多少 parent conversation 历史。\n' +
    '- "none"(默认):子 agent 完全独立,只看到 prompt。最便宜,适合"独立探索/查文档"任务。\n' +
    '- "last_n_turns":注入 parent 最近 N 轮 user/assistant(默认 N=3)。子 agent 知道"在干嘛",适合"基于刚才对话的延伸任务"。\n' +
    '- "summary_only":跑一次 LLM 摘要 parent history 注入子 agent。代价较高,慎用。\n' +
    '- "full_history":parent 全量 history 注入。**最贵,通常不要用**。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '给子 agent 的详细任务描述(目标 + 约束)' },
      engine: {
        type: 'string',
        enum: ['direct', 'claudeCode', 'codex'],
        description: "子任务用的引擎。默认 'direct'(本地 ReAct + GLM)。'claudeCode' / 'codex' 走对应 CLI one-shot。",
      },
      model: {
        type: 'string',
        description: '子 agent 用的大模型(仅 Direct 引擎生效)。通常留空:自动使用频道/全局配置的子 Agent 模型,未配置则跟随主 agent。',
      },
      scope: {
        type: 'object',
        description: 'P1:子 agent 接收 parent history 的范围',
        properties: {
          mode: {
            type: 'string',
            enum: ['none', 'last_n_turns', 'summary_only', 'full_history'],
            description: '默认 "none"。last_n_turns 推荐 3 轮(经验值,够上下文又不贵)。',
          },
          n: {
            type: 'number',
            description: '仅 last_n_turns 模式有效:取最近 N 个 user 消息 + 对应 assistant 回复。默认 3。',
          },
        },
      },
    },
    required: ['prompt'],
  },
  async run(args, ctx) {
    if (!ctx.spawn) return '该引擎不支持子任务派发。';
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return '缺少 prompt';
    const engine = (args.engine as SubEngine) ?? 'direct';
    // P1:解析 scope,默认 'none'。空对象也当 none 处理。
    let scope: SpawnScopeConfig = { mode: 'none' };
    const scopeArg = args.scope as { mode?: string; n?: number } | undefined;
    if (scopeArg?.mode === 'last_n_turns') {
      scope = { mode: 'last_n_turns', n: scopeArg.n && scopeArg.n > 0 ? Math.min(scopeArg.n, 10) : 3 };
    } else if (scopeArg?.mode === 'summary_only') {
      scope = { mode: 'summary_only' };
    } else if (scopeArg?.mode === 'full_history') {
      scope = { mode: 'full_history' };
    }
    try {
      return await ctx.spawn({
        prompt,
        signal: ctx.signal ?? new AbortController().signal,
        engine,
        model: args.model ? String(args.model) : undefined,
        scope,
      });
    } catch (e) {
      const err = e as Error;
      // 超时 abort 的错误信息要可读 — "operation aborted" 会让主 agent 盲目原样重试
      if (err?.name === 'AbortError' || /abort/i.test(err?.message ?? '')) {
        return '子任务超时或被取消(8 分钟上限)。建议:把任务拆小(一次只查一个目标),或换更具体的 prompt 减少探查轮数,不要原样重试同一个任务。';
      }
      return `子任务出错: ${err?.message ?? e}`;
    }
  },
};

// P2:AgentTeams 多 agent 协作工具。
// 工作流:spawn_team 创建团队 → team_broadcast 派活 → team_send 单独追问 → team_close 收尾。
// 每个 member 是独立只读 sub-agent(复用 SUBAGENT_PROMPT),有自己持久化的 history。
// 成员间通过 recall_fact 共享数据(主会话的 remember_fact 也对 member 可见)。
const spawnTeam: Tool = {
  name: 'spawn_team',
  description:
    '创建一个 agent 团队(team)。每个 member 是独立只读 sub-agent,有各自持久化的 history。\n' +
    '适合"并行调研 / 多视角评审 / 分模块探查"场景。**与 dispatch_agent 的区别**:dispatch_agent 起一次性 sub-agent,\n' +
    'team 的 member 可以反复对话(每次看到自己 history 累积),且多个 member 可以同时持有"团队上下文"。\n\n' +
    '使用流程:\n' +
    '1. spawn_team({ members: [{name, role}, ...] }) → 返回 team_id 和 member 列表\n' +
    '2. team_broadcast({ team_id, message }) → 给所有 member 发同一条指令,各自独立处理\n' +
    '3. team_send({ team_id, member_name, message }) → 单独追问某个 member\n' +
    '4. team_close({ team_id }) → 团队完成,可删除;不调用 close 也能继续用(members 持久化)',
  parameters: {
    type: 'object',
    properties: {
      members: {
        type: 'array',
        description: '成员列表。每个 member 必须有 name(短标识)和 role(职责描述,如 "explorer"/"reviewer")',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '成员名(团队内唯一,用于 team_send)' },
            role: { type: 'string', description: '角色描述,如 "前端模块探查"、"数据库架构评审"' },
          },
          required: ['name', 'role'],
        },
      },
    },
    required: ['members'],
  },
  async run(args, ctx) {
    if (!ctx.convId) return '该上下文不支持 team(无 convId)';
    const members = (args.members as Array<{ name?: string; role?: string }> | undefined) ?? [];
    if (members.length === 0) return '缺少 members';
    if (members.length > 8) return '成员过多(上限 8),请拆成多个 team 或缩减';
    const teamId = `conv:${ctx.convId}:team:${Date.now().toString(36)}`;
    const now = Date.now() / 1000;
    const seen = new Set<string>();
    for (const m of members) {
      const name = String(m.name ?? '').trim();
      const role = String(m.role ?? '').trim();
      if (!name || !role) return '每个 member 必须有 name 和 role';
      if (seen.has(name)) return `成员名重复: ${name}`;
      seen.add(name);
      store.upsertTeamMember({
        team_id: teamId,
        member_id: name,
        name,
        role,
        history: '[]',
        last_message: null,
        last_result: null,
        status: 'idle',
        created_at: now,
        updated_at: now,
      });
    }
    return JSON.stringify({
      team_id: teamId,
      members: members.map((m) => ({ name: m.name, role: m.role })),
    });
  },
};

const teamBroadcast: Tool = {
  name: 'team_broadcast',
  description:
    '给 team 的所有 member 发同一条指令。每个 member 独立处理,各自跑一次 LLM,各自更新自己的 history。\n' +
    '返回每位 member 的回答(按成员顺序)。适合"统一问询所有模块的状态"。',
  parameters: {
    type: 'object',
    properties: {
      team_id: { type: 'string', description: 'spawn_team 返回的 team_id' },
      message: { type: 'string', description: '广播给所有 member 的指令' },
    },
    required: ['team_id', 'message'],
  },
  async run(args, ctx) {
    if (!ctx.convId || !ctx.teamRun) return '该上下文不支持 team run(无 convId 或 teamRun)';
    const teamId = String(args.team_id ?? '').trim();
    const message = String(args.message ?? '').trim();
    if (!teamId || !message) return '缺少 team_id 或 message';
    const members = store.listTeamMembers(teamId);
    if (members.length === 0) return `team 不存在或已关闭: ${teamId}`;
    try {
      return await ctx.teamRun({ teamId, memberNames: members.map((m) => m.member_id), message });
    } catch (e) {
      return `team_broadcast 失败: ${(e as Error)?.message ?? e}`;
    }
  },
};

const teamSend: Tool = {
  name: 'team_send',
  description:
    '单独给 team 的某个 member 发指令。Member 看到自己 history + 这条消息,跑一次 LLM。\n' +
    '返回该 member 的回答。适合"追问某个 member 上一轮没说完的" 或 "独立咨询某个专家"。',
  parameters: {
    type: 'object',
    properties: {
      team_id: { type: 'string' },
      member_name: { type: 'string', description: 'spawn_team 时声明的 name' },
      message: { type: 'string' },
    },
    required: ['team_id', 'member_name', 'message'],
  },
  async run(args, ctx) {
    if (!ctx.convId || !ctx.teamRun) return '该上下文不支持 team run';
    const teamId = String(args.team_id ?? '').trim();
    const memberName = String(args.member_name ?? '').trim();
    const message = String(args.message ?? '').trim();
    if (!teamId || !memberName || !message) return '缺少必要参数';
    const member = store.loadTeamMember(teamId, memberName);
    if (!member) return `member 不存在: ${teamId}/${memberName}`;
    try {
      const out = await ctx.teamRun({ teamId, memberNames: [memberName], message });
      return out; // 单 member,直接返回结果文本
    } catch (e) {
      return `team_send 失败: ${(e as Error)?.message ?? e}`;
    }
  },
};

const teamClose: Tool = {
  name: 'team_close',
  description:
    '删除 team 及其所有 member 的持久化数据。团队不再可用。\n' +
    '通常在所有 member 都"汇报完毕"且主流程不再需要时调用。如果不调,members 也会一直保留(可继续对话)。',
  parameters: {
    type: 'object',
    properties: {
      team_id: { type: 'string' },
    },
    required: ['team_id'],
  },
  async run(args) {
    const teamId = String(args.team_id ?? '').trim();
    if (!teamId) return '缺少 team_id';
    const n = store.deleteTeam(teamId);
    return `已关闭 team ${teamId}(删除 ${n} 个 member)`;
  },
};

// ── MiniMax 文生视频(H3 模型)──
// 异步任务:创建 → 轮询 → 返回视频 URL。
// API Key 从 settings.minimaxApiKey 获取。
// MiniMax text-to-video (H3 model) — async task: create → poll → return video URL.
const MINIMAX_API_BASE = 'https://api.minimaxi.com';
const VIDEO_POLL_INTERVAL_MS = 5_000;  // 每 5 秒查询一次 / poll every 5s
const VIDEO_MAX_POLL_MS = 180_000;     // 最长等 3 分钟 / max wait 3 min

const videoGen: Tool = {
  name: 'video_gen',
  description: '使用 MiniMax H3 模型生成视频(文生视频)。输入文字描述,返回视频下载链接。需要先在设置中配置 MiniMax API Key。支持 2K/1080P 分辨率,5-15 秒时长,支持 16:9/9:16/1:1 等比例。',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '视频内容描述(中文/英文均可,建议详细描述场景、人物、动作、镜头语言)',
      },
      resolution: {
        type: 'string',
        enum: ['2K', '1080P'],
        description: '分辨率(默认 1080P)。2K 画质更好但更慢更贵。',
      },
      duration: {
        type: 'number',
        description: '视频时长秒数(可选值:4-15,默认 5)',
      },
      ratio: {
        type: 'string',
        enum: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
        description: '宽高比(默认 16:9)',
      },
    },
    required: ['prompt'],
  },
  async run(args, ctx) {
    const { getSettings } = await import('./settings');
    const settings = getSettings();
    const apiKey = settings.minimaxApiKey;

    if (!apiKey) {
      return '❌ MiniMax API Key 未配置。请在设置 → MiniMax API Key 中填入你的密钥(获取地址: https://platform.minimaxi.com → 账户管理 > 接口密钥)。';
    }

    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return '请提供视频内容描述(prompt)。';

    const resolution = String(args.resolution ?? '1080P');
    const duration = Number(args.duration ?? 5);
    const ratio = String(args.ratio ?? '16:9');
    const signal = ctx?.signal ?? AbortSignal.timeout(VIDEO_MAX_POLL_MS);

    // ── Step 1: 创建视频生成任务 / Create video generation task ──
    let taskId: string;
    try {
      const resp = await fetch(`${MINIMAX_API_BASE}/v2/video_generation`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'MiniMax-H3',
          content: [{ type: 'text', text: prompt }],
          resolution,
          duration,
          ratio,
        }),
        signal,
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        let errMsg = errBody;
        try { errMsg = JSON.parse(errBody)?.error?.message ?? errBody; } catch { /* keep raw */ }
        return `❌ 创建视频任务失败 (HTTP ${resp.status}): ${errMsg.slice(0, 300)}`;
      }

      const data = await resp.json() as { task_id?: string };
      taskId = data.task_id ?? '';
      if (!taskId) {
        return `❌ 创建视频任务成功但未返回 task_id。响应: ${JSON.stringify(data).slice(0, 300)}`;
      }
    } catch (e) {
      return `❌ 创建视频任务网络错误: ${sanitizeError(e)}`;
    }

    // ── Step 2: 轮询任务状态 / Poll task status ──
    const deadline = Date.now() + VIDEO_MAX_POLL_MS;
    let lastStatus = '';

    while (Date.now() < deadline) {
      if (signal.aborted) return `⏹ 视频生成已取消(task_id: ${taskId})`;

      await new Promise(r => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
      if (signal.aborted) return `⏹ 视频生成已取消(task_id: ${taskId})`;

      try {
        const resp = await fetch(`${MINIMAX_API_BASE}/v2/query/video_generation/${taskId}`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal,
        });

        if (!resp.ok) {
          // 临时错误,继续等
          continue;
        }

        const data = await resp.json() as {
          task?: {
            status: string;
            content?: { url?: string };
            resolution?: string;
            duration?: number;
            ratio?: string;
            usage?: { total_seconds?: number };
          };
        };

        const task = data.task;
        if (!task) continue;
        const status = task.status;

        if (status !== lastStatus) {
          lastStatus = status;
        }

        if (status === 'succeeded') {
          const url = task.content?.url ?? '';
          if (!url) return `✅ 视频生成成功但未返回 URL(task_id: ${taskId})`;
          const meta = [
            task.resolution && `分辨率: ${task.resolution}`,
            task.duration && `时长: ${task.duration}s`,
            task.ratio && `比例: ${task.ratio}`,
          ].filter(Boolean).join(' · ');
          return `✅ 视频生成成功!\n📊 ${meta}\n🔗 视频链接(有效期有限,请及时下载):\n${url}\n\n📌 task_id: ${taskId}`;
        }

        if (status === 'failed') {
          return `❌ 视频生成失败(task_id: ${taskId})。可能原因:内容审核未通过 / 服务内部错误。`;
        }

        // queued / running → 继续等待
      } catch {
        // 网络抖动,继续等
      }
    }

    // 超时但任务可能仍在后台运行
    return `⏳ 视频生成超时(已等 ${VIDEO_MAX_POLL_MS / 1000}s)。任务仍在后台运行,task_id: ${taskId}。\n稍后可用以下 curl 查询:\ncurl -H "Authorization: Bearer ${apiKey.slice(0, 6)}..." ${MINIMAX_API_BASE}/v2/query/video_generation/${taskId}`;
  },
};

// ── wecom_send_file: 将磁盘文件发送到当前企业微信会话 ──
// Send a file on disk to the current WeCom chat.
// 仅在企业微信通道会话中可用(bridge 有活跃会话即视为企微环境)。
// / Only available in WeCom channel sessions.
const wecomSendFile: Tool = {
  name: 'wecom_send_file',
  description: '将磁盘上已有的文件发送到当前企业微信会话。支持文档(pdf/xlsx/docx/csv/txt)、图片(png/jpg/gif/webp)、压缩包(zip)等,单文件最大 50MB。仅在会话来自企业微信通道时有效。如果用户要求发送已有文件,请用此工具,不要用 write_file。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径(绝对或相对路径)' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const p = expandPath((args.path as string) ?? '', ctx.cwd);
    if (!p) return '缺少 path 参数';

    if (!fs.existsSync(p)) return `文件不存在: ${p}`;
    const stat = fs.statSync(p);
    if (stat.size === 0) return `文件为空: ${p}`;
    if (stat.size > 50 * 1024 * 1024) return `文件超过 50MB 上限: ${(stat.size / 1048576).toFixed(1)}MB`;

    try {
      const { getWeComBridge } = await import('./wecom');
      const bridge = getWeComBridge();
      const res = await bridge.sendFileToActiveChat(p);
      if (res.ok) {
        return `✅ 已发送文件到企业微信会话: ${path.basename(p)} (${(stat.size / 1024).toFixed(1)} KB)`;
      }
      return `❌ 发送失败: ${res.error}`;
    } catch (e: any) {
      return `❌ 发送失败: ${sanitizeError(e)}`;
    }
  },
};

// ── feishu_send_file: 将磁盘文件发送到当前飞书频道 ──
// / Send a file from disk to the active Feishu chat.
// 仅在飞书频道会话中可用(Agent 通过 conv.feishuKey 判断)。
// / Only available in Feishu chat sessions.
const feishuSendFile: Tool = {
  name: 'feishu_send_file',
  description: '将磁盘上已有的文件发送到当前飞书频道。支持图片(png/jpg/gif/webp)、文档(pdf/xlsx/docx/csv)、音视频(mp4/mp3)等。仅在飞书频道会话中有效。如果用户要求发送已有文件/图片,请用此工具,不要用 write_file。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径(绝对或相对路径)' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const p = expandPath((args.path as string) ?? '', ctx.cwd);
    if (!p) return '缺少 path 参数';

    if (!fs.existsSync(p)) return `文件不存在: ${p}`;
    const stat = fs.statSync(p);
    if (stat.size === 0) return `文件为空: ${p}`;

    const ext = path.extname(p).toLowerCase();
    const OK_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.pdf', '.xlsx', '.xls', '.docx', '.doc', '.csv', '.zip', '.mp4', '.mp3'];
    if (!OK_EXTS.includes(ext)) return `不支持的文件类型: ${ext}。支持: 图片(png/jpg/gif/webp)、文档(pdf/xlsx/docx/csv)、音视频(mp4/mp3)等。`;

    try {
      const { getFeishuBridge } = await import('./feishu');
      const bridge = getFeishuBridge();
      if (!bridge.connected) return '❌ 飞书未连接,无法发送文件。';
      const res = await bridge.sendFileToActiveChat(p);
      if (res.ok) {
        return `✅ 已发送文件到飞书频道: ${path.basename(p)} (${(stat.size / 1024).toFixed(1)} KB)`;
      }
      return `❌ 发送失败: ${res.error}`;
    } catch (e: any) {
      return `❌ 发送失败: ${sanitizeError(e)}`;
    }
  },
};

// ── Computer Use 工具:截屏 / 鼠标 / 键盘 ──
// Computer Use tools: screenshot + mouse + keyboard via OS-native APIs.
// 截屏返回 base64 图片(直接放进 assistant 消息的 image_url),LLM 看到屏幕后决策下一步操作。
import { captureScreenshot, mouseClick as doMouseClick, mouseMove as doMouseMove, mouseScroll as doMouseScroll, mouseDrag as doMouseDrag, keyboardType as doKeyboardType, keyboardKey as doKeyboardKey } from './computer-use';

const screenshot: Tool = {
  name: 'screenshot',
  description: '截取当前屏幕截图。返回 base64 PNG 图片 + 屏幕分辨率。Computer Use 核心工具:LLM 看到屏幕后决定下一步操作(点击坐标、输入文本等)。截图坐标基于屏幕物理像素。',
  parameters: { type: 'object', properties: {} },
  readOnly: true,
  async run() {
    const r = await captureScreenshot();
    if (!r.ok || !r.base64) return `❌ 截屏失败: ${r.error}`;
    // 返回特殊格式:AgentLoop 会识别 __IMAGE_BASE64__ 前缀,将其转为 image_url content part 注入对话。
    return `📷 截屏成功 (${r.width}×${r.height})\n__IMAGE_BASE64__:${r.base64}`;
  },
};

const mouseAction: Tool = {
  name: 'mouse_click',
  description: '在屏幕指定坐标点击鼠标。需要先用 screenshot 截屏查看当前屏幕,确定要点击的位置坐标。坐标基于截图的像素分辨率。',
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'X 坐标(屏幕像素)' },
      y: { type: 'number', description: 'Y 坐标(屏幕像素)' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标按键(默认 left)' },
      double_click: { type: 'boolean', description: '是否双击(默认 false)' },
    },
    required: ['x', 'y'],
  },
  async run(args) {
    const x = Number(args.x);
    const y = Number(args.y);
    if (isNaN(x) || isNaN(y)) return '❌ 无效坐标';
    const r = await doMouseClick({
      x, y,
      button: (args.button as 'left' | 'right' | 'middle') || 'left',
      doubleClick: Boolean(args.double_click),
    });
    return r.ok ? `✅ 鼠标点击 (${Math.round(x)}, ${Math.round(y)}) ${args.button || 'left'}${args.double_click ? ' 双击' : ''}` : `❌ ${r.error}`;
  },
};

const mouseScrollTool: Tool = {
  name: 'mouse_scroll',
  description: '滚轮滚动。正数向上滚,负数向下滚。',
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'X 坐标' },
      y: { type: 'number', description: 'Y 坐标' },
      clicks: { type: 'number', description: '滚动量(正=向上,负=向下)' },
    },
    required: ['x', 'y', 'clicks'],
  },
  async run(args) {
    const r = await doMouseScroll(Number(args.x), Number(args.y), Number(args.clicks));
    return r.ok ? `✅ 滚动 (${Math.round(Number(args.x))}, ${Math.round(Number(args.y))}) ${Number(args.clicks) > 0 ? '↑' : '↓'} ${Math.abs(Number(args.clicks))} clicks` : `❌ ${r.error}`;
  },
};

const mouseDragTool: Tool = {
  name: 'mouse_drag',
  description: '从一点拖拽到另一点(用于拖拽文件、选中文本等)。',
  parameters: {
    type: 'object',
    properties: {
      from_x: { type: 'number', description: '起点 X' },
      from_y: { type: 'number', description: '起点 Y' },
      to_x: { type: 'number', description: '终点 X' },
      to_y: { type: 'number', description: '终点 Y' },
    },
    required: ['from_x', 'from_y', 'to_x', 'to_y'],
  },
  async run(args) {
    const r = await doMouseDrag(Number(args.from_x), Number(args.from_y), Number(args.to_x), Number(args.to_y));
    return r.ok ? `✅ 拖拽 (${Math.round(Number(args.from_x))},${Math.round(Number(args.from_y))}) → (${Math.round(Number(args.to_x))},${Math.round(Number(args.to_y))})` : `❌ ${r.error}`;
  },
};

const keyboardTypeTool: Tool = {
  name: 'keyboard_type',
  description: '输入文本(模拟键盘逐字输入)。先点击目标输入框,再调用此工具输入内容。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要输入的文本' },
    },
    required: ['text'],
  },
  async run(args) {
    const text = String(args.text ?? '');
    if (!text) return '❌ 空文本';
    const r = await doKeyboardType(text);
    return r.ok ? `✅ 输入文本: ${text.slice(0, 50)}${text.length > 50 ? '…' : ''} (${text.length} 字符)` : `❌ ${r.error}`;
  },
};

const keyboardKeyTool: Tool = {
  name: 'keyboard_key',
  description: '按下按键或组合键。支持:Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space。组合键用 + 连接,如 Ctrl+C, Shift+Home, Ctrl+Shift+Tab。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '按键名称或组合键(如 Enter, Ctrl+C, Alt+Tab)' },
    },
    required: ['key'],
  },
  async run(args) {
    const key = String(args.key ?? '');
    if (!key) return '❌ 空按键';
    const r = await doKeyboardKey(key);
    return r.ok ? `✅ 按键: ${key}` : `❌ ${r.error}`;
  },
};

export function builtinTools(): Tool[] {
  return [shell, readFile, writeFile, editFile, grep, glob, webFetch, webSearch, recallMemory, gitDiff, rememberFact, recallFact, memoryReplace, memoryAppend, dispatchAgent, spawnTeam, teamBroadcast, teamSend, teamClose, videoGen, feishuSendFile, wecomSendFile, screenshot, mouseAction, mouseScrollTool, mouseDragTool, keyboardTypeTool, keyboardKeyTool];
}

// 内置工具 + 用户插件(<userData>/plugins/*)贡献的工具。
// ponytail: pluginTools() 内部有缓存,每次 Direct run 调用是 O(plugins) 浅遍历,不疼。
// 子 agent 的 readOnlyTools() 不含插件 —— 子 agent 只信内置只读集,沙箱边界明确。
export function allTools(): Tool[] {
  // 延迟 require:plugins.ts 引用了 app.getPath,只在 main 进程跑;renderer 不会走到这。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { pluginTools } = require('./plugins') as typeof import('./plugins');
  return [...builtinTools(), ...pluginTools(), ...customTools()];
}

// 子 agent 用的只读工具集 —— 不含 dispatch_agent(防无限递归)、不含 shell/write/edit(子 agent 只读)。
// recall_fact 算只读(读 SQLite),可加;remember_fact 会改 SQLite,所以不放(子 agent 默认不写)。
export function readOnlyTools(): Tool[] {
  return [readFile, grep, glob, webFetch, webSearch, recallMemory, gitDiff, recallFact];
}

// 沙箱检查:返回 string = 拦截(reason),返回 null = 放行。
// readOnly 模式:block 写操作;读操作限制在 cwd 内(防 LLM 读敏感文件)。
// workspaceWrite 模式:限制写操作在 cwd 内;读不限。
function sandboxCheck(sandbox: SandboxMode | undefined, filePath: string, cwd: string, isWrite = false): string | null {
  if (!sandbox || sandbox === 'fullAccess') return null; // 不限或未设
  if (sandbox === 'readOnly') {
    if (isWrite) return '🚫 沙箱模式 [readOnly]: 写操作被禁止。请在设置中切换到 workspaceWrite 或 fullAccess。';
    // 读操作也限制在 cwd 内
    const resolved = path.resolve(filePath);
    const base = path.resolve(cwd || process.cwd());
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return `🚫 沙箱模式 [readOnly]: 只能在工作目录内读取。\n工作目录: ${base}\n尝试读取: ${resolved}`;
    }
    return null;
  }
  if (sandbox === 'workspaceWrite' && isWrite) {
    const resolved = path.resolve(filePath);
    const base = path.resolve(cwd || process.cwd());
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return `🚫 沙箱模式 [workspaceWrite]: 只能在工作目录内写入。\n工作目录: ${base}\n尝试写入: ${resolved}`;
    }
  }
  return null;
}

// 从 SQLite 加载自定义工具,包装成 Tool 接口(运行时注入到 allTools)。
export function customTools(): Tool[] {
  let rows: Array<{ id: string; name: string; description: string; parameters: string; commandTpl: string; timeoutMs: number }>;
  try {
    rows = store.loadCustomTools();
  } catch {
    return []; // store 未初始化时优雅降级
  }
  return rows.map((r) => {
    let params: Record<string, unknown> = {};
    try { params = JSON.parse(r.parameters || '{}'); } catch { /* 留空 */ }
    return {
      name: r.name,
      description: r.description || `(自定义工具 ${r.name})`,
      parameters: params,
      readOnly: false, // 自定义工具通过 shell 执行,不能保证只读 → 串行执行(避免并发写冲突)
      async run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
        // 将 $ARG_<param> 替换为实际参数值。
        // 安全:对参数值做 shell 转义(双引号包裹 + 转义特殊字符),防止 LLM 注入 shell 命令。
        // 参数名(k)转义正则特殊字符,防 RegExp injection。
        let cmd = r.commandTpl;
        for (const [k, v] of Object.entries(args)) {
          const safeVal = shellQuote(String(v ?? ''));
          const safeKey = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          cmd = cmd.replace(new RegExp(`\\$ARG_${safeKey}`, 'g'), safeVal);
        }
        const out = await shellExec(cmd, ctx.cwd, r.timeoutMs * 1000 || 120_000, ctx.signal);
        return out.length > 20000 ? out.slice(0, 20000) + '\n…[输出过长,已截断]' : out;
      },
    };
  });
}

// Resolve a (possibly relative / ~ / %USERPROFILE%) path against cwd.
function expandPath(p: string, cwd: string): string {
  if (!p) return '';
  let s = p.trim();
  const home = process.env.USERPROFILE || process.env.HOME || '';
  s = s.replace(/^~(?=$|\/|\\)/, home);
  s = s.replace(/^%USERPROFILE%/i, home);
  if (!path.isAbsolute(s)) s = path.resolve(cwd || process.cwd(), s);
  return s;
}
