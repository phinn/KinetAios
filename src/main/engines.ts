// Engine abstraction + the three engines. Ported from Swift ClaudeCodeEngine/CodexEngine and
// the Direct logic that lived in TaskManager. Three real engines now → the interface is worth it.
//
// CLI spawn note (Windows): npm-global bins ship as .cmd shims. Node refuses to spawn .cmd/.bat
// directly (CVE-2024-27980), so .cmd/.bat go through shell:true. Direct .exe / unix bins spawn
// without a shell → clean argv, no prompt-injection surface. ponytail: prompt-arg via shell:true
// on Windows isn't bulletproof against cmd metachars; user authors the prompt, acceptable for MVP.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentEvent, Conversation, EngineKind, SandboxMode } from '../shared/types';
import { runAgentLoop, trimHistoryToTokenBudget } from './AgentLoop';
import { currentProvider, priceUSD } from './glm';
import { allTools, type ToolCtx } from './tools';
import { getSettings, snapshot } from './settings';
import { mcp } from './mcp';

export const baseSystemPrompt = `你是 KinetAios,运行在用户 Windows 电脑上的 AI 助手。你能执行 shell 命令、读文件、写文件、抓网页、搜索历史记忆来帮用户完成任务。
该用工具就果断用,不要只给步骤。需要回忆过去做过/聊过的事,用 recall_memory 搜历史。

【重要】写文件的唯一正确方式是 write_file 工具(path + content 直传)。
- write_file 没有长度限制,几 KB、几十 KB、几百 KB 都可以一次性写入
- 永远不要因为"内容太长"而改用 shell echo/cat/heredoc,或 powershell Set-Content,或 base64 decode
- 那些 shell/powershell 方式在 JSON+shell 双层转义下几乎必崩
- 一旦决定要写文件,直接 write_file 一次到位

【输出路径】生成的文件(HTML / CSV / 报告等)默认写到当前工作目录(cwd)或其子目录。
执行 shell 前会请求用户确认。Windows 上 shell 走 cmd.exe。回复用中文,简洁。`;

export interface EngineRunOpts {
  conv: Conversation;
  memoryBlock: string;
  skillBlock?: string; // Direct only: body of a /<skill> the user invoked this turn
  signal: AbortSignal;
  onEvent: (e: AgentEvent) => void;
}

export interface Engine {
  readonly name: EngineKind;
  run(opts: EngineRunOpts): Promise<void>;
}

// 项目规则文件(AGENTS.md / CLAUDE.md)注入 system prompt —— 约定大于配置。
function loadProjectRules(cwd: string): string {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      const body = fs.readFileSync(path.join(cwd, name), 'utf8');
      if (body.trim()) return `\n\n# 项目规则(${name})\n${body.slice(0, 8000)}`;
    } catch {
      /* 不存在 → 试下一个 */
    }
  }
  return '';
}

// Direct = the built-in ReAct loop (AgentLoop) talking to the GLM/OpenAI/Anthropic provider.
class DirectEngine implements Engine {
  readonly name = 'direct' as const;
  constructor(private confirm: (cmd: string) => Promise<boolean>) {}
  async run({ conv, memoryBlock, skillBlock, signal, onEvent }: EngineRunOpts): Promise<void> {
    const prompt = conv.turns[conv.turns.length - 1]?.prompt ?? '';
    // Per-conversation model (Direct only). Falls back to the global setting for old convs.
    const base = snapshot();
    const snap = { ...base, model: conv.model || base.model };
    const ctx: ToolCtx = { cwd: conv.cwd, confirm: this.confirm };
    // A skill invoked via /<name> rides ahead of memory so the active instruction is prominent.
    const skillSection = skillBlock ? `\n\n# 当前 Skill 指令(用户通过 / 调用,请遵循)\n${skillBlock}` : '';
    const rulesSection = loadProjectRules(conv.cwd);
    // 内置工具 + 系统里配置的 MCP 工具(最多等 2s 让连接就绪)。
    const tools = [...allTools(), ...(await mcp.directTools(2000))];
    const updated = await runAgentLoop({
      provider: currentProvider(snap),
      tools,
      systemPrompt: baseSystemPrompt + skillSection + rulesSection + memoryBlock,
      snapshot: snap,
      userInput: prompt,
      history: conv.directHistory,
      ctx,
      signal,
      onEvent,
    });
    conv.directHistory = trimHistoryToTokenBudget(updated, 30_000);
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
function binEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extra =
    process.platform === 'win32'
      ? [path.join(home, 'AppData', 'Roaming', 'npm'), path.join(home, '.npm-global')]
      : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.local', 'bin')];
  const base = process.env.PATH || '';
  return { ...process.env, PATH: base + path.delimiter + extra.join(path.delimiter) };
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
    child.on('error', () => resolve(-1));
    child.on('close', (code) => {
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
  async run({ conv, memoryBlock, signal, onEvent }: EngineRunOpts): Promise<void> {
    const prompt = conv.turns[conv.turns.length - 1]?.prompt ?? '';
    const cwd = conv.cwd;
    const s = getSettings();
    const permissionMode = s.planMode ? 'plan' : CLAUDE_PERM[s.sandbox];
    const bin = resolveBin('claude');
    if (!bin.found) {
      onEvent({ type: 'error', message: '找不到 claude CLI。装 Claude Code(npm i -g @anthropic-ai/claude-code)或把它加进 PATH。' });
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
    if (memoryBlock) args.push('--append-system-prompt', memoryBlock);

    let sawResult = false;
    const pending = new Map<string, { name: string; args: string }>();
    const onLine = (line: string): void => {
      let obj: any;
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
          onEvent({ type: 'status', text: `模型 ${obj.error ?? ''}(HTTP ${obj.error_status ?? ''}),重试 ${obj.attempt ?? 0}/${obj.max_retries ?? 0}…` });
        else if (sub === 'status' && obj.status === 'requesting') onEvent({ type: 'status', text: '请求中…' });
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
                ? b.content.map((x: any) => x.text || '').join('')
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
        if (isErr) onEvent({ type: 'error', message: obj.result ?? obj.subtype ?? 'claude 执行出错' });
        else onEvent({ type: 'done' });
      }
    };

    await runBin(bin, args, { cwd, signal, onLine });
    if (signal.aborted) return; // user cancelled — not an error
    if (!sawResult) onEvent({ type: 'error', message: 'claude 未返回结果(被中断 / 超时 / 或 flags 不被当前版本支持)' });
  }
}

// MARK: Codex (codex exec --json). Verbatim port of the Swift parser.
class CodexEngine implements Engine {
  readonly name = 'codex' as const;
  async run({ conv, memoryBlock, signal, onEvent }: EngineRunOpts): Promise<void> {
    const prompt = conv.turns[conv.turns.length - 1]?.prompt ?? '';
    const cwd = conv.cwd;
    const s = getSettings();
    const sandboxKind: SandboxMode = s.planMode ? 'readOnly' : s.sandbox;
    const bin = resolveBin('codex');
    if (!bin.found) {
      onEvent({ type: 'error', message: '找不到 codex CLI。装 OpenAI Codex 或加进 PATH。' });
      return;
    }
    // codex has no --append-system-prompt flag → memoryBlock prepended to the prompt.
    const fullPrompt = memoryBlock ? `${memoryBlock}\n\n---\n\n${prompt}` : prompt;
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
      let obj: any;
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
          onEvent({ type: 'status', text: '请求中…' });
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
          onEvent({ type: 'error', message: obj.error?.message ?? (typeof obj.error === 'string' ? obj.error : 'codex 轮失败') });
          break;
        case 'error':
          if (obj.message) onEvent({ type: 'status', text: `codex: ${obj.message}` });
          break;
      }
    };

    const code = await runBin(bin, args, { cwd, signal, onLine });
    if (signal.aborted) return;
    if (!sawTurnEnd) {
      const tail = stderrTail.length ? ' — ' + stderrTail.join(' | ') : '';
      onEvent({ type: 'error', message: `codex 未返回结果(status=${code})${tail}` });
    }
  }
}

export function buildEngines(confirm: (cmd: string) => Promise<boolean>): Map<EngineKind, Engine> {
  return new Map<EngineKind, Engine>([
    ['direct', new DirectEngine(confirm)],
    ['claudeCode', new ClaudeCodeEngine()],
    ['codex', new CodexEngine()],
  ]);
}
