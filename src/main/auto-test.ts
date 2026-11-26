// 编辑后自动跑「受影响的测试」—— 类型检查之后的第二道硬闸。
//
// 为什么只跑受影响的:全量测试在稍大的项目里就是分钟级,挂到每次编辑后面会让 agent 卡死。
// 这里的口径是"只跑能证明这次改动没坏的测试":
//   1. 改的就是测试文件 → 跑它自己;
//   2. 同目录的 *.test / test_*.py → 大概率覆盖该文件;
//   3. 其它测试文件里 import/require 了该模块 → 跑它。
// 找不到受影响测试就静默跳过(不假装跑过、不误报通过)。
//
// 失败同样走基线 diff:首次运行报全部,之后只报"新增失败" —— 已知的坏测试不会每次编辑都刷屏。
// KINET_NO_AUTOTEST=1 可关闭。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { commandExists } from './skill-requires';

export type TestRunner = 'vitest' | 'jest' | 'mocha' | 'pytest' | 'go';

export interface TestPlan {
  runner: TestRunner;
  root: string;
  cmd: string;
  args: string[];
  /** 相对 root 的测试文件(go 为包目录) */
  files: string[];
  label: string;
  timeoutMs: number;
}

export interface TestProbe {
  which(cmd: string): boolean;
}

const defaultProbe: TestProbe = { which: commandExists };
const CODE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.venv', 'venv', '__pycache__', 'target', 'vendor']);
const MAX_SCAN_FILES = 3000;
const MAX_AFFECTED = 8;
const MAX_READ = 200 * 1024;
const TEST_FAIL_TIMEOUT_MS = 180_000;

function readText(p: string, max = MAX_READ): string {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > max) return '';
    return fs.readFileSync(p, 'utf8');
  } catch { return ''; }
}

function nearestRoot(start: string, markers: string[], boundary: string): string | null {
  let dir = path.resolve(start);
  const stop = path.resolve(boundary);
  for (;;) {
    if (markers.some((m) => { try { return fs.existsSync(path.join(dir, m)); } catch { return false; } })) return dir;
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    const rel = path.relative(stop, parent);
    if (parent === dir || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    dir = parent;
  }
}

function walk(dir: string, out: string[], budget: number, isTest: (rel: string) => boolean): void {
  if (out.length >= budget) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= budget) return;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), out, budget, isTest);
    } else if (e.isFile()) {
      const abs = path.join(dir, e.name);
      if (isTest(abs)) out.push(abs);
    }
  }
}

// 测试文件发现按项目缓存:每次编辑都全仓 walk 一次太浪费(60s TTL,足够覆盖一轮改动)。
const discoverCache = new Map<string, { at: number; files: string[] }>();

function testFilesOf(root: string, isTest: (abs: string) => boolean): string[] {
  const hit = discoverCache.get(root);
  if (hit && Date.now() - hit.at < 60_000) return hit.files;
  const out: string[] = [];
  walk(root, out, MAX_SCAN_FILES, isTest);
  discoverCache.set(root, { at: Date.now(), files: out });
  return out;
}

function localBin(root: string, name: string, _probe: TestProbe): string | null {
  const base = path.join(root, 'node_modules', '.bin', name);
  if (process.platform === 'win32') {
    for (const ext of ['.cmd', '.exe', '']) if (fs.existsSync(base + ext)) return base + ext;
    return null;
  }
  return fs.existsSync(base) ? base : null;
}

function importPattern(moduleBase: string): RegExp {
  // '…/tools' / './tools.ts' / '@/lib/tools' —— 只认"引号里的模块路径",不认正文提及
  const esc = moduleBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['"](?:[^'"]*/)?${esc}(?:\\.(?:[cm]?[jt]sx?|py))?['"]`);
}

/** Python 的 import 不带引号:from pkg.mod import x / import mod */
function pyImportPattern(moduleBase: string): RegExp {
  const esc = moduleBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)\\s*(?:from|import)\\s+[\\w.]*\\b${esc}\\b`);
}

function isJsTest(abs: string): boolean {
  const base = path.basename(abs);
  if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return false;
  return true;
}

function isPyTest(abs: string): boolean {
  const base = path.basename(abs);
  return /^(test_.*|.*_test)\.py$/.test(base);
}

/** 该文件改动后应该跑哪些测试;判定不了返回 null(静默跳过)。 */
export function planAffectedTests(file: string, cwd: string, probe: TestProbe = defaultProbe): TestPlan | null {
  const abs = path.resolve(file);
  const ext = path.extname(abs).toLowerCase();
  if (!CODE_EXTS.has(ext)) return null;
  const dir = path.dirname(abs);
  const base = path.basename(abs, ext);

  if (ext === '.py') {
    const root = nearestRoot(dir, ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'], cwd);
    if (!root) return null;
    const venvPytest = path.join(root, '.venv', 'bin', 'pytest');
    const cmd = fs.existsSync(venvPytest) ? venvPytest : probe.which('pytest') ? 'pytest' : null;
    if (!cmd) return null;
    const tests = testFilesOf(root, isPyTest);
    const files = selectAffected(abs, root, tests, base, (t) => pyImportPattern(base).test(readText(t)));
    if (!files.length) return null;
    return { runner: 'pytest', root, cmd, args: [...files], files, label: `pytest · ${files.length} 个文件`, timeoutMs: TEST_FAIL_TIMEOUT_MS };
  }

  if (ext === '.go') {
    const root = nearestRoot(dir, ['go.mod'], cwd);
    if (!root) return null;
    let hasTest = false;
    try { hasTest = fs.readdirSync(dir).some((n) => n.endsWith('_test.go')); } catch { /* ignore */ }
    if (!hasTest) return null;
    const rel = path.relative(root, dir).replace(/\\/g, '/');
    return { runner: 'go', root, cmd: 'go', args: ['test', rel ? `./${rel}` : './...'], files: [rel || '.'], label: `go test ./${rel || '...'}`, timeoutMs: TEST_FAIL_TIMEOUT_MS };
  }

  // JS / TS
  const root = nearestRoot(dir, ['package.json'], cwd);
  if (!root) return null;
  const runners: Array<{ runner: TestRunner; bin: string }> = [
    { runner: 'vitest', bin: 'vitest' },
    { runner: 'jest', bin: 'jest' },
    { runner: 'mocha', bin: 'mocha' },
  ];
  const hit = runners.map((r) => ({ ...r, path: localBin(root, r.bin, probe) })).find((r) => r.path);
  if (!hit || !hit.path) return null;
  const tests = testFilesOf(root, isJsTest).filter((t) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(t));
  const files = selectAffected(abs, root, tests, base, (t) => importPattern(base).test(readText(t)));
  if (!files.length) return null;
  const args = hit.runner === 'vitest' ? ['run', ...files]
    : hit.runner === 'jest' ? ['--runTestsByPath', ...files, '--silent']
      : [...files];
  return {
    runner: hit.runner,
    root,
    cmd: hit.path,
    args,
    files,
    label: `${hit.runner} · ${files.length} 个文件`,
    timeoutMs: TEST_FAIL_TIMEOUT_MS,
  };
}

function testStem(absTest: string): string {
  return path.basename(absTest)
    .replace(/\.(test|spec)\.[^.]+$/, '')
    .replace(/\.[^.]+$/, '')
    .replace(/^test_/, '')
    .replace(/_test$/, '');
}

/** 同目录 + 名字直接对应(util.ts ↔ util.test.ts / test_util.py)才算"大概覆盖"。 */
function isNameSibling(absTest: string, absSource: string, moduleBase: string): boolean {
  if (path.dirname(absTest) !== path.dirname(absSource)) return false;
  return testStem(absTest) === moduleBase;
}

/** 自身是测试 → 只跑它;否则按"名字对应 / 直接 import"筛选,按路径排序后截断。 */
function selectAffected(
  absFile: string,
  root: string,
  tests: string[],
  moduleBase: string,
  isImported: (t: string) => boolean,
): string[] {
  const relSelf = path.relative(root, absFile).replace(/\\/g, '/');
  if (tests.some((t) => path.resolve(t) === absFile)) return [relSelf];
  return tests
    .filter((t) => isImported(t) || isNameSibling(t, absFile, moduleBase))
    .map((t) => path.relative(root, t).replace(/\\/g, '/'))
    .sort()
    .slice(0, MAX_AFFECTED);
}

export interface TestRunResult { code: number; output: string; ms: number; spawnFailed: boolean }

function runTests(plan: TestPlan): Promise<TestRunResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(
      plan.cmd,
      plan.args,
      { cwd: plan.root, timeout: plan.timeoutMs, maxBuffer: 6 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
        resolve({
          code,
          output: `${stdout ?? ''}\n${stderr ?? ''}`.trim(),
          ms: Date.now() - t0,
          spawnFailed: !!(err && (err as NodeJS.ErrnoException).code === 'ENOENT'),
        });
      },
    );
  });
}

/** 从测试输出里抽失败行(vitest/jest/pytest/go test 的常见形态),归一化后去重。 */
export function parseTestFailures(output: string, code: number, max = 12): string[] {
  const ANON = /\u001b\[[0-9;]*m/g;
  const lines = output.replace(ANON, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const isFail = /^(FAIL|✕|×|✗|not ok\b)/.test(line)
      || /^E\s{2,}/.test(line)
      || /^(AssertionError|Error:|TypeError|ReferenceError|Failed:)/.test(line)
      || /(^|\s)(FAILED|ERROR)\s+[^\s]/.test(line);
    if (!isFail) continue;
    // 去掉耗时/内存等易变噪声,基线才能跨次比较
    const sig = line.replace(/\b\d+(\.\d+)?\s*(ms|s|seconds?|minutes?)\b/gi, '').replace(/\s+/g, ' ').slice(0, 200);
    if (seen.has(sig)) continue;
    seen.add(sig);
    picked.push(sig);
    if (picked.length >= max) break;
  }
  if (!picked.length && code !== 0) {
    for (const line of lines.slice(-6)) if (!seen.has(line)) { seen.add(line); picked.push(line.slice(0, 200)); }
  }
  return picked;
}

const baselines = new Map<string, Set<string>>();
const inflight = new Set<string>();

/**
 * 编辑后自动测试入口。返回要拼进工具结果的文本;不适用/没条件 → 空串。
 */
export async function testAfterEdit(opts: { cwd: string; file: string; probe?: TestProbe }): Promise<string> {
  if (process.env.KINET_NO_AUTOTEST === '1') return '';
  let plan: TestPlan | null = null;
  try { plan = planAffectedTests(opts.file, opts.cwd, opts.probe ?? defaultProbe); } catch { return ''; }
  if (!plan) return '';
  const key = `${plan.runner}|${plan.root}|${plan.files.join(',')}`;
  if (inflight.has(key)) return '';
  inflight.add(key);
  try {
    const res = await runTests(plan);
    if (res.spawnFailed) return '';
    const prev = baselines.get(key) ?? null;
    const failures = parseTestFailures(res.output, res.code);
    baselines.set(key, new Set(failures));
    const fresh = prev ? failures.filter((f) => !prev.has(f)) : failures;
    const sec = (res.ms / 1000).toFixed(1);
    if (res.code === 0) return `🧪 自动测试(${plan.label}):通过 (${sec}s)`;
    if (!fresh.length) {
      return failures.length
        ? `🧪 自动测试(${plan.label}):${failures.length} 个既有失败,本次未新增 (${sec}s)`
        : `🧪 自动测试(${plan.label}):退出码 ${res.code},但未解析出失败行 — 手动跑一次确认 (${sec}s)`;
    }
    return `⚠️ 自动测试(${plan.label}):${fresh.length} 个失败 (${sec}s)\n${fresh.map((f) => `  ${f}`).join('\n')}\n  [先修失败再继续;确认是既有问题可忽略]`;
  } catch {
    return '';
  } finally {
    inflight.delete(key);
  }
}
