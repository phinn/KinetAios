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

const probeMode = !!args['probe-key'];
if (probeMode ? !outFile : (!userData || !cwd || !promptFile || !outFile)) {
  process.stderr.write(probeMode
    ? 'runner: 探针模式需要 --out\n'
    : 'runner: 缺少参数(--user-data/--cwd/--prompt-file/--out)\n');
  process.exit(2);
}

// ── 必须在 require(main 模块) 之前钉住应用身份与数据目录 ──
// 应用用 safeStorage 加密 API key,钥匙串项按「应用名」隔离。stock Electron 默认叫
// "Electron",所以必须先 setName 成与真实应用一致的 productName,才能解出用户已配置的
// default 模型 —— 这样评测不需要任何额外密钥文件。只读钥匙串、绝不新建/修改。
const electron = require('electron');
const { app } = electron;
let productName = 'KinetAios';
try {
  productName = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'brand.json'), 'utf8')).productName || productName;
} catch { /* 用默认名 */ }
app.setName(productName);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
// 探针模式要读真实 settings.json(密钥在真实 userData 里),所以不重定向;
// 正常跑任务时必须指向临时目录,避免写脏真实库。
if (!probeMode) app.setPath('userData', userData);

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

// harness 用 spawnSync 超时只能发 SIGTERM,Electron 不一定响应;显式落盘再退,
// 避免留下一批"无结果"的任务。
process.on('SIGTERM', () => {
  try { writeResult({ ok: false, error: 'SIGTERM(harness 超时)', steps: [], events, engine }); } catch { /* ignore */ }
  process.exit(3);
});

app.whenReady().then(async () => {
  // --probe-key:只验证「能否读到已配置的密钥」,不跑 agent。
  // 必须在 app ready 之后 —— safeStorage 在 ready 前不可用,decryptString 会失败。
  if (probeMode) {
    try {
      const settingsMod = require(path.join(__dirname, '..', '..', 'dist', 'main', 'settings.js'));
      const snap = settingsMod.snapshot();
      const key = String(snap.apiKey || '');
      writeResult({
        hasKey: key.length > 0 && !key.startsWith('@enc:'),
        keyLen: key.length,
        encrypted: key.startsWith('@enc:'),
        safeStorageAvailable: electron.safeStorage.isEncryptionAvailable(),
        baseURL: snap.baseURL || null,
        model: snap.model || null,
        apiProtocol: snap.apiProtocol || null,
      });
      app.exit(0);
    } catch (e) {
      writeResult({ hasKey: false, error: String(e && e.stack || e) });
      app.exit(1);
    }
    return;
  }

  let tm;
  let conv;
  try {
    const dbg = process.env.KINET_EVAL_DEBUG ? (m) => process.stderr.write(`runner: ${m}\n`) : () => {};
    const { TaskManager } = require(path.join(__dirname, '..', '..', 'dist', 'main', 'TaskManager.js'));
    const store = require(path.join(__dirname, '..', '..', 'dist', 'main', 'store.js'));
    dbg('modules loaded');
    store.initStore();
    dbg('store initialized');

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
    dbg('loaded');
    conv = tm.newConversation(cwd, engine);
    dbg(`conversation ${conv && conv.id}`);
    if (args.model) tm.setModel(conv.id, args.model);

    const prompt = fs.readFileSync(promptFile, 'utf8').trim();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { tm.cancel(conv.id); } catch { /* ignore */ }
    }, timeoutMs);

    // 硬看门狗:tm.cancel 不保证 send 会 settle(模型连接可能僵死)。
    // 到时先落盘已有证据再退出,避免 harness 被一个僵死任务挂住整批。
    const watchdog = setTimeout(() => {
      const live = tm.get(conv.id) || conv;
      const turns0 = Array.isArray(live.turns) ? live.turns : [];
      const turn0 = turns0[turns0.length - 1] || {};
      writeResult({
        ok: false, timedOut: true, hardTimeout: true,
        durationMs: Date.now() - startedAt,
        answer: String(turn0.answer || '').slice(0, 4000),
        error: 'hard timeout (cancel 未让 send 结束)',
        steps: [], events, engine,
      });
      process.exit(3);
    }, timeoutMs + 15000);

    if (process.env.KINET_EVAL_DEBUG) process.stderr.write(`runner: send start ${conv.id}\n`);
    try {
      await tm.send(conv.id, prompt);
    } finally {
      clearTimeout(timer);
      clearTimeout(watchdog);
    }
    if (process.env.KINET_EVAL_DEBUG) process.stderr.write(`runner: send done\n`);

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
