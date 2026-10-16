#!/usr/bin/env node
// registerIpc() 切割器 v2 — 纯机械搬迁,零逻辑改动
// 用法: node scripts/split-ipc.mjs --analyze | --write
// 核心保证: 拆分前后 ipcMain.handle/on 的 channel 集合全等(内置校验)
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const MAIN = process.env.MAIN_TS || 'src/main/main.ts';
const OUTDIR = 'src/main/ipc';
const A = 1092, B = 2824; // registerIpc 起/止(1-based,行内容有断言校验)

const src = fs.readFileSync(MAIN, 'utf8');
const lines = src.split('\n');
if (!lines[A - 1].startsWith('function registerIpc')) throw new Error('A 线校验失败: ' + lines[A - 1]);
if (lines[B - 1] !== '}') throw new Error('B 线校验失败: ' + lines[B - 1]);

const region = lines.slice(A, B - 1); // 函数体(不含首尾行)

// ── 1. 分节检测(区内 `  // ── 标题 ──` 行)──
const marks = [];
region.forEach((l, i) => {
  const m = l.match(/^  \/\/ ── (.+?) ──/);
  if (m) marks.push({ idx: i, title: m[1] });
});
const sections = [];
if (marks[0].idx > 0) sections.push({ title: '(前置无标题段)', start: 0, end: marks[0].idx });
for (let i = 0; i < marks.length; i++) {
  sections.push({ title: marks[i].title, start: marks[i].idx, end: i + 1 < marks.length ? marks[i + 1].idx : region.length });
}

// ── 2. main 本地顶层定义(依赖候选;import 进来的不算)──
const importSrc = new Set();
{
  let inImport = false;
  for (const l of lines) {
    if (/^import\b/.test(l)) inImport = !/;\s*$/.test(l) && !/\} from |from '/.test(l) ? true : false;
    if (inImport) { for (const m of l.matchAll(/(\w+),?\s*$/g)) importSrc.add(m[1]); }
    for (const m of l.matchAll(/(?:import|,)\s*(\w+)(?:\s*,|\s*\}|\s+from)/g)) importSrc.add(m[1]);
    const single = l.match(/^import\s+\{([^}]*)\}\s+from/);
    if (single) single[1].split(',').forEach((s) => { const n = s.trim().split(/\s+as\s+/).pop().trim(); if (n) importSrc.add(n); });
    const ns = l.match(/^import\s+(\w+)\s+from/);
    if (ns) importSrc.add(ns[1]);
  }
}
const localDefs = new Map();
for (let i = 0; i < lines.length; i++) {
  if (i + 1 >= A && i + 1 <= B) continue;
  const l = lines[i];
  let m = l.match(/^(?:export )?(?:async )?function (\w+)/);
  if (m) { localDefs.set(m[1], { line: i + 1, kind: 'func', decl: l }); continue; }
  m = l.match(/^(?:export )?const (\w+)/);
  if (m) { localDefs.set(m[1], { line: i + 1, kind: 'const', decl: l }); continue; }
  m = l.match(/^(?:export )?let (\w+)\s*(:[^=]*)?(?:=|$)/);
  if (m) { localDefs.set(m[1], { line: i + 1, kind: 'let', decl: l, ann: (m[2] || '').trim().replace(/;+\s*$/, '') }); }
}

// ── 3. 拆分区实际引用的本地符号 ──
const regionText = region.join('\n');
const deps = [];
for (const [name, info] of localDefs) {
  if (new RegExp('\\b' + name + '\\b').test(regionText)) deps.push({ name, ...info });
}
deps.sort((a, b) => a.line - b.line);

// ── 4. let 依赖的区内赋值点 → setter ──
for (const d of deps) {
  if (d.kind !== 'let') continue;
  const are = new RegExp('^[ \\t]*' + d.name + '\\s*=(?!=)', 'gm');
  d.assignments = (regionText.match(are) || []).length;
  d.assignLine = (() => { // 抓区内赋值行的完整声明(含注释),用于精确 setter 类型
    const hit = region.find((l) => new RegExp('^[ \\t]*' + d.name + '\\s*=(?!=)').test(l));
    return hit || null;
  })();
}

// ── 5. 域路由(按分节标题)──
const ROUTE = [
  { file: 'misc', re: /前置无标题段|Prompt 模板|可视化规则生成|Pipeline 跨引擎/ },
  { file: 'collab', re: /多机协作|AgentTeams|企业微信|飞书/ },
  { file: 'memory', re: /记忆|Memory|P0|P2|P3|图谱|搜索|任务图/ },
  { file: 'tools', re: /截图|转写|Inspector|语音助手|自定义工具/ },
  { file: 'ai', re: /Pipeline|Pin|上下文检查器|余额|供应商|定价|hifi|approval|设置|模型/i },
  { file: 'convs', re: /会话|Job|Arena|分支|预算|上下文压缩|Visual Inspector|采集|导出/ },
];
function routeOf(title) {
  for (const r of ROUTE) if (r.re.test(title)) return r.file;
  return null;
}

// ── 6. 上下文感知改写:先把命中点分类(标识符位置 / 字符串内 / 注释内),只改标识符位置 ──
// 用单趟扫描替代裸 regex.replace,彻底避免 'deps.confirm-response' 字符串污染
function tokenize(text) {
  // 返回 [{type: 'code'|'str'|'comment', text}] 序列
  const out = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if ((m = rest.match(/^\/\/[^\n]*/))) { out.push({ type: 'comment', text: m[0] }); i += m[0].length; continue; }
    if ((m = rest.match(/^'(?:[^'\\\n]|\\.)*'/)) || (m = rest.match(/^"(?:[^"\\\n]|\\.)*"/)) || (m = rest.match(/^`(?:[^`\\]|\\.)*`/))) { out.push({ type: 'str', text: m[0] }); i += m[0].length; continue; }
    // 普通字符
    let j = i;
    while (j < text.length && !"'`/".includes(text[j]) && !(text[j] === '/' && text[j + 1] === '/')) j++;
    if (j === i) j++; // 保险,防死循环
    out.push({ type: 'code', text: text.slice(i, j) });
    i = j;
  }
  return out;
}
function smartReplace(text, name, replacement, isLet) {
  // 位置感知替换:code 段内区分 普通引用/对象键/简写属性
  const re = new RegExp('\\b' + name + '\\b', 'g');
  return tokenize(text).map((tk) => {
    if (tk.type !== 'code') return tk.text;
    let out = '';
    let last = 0;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(tk.text))) {
      const s = m.index, e = m.index + m[0].length;
      // 前一个非空白字符 / 后一个非空白字符
      const before = tk.text.slice(last, s);
      const prevCh = (before.replace(/\s+$/, '').match(/[^\s]$/) || [''])[0];
      const after = tk.text.slice(e);
      const nextCh = (after.replace(/^\s+/, '').match(/^[^\s]/) || [''])[0];
      const isPropKey = (prevCh === '{' || prevCh === ',') && nextCh === ':'; // 对象键 → 跳过
      const isShorthand = (nextCh === ',' || nextCh === '}') && (prevCh === '{' || prevCh === ',' || prevCh === ''); // 简写属性(含跨行对象字面量;行首+逗号/闭括号结尾必属字面量,语句不可能此形态)
      if (isPropKey) { out += before + m[0]; last = e; continue; }
      if (isShorthand) {
        if (isLet) { out += before + m[0] + ': ' + replacement + ' /*SHA*/'; last = e; continue; } // let 简写→getter,生成后人工审计求值时机
        out += before + m[0] + ': ' + replacement; last = e; continue;
      }
      out += before + replacement; last = e;
    }
    out += tk.text.slice(last);
    return out;
  }).join('');
}

// ── 7. 每个分节改写为域函数体 ──
function rewriteBody(text) {
  const n = { name: 0, assign: 0 };
  for (const d of deps) {
    // 7a. 区内赋值行 `xxx = <expr>;` → `deps.setXxx(<expr>);`(整行重写,注释保留;7b 跳过该行)
    if (d.kind === 'let' && d.assignments > 0) {
      const setter = 'set' + d.name[0].toUpperCase() + d.name.slice(1);
      const lines2 = text.split('\n');
      for (let i = 0; i < lines2.length; i++) {
        const assignRe = new RegExp('^([ \\t]*)' + d.name + '(\\s*)=(?!=)([ \\t]*)(.*?)(;[ \\t]*(?:\\/\\/.*)?)$');
        const m = lines2[i].match(assignRe);
        if (m) {
          lines2[i] = m[1] + 'deps.' + setter + '(' + m[4] + ')' + m[5] + ' /*IPL*/';
          n.assign++;
        }
      }
      text = lines2.join('\n');
    }
  }
  // 7b. 符号引用 → deps.xxx() / deps.xxx;带 /*IPL*/ 标记的 setter 行整行跳过
  for (const d of deps) {
    const ref = d.kind === 'let' ? 'deps.' + d.name + '()' : 'deps.' + d.name;
    const lines2 = text.split('\n');
    for (let i = 0; i < lines2.length; i++) {
      if (lines2[i].includes('/*IPL*/')) continue;
      lines2[i] = smartReplace(lines2[i], d.name, ref, d.kind === 'let');
    }
    text = lines2.join('\n');
    n.name++;
  }
  // 收尾:清掉标记
  text = text.replace(/ \/\*IPL\*\//g, '');
  // 后处理:getter 链式调用破坏 TS narrowing 的 3 种形态,机械等语义重写(IIFE 取本地别名)
  text = text.replace(
    /const (\w+) = deps\.dashboardWin\(\) && !deps\.dashboardWin\(\)\.isDestroyed\(\) \? deps\.dashboardWin\(\) : (undefined|null);/g,
    (mm, v, alt) => `const ${v} = (__dw => __dw && !__dw.isDestroyed() ? __dw : ${alt})(deps.dashboardWin());`
  );
  text = text.replace(
    /if \(deps\.dashboardWin\(\) && !deps\.dashboardWin\(\)\.isDestroyed\(\) && !deps\.dashboardWin\(\)\.webContents\.isDestroyed\(\)\) \{([\s\S]*?)\n(\s*)deps\.dashboardWin\(\)\.webContents\.send\(/g,
    (mm, mid, ind) => `if ((__dw => __dw && !__dw.isDestroyed() && !__dw.webContents.isDestroyed())(deps.dashboardWin())) {${mid}\n${ind}(deps.dashboardWin() as BrowserWindow).webContents.send(`
  );
  text = text.replace(
    /if \(deps\.tray\(\) && !deps\.tray\(\)\.isDestroyed\(\)\) \{([\s\S]*?)\n(\s*)deps\.tray\(\)\.setImage\(/g,
    (mm, mid, ind) => `if ((__tr => __tr && !__tr.isDestroyed())(deps.tray())) {${mid}\n${ind}(deps.tray() as Tray).setImage(`
  );
  // 体内相对路径 specifier 重写(import()/require(),域文件在 ipc/ 下比 main.ts 深一层)
  text = text
    .replace(/(import\(|require\()(['"])(\.[^'"]+)\2/g, (mm, kw, q, p) => kw + q + adjustSpec(p) + q)
    .replace(/(from\s+)(['"])(\.[^'"]+)\2/g, (mm, kw, q, p) => kw + q + adjustSpec(p) + q);
  return { text, n };
}

// ── 8. 类型签名生成(干净注解,不吃行尾注释;硬编码 override 优先)──
const ANN_OVERRIDE = {
  _appIconKey: ': string | null',
  voiceChatRef: ': VoiceChat | null',
};
const FUNC_RET_OVERRIDE = {
  appIcon: ': ReturnType<typeof nativeImage.createFromPath> | undefined',
  makeTrayIcon: ': NativeImage',
};
function annOfLet(d) {
  if (ANN_OVERRIDE[d.name]) return ANN_OVERRIDE[d.name];
  // 从声明行推:let xxx: T = ... / let xxx: T;(注解到 `=` 或行尾,非贪婪;剥尾分号)
  const im = d.decl.match(/^let\s+(\w+)\s*(:[^=]+?)\s*(?:=.*)?$/);
  if (im && im[1] === d.name && im[2].trim()) return im[2].trim().replace(/;+\s*$/, '');
  return ': unknown';
}
function sigOfFunc(d) {
  // 返回类型可能含 {}(对象字面量类型),不能 [^{] 截断:从 decl 取 '(' 首个到末尾 ' {' 之前的整段
  const fnHead = d.decl.slice(d.decl.indexOf('function'));
  const open = fnHead.indexOf('(');
  // 找配对右括号(参数里可能嵌回调类型,用栈计数)
  let depth = 0, close = -1;
  for (let i = open; i < fnHead.length; i++) {
    if (fnHead[i] === '(') depth++;
    else if (fnHead[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
  }
  if (open < 0 || close < 0) return d.name + ': unknown /* func 解析失败: ' + d.decl.slice(0, 60) + ' */';
  const params = fnHead.slice(open + 1, close).replace(/\s+/g, ' ').trim();
  const ret = FUNC_RET_OVERRIDE[d.name] || fnHead.slice(close + 1).replace(/\s*\{\s*$/, '').trim();
  return `${d.name}(${params})${ret}`;
}

// ── 9. 写文件 ──
function write() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.copyFileSync(MAIN, MAIN + '.bak-split');
  const beforeChannels = execSync(`grep -oE "ipcMain\\.(handle|on)\\('[^']+'" ${MAIN} | sort`).toString().split('\n').filter(Boolean);

  // 9a. ctx.ts
  const iface = deps.map((d) => {
    if (d.kind === 'let') {
      const lines = [`  ${d.name}()${annOfLet(d)};`];
      if (d.assignments > 0) lines.push(`  set${d.name[0].toUpperCase() + d.name.slice(1)}(v${annOfLet(d)}): void;`);
      return lines.join('\n');
    }
    if (d.kind === 'func') return `  ${sigOfFunc(d)};`;
    return `  ${d.name}: ${inferConstType(d)};`;
  }).join('\n');
  // 接口文本里也可能带 import('./x') specifier(main.ts 相对路径),统一加深
  const iface2 = iface.replace(/(import\(|from\s+)(['"])(\.[^'"]+)\2/g, (mm, kw, q, p) => kw + q + adjustSpec(p) + q);
  function inferConstType(d) {
    const CONST_OVERRIDE = {
      pendingConfirms: 'Map<string, (approved: boolean) => void>',
      pendingPrivacyConfirms: 'Map<string, { fn: (approved: boolean) => void; timer: NodeJS.Timeout }>',
      IPC_TURNS_CHAR_LIMIT: 'number',
    };
    if (CONST_OVERRIDE[d.name]) return CONST_OVERRIDE[d.name];
    const im = d.decl.match(/const (\w+)(?::([^=]+))?\s*=/);
    if (im && im[2] && im[2].trim()) return im[2].trim();
    return 'unknown /* const ' + d.name + ' */';
  }
  const ctxTs =
    genFileHeader('ctx') +
    `import type { BrowserWindow, NativeImage } from 'electron';\n` +
    `import type { TaskManager } from '../TaskManager';\n` +
    `import type { PromptTemplate, Conversation, GitSnapshot, GitDiffResult, GitActionResult, GitActionKind, RuleConfig } from '../../shared/types';\n` +
    (deps.some((d) => d.name === 'voiceChatRef') ? `import type { VoiceChat } from '../VoiceChat';\n` : '') +
    `import { nativeImage, Tray } from 'electron';\n` +
    `\nexport interface IpcDeps {\n${iface2}\n}\n\nexport const deps: IpcDeps = {} as IpcDeps;\n`;
  fs.writeFileSync(OUTDIR + '/ctx.ts', ctxTs);

  // 9b. 域文件
  const summary = [];
  const perFile = new Map();
  const perFileRaw = new Map();
  for (const s of sections) {
    const f = routeOf(s.title);
    if (!f) throw new Error('未路由分节: ' + s.title);
    const body = region.slice(s.start, s.end).join('\n');
    const { text } = rewriteBody(body);
    const handlers = (body.match(/ipcMain\.(handle|on)\('[^']+'/g) || []).length;
    perFile.set(f, (perFile.get(f) || 0) + handlers);
    const arr = perFileRaw.get(f) || [];
    arr.push(text);
    perFileRaw.set(f, arr);
  }
  for (const [f, arr] of perFileRaw) {
    const content = genFileHeader(f) + importBlock() + `\nimport { deps } from './ctx';\n\nexport function register(): void {\n` + arr.join('\n') + `\n}\n`;
    fs.writeFileSync(`${OUTDIR}/${f}.ts`, content);
    summary.push(`${f}.ts: ${perFile.get(f)} handlers`);
  }

  // 9c. main.ts 重装
  const createFn =
    `\n// ── IPC 依赖注入(registerIpc 已拆分至 src/main/ipc/*;此处是唯一注入点)──\n` +
    `function createIpcDeps(): void {\n` +
    deps.map((d) => {
      if (d.kind === 'let') {
        const getter = `  deps.${d.name} = () => ${d.name};`;
        if (d.assignments > 0) {
          const setter = 'set' + d.name[0].toUpperCase() + d.name.slice(1);
          return getter + `\n  deps.${setter} = (v${annOfLet(d)}) => { ${d.name} = v${d.ann ? '' : ' as never'}; };`;
        }
        return getter;
      }
      return `  deps.${d.name} = ${d.name};`;
    }).join('\n') +
    `\n}\n`;
  const head = lines.slice(0, A - 1).join('\n');
  const tail = lines.slice(B).join('\n'); // B 是 '}' 行本身(0-based B-1),tail 从 B 开始=跳过它
  let out = head + '\n' + createFn + '\n' + tail;
  // import 注入:插到最后一个 import 行后(multiline import 以 `} from` 收尾也算);
  // 放最后 = CJS require 顺序里 ipc/* 最后加载,setPath/brand 初始化先行(见 main.ts 顶部警告)
  const oLines = out.split('\n');
  let lastImp = -1;
  oLines.forEach((l, i) => { if (/^(?:import |\} from )/.test(l)) lastImp = i; });
  if (lastImp < 0) throw new Error('main.ts 找不到任何 import 行,注入失败');
  oLines.splice(lastImp + 1, 0, `import { deps } from './ipc/ctx';`, `import { register as registerIpcModules } from './ipc/register';`);
  out = oLines.join('\n');
  // registerIpc() 调用点改两步:先注入再注册(4 空格缩进调用点)
  out = out.replace(/(\n    registerIpc\(\);)/, '\n    createIpcDeps();\n    registerIpcModules();');
  fs.writeFileSync(MAIN, out);

  // 9d. register.ts + channel 全等校验
  const domainFiles = [...perFileRaw.keys()];
  const regBody = domainFiles.map((f) => `import { register as r_${f} } from './${f}';`).join('\n');
  const regTs = genFileHeader('register') + regBody + `\n\nexport function register(): void {\n` + domainFiles.map((f) => `  r_${f}();`).join('\n') + `\n}\n`;
  fs.writeFileSync(OUTDIR + '/register.ts', regTs);

  const allTs = domainFiles.map((f) => fs.readFileSync(`${OUTDIR}/${f}.ts`, 'utf8')).join('\n') + ctxTs;
  // after 侧 = 全新 main.ts(registerIpc 函数体已移除,区外 ipcMain.* 原样保留) + 拆分区新文件
  const afterMain = fs.readFileSync(MAIN, 'utf8');
  const afterChannels = (allTs.match(/ipcMain\.(handle|on)\('[^']+'/g) || [])
    .concat(afterMain.match(/ipcMain\.(handle|on)\('[^']+'/g) || []);
  const norm = (arr) => arr.map((s) => s.replace(/ipcMain\./, '')).sort();
  const b = norm(beforeChannels), a2 = norm(afterChannels);
  const missing = b.filter((x, i) => !a2.includes(x));
  const extra = a2.filter((x) => !b.includes(x));
  if (missing.length || extra.length) {
    console.error('!! channel 全等校验失败 missing=' + JSON.stringify(missing) + ' extra=' + JSON.stringify(extra));
    process.exit(1);
  }
  console.log(summary.join('\n'));
  console.log(`channels: ${b.length} -> ${a2.length} 全等 ✓`);
  console.log('main.ts: ' + lines.length + ' -> ' + out.split('\n').length + ' 行; 备份 ' + MAIN + '.bak-split');
}

// ── import 块(main.ts 头部 import 区,相对路径升一级)──
function adjustSpec(p) {
  if (p.startsWith('../')) return '../' + p;
  if (p.startsWith('./')) return '../' + p.slice(2);
  return p; // 裸包名/绝对路径不动
}
function importBlock() {
  const out = [];
  let inImport = false;
  for (let i = 0; i < A - 1; i++) {
    const l = lines[i];
    if (/^import /.test(l)) inImport = !/from '/.test(l);
    if (/^import /.test(l) || inImport) {
      out.push(l
        .replace(/(from\s+)(['"])([^'"]+)\2/g, (mm, kw, q, p) => kw + q + adjustSpec(p) + q)
        .replace(/import\((['"])([^'"]+)\1\)/g, (mm, q, p) => `import(${q}${adjustSpec(p)}${q})`)
        .replace(/require\((['"])([^'"]+)\1\)/g, (mm, q, p) => `require(${q}${adjustSpec(p)}${q})`));
    }
    if (inImport && /from '/.test(l)) inImport = false;
  }
  return out.join('\n');
}

function genFileHeader(name) {
  // 仅 ctx/register 有自己独立的 import 头,不走 importBlock
  return name === 'ctx' || name === 'register' ? `// ⚠️ 本文件由 scripts/split-ipc.mjs 机械生成(main.ts registerIpc 拆分),勿手改;改 main.ts 后重跑生成器\n// 域: ${name}\n` : '';
}

if (process.argv[2] === '--analyze') analyze();
else if (process.argv[2] === '--write') write();
else { console.log('用法: node scripts/split-ipc.mjs --analyze | --write'); process.exit(1); }

function analyze() {
  console.log('=== 分节 → 域 ===');
  const unassigned = [];
  const perFile = {};
  for (const s of sections) {
    const f = routeOf(s.title);
    if (!f) unassigned.push(s.title);
    const handlers = region.slice(s.start, s.end).join('\n').match(/ipcMain\.(handle|on)\('[^']+'/g) || [];
    perFile[f || '??'] = (perFile[f || '??'] || 0) + handlers.length;
    console.log(`  [${f || '未路由'}] ${s.title}  (L${A + s.start}~, handlers=${handlers.length})`);
  }
  console.log('=== 域文件 handler 数 ===\n  ' + JSON.stringify(perFile));
  if (unassigned.length) console.log('!! 未路由标题: ' + unassigned.join(' | '));
  console.log('=== 依赖(' + deps.length + ') ===');
  for (const d of deps) {
    console.log(`  ${d.name} (${d.kind}, :${d.line})` + (d.kind === 'let' ? ` 赋值${d.assignments}处 ann=[${d.ann || '无'}] 区内赋值行=${JSON.stringify(d.assignLine)}` : ''));
  }
  // 区内赋值形态审计(必须全是单行 `x = expr;`,否则 setter 改写不安全)
  console.log('=== 区内赋值形态审计 ===');
  for (const d of deps) {
    if (d.kind !== 'let' || !d.assignments) continue;
    const re = new RegExp('^[ \\t]*' + d.name + '\\s*=(?!=)');
    region.forEach((l, i) => { if (re.test(l)) console.log(`  L${A + i}: ${l.trim().slice(0, 90)}`); });
  }
}
