// Tools: shell / read_file / write_file / web_fetch / recall_memory. Port of Swift Tool.swift.
// shell runs cross-platform via child_process.exec (cmd.exe on Windows, /bin/sh elsewhere).
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDef } from './glm';
import * as store from './store';

// Context threaded into every tool.run — cwd for relative paths + the shell confirm callback.
export interface ToolCtx {
  cwd: string;
  confirm: (cmd: string) => Promise<boolean>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string>;
}

// OpenAI function-calling definition.
export function toolDef(t: Tool): ToolDef {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

// Shared shell runner (the shell tool uses it). exec picks the platform shell automatically:
// process.env.ComSpec (cmd.exe) on Windows, /bin/sh on unix. Raised maxBuffer so big outputs survive.
// 120s default — 30s killed real work (npm install / builds). Still bounded so a runaway can't hang.
export function shellExec(command: string, cwd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd: cwd || undefined, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          resolve(`[超时(${Math.round(timeoutMs / 1000)}s),已终止。]\n`);
          return;
        }
        let out = (stdout || '') + (stderr || '');
        const code = err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0;
        if (err && code !== 0) out = `[exit ${code}] ${out}`; // surface non-zero exit like the Swift version
        if (!out.trim()) out = '(无输出)\n';
        resolve(out);
      },
    );
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
    return shellExec(cmd, ctx.cwd);
  },
};

const readFile: Tool = {
  name: 'read_file',
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
      const body = fs.readFileSync(p, 'utf8');
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
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      return `已写入 ${p} (${Buffer.byteLength(content, 'utf8')} 字节)`;
    } catch (e) {
      return `写入失败: ${e}`;
    }
  },
};

const webFetch: Tool = {
  name: 'web_fetch',
  description: '抓取一个 http(s) URL 的文本内容(GET)。',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
    required: ['url'],
  },
  async run(args) {
    const s = (args.url as string) ?? '';
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return `非法 URL: ${s}`;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `非法 URL: ${s}`;
    try {
      const resp = await fetch(s, { headers: { 'User-Agent': 'KinetAios/0.2' }, signal: AbortSignal.timeout(20_000) });
      const body = await resp.text();
      const trimmed = body.length > 8000 ? body.slice(0, 8000) + '\n…[截断]' : body;
      return `[HTTP ${resp.status}]\n${trimmed}`;
    } catch (e) {
      return `抓取失败: ${e}`;
    }
  },
};

const recallMemory: Tool = {
  name: 'recall_memory',
  description: '全文搜索用户的历史(shell 输出、读过的文件、之前的问答)。需要回忆过去做过/聊过什么时用。',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: '搜索关键词' } },
    required: ['query'],
  },
  async run(args) {
    const q = (args.query as string) ?? '';
    const hits = store.search(q, 20);
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

export function allTools(): Tool[] {
  return [shell, readFile, writeFile, webFetch, recallMemory];
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
