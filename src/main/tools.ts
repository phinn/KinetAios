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

// 简单 glob → regex(**/ 匹配 0 或多目录段、** 跨目录、* 单段、? 单字符)。
function globToRegex(pat: string): RegExp {
  const s = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\x02') // **/ → 0 或多目录前缀(让 **/*.ts 也能匹配根目录文件)
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\x02/g, '(?:.*/)?');
  return new RegExp('^' + s + '$');
}

const grep: Tool = {
  name: 'grep',
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
        const body = await fs.promises.readFile(f, 'utf8'); // 异步读,不阻塞主进程(否则扫大项目时 UI/token 流卡住)
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
    let body: string;
    try {
      body = fs.readFileSync(p, 'utf8');
    } catch {
      return `读不到: ${p}`;
    }
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
      return `写入失败: ${e}`;
    }
  },
};

export function allTools(): Tool[] {
  return [shell, readFile, writeFile, editFile, grep, glob, webFetch, recallMemory];
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
