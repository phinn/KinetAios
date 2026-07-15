// Tools: shell / read_file / write_file / web_fetch / recall_memory. Port of Swift Tool.swift.
// shell runs cross-platform via child_process.exec (cmd.exe on Windows, /bin/sh elsewhere).
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { ToolDef } from './glm';
import * as store from './store';
import { takeSnapshot } from './snapshots';
import type { SandboxMode } from '../shared/types';

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

// Context threaded into every tool.run — cwd for relative paths + the shell confirm callback.
// spawn/signal only used by dispatch_agent (Direct injects them so it can start a sub-agent loop);
// every other tool ignores them。convId 用作快照 scope(write_file/edit_file 改前存原文)。
export type SubEngine = 'direct' | 'claudeCode' | 'codex';
export interface ToolCtx {
  cwd: string;
  confirm: (cmd: string) => Promise<boolean>;
  spawn?: (a: { prompt: string; signal: AbortSignal; engine?: SubEngine }) => Promise<string>;
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
export function shellExec(command: string, cwd: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const child = exec(
      command,
      { cwd: cwd || undefined, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          resolve(`[超时(${Math.round(timeoutMs / 1000)}s),已终止。]\n`);
          return;
        }
        let out = (stdout || '') + (stderr || '');
        const code = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code ?? 1 : 0;
        if (err && code !== 0) out = `[exit ${code}] ${out}`;
        if (!out.trim()) out = '(无输出)\n';
        resolve(out);
      },
    );
    // 支持 abort:用户点"停止"时杀掉正在跑的子进程
    if (signal) {
      if (signal.aborted) child.kill('SIGKILL');
      else signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
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
  description: '读取本地文件内容(UTF-8 文本)。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '文件绝对路径或相对路径' } },
    required: ['path'],
  },
  async run(args, ctx) {
    const p = expandPath((args.path as string) ?? '', ctx.cwd);
    if (!p) return '缺少 path';
    try {
      const stat = fs.statSync(p);
      // 防止 read_file 大文件(PDF/图片等二进制)把主进程读 OOM —— 之前没限制是崩溃主因。
      if (stat.size > 512 * 1024) return `文件过大(${(stat.size / 1024 / 1024).toFixed(1)}MB),read_file 上限 512KB。改用 shell 按需读(如 pdftotext/head/grep)。`;
      // 二进制检测:先读 Buffer,前 8KB 有 null byte → 拒绝(避免 utf8 解码二进制产生乱码)。
      const buf = fs.readFileSync(p);
      const checkLen = Math.min(buf.length, 8192);
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0) return `二进制文件(非文本),read_file 不支持。改用 shell 工具(如 xxd/head/strings)。`;
      }
      // 编码检测:BOM → ASCII → UTF-8 校验 → 启发式(GBK/Big5/Shift_JIS)。
      // Windows 上大量文件是 GBK 编码,直接 toString('utf8') 会产生乱码。
      const body = decodeBuffer(buf);
      return body.length > 20000 ? body.slice(0, 20000) + '\n…[截断]' : body;
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
    const guard = sandboxCheck(ctx.sandbox, p, ctx.cwd);
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

const webFetch: Tool = {
  name: 'web_fetch',
  readOnly: true,
  description: '抓取一个 http(s) URL 的文本内容(GET)。',
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
    // SSRF 防护:阻止访问内网/本地地址(LLM 被诱导时不会探测内部服务)
    const host = url.hostname.toLowerCase();
    if (isPrivateHost(host)) {
      return `安全限制:不允许访问内网地址(${host})`;
    }
    try {
      const resp = await fetch(s, { headers: { 'User-Agent': 'KinetAios/0.2' }, signal: ctx?.signal ?? AbortSignal.timeout(20_000) });
      // body 上限:避免 OOM(截断到 500KB 后 toString)
      const text = await resp.text();
      const body = text.length > 500_000 ? text.slice(0, 500_000) + '\n…[截断]' : text;
      const trimmed = body.length > 8000 ? body.slice(0, 8000) + '\n…[截断]' : body;
      return `[HTTP ${resp.status}]\n${trimmed}`;
    } catch (e) {
      return `抓取失败: ${sanitizeError(e)}`;
    }
  },
};

const recallMemory: Tool = {
  name: 'recall_memory',
  readOnly: true,
  description: '语义搜索用户的历史(长期记忆 + 历史对话)。先走 embedding cosine 召回(语义近似),无 embedding 时回退 FTS5 关键词。需要回忆过去做过/聊过什么时用。',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: '搜索关键词或语义描述' } },
    required: ['query'],
  },
  async run(args) {
    const q = (args.query as string) ?? '';
    // 先试语义召回:embed query → cosine top-K over memory_embeddings(只覆盖 facts)。
    // 失败 / 无 embedding → 回退 FTS5(覆盖 history 表,即对话历史)。
    // ponytail ceiling:embedding 只覆盖 memories 表(facts),history 表(对话原文)仍走 FTS5;
    // 后续要全量语义召回需把每轮对话也 embed,数量级会涨,先做 fact 这一档。
    try {
      const { embed } = await import('./glm');
      const { snapshot } = await import('./settings');
      const snap = snapshot();
      const qVecArr = await embed([q], snap);
      if (qVecArr[0]?.length) {
        const qVec = new Float32Array(qVecArr[0]);
        const rows = store.listMemoryEmbeddings();
        if (rows.length) {
          const scored = rows
            .map((r) => ({ content: r.content, score: store.cosine(qVec, r.vec) }))
            .filter((r) => r.score > 0.2)
            .sort((a, b) => b.score - a.score)
            .slice(0, 20);
          if (scored.length) {
            // 命中的记忆 touch 一下(更新 lastUsed + useCount → 衰减权重 / 时间线统计才有数据)。
            for (const s of scored) {
              const row = rows.find((r) => r.content === s.content);
              if (row) try { store.touchMemoryUsed(row.memoryId); } catch { /* non-blocking */ }
            }
            const body = scored
              .map((m, i) => {
                const cut = m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content;
                return `[${i + 1}] (score ${m.score.toFixed(2)}) ${cut}`;
              })
              .join('\n');
            return `语义命中 ${scored.length} 条记忆:\n${body}`;
          }
        }
      }
    } catch (e) {
      console.warn('[recall] embed path failed, fallback to FTS5:', (e as Error)?.message);
    }
    // FTS5 fallback —— 覆盖对话历史(role/content 全文索引)。
    // FTS5 特殊字符(" * NEAR 等)可能导致语法错误 → try/catch
    let hits: Array<{ role: string; content: string }> = [];
    try {
      hits = store.search(q, 20);
    } catch {
      // FTS5 语法错误 → 用转义后的查询重试
      hits = store.search(q.replace(/["*]/g, ' '), 20);
    }
    if (!hits.length) return `没有匹配「${q}」的历史。`;
    const body = hits
      .map((m, i) => {
        const preview = m.content.replace(/\n/g, ' ');
        const cut = preview.length > 200 ? preview.slice(0, 200) + '…' : preview;
        return `[${i + 1}] (${m.role}) ${cut}`;
      })
      .join('\n');
    return `命中 ${hits.length} 条:\n${body}`;
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
    const guard = sandboxCheck(ctx.sandbox, p, ctx.cwd);
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

// dispatch_agent:派发独立子任务给子 agent。Direct 默认走 runAgentLoop(只读工具集);
// engine=claudeCode / codex 时跨引擎:走对应 CLI 的 one-shot 模式,只读、不递归。
// 对应 CC 的 AgentTool 最小版 + 跨引擎扩展。readOnly 留空 → 串行,避免同轮多个 subagent 并发 LLM 风暴。
const dispatchAgent: Tool = {
  name: 'dispatch_agent',
  description:
    '派发一个独立子任务给子 agent(独立上下文)。默认走 Direct 引擎(只读工具集:read_file/grep/glob/web_fetch/recall_memory)。设 engine=claudeCode 或 codex 跨引擎:走对应 CLI 的 one-shot(同样只读)。用于并行探索或大任务分解,可以借力更强的模型完成子任务。子 agent 不能写文件、不能起 shell、不能再派发子任务;完成后用文本汇报结果。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '给子 agent 的详细任务描述(目标 + 约束)' },
      engine: {
        type: 'string',
        enum: ['direct', 'claudeCode', 'codex'],
        description: "子任务用的引擎。默认 'direct'(本地 ReAct + GLM)。'claudeCode' / 'codex' 走对应 CLI one-shot。",
      },
    },
    required: ['prompt'],
  },
  async run(args, ctx) {
    if (!ctx.spawn) return '该引擎不支持子任务派发。';
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return '缺少 prompt';
    const engine = (args.engine as SubEngine) ?? 'direct';
    try {
      return await ctx.spawn({ prompt, signal: ctx.signal ?? new AbortController().signal, engine });
    } catch (e) {
      return `子任务出错: ${(e as Error)?.message ?? e}`;
    }
  },
};

export function builtinTools(): Tool[] {
  return [shell, readFile, writeFile, editFile, grep, glob, webFetch, recallMemory, gitDiff, dispatchAgent];
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
export function readOnlyTools(): Tool[] {
  return [readFile, grep, glob, webFetch, recallMemory, gitDiff];
}

// 沙箱检查:返回 string = 拦截(reason),返回 null = 放行。
function sandboxCheck(sandbox: SandboxMode | undefined, filePath: string, cwd: string): string | null {
  if (!sandbox || sandbox === 'fullAccess') return null; // 不限或未设
  if (sandbox === 'readOnly') return '🚫 沙箱模式 [readOnly]: 写操作被禁止。请在设置中切换到 workspaceWrite 或 fullAccess。';
  if (sandbox === 'workspaceWrite') {
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
      readOnly: true, // 自定义工具标记为只读(可并发),实际通过 shell 执行用户定义的命令
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
