// KinetAios CLI —— 纯 Node 终端入口(Windows Server 2012 等 GUI 不宜环境)。
// 复用桌面版 main 进程核心:TaskManager + Direct 引擎 + SQLite 记忆库 + 全部工具。
// 用法:
//   node cli.js                      交互 REPL(默认)
//   node cli.js "你的问题"           单次问答(用完即退)
//   node cli.js --cwd C:\path ...    指定会话工作目录(默认 process.cwd())
// 构建产物由 scripts/build-cli.mjs 用 esbuild bundle,electron 被 alias 到本目录 shims。
import * as readline from 'node:readline';
import { TaskManager, type TaskManagerEmitter } from '../main/TaskManager';
import * as store from '../main/store';
import { getSettings } from '../main/settings';
import type { AgentEvent } from '../shared/types';

// ── 参数解析 ──
const argv = process.argv.slice(2);
let cwdArg = '';
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--cwd') cwdArg = argv[++i] ?? '';
  else positional.push(argv[i]);
}
const oneShot = positional.length > 0 ? positional.join(' ') : null;
const cwd = cwdArg || process.cwd();

// ── 终端渲染:AgentEvent 流 → ANSI ──
const DIM = '\x1b[2m', CYAN = '\x1b[36m', RESET = '\x1b[0m', BOLD = '\x1b[1m';

function renderEvent(ev: AgentEvent): void {
  switch (ev.type) {
    case 'token':
      process.stdout.write(ev.text ?? '');
      break;
    case 'status':
      process.stdout.write(`\n${DIM}· ${ev.text}${RESET}\n`);
      break;
    case 'tool':
      process.stdout.write(`${CYAN}⚙ ${ev.name}(${JSON.stringify(ev.args ?? {}).slice(0, 200)})${RESET}\n`);
      break;
    case 'cost':
      process.stdout.write(`${DIM}[cost $${(ev.usd ?? 0).toFixed(4)} · ${ev.tokens ?? 0} tok]${RESET}\n`);
      break;
    case 'error':
      process.stdout.write(`\n${BOLD}✗ ${ev.message}${RESET}\n`);
      break;
    // sessionStarted/done 静默(由 REPL 外层控制)
  }
}

// ── confirm:CLI 里直接在终端问 ──
async function confirmInTerminal(cmd: string): Promise<boolean> {
  process.stdout.write(`\n${BOLD}确认执行?${RESET} ${cmd}\n${DIM}y = 允许 / 其他 = 拒绝${RESET} `);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise<string>((res) => rl.question('', (a) => { res(a); rl.close(); }));
  return ans.trim().toLowerCase() === 'y' || ans.trim().toLowerCase() === 'yes';
}

// ── 启动 ──
async function main(): Promise<void> {
  const s = getSettings();
  if (!s.apiKey) {
    // settings 允许无 key 进入,但跑一轮必失败;提前给指引进 CLI 的 settings.json
    const fs = await import('node:fs');
    const path = await import('node:path');
    const shim = await import('./shims/electron');
    const ud = shim.app.getPath('userData');
    const file = path.join(ud, 'settings.json');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(ud, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ apiKey: '', baseURL: s.baseURL, model: s.model }, null, 2));
    }
    process.stdout.write(`未配置 API key。请编辑 ${file} 填入 apiKey 后重试。\n`);
    process.exit(1);
  }

  store.initStore();

  const emitter: TaskManagerEmitter = {
    emitEvent(_convId, ev) { renderEvent(ev); },
    emitConversation() { /* CLI 不需要会话快照推送 */ },
    emitRemoved() { /* 同上 */ },
    confirm: confirmInTerminal,
    notifyDone() { /* 无系统通知 */ },
  };
  const tm = new TaskManager(emitter);
  tm.load();

  const conv = tm.newConversation(cwd, 'direct');
  process.stdout.write(`${DIM}KinetAios CLI · engine=direct · cwd=${cwd}${RESET}\n`);
  process.stdout.write(`${DIM}模型: ${s.model} @ ${s.baseURL}${RESET}\n\n`);

  if (oneShot) {
    await tm.send(conv.id, oneShot);
    process.stdout.write('\n');
    return;
  }

  // 交互 REPL
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${BOLD}>${RESET} ` });
  rl.prompt();
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    if (text === '/exit' || text === '/quit') { rl.close(); return; }
    if (text === '/cwd' || text === '/pwd') { process.stdout.write(`${cwd}\n`); rl.prompt(); return; }
    rl.pause();
    try {
      await tm.send(conv.id, text);
    } catch (e) {
      process.stdout.write(`\n${BOLD}✗ ${e instanceof Error ? e.message : String(e)}${RESET}\n`);
    }
    process.stdout.write('\n');
    rl.resume();
    rl.prompt();
  });
  rl.on('close', () => {
    process.stdout.write('再见。\n');
    process.exit(0);
  });
}

main().catch((e) => {
  process.stderr.write(`CLI 启动失败: ${e instanceof Error ? e.stack || e.message : String(e)}\n`);
  process.exit(1);
});
