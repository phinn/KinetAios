// 诊断自验证内环 —— 改完代码立刻让类型检查器/静态检查器看一眼,把错误回灌给模型。
//
// 为什么需要:模型改完文件"觉得对"就往下走,类型错误往往要到跑构建/被用户发现才暴露,
// 平均多花 1~2 轮返工。这里按项目类型自动选检查器(TS: tsc / JS: eslint / Python: pyright 或
// 语法编译 / Go: gopls check 或 go vet),在 write_file / edit_file 成功后自动跑一次。
//
// 关键设计:
// - 只回灌「本文件的问题」+「本次新增到其他文件的问题」:首次运行先记基线,之后按 (文件|消息)
//   去重。否则大仓库的数百条历史错误会每次编辑都灌进上下文,直接把 agent 淹掉。
// - 纯检测 + 纯解析可注入探针(测试不 spawn 真编译器);执行侧用 execFile(argv 直传,不过 shell)。
// - 任何一步失败(工具没装/项目没配置/超时)→ 静默跳过:自动诊断是增强,不能反过来拖慢编辑。
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { commandExists } from './skill-requires';

export type DiagKind = 'tsc' | 'eslint' | 'pyright' | 'pycompile' | 'gopls' | 'govet';

export const DIAG_LABELS: Record<DiagKind, string> = {
  tsc: 'tsc 类型检查',
  eslint: 'eslint',
  pyright: 'pyright',
  pycompile: 'Python 语法编译',
  gopls: 'gopls check',
  govet: 'go vet',
};

export interface DiagPlan {
  kind: DiagKind;
  /** 项目根(命令 cwd + 相对路径基准) */
  root: string;
  cmd: string;
  args: string[];
  timeoutMs: number;
  /** 单文件诊断时记录(自动回灌要用它挑"我改的文件") */
  file?: string;
}

export interface DiagFinding {
  /** 相对项目根的路径;拿不到位置时为空串 */
  file: string;
  line: number;
  col?: number;
  text: string;
}

export interface DiagProbe {
  exists(p: string): boolean;
  which(cmd: string): boolean;
}

const defaultProbe: DiagProbe = {
  exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
  which: (c) => commandExists(c),
};

const CODE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go']);
const TS_CONFIG_RE = /^(tsconfig|jsconfig)(\.[A-Za-z0-9_.-]+)?\.json$/;
const ESLINT_CONFIG_RE = /^(eslint\.config\.(js|mjs|cjs|ts)|\.eslintrc(\.[A-Za-z0-9]+)?)$/;
const PY_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', '.venv', 'venv'];
const MAX_FINDINGS = 200;

function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function readdirSafe(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function readTextSafe(p: string, max = 200_000): string {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > max) return '';
    return fs.readFileSync(p, 'utf8');
  } catch { return ''; }
}

// tsconfig 允许注释/尾逗号,JSON.parse 会炸 → 宽松解析(只兜这两种)。
function tolerantJson(text: string): { include?: unknown; files?: unknown } | null {
  if (!text.trim()) return null;
  const strip = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/,\s*([}\]])/g, '$1');
  for (const candidate of [text, strip(text)]) {
    try { return JSON.parse(candidate); } catch { /* 试下一种 */ }
  }
  return null;
}

function includePrefix(inc: string): string {
  return inc.replace(/^\.\//, '').replace(/\*.*$/, '').replace(/\/+$/, '');
}

/** 找一个配置文件覆盖了该文件的 tsconfig/jsconfig(多配置仓库:tsconfig.main.json / tsconfig.renderer.json 等)。 */
function findTsConfig(startDir: string, boundary: string, absFile: string): { root: string; config: string } | null {
  const root = findConfigDir(startDir, boundary, (n) => TS_CONFIG_RE.test(n));
  if (!root) return null;
  const names = readdirSafe(root).filter((n) => TS_CONFIG_RE.test(n) && !n.endsWith('.tsbuildinfo'));
  if (!names.length) return null;
  const rel = path.relative(root, absFile).replace(/\\/g, '/');
  const scored = names.map((n) => {
    const cfgPath = path.join(root, n);
    const json = tolerantJson(readTextSafe(cfgPath));
    const list = [...(Array.isArray(json?.include) ? json!.include as string[] : []), ...(Array.isArray(json?.files) ? json!.files as string[] : [])]
      .filter((x): x is string => typeof x === 'string');
    // include 的静态前缀命中文件路径 = 这份配置确实管这个文件
    const covered = list.some((inc) => {
      const p = includePrefix(inc);
      return !p || rel === p || rel.startsWith(`${p}/`);
    });
    return { n, cfgPath, covered, depth: n.split('.').length };
  }).sort((a, b) => Number(b.covered) - Number(a.covered) || a.depth - b.depth || a.n.localeCompare(b.n));
  return { root, config: scored[0].cfgPath };
}

/** 向上找最近的含满足 match 的文件的目录;不越过 boundary(工作目录)。 */
function findConfigDir(start: string, boundary: string, match: (name: string) => boolean): string | null {
  let dir = path.resolve(start);
  const stop = path.resolve(boundary);
  for (;;) {
    if (readdirSafe(dir).some(match)) return dir;
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir || !isInside(parent, stop)) return null;
    dir = parent;
  }
}

/** 从 start 向上找最近的含指定标记的目录;不越过 boundary(工作目录)。 */
function nearestAncestor(start: string, markers: string[], boundary: string, probe: DiagProbe): string | null {
  let dir = path.resolve(start);
  const stop = path.resolve(boundary);
  for (;;) {
    if (markers.some((m) => probe.exists(path.join(dir, m)))) return dir;
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir || !isInside(parent, stop)) return null;
    dir = parent;
  }
}

function localBin(root: string, name: string, probe: DiagProbe): string | null {
  const base = path.join(root, 'node_modules', '.bin', name);
  if (process.platform === 'win32') {
    for (const ext of ['.cmd', '.exe', '']) if (probe.exists(base + ext)) return base + ext;
    return null;
  }
  return probe.exists(base) ? base : null;
}

/** 该文件属于哪个项目、该用哪个检查器。判定不了/工具不可用 → null(静默跳过)。 */
export function planDiagnostics(file: string, cwd: string, probe: DiagProbe = defaultProbe): DiagPlan | null {
  const abs = path.resolve(file);
  const ext = path.extname(abs).toLowerCase();
  if (!CODE_EXTS.has(ext)) return null;
  const dir = path.dirname(abs);

  if (ext === '.py') {
    const root = nearestAncestor(dir, PY_MARKERS, cwd, probe);
    if (!root) return null;
    const pyright = localBin(root, 'pyright', probe) ?? (probe.which('pyright') ? 'pyright' : null);
    if (pyright) {
      return { kind: 'pyright', root, cmd: pyright, args: ['--outputjson', abs], timeoutMs: 40_000, file: abs };
    }
    if (probe.which('python3')) {
      return { kind: 'pycompile', root, cmd: 'python3', args: ['-m', 'py_compile', abs], timeoutMs: 12_000, file: abs };
    }
    return null;
  }

  if (ext === '.go') {
    const root = nearestAncestor(dir, ['go.mod'], cwd, probe);
    if (!root) return null;
    if (probe.which('gopls')) {
      return { kind: 'gopls', root, cmd: 'gopls', args: ['check', abs], timeoutMs: 25_000, file: abs };
    }
    if (probe.which('go')) {
      const rel = path.relative(root, dir) || '.';
      return { kind: 'govet', root, cmd: 'go', args: ['vet', rel === '.' ? './...' : `./${rel.replace(/\\/g, '/')}`], timeoutMs: 30_000, file: abs };
    }
    return null;
  }

  // TS / JS:有 tsconfig/jsconfig 用 tsc(项目级),否则有 eslint 配置用 eslint(单文件)。
  // 多配置仓库(tsconfig.main.json / tsconfig.renderer.json)按 include 覆盖范围选正确的那份。
  const pick = findTsConfig(dir, cwd, abs);
  if (pick) {
    const tsc = localBin(pick.root, 'tsc', probe) ?? (probe.which('tsc') ? 'tsc' : null);
    if (tsc) {
      return { kind: 'tsc', root: pick.root, cmd: tsc, args: ['--noEmit', '--pretty', 'false', '-p', pick.config], timeoutMs: 40_000, file: abs };
    }
  }
  const esRoot = findConfigDir(dir, cwd, (n) => ESLINT_CONFIG_RE.test(n));
  if (esRoot) {
    const eslint = localBin(esRoot, 'eslint', probe) ?? (probe.which('eslint') ? 'eslint' : null);
    if (eslint) {
      return { kind: 'eslint', root: esRoot, cmd: eslint, args: ['--no-color', '--format', 'unix', abs], timeoutMs: 20_000, file: abs };
    }
  }
  return null;
}

/** 目录级诊断(手动工具用):按目录里的项目标记选检查器。 */
export function planProjectDiagnostics(targetDir: string, cwd: string, probe: DiagProbe = defaultProbe): DiagPlan | null {
  const abs = path.resolve(targetDir);
  let isFile = false;
  try { isFile = fs.existsSync(abs) && fs.statSync(abs).isFile(); } catch { isFile = false; }
  const dir = isFile ? path.dirname(abs) : abs;

  const pick = findTsConfig(dir, cwd, isFile ? abs : path.join(dir, '__project__.ts'));
  if (pick && TS_CONFIG_RE.test(path.basename(pick.config))) {
    const tsc = localBin(pick.root, 'tsc', probe) ?? (probe.which('tsc') ? 'tsc' : null);
    if (tsc) {
      return { kind: 'tsc', root: pick.root, cmd: tsc, args: ['--noEmit', '--pretty', 'false', '-p', pick.config], timeoutMs: 60_000 };
    }
  }
  const esRoot = findConfigDir(dir, cwd, (n) => ESLINT_CONFIG_RE.test(n));
  if (esRoot) {
    const eslint = localBin(esRoot, 'eslint', probe) ?? (probe.which('eslint') ? 'eslint' : null);
    if (eslint) return { kind: 'eslint', root: esRoot, cmd: eslint, args: ['--no-color', '--format', 'unix', esRoot], timeoutMs: 40_000 };
  }
  const pyRoot = nearestAncestor(dir, PY_MARKERS, cwd, probe);
  if (pyRoot) {
    const pyright = localBin(pyRoot, 'pyright', probe) ?? (probe.which('pyright') ? 'pyright' : null);
    if (pyright) return { kind: 'pyright', root: pyRoot, cmd: pyright, args: ['--outputjson', pyRoot], timeoutMs: 90_000 };
  }
  const goRoot = nearestAncestor(dir, ['go.mod'], cwd, probe);
  if (goRoot) {
    if (probe.which('go')) return { kind: 'govet', root: goRoot, cmd: 'go', args: ['vet', './...'], timeoutMs: 60_000 };
  }
  return null;
}

// ── 解析 ────────────────────────────────────────────────────

function normalizeRel(file: string, root: string): string {
  if (!file) return '';
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : abs;
}

/** 把检查器输出解析成结构化问题。只认各工具的标准输出格式,解析不了的行直接丢。 */
export function parseDiagnostics(kind: DiagKind, output: string, root: string): DiagFinding[] {
  const out: DiagFinding[] = [];
  const push = (file: string, line: number, col: number | undefined, text: string): void => {
    if (out.length >= MAX_FINDINGS) return;
    out.push({ file: normalizeRel(file, root), line, col, text: text.trim().slice(0, 300) });
  };

  if (kind === 'pyright') {
    let json: { generalDiagnostics?: Array<{ file?: string; severity?: string; message?: string; range?: { start?: { line?: number; character?: number } } }> };
    try { json = JSON.parse(output); } catch { json = {}; }
    for (const d of json.generalDiagnostics ?? []) {
      if (d.severity && d.severity !== 'error' && d.severity !== 'warning') continue;
      push(d.file ?? '', (d.range?.start?.line ?? 0) + 1, (d.range?.start?.character ?? 0) + 1, d.message ?? '');
    }
    if (out.length) return out;
    // 非 JSON 兜底:  /path/a.py:12:5 - error: msg
    for (const line of output.split('\n')) {
      const m = /^\s*(.+?):(\d+):(\d+)\s+-\s+(?:error|warning):\s*(.+)$/.exec(line);
      if (m) push(m[1], Number(m[2]), Number(m[3]), m[4]);
    }
    return out;
  }

  if (kind === 'pycompile') {
    const lines = output.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /File "([^"]+)", line (\d+)/.exec(lines[i]);
      if (!m) continue;
      // 错误类型在后面的缩进行里(SyntaxError: …)
      let msg = '';
      for (let k = i + 1; k < Math.min(i + 5, lines.length); k++) {
        const em = /^\s*([A-Za-z_]*Error):\s*(.+)$/.exec(lines[k]);
        if (em) { msg = `${em[1]}: ${em[2]}`; break; }
      }
      push(m[1], Number(m[2]), undefined, msg || lines[i].trim());
    }
    return out;
  }

  // tsc / eslint / gopls / go vet 都是「文件:行:列: 消息」族,各有一个细节差异。
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    if (kind === 'tsc') {
      const m = /^(.+?)\((\d+),(\d+)\):\s*(?:error|warning)\s+(TS\d+):\s*(.*)$/.exec(line.trim());
      if (m) { push(m[1], Number(m[2]), Number(m[3]), `${m[4]} ${m[5]}`); continue; }
      const plain = /^error\s+(TS\d+):\s*(.*)$/.exec(line.trim());
      if (plain) push('', 0, undefined, `${plain[1]} ${plain[2]}`);
      continue;
    }
    // eslint unix / go vet / gopls check
    const m = /^(.+?):(\d+):(\d+):\s*(.+)$/.exec(line.trim());
    if (m) push(m[1], Number(m[2]), Number(m[3]), m[4].replace(/\s*\[[^\]]*\]\s*$/, ''));
  }
  return out;
}

// ── 执行 ────────────────────────────────────────────────────

export interface DiagExecResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
  /** 进程都没起来(工具不存在等)→ 调用方静默跳过 */
  spawnFailed: boolean;
}

function runCmd(plan: DiagPlan): Promise<DiagExecResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Windows 上 node_modules/.bin 是 .cmd shim,execFile 必须走 shell 才能执行(CVE-2024-27980)。
    // 走 shell 时 argv 不会自动转义 → 自己加上引号,否则路径含空格(用户名带空格很常见)必炸。
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(plan.cmd);
    const winQuote = (s: string): string => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const cmd = shell ? [plan.cmd, ...plan.args].map(winQuote).join(' ') : plan.cmd;
    const args = shell ? [] : plan.args;
    execFile(
      cmd,
      args,
      { cwd: plan.root, timeout: plan.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ms: Date.now() - t0,
          spawnFailed: !!(err && (err as NodeJS.ErrnoException).code === 'ENOENT'),
        });
      },
    );
  });
}

/** 跑一次诊断,返回解析后的问题。进程起不来(工具缺失)→ null。 */
export async function runPlan(plan: DiagPlan): Promise<{ findings: DiagFinding[]; ms: number; code: number; output: string } | null> {
  const r = await runCmd(plan);
  if (r.spawnFailed) return null;
  const output = `${r.stdout}\n${r.stderr}`.trim();
  const findings = parseDiagnostics(plan.kind, output, plan.root);
  return { findings, ms: r.ms, code: r.code, output };
}

// ── 基线与回灌 ──────────────────────────────────────────────

// 每个项目一份「上一次诊断看到的问题」签名(文件|消息,不含行号 —— 编辑会让行号整体漂移)。
// key 含完整命令:同一仓库的多套配置(tsconfig.main / tsconfig.renderer)基线互不污染。
const baselines = new Map<string, Set<string>>();
const inflight = new Set<string>();
// 同一份内容不必重复诊断:文件写完立刻再写一次相同内容(或格式化回写)时直接跳过,
// 省掉一次几秒的 tsc。内容变了才重新跑。
const lastHash = new Map<string, string>();

function contentHash(file: string): string {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return '';
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

function planKey(plan: DiagPlan): string {
  return `${plan.kind}|${plan.root}|${plan.args.join(' ')}`;
}

function sigOf(f: DiagFinding): string {
  return `${f.file}|${f.text}`;
}

/**
 * 从全量问题里挑出要回灌给模型的部分:
 * - 首次运行(previous=null):只报「我改的文件」(其他文件的历史错误是噪声);
 * - 之后:本文件的问题 + 本次新增到其他文件的问题。
 */
export function selectFeedback(findings: DiagFinding[], previous: Set<string> | null, editedFile: string | undefined, root: string): DiagFinding[] {
  const edited = editedFile ? normalizeRel(editedFile, root) : '';
  const picked: DiagFinding[] = [];
  const seen = new Set<string>();
  const add = (f: DiagFinding): void => {
    const k = sigOf(f);
    if (seen.has(k)) return;
    seen.add(k);
    picked.push(f);
  };
  for (const f of findings) {
    if (edited && f.file === edited) add(f);
    else if (previous && !previous.has(sigOf(f))) add(f);
  }
  return picked;
}

export function formatDiagFindings(label: string, findings: DiagFinding[], opts: { max?: number; hidden?: number } = {}): string {
  const max = opts.max ?? 10;
  if (!findings.length) return `✅ 自动诊断(${label}):无错误`;
  const lines = findings.slice(0, max).map((f) => {
    const loc = f.file ? `${f.file}${f.line ? `:${f.line}${f.col ? `:${f.col}` : ''}` : ''}` : '(项目)';
    return `  ${loc}  ${f.text}`;
  });
  const more = findings.length > max ? `\n  …(共 ${findings.length} 条,只显示前 ${max})` : '';
  const hidden = opts.hidden ? `\n  (另有 ${opts.hidden} 个其他文件的历史问题,未列出)` : '';
  return `⚠️ 自动诊断(${label}):${findings.length} 个问题\n${lines.join('\n')}${more}${hidden}\n  [这是刚改完文件后的自动检查。请先修掉这些问题再继续,别让错误累积到构建/运行阶段。]`;
}

/**
 * 编辑后自动诊断的唯一入口。返回要拼在工具结果后面的文本;不需要/没条件 → 空串。
 * KINET_NO_AUTODIAG=1 可整体关闭(大仓库里 tsc 很慢时可救急)。
 */
export async function diagnoseAfterEdit(opts: { cwd: string; file: string; probe?: DiagProbe }): Promise<string> {
  if (process.env.KINET_NO_AUTODIAG === '1') return '';
  const plan = planDiagnostics(opts.file, opts.cwd, opts.probe ?? defaultProbe);
  if (!plan) return '';
  const key = planKey(plan);
  const hash = contentHash(plan.file ?? opts.file);
  if (hash && lastHash.get(key) === hash) return ''; // 内容没变,上次结论仍然有效
  // 同一个项目同时只跑一个检查(并发编辑时后一次直接跳过,避免叠好几份 tsc)。
  if (inflight.has(key)) return '';
  inflight.add(key);
  try {
    const res = await runPlan(plan);
    if (!res) return '';
    if (hash) lastHash.set(key, hash);
    const previous = baselines.get(key) ?? null;
    const picked = selectFeedback(res.findings, previous, plan.file, plan.root);
    baselines.set(key, new Set(res.findings.map(sigOf)));
    if (!picked.length) {
      // 解析不出问题但进程非 0 退出 = 检查器自身没跑通(配置错/版本不兼容)。
      // 不能报"✅ 无错误",否则给了假的安全感。
      if (!res.findings.length && res.code !== 0 && res.output) {
        return `⚠️ 自动诊断(${DIAG_LABELS[plan.kind]}):检查未正常完成(退出码 ${res.code}):${res.output.split('\n').find((l) => l.trim())?.slice(0, 200) ?? ''}`;
      }
      return res.findings.length ? `✅ 自动诊断(${DIAG_LABELS[plan.kind]}):本次改动未引入新问题` : `✅ 自动诊断(${DIAG_LABELS[plan.kind]}):无错误`;
    }
    const hidden = res.findings.length - picked.length;
    return formatDiagFindings(DIAG_LABELS[plan.kind], picked, { hidden: hidden > 0 ? hidden : 0 });
  } catch {
    return ''; // 自动诊断失败绝不拖累编辑本身
  } finally {
    inflight.delete(key);
  }
}

/** 手动 diagnostics 工具:全量报告(不走基线,不隐藏其他文件的问题)。 */
export async function diagnosticsReport(opts: { target: string; cwd: string; maxErrors?: number; probe?: DiagProbe }): Promise<string> {
  const plan = planProjectDiagnostics(opts.target, opts.cwd, opts.probe ?? defaultProbe);
  if (!plan) {
    return 'ℹ️ 未检测到可用的诊断工具:当前目录没有 tsconfig/jsconfig、eslint 配置、pyproject/requirements、go.mod,或对应检查器未安装。';
  }
  const res = await runPlan(plan);
  if (!res) return `ℹ️ 诊断工具「${DIAG_LABELS[plan.kind]}」执行失败(可能未安装或路径不可用)。`;
  const max = Math.max(1, Math.min(100, opts.maxErrors ?? 30));
  if (!res.findings.length) {
    if (res.code !== 0 && res.output) {
      return `⚠️ 诊断未正常完成(${DIAG_LABELS[plan.kind]},退出码 ${res.code}):\n${res.output.split('\n').slice(0, 5).join('\n')}`;
    }
    return `✅ 诊断通过(${DIAG_LABELS[plan.kind]},${(res.ms / 1000).toFixed(1)}s):无错误`;
  }
  const lines = res.findings.slice(0, max).map((f) => {
    const loc = f.file ? `${f.file}${f.line ? `:${f.line}${f.col ? `:${f.col}` : ''}` : ''}` : '(项目)';
    return `${loc}  ${f.text}`;
  });
  const more = res.findings.length > max ? `\n…(共 ${res.findings.length} 条,只显示前 ${max})` : '';
  return `⚠️ 诊断发现 ${res.findings.length} 个问题(${DIAG_LABELS[plan.kind]},${(res.ms / 1000).toFixed(1)}s):\n${lines.join('\n')}${more}`;
}
