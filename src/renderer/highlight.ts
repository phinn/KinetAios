// 轻量零依赖语法高亮 — 覆盖 agent 输出的绝大多数语言(js/ts, python, json, bash/sh,
// sql, css, html/xml, yaml, diff),其余语言原样转义(不_highlight 不出错)。
// 设计决策:
// 1. 在**原始文本**上按优先级扫描(先 HTML 转义再匹配会破坏字符串/注释边界),
//    每个 token 发射时再单独转义 — 与 markdown.ts 的安全姿态一致。
// 2. token 按换行切分逐行发射 — 行号模式(markdown.ts 的 span.cl + CSS counter)
//    需要按行包一层;逐行发射保证跨行 token(块注释/模板字符串)不会把 span 撕断。
// Lightweight zero-dependency syntax highlighter; tokens are scanned on raw text,
// escaped individually at emit, and split per line so line-numbered blocks stay well-formed.
export type Tok = { cls: string | null; text: string };
type Rule = { cls: string; re: RegExp }; // re: 无 g 标志、无捕获组(全部 (?:))

// ── 可复用规则片段 ──
const DQ = /"(?:[^"\\\n]|\\.)*"?/; // 允许未闭合(流式输出/截断) — trailing ? 可选闭合
const SQ = /'(?:[^'\\\n]|\\.)*'?/;
const NUM = /\b0x[\da-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/;
const FN = /[A-Za-z_$][\w$]*(?=\s*\()/;

const JS_KW = /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|new|delete|typeof|instanceof|in|of|class|extends|super|this|import|from|export|default|async|await|try|catch|finally|throw|yield|void|null|undefined|true|false|static|get|set|interface|type|enum|implements|public|private|protected|readonly|namespace|declare|as|is|keyof|infer|satisfies|abstract|override)\b/;
const PY_KW = /\b(?:def|class|return|if|elif|else|for|while|break|continue|import|from|as|with|try|except|finally|raise|lambda|pass|yield|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|async|await|self|cls|print)\b/;
const SH_KW = /\b(?:if|then|elif|else|fi|for|while|do|done|case|esac|function|return|export|local|source|echo|cd|ls|cat|grep|sed|awk|curl|git|npm|npx|pnpm|yarn|node|python|pip|sudo|mkdir|rm|cp|mv|chmod|chown|which|where|head|tail|sort|uniq|wc|find|xargs|kill|ps|sleep|date|test|touch|ln|tee|du|df|tar|zip|unzip|ssh|scp|docker|kubectl)\b/;
const SQL_KW = /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|VIEW|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|GROUP|BY|ORDER|LIMIT|OFFSET|HAVING|AS|AND|OR|NOT|NULL|IS|IN|BETWEEN|LIKE|GLOB|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END|UNION|ALL|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|PRAGMA|EXPLAIN|WITH|RECURSIVE|RETURNING|CONFLICT|IGNORE|REPLACE|ASC|DESC|IF|EXISTS|CAST|COLLATE|AUTOINCREMENT|BEGIN|COMMIT|ROLLBACK|TRANSACTION)\b/i;

function rules(...list: Array<[string, RegExp]>): Array<{ cls: string; src: string }> {
  return list.map(([cls, re]) => ({ cls, src: re.source }));
}

const LANGS: Record<string, { flags: string; rules: Array<{ cls: string; src: string }> }> = {
  js: {
    flags: 'gm',
    rules: rules(
      ['com', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))/],
      ['str', /`(?:[^`\\]|\\.)*`?/],
      ['str', DQ], ['str', SQ],
      ['kw', JS_KW],
      ['num', NUM],
      ['fn', FN],
    ),
  },
  py: {
    flags: 'gm',
    rules: rules(
      ['com', /#[^\n]*/],
      ['str', /"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))/],
      ['str', DQ], ['str', SQ],
      ['kw', PY_KW],
      ['num', NUM],
      ['fn', FN],
      ['kw', /@[\w.]+/], // 装饰器
    ),
  },
  sh: {
    flags: 'gm',
    rules: rules(
      ['com', /#[^\n]*/],
      ['str', DQ], ['str', SQ],
      ['var', /\$\{[^}\n]*\}|\$[\w@#?*!-]+/],
      ['kw', SH_KW],
      ['num', NUM],
    ),
  },
  json: {
    flags: 'gm',
    rules: rules(
      ['key', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/],
      ['str', DQ],
      ['kw', /\b(?:true|false|null)\b/],
      ['num', NUM],
    ),
  },
  sql: {
    flags: 'gmi',
    rules: rules(
      ['com', /--[^\n]*/],
      ['str', DQ], ['str', SQ],
      ['kw', SQL_KW],
      ['num', NUM],
      ['fn', FN],
    ),
  },
  css: {
    flags: 'gm',
    rules: rules(
      ['com', /\/\*[\s\S]*?(?:\*\/|(?![\s\S]))/],
      ['str', DQ], ['str', SQ],
      ['kw', /@[\w-]+/],
      ['key', /[a-zA-Z-]+(?=\s*:)/],
      ['num', /#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|vmin|vmax|s|ms|deg|fr|%)?\b/],
    ),
  },
  html: {
    flags: 'gm',
    rules: rules(
      ['com', /<!--[\s\S]*?(?:-->|(?![\s\S]))/],
      ['str', DQ], ['str', SQ],
      ['tag', /<\/?[a-zA-Z][^<>]*>/],
      ['num', /&\w+;/],
    ),
  },
  yaml: {
    flags: 'gm',
    rules: rules(
      ['com', /#[^\n]*/],
      ['key', /^[ \t]*[\w.-]+(?=\s*:)/],
      ['str', DQ], ['str', SQ],
      ['kw', /\b(?:true|false|null|yes|no|on|off)\b/],
      ['num', NUM],
    ),
  },
  diff: {
    flags: 'gm',
    rules: rules(
      ['add', /^\+[^\n]*/],
      ['del', /^-[^\n]*/],
      ['meta', /^@@[^\n]*/],
      ['meta', /^(?:diff|index|---|\+\+\+)[^\n]*/],
    ),
  },
};

// 语言别名归一化
const ALIAS: Record<string, string> = {
  js: 'js', javascript: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', mjs: 'js', cjs: 'js',
  py: 'py', python: 'py', python3: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', terminal: 'sh', powershell: 'sh', ps1: 'sh', bat: 'sh', cmd: 'sh',
  json: 'json', json5: 'json', jsonc: 'json',
  sql: 'sql', sqlite: 'sql',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml',
  diff: 'diff', patch: 'diff',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** tokenize:在原始文本上按规则优先级扫描 → token 序列(规则无捕获组,参与组序号=规则序号) */
function tokenize(code: string, lang: { flags: string; rules: Array<{ cls: string; src: string }> }): Tok[] {
  const re = new RegExp(lang.rules.map((r) => `(${r.src})`).join('|'), lang.flags);
  const toks: Tok[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[0].length === 0) { re.lastIndex++; continue; } // 零宽防御
    if (m.index > last) toks.push({ cls: null, text: code.slice(last, m.index) });
    let gi = -1;
    for (let i = 1; i < m.length; i++) { if (m[i] !== undefined) { gi = i - 1; break; } }
    toks.push({ cls: lang.rules[gi]?.cls ?? null, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < code.length) toks.push({ cls: null, text: code.slice(last) });
  return toks;
}

/**
 * 语法高亮 → HTML(纯文本已转义;按 \n 分行,可安全再按行包 span.cl 做行号)。
 * 未识别语言:整段转义返回(不引入错误,零开销路径)。
 */
export function highlightCode(code: string, lang?: string): string {
  const key = ALIAS[(lang ?? '').toLowerCase().trim()] ?? '';
  if (!key || !code) return esc(code);
  const toks = tokenize(code, LANGS[key]);
  // 按行发射:token 内含换行 → 切开,跨行 span 变成逐行同色 span(行号模式不会撕断标签)
  const lines: string[] = [''];
  for (const t of toks) {
    const parts = t.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push('');
      const p = parts[i];
      if (!p) continue;
      lines[lines.length - 1] += t.cls ? `<span class="tok-${t.cls}">${esc(p)}</span>` : esc(p);
    }
  }
  return lines.join('\n');
}
