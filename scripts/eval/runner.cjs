// 评测运行器 —— 在隔离的 userData 里跑「一个任务、一轮对话」,输出机器可读结果。
//
// 为什么用 Electron 而不是 node:better-sqlite3 是按 Electron ABI 重编译的,
// 纯 node 起不来;而 main 进程核心(TaskManager/Direct 引擎/工具)本就跑在 Electron 里。
// 不创建任何窗口,跑完即退。
//
// 关键约束:
// - userData 必须指向临时目录 —— 否则会写脏真实历史库/记忆/技能库。
// - 非交互:confirm 一律放行。评测只在临时工作区里跑,不碰用户真实文件。
// - 超时强制 cancel,避免模型卡死让整批评测挂住。
//
// 用法(由 run.mjs 调用,一般不手跑):
//   electron scripts/eval/runner.cjs --user-data=<dir> --cwd=<dir> --prompt-file=<f> \
//     --out=<json> --timeout=<ms> [--engine=direct] [--model=<m>]
const path = require('node:path');
const fs = require('node:fs');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const userData = args['user-data'];
const cwd = args.cwd;
const promptFile = args['prompt-file'];
const outFile = args.out;
const timeoutMs = Number(args.timeout || 600_000);
const engine = args.engine || 'direct';

if (!userData || !cwd || !promptFile || !outFile) {
  process.stderr.write('runner: 缺少参数(--user-data/--cwd/--prompt-file/--out)\n');
  process.exit(2);
}

// ── 必须在 require(main 模块) 之前改 userData:store 初始化时就定路径 ──
const electron = require('electron');
const { app } = electron;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', userData);

// 【红线】评测全程不碰 Keychain:把 safeStorage 声明为不可用。
// settings.ts 的 enc()/dec() 都以 isEncryptionAvailable() 为前提 —— 关掉之后
// 既不会调用 decryptString(读钥匙串),也不会调用 encryptString(写钥匙串),
// 凭据一律按明文处理(而 run.mjs 已把 @enc: 值全部抹空)。
try {
  electron.safeStorage.isEncryptionAvailable = () => false;
} catch { /* 不同 Electron 版本 property 可能只读,忽略 */ }

function writeResult(payload) {
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write(`runner: 写结果失败 ${e && e.message}\n`);
  }
}

const startedAt = Date.now();
const events = [];

app.whenReady().then(async () => {
  let tm;
  let conv;
  try {
    const { TaskManager } = require(path.join(__dirname, '..', '..', 'dist', 'main', 'TaskManager.js'));
    const store = require(path.join(__dirname, '..', '..', 'dist', 'main', 'store.js'));
    store.initStore();

    const emitter = {
      emitEvent(_convId, ev) {
        // 只留诊断需要的事件,避免把整段 token 流存进结果文件。
        if (ev.type === 'tool') events.push({ type: 'tool', name: ev.name, ok: true });
        else if (ev.type === 'error') events.push({ type: 'error', message: String(ev.message || '') });
        else if (ev.type === 'done') events.push({ type: 'done' });
      },
      emitConversation() {},
      emitRemoved() {},
      // 评测是非交互的:临时工作区内一律放行。
      confirm: async () => true,
      notifyDone() {},
    };

    tm = new TaskManager(emitter);
    tm.load();
    conv = tm.newConversation(cwd, engine);
    if (args.model) tm.setModel(conv.id, args.model);

    const prompt = fs.readFileSync(promptFile, 'utf8').trim();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { tm.cancel(conv.id); } catch { /* ignore */ }
    }, timeoutMs);

    try {
      await tm.send(conv.id, prompt);
    } finally {
      clearTimeout(timer);
    }

    const live = tm.get(conv.id) || conv;
    const turns = Array.isArray(live.turns) ? live.turns : [];
    const turn = turns[turns.length - 1] || {};
    const steps = (turn.steps || []).map((s) => ({
      name: s.name,
      outcome: s.outcome || null,
      // 结果只留头部:判定工具是否失败的证据,不把大输出塞进报告。
      resultHead: String(s.result || '').slice(0, 300),
    }));

    writeResult({
      ok: !timedOut && !turn.error,
      timedOut,
      durationMs: Date.now() - startedAt,
      answer: String(turn.answer || ''),
      error: turn.error || null,
      errorKind: turn.errorKind || null,
      done: !!turn.done,
      costUSD: Number(turn.costUSD || 0),
      tokensIn: Number(turn.tokensIn || 0),
      tokensOut: Number(turn.tokensOut || 0),
      steps,
      toolCalls: steps.length,
      toolErrors: steps.filter((s) => s.outcome === 'error').length,
      events,
      engine,
    });
    app.exit(0);
  } catch (e) {
    writeResult({
      ok: false,
      durationMs: Date.now() - startedAt,
      error: e && e.stack ? String(e.stack) : String(e),
      steps: [],
      events,
      engine,
    });
    app.exit(1);
  }
});
