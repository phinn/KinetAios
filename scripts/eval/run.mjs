// 评测编排(P0)—— 固定任务集 + 机器可判验收,回答"改了这版,变好还是变差"。
//
// 一次评测 = 每个任务在全新隔离工作区里跑一轮真实 agent,然后按验收条件判定。
// 隔离做到三层:
//   HOME       → 临时目录(不读用户的 ~/.claude、~/.kinetaios 技能)
//   userData   → 临时目录(不写用户真实历史库/记忆)
//   工作区      → 临时目录(每个任务一份,任务间互不污染)
// 唯一从真实环境带过来的是 settings.json 里的模型配置(API key 不用重填)。
//
// 用法:
//   npm run eval                        # 全量 10 个任务
//   npm run eval -- --only fix-bug,no-tool-answer
//   npm run eval -- --repeat 3          # 每题重复 3 次,看稳定性
//   npm run eval -- --keep              # 保留临时目录,便于复盘失败现场
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      if (inline !== undefined) { out[k] = inline; continue; }
      const next = argv[i + 1];
      // 支持 `--only fix-bug` 与 `--only fix-bug,no-tool-answer` 两种写法。
      if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++; }
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const only = typeof args.only === 'string' ? args.only.split(',').map((s) => s.trim()).filter(Boolean) : null;
const repeat = Math.max(1, Number(args.repeat || 1));
const engine = typeof args.engine === 'string' ? args.engine : 'direct';
const model = typeof args.model === 'string' ? args.model : null;
const timeoutScale = Number(args['timeout-scale'] || 1);
const keep = !!args.keep;
const skipBuild = !!args['skip-build'];

// ── 1. 前置:构建产物 ─────────────────────────────────────────
if (!skipBuild && !fs.existsSync(path.join(ROOT, 'dist', 'main', 'TaskManager.js'))) {
  console.log('▸ dist 不存在,先构建…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error('构建失败,中止。'); process.exit(1); }
}

const electronBinary = require('electron');
if (typeof electronBinary !== 'string' || !fs.existsSync(electronBinary)) {
  console.error('找不到 Electron 可执行文件。先 npm install。');
  process.exit(1);
}

// ── 2. 真实 settings(只取模型配置)────────────────────────────
function realUserDataCandidates() {
  const home = os.homedir();
  const appName = 'KinetAios';
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', appName);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), appName);
  return path.join(home, '.config', appName);
}

function loadRealSettings() {
  for (const dir of [realUserDataCandidates(), path.join(os.homedir(), '.kinetaios')]) {
    const f = path.join(dir, 'settings.json');
    if (fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 换下一个 */ }
    }
  }
  return null;
}

const real = loadRealSettings();
if (!real) {
  console.error('❌ 找不到真实 settings.json,无法继承模型配置。请先在应用里配好 API。');
  process.exit(1);
}

// ── 凭据解析 ────────────────────────────────────────────────
// 【红线】评测进程绝不触碰 Keychain。
// 应用里的密钥是 safeStorage 加密的(@enc:...),解密会访问系统钥匙串;
// 所以本脚本从不调用任何解密 API,而是把配置里所有 @enc: 值原样抹成空串,
// 模型凭据只认显式提供的明文:
//   ① KINET_EVAL_API_KEY=<key>         显式明文密钥(推荐)
//   ② --profile <本地模型档案名>          localhost 档案不需要密钥(抹空即可)
function scrubEncrypted(obj, counter) {
  if (typeof obj === 'string') {
    if (obj.startsWith('@enc:')) { counter.n++; return ''; }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => scrubEncrypted(v, counter));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = scrubEncrypted(v, counter);
    return out;
  }
  return obj;
}

const apiKeyOverride = process.env.KINET_EVAL_API_KEY || null;
const baseUrlOverride = typeof args['base-url'] === 'string' ? args['base-url'] : null;
const profileName = typeof args.profile === 'string' ? args.profile : null;

let base = { ...real };
if (profileName) {
  const p = (real.modelProfiles || []).find((x) => x.name === profileName || x.id === profileName);
  if (!p) {
    console.error(`❌ 没有名为 ${profileName} 的模型档案。可选: ${(real.modelProfiles || []).map((x) => x.name).join(', ')}`);
    process.exit(1);
  }
  base = {
    ...real,
    apiKey: p.apiKey, baseURL: p.baseURL, model: p.model,
    apiProtocol: p.apiProtocol || real.apiProtocol, reasoning: p.reasoning || real.reasoning,
  };
}
if (baseUrlOverride) base.baseURL = baseUrlOverride;
if (model) base.model = model;

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(String(base.baseURL || ''));
let effectiveKey = apiKeyOverride || (String(base.apiKey || '').startsWith('@enc:') ? '' : base.apiKey) || '';
if (!effectiveKey && !isLocal) {
  console.error(
    '\n❌ 没有可用的明文密钥。评测不允许解密 Keychain,请二选一:\n'
    + '     KINET_EVAL_API_KEY=<你的key> npm run eval\n'
    + '     npm run eval -- --profile <本地模型档案名>     # 例如 ollama\n',
  );
  process.exit(1);
}

// 评测专用 settings:继承模型配置,但要满足两条硬约束:
//   ① 所有 @enc: 密文抹掉 —— 加载时就不会触发任何钥匙串访问
//   ② 关掉会写真实环境的自进化副作用(蒸馏/归档/外部 MCP 扫描)
const scrubStats = { n: 0 };
const evalSettings = scrubEncrypted({
  ...base,
  distillAutoEnabled: false,
  skillAutoArchiveEnabled: false,
  mcpExternalScan: false,
  remoteMcpServers: [],
  mcpServers: [],
  disabledMcpServers: [],
}, scrubStats);
evalSettings.apiKey = effectiveKey;
if (scrubStats.n > 0) {
  console.log(`▸ 已抹除 ${scrubStats.n} 处加密凭据(@enc:),评测全程不访问 Keychain`);
}

// ── 3. 临时环境 ──────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-eval-'));
const dirs = {
  root: evalRoot,
  home: path.join(evalRoot, 'home'),
  userData: path.join(evalRoot, 'userdata'),
  work: path.join(evalRoot, 'work'),
  out: path.join(evalRoot, 'out'),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(dirs.userData, 'settings.json'), JSON.stringify(evalSettings, null, 2), 'utf8');

// ── 4. 任务与验收 ────────────────────────────────────────────
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'tasks.json'), 'utf8'));
let tasks = spec.tasks;
if (only) tasks = tasks.filter((t) => only.includes(t.id));
if (!tasks.length) { console.error('没有匹配的任务。'); process.exit(1); }

/** 递归列出工作区文件(相对路径,排序),跳过 node_modules。 */
function listFiles(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(abs, base));
    else out.push(path.relative(base, abs));
  }
  return out.sort();
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function expandGlob(work, glob) {
  // 只支持同目录内的简单 * 通配(评测任务用不到深层 glob)。
  const dir = path.join(work, path.dirname(glob));
  const pat = path.basename(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp(`^${pat}$`);
  try {
    return fs.readdirSync(dir).filter((n) => re.test(n)).map((n) => path.join(dir, n));
  } catch { return []; }
}

function runChecks(task, work, result, beforeFiles) {
  const failures = [];
  for (const c of task.checks || []) {
    const abs = c.path ? path.join(work, c.path) : null;
    switch (c.type) {
      case 'fileExists': {
        if (!abs || !fs.existsSync(abs)) failures.push(`缺少文件 ${c.path}`);
        break;
      }
      case 'fileContains': {
        const txt = abs && readIfExists(abs);
        if (txt == null) failures.push(`缺少文件 ${c.path}`);
        else if (!new RegExp(c.pattern, 'm').test(txt)) failures.push(`${c.path} 不含 /${c.pattern}/`);
        break;
      }
      case 'fileNotContains': {
        const txt = abs && readIfExists(abs);
        if (txt != null && new RegExp(c.pattern, 'm').test(txt)) failures.push(`${c.path} 不应含 /${c.pattern}/`);
        break;
      }
      case 'globCount': {
        const n = expandGlob(work, c.glob).length;
        if (c.min != null && n < c.min) failures.push(`${c.glob} 只有 ${n} 个,应 ≥${c.min}`);
        if (c.max != null && n > c.max) failures.push(`${c.glob} 有 ${n} 个,应 ≤${c.max}`);
        break;
      }
      case 'command': {
        const r = spawnSync(c.cmd, { cwd: work, shell: true, encoding: 'utf8', timeout: 120000 });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        if (r.status !== 0) failures.push(`命令失败(${r.status}): ${c.cmd}`);
        else if (c.expectStdout && !out.includes(c.expectStdout)) {
          failures.push(`命令输出不含 "${c.expectStdout}",实际: ${out.trim().slice(0, 200)}`);
        }
        break;
      }
      case 'answerContains': {
        if (!new RegExp(c.pattern, 'm').test(result.answer || '')) {
          failures.push(`回答不含 /${c.pattern}/`);
        }
        break;
      }
      case 'noNewFiles': {
        const after = listFiles(work);
        const added = after.filter((f) => !beforeFiles.has(f));
        if (added.length) failures.push(`不该动文件,却新增了: ${added.join(', ')}`);
        break;
      }
      default:
        failures.push(`未知检查类型 ${c.type}`);
    }
  }
  return failures;
}

// ── 5. 跑 ────────────────────────────────────────────────────
function runOnce(task, runIndex) {
  const work = path.join(dirs.work, `${task.id}-${runIndex}`);
  fs.mkdirSync(work, { recursive: true });
  for (const [rel, content] of Object.entries(task.files || {})) {
    const abs = path.join(work, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  const beforeFiles = new Set(listFiles(work));

  const promptFile = path.join(dirs.out, `${task.id}-${runIndex}.prompt.txt`);
  fs.writeFileSync(promptFile, task.prompt, 'utf8');
  const outFile = path.join(dirs.out, `${task.id}-${runIndex}.json`);

  const timeoutMs = Math.round((task.timeoutMs || 240000) * timeoutScale);
  const childArgs = [
    path.join(__dirname, 'runner.cjs'),
    `--user-data=${dirs.userData}`,
    `--cwd=${work}`,
    `--prompt-file=${promptFile}`,
    `--out=${outFile}`,
    `--timeout=${timeoutMs}`,
    `--engine=${engine}`,
  ];
  if (model) childArgs.push(`--model=${model}`);

  const started = Date.now();
  const r = spawnSync(electronBinary, childArgs, {
    cwd: ROOT,
    env: { ...process.env, HOME: dirs.home, USERPROFILE: dirs.home },
    encoding: 'utf8',
    timeout: timeoutMs + 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let result;
  try {
    result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch {
    result = {
      ok: false,
      error: `运行器未产出结果(status=${r.status})\n${(r.stderr || '').slice(-800)}`,
      steps: [],
      events: [],
    };
  }
  const failures = runChecks(task, work, result, beforeFiles);
  return {
    taskId: task.id,
    title: task.title,
    run: runIndex,
    pass: failures.length === 0 && !!result.ok,
    failures,
    durationMs: result.durationMs ?? Date.now() - started,
    toolCalls: result.toolCalls ?? 0,
    toolErrors: result.toolErrors ?? 0,
    costUSD: result.costUSD ?? 0,
    tokensIn: result.tokensIn ?? 0,
    tokensOut: result.tokensOut ?? 0,
    error: result.error || null,
    errorKind: result.errorKind || null,
    answer: (result.answer || '').slice(0, 600),
    steps: (result.steps || []).map((s) => `${s.name}${s.outcome === 'error' ? '✗' : ''}`).join(' '),
  };
}

console.log(`\n▸ 评测开始  engine=${engine}${model ? ` model=${model}` : ''}  任务 ${tasks.length} 个 × ${repeat} 次`);
console.log(`▸ 隔离目录 ${evalRoot}\n`);

const rows = [];
for (const task of tasks) {
  for (let i = 1; i <= repeat; i++) {
    process.stdout.write(`  ${task.id}${repeat > 1 ? ` #${i}` : ''} … `);
    const row = runOnce(task, i);
    rows.push(row);
    const secs = (row.durationMs / 1000).toFixed(0);
    if (row.pass) console.log(`✓ ${secs}s  ${row.toolCalls}步  $${row.costUSD.toFixed(4)}`);
    else console.log(`✗ ${secs}s  — ${row.failures[0] || row.error?.split('\n')[0] || '未通过'}`);
  }
}

// ── 6. 汇总 ─────────────────────────────────────────────────
const total = rows.length;
const passed = rows.filter((r) => r.pass).length;
const rate = total ? (passed / total) * 100 : 0;
const cost = rows.reduce((s, r) => s + r.costUSD, 0);
const avgSteps = total ? rows.reduce((s, r) => s + r.toolCalls, 0) / total : 0;
const avgDur = total ? rows.reduce((s, r) => s + r.durationMs, 0) / total : 0;

const summary = {
  stamp,
  engine,
  model,
  total,
  passed,
  rate,
  costUSD: cost,
  avgSteps,
  avgDurationMs: avgDur,
  rows,
};

const resultDir = path.join(ROOT, 'scripts', 'eval', 'results');
fs.mkdirSync(resultDir, { recursive: true });
const baseName = path.join(resultDir, stamp);
fs.writeFileSync(`${baseName}.json`, JSON.stringify(summary, null, 2), 'utf8');

const md = [
  `# 评测报告 ${stamp}`,
  '',
  `- 引擎: ${engine}${model ? ` / ${model}` : ''}`,
  `- 通过: **${passed}/${total} (${rate.toFixed(1)}%)**`,
  `- 平均步数: ${avgSteps.toFixed(1)}  平均耗时: ${(avgDur / 1000).toFixed(0)}s  总成本: $${cost.toFixed(4)}`,
  '',
  '| 任务 | 结果 | 步数 | 耗时 | 成本 | 失败原因 |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.taskId}${repeat > 1 ? ` #${r.run}` : ''} | ${r.pass ? '✅' : '❌'} | ${r.toolCalls} | ${(r.durationMs / 1000).toFixed(0)}s | $${r.costUSD.toFixed(4)} | ${(r.failures[0] || r.error || '').split('\n')[0].replace(/\|/g, '/').slice(0, 80)} |`),
  '',
].join('\n');
fs.writeFileSync(`${baseName}.md`, md, 'utf8');

console.log(`\n▸ 通过率 ${passed}/${total} (${rate.toFixed(1)}%)  平均 ${avgSteps.toFixed(1)} 步  总成本 $${cost.toFixed(4)}`);
console.log(`▸ 报告 ${path.relative(ROOT, `${baseName}.md`)}\n`);

// 与上一次同引擎报告对比,直接回答"这版比上版好还是差"。
const prior = fs.readdirSync(resultDir)
  .filter((f) => f.endsWith('.json') && !f.startsWith(stamp))
  .sort()
  .reverse()
  .map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(resultDir, f), 'utf8')); } catch { return null; }
  })
  .find((x) => x && x.engine === engine);
if (prior) {
  const delta = rate - prior.rate;
  const sign = delta > 0 ? '+' : '';
  console.log(`▸ 对比上次(${prior.stamp}): ${sign}${delta.toFixed(1)}pp  (${prior.passed}/${prior.total} → ${passed}/${total})\n`);
}

if (!keep) fs.rmSync(evalRoot, { recursive: true, force: true });
else console.log(`▸ 临时目录保留: ${evalRoot}\n`);

process.exit(rate === 100 ? 0 : 1);
