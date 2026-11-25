// 仓库语义地图 —— 零依赖符号索引。
//
// 解决的问题:agent 进陌生仓库时,只能 glob → 逐层 ls → 挨个 read_file 猜结构,
// 一轮 turn 就烧掉几千 token 还没看到实现。这里用保守的正则扫描把「有哪些文件、
// 每个文件定义了什么顶层符号、谁依赖谁」压成一段 2~4K 字符的地图,一次调用到手。
//
// 不引 tree-sitter:只认顶层声明(导出/顶层 function/class/def/func/fn)与相对 import 边。
// 宁可漏(嵌套声明),不要错(把注释/字符串里的内容当成符号)。
// 索引按 (relative path + size + mtimeMs) 指纹缓存到 userData;仓库没动 → 第二次零扫描。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type RepoSymbol = { name: string; kind: string; line: number; exported?: boolean };
export type RepoFile = { path: string; lang: string; symbols: RepoSymbol[]; deps: string[] };
export type RepoIndex = {
  root: string;
  files: RepoFile[];
  /** 扫描(或命中缓存)的源码文件数 */
  scanned: number;
  /** 是否因 maxFiles 上限截断 */
  truncated: boolean;
  fingerprint: string;
};

export type ScanOpts = {
  maxFiles?: number;
  maxFileBytes?: number;
  /** 传 null = 只用内存缓存(测试/无 userData 场景);不传 = 自动解析 userData */
  cacheDir?: string | null;
  /** 跳过缓存,强制重扫 */
  refresh?: boolean;
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'release', 'target', '.next', '.nuxt',
  'coverage', '.cache', '__pycache__', 'venv', '.venv', 'vendor', 'tmp', 'temp',
  '.idea', '.vscode', 'Pods', 'DerivedData', '.gradle', '.tox', '.mypy_cache', '.pytest_cache',
  '.turbo', '.parcel-cache', '.svelte-kit', 'bower_components',
]);

const SKIP_FILE_SUFFIX = ['.min.js', '.min.mjs', '.min.css', '.d.ts', '.map', '.bundle.js'];

const EXT_LANG: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.py': 'py', '.go': 'go', '.rs': 'rs',
};
const LANG_EXTS: Record<string, string[]> = {
  ts: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  js: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  py: ['.py'],
  go: ['.go'],
  rs: ['.rs'],
};

const MAX_FILES_DEFAULT = 3000;
const MAX_FILE_BYTES_DEFAULT = 400_000;
const MAX_SYMBOLS_PER_FILE = 300;

// ── 扫描 ────────────────────────────────────────────────────

type Walked = { rel: string; abs: string; size: number; mtimeMs: number; lang: string };

function walk(root: string, maxFiles: number): { files: Walked[]; truncated: boolean } {
  const out: Walked[] = [];
  const stack = [''];
  let truncated = false;
  while (stack.length) {
    const relDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) { truncated = true; break; }
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue; // 防循环
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        stack.push(rel);
        continue;
      }
      if (!ent.isFile()) continue;
      const lower = ent.name.toLowerCase();
      if (SKIP_FILE_SUFFIX.some((s) => lower.endsWith(s))) continue;
      const lang = EXT_LANG[path.extname(lower)];
      if (!lang) continue;
      try {
        const st = fs.statSync(path.join(root, rel));
        out.push({ rel, abs: path.join(root, rel), size: st.size, mtimeMs: st.mtimeMs, lang });
      } catch {
        /* 竞态:文件在扫描中被删 */
      }
    }
    if (out.length >= maxFiles) { truncated = true; break; }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files: out, truncated };
}

function fingerprintOf(files: Walked[]): string {
  const h = crypto.createHash('sha1');
  for (const f of files) h.update(`${f.rel}|${f.size}|${Math.round(f.mtimeMs)}\n`);
  return h.digest('hex');
}

// ── 符号提取 ────────────────────────────────────────────────

const TS_DECL = /^(export\s+)?(?:declare\s+)?(?:default\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const PY_DEF = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const PY_CLASS = /^class\s+([A-Za-z_]\w*)/;
const GO_FUNC = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/;
const GO_TYPE = /^(type|var|const)\s+([A-Za-z_]\w*)/;
const RS_FN = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/;
const RS_DECL = /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|const|static|mod)\s+([A-Za-z_]\w*)/;

function pushSymbol(syms: RepoSymbol[], s: RepoSymbol): void {
  if (syms.length >= MAX_SYMBOLS_PER_FILE) return;
  syms.push(s);
}

function extractSymbols(text: string, lang: string): RepoSymbol[] {
  const syms: RepoSymbol[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // 只认行首(顶层)。缩进行属于嵌套声明,不进地图 —— 宁可漏,不要错。
    const line = lines[i];
    if (!line || line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9) continue;
    const lineNo = i + 1;

    if (lang === 'ts' || lang === 'js') {
      const m = TS_DECL.exec(line);
      if (!m) continue;
      const rawKind = m[2] === 'function*' ? 'function' : m[2];
      // 未导出的 const/let/var 是文件内单例常量,噪声多;函数/类/接口照样收(同目录引用常见)。
      if (!m[1] && (rawKind === 'const' || rawKind === 'let' || rawKind === 'var')) continue;
      const kind = rawKind === 'function' ? 'fn' : rawKind === 'interface' ? 'iface' : rawKind;
      pushSymbol(syms, { name: m[3], kind, line: lineNo, exported: !!m[1] });
      continue;
    }
    if (lang === 'py') {
      let m = PY_DEF.exec(line);
      if (m) { pushSymbol(syms, { name: m[1], kind: 'def', line: lineNo }); continue; }
      m = PY_CLASS.exec(line);
      if (m) pushSymbol(syms, { name: m[1], kind: 'class', line: lineNo });
      continue;
    }
    if (lang === 'go') {
      let m = GO_FUNC.exec(line);
      if (m) { pushSymbol(syms, { name: m[1], kind: 'func', line: lineNo }); continue; }
      m = GO_TYPE.exec(line);
      if (m) pushSymbol(syms, { name: m[2], kind: m[1], line: lineNo });
      continue;
    }
    if (lang === 'rs') {
      let m = RS_FN.exec(line);
      if (m) { pushSymbol(syms, { name: m[1], kind: 'fn', line: lineNo }); continue; }
      m = RS_DECL.exec(line);
      if (m) pushSymbol(syms, { name: m[2], kind: m[1], line: lineNo });
    }
  }
  return syms;
}

// ── 依赖边 ──────────────────────────────────────────────────

const TS_IMPORT = /(?:from\s*|require\(\s*|import\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
const PY_FROM = /^\s*from\s+(\.+[\w.]*)\s+import\b/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+)/gm;
const RS_MOD = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm;

function extractRawDeps(text: string, lang: string): string[] {
  const out: string[] = [];
  if (lang === 'ts' || lang === 'js') {
    TS_IMPORT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TS_IMPORT.exec(text))) out.push(m[1]);
    return out;
  }
  if (lang === 'py') {
    PY_FROM.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PY_FROM.exec(text))) out.push(m[1]);
    return out; // 绝对 import(标准库/三方)不画边,只画包内相对引用
  }
  if (lang === 'rs') {
    RS_MOD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RS_MOD.exec(text))) out.push(`mod:${m[1]}`);
    return out;
  }
  return out; // go:同包多文件由 package 语义隐式连接,不做假边
}

function resolveDep(fromRel: string, raw: string, lang: string, fileSet: Set<string>): string | null {
  if (lang === 'ts' || lang === 'js') {
    if (!raw.startsWith('.')) return null; // 三方包/别名不画边
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), raw));
    const exts = LANG_EXTS[lang];
    if (fileSet.has(base)) return base;
    for (const e of exts) if (fileSet.has(base + e)) return base + e;
    for (const e of exts) if (fileSet.has(`${base}/index${e}`)) return `${base}/index${e}`;
    return null;
  }
  if (lang === 'py') {
    if (!raw.startsWith('.')) return null;
    const dots = raw.match(/^\.+/)![0].length;
    const rest = raw.slice(dots).replace(/\./g, '/');
    let base = path.posix.dirname(fromRel);
    for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
    const p = rest ? path.posix.normalize(path.posix.join(base, rest)) : base;
    for (const cand of [`${p}.py`, `${p}/__init__.py`]) if (fileSet.has(cand)) return cand;
    return null;
  }
  if (lang === 'rs') {
    if (!raw.startsWith('mod:')) return null;
    const name = raw.slice(4);
    const dir = path.posix.dirname(fromRel);
    const stemDir = path.posix.join(dir, path.posix.basename(fromRel).replace(/\.rs$/, ''));
    const cands = [`${dir}/${name}.rs`, `${dir}/${name}/mod.rs`, `${stemDir}/${name}.rs`, `${stemDir}/${name}/mod.rs`];
    for (const c of cands) {
      const n = path.posix.normalize(c);
      if (fileSet.has(n)) return n;
    }
    return null;
  }
  return null;
}

// ── 缓存 ────────────────────────────────────────────────────

const memCache = new Map<string, RepoIndex>();

function cacheDir(opts: ScanOpts): string | null {
  if (opts.cacheDir === null) return null;
  if (typeof opts.cacheDir === 'string') return opts.cacheDir;
  if (process.env.KINET_REPO_MAP_CACHE) return process.env.KINET_REPO_MAP_CACHE;
  try {
    // 延迟 require:测试/纯 node 环境没有 electron,不能顶层 import
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    return path.join(app.getPath('userData'), 'repo-map');
  } catch {
    return null;
  }
}

function cacheFile(dir: string, root: string): string {
  const key = crypto.createHash('sha1').update(root).digest('hex').slice(0, 16);
  return path.join(dir, `map-${key}.json`);
}

function readCache(dir: string | null, root: string, fp: string): RepoIndex | null {
  if (!dir) return null;
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(dir, root), 'utf8')) as RepoIndex & { v?: number };
    if (j && j.v === 1 && j.fingerprint === fp && Array.isArray(j.files)) {
      return { root, files: j.files, scanned: j.scanned, truncated: j.truncated, fingerprint: fp };
    }
  } catch { /* 无缓存/坏缓存 → 重扫 */ }
  return null;
}

function writeCache(dir: string | null, index: RepoIndex): void {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile(dir, index.root), JSON.stringify({ v: 1, ...index }), 'utf8');
  } catch { /* 缓存失败不影响主流程 */ }
}

// ── 对外:索引 ──────────────────────────────────────────────

/** 扫描(或命中缓存)仓库索引。 */
export function scanRepo(root: string, opts: ScanOpts = {}): RepoIndex {
  const absRoot = path.resolve(root);
  const maxFiles = opts.maxFiles ?? MAX_FILES_DEFAULT;
  const maxBytes = opts.maxFileBytes ?? MAX_FILE_BYTES_DEFAULT;
  const { files: walked, truncated } = walk(absRoot, maxFiles);
  const fp = fingerprintOf(walked);

  if (!opts.refresh) {
    const mem = memCache.get(absRoot);
    if (mem && mem.fingerprint === fp) return mem;
    const disk = readCache(cacheDir(opts), absRoot, fp);
    if (disk) { memCache.set(absRoot, disk); return disk; }
  }

  const fileSet = new Set(walked.map((f) => f.rel));
  const files: RepoFile[] = [];
  for (const f of walked) {
    let text = '';
    try {
      const fd = fs.openSync(f.abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(f.size, maxBytes));
        fs.readSync(fd, buf, 0, buf.length, 0);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue; // 读不到就跳过,地图不因单个文件报废
    }
    if (text.includes('\u0000')) continue; // 二进制误标扩展名
    const symbols = extractSymbols(text, f.lang);
    const deps = [...new Set(extractRawDeps(text, f.lang)
      .map((d) => resolveDep(f.rel, d, f.lang, fileSet))
      .filter((d): d is string => !!d && d !== f.rel))].sort();
    files.push({ path: f.rel, lang: f.lang, symbols, deps });
  }

  const index: RepoIndex = { root: absRoot, files, scanned: files.length, truncated, fingerprint: fp };
  memCache.set(absRoot, index);
  writeCache(cacheDir(opts), index);
  return index;
}

// ── 对外:渲染 ──────────────────────────────────────────────

export type RenderOpts = { maxChars?: number; filter?: string };

/** 把索引渲染成紧凑文本地图(默认 3500 字符预算)。 */
export function renderRepoMap(index: RepoIndex, opts: RenderOpts = {}): string {
  const maxChars = Math.max(400, opts.maxChars ?? 3500);
  const filter = (opts.filter ?? '').trim().toLowerCase();
  let files = index.files.filter((f) => f.symbols.length || f.deps.length);
  if (filter) files = files.filter((f) => f.path.toLowerCase().includes(filter));
  const totalSymbols = files.reduce((n, f) => n + f.symbols.length, 0);
  const base = path.basename(index.root) || index.root;

  if (!files.length) {
    return `# 仓库地图:${base}\n(没有可索引的源码文件${filter ? `匹配 filter「${opts.filter}」` : ''};支持 .ts/.tsx/.js/.py/.go/.rs)`;
  }

  const head = [
    `# 仓库地图:${base} — ${files.length} 文件 / ${totalSymbols} 符号${index.truncated ? `(扫描达上限 ${index.scanned}+,结果已截断)` : ''}`,
    `# 这是索引不是全文:先定位文件与符号,再 read_file 看实现。只看某部分时传 filter(路径子串)。`,
  ];
  let out = head.join('\n');
  let shown = 0;
  let cut = false;

  const sorted = [...files].sort((a, b) => (b.symbols.length - a.symbols.length) || a.path.localeCompare(b.path));
  for (const f of sorted) {
    const syms = f.symbols.slice(0, 24).map((s) => `${s.kind} ${s.name}`);
    if (f.symbols.length > 24) syms.push(`+${f.symbols.length - 24}`);
    const deps = f.deps.slice(0, 6).map((d) => path.posix.basename(d));
    const lines = [`${f.path}  (${f.symbols.length})`];
    if (syms.length) lines.push(`  ${syms.join(', ')}`);
    if (deps.length) lines.push(`  ↳ ${deps.join(', ')}${f.deps.length > 6 ? ', …' : ''}`);
    const block = '\n' + lines.join('\n');
    if (out.length + block.length > maxChars) { cut = true; break; }
    out += block;
    shown++;
  }
  if (cut) {
    out += `\n…(省略 ${files.length - shown} 个文件:加 filter 或提高 max_chars)`;
  }
  return out;
}

/** 一次调用:扫描 + 渲染。工具层直接用这个。 */
export function repoMapText(root: string, opts: ScanOpts & RenderOpts = {}): string {
  const index = scanRepo(root, opts);
  return renderRepoMap(index, { maxChars: opts.maxChars, filter: opts.filter });
}

/**
 * 体系提示里的一句话引导。只有当前目录像代码仓库时才注入,
 * 文本固定(不随文件变化)→ 不会打穿 prompt 缓存。
 */
const REPO_MARKERS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'tsconfig.json', 'pom.xml', 'build.gradle'];

export function repoMapHint(cwd: string): string {
  let isRepo = false;
  try {
    isRepo = fs.existsSync(path.join(cwd, '.git')) || REPO_MARKERS.some((m) => fs.existsSync(path.join(cwd, m)));
  } catch {
    return '';
  }
  if (!isRepo) return '';
  return '\n\n# 仓库地图\n探索代码前先调用一次 repo_map(文件 + 顶层符号 + 依赖边一次到手),再用 grep / read_file 定点深入;不要一上来盲目 glob。';
}
