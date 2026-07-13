// CodeEditor:自研轻量代码编辑器组件 / Lightweight code editor component (zero dependencies)
// 基于 contenteditable + 后方高亮层方案:用户输入在透明 textarea,语法高亮在底层 pre。
// 这比 contenteditable 直接做富文本简单得多 —— 不需要处理光标穿越 styled DOM 的噩梦。
//
// 设计灵感:highlight.js 的 token 思路 + CodeMirror 的双行号槽。
// ponytail:tokenizer 是正则级,不支持嵌套语法(JS template literal 里的 CSS 等)。
// 升级路径:接 CodeMirror 6（~150KB gzipped）或 Shiki（~300KB,基于 TextMate grammar）。
//
// 用法:
//   const ed = new CodeEditor(containerEl, { lang: 'typescript' });
//   ed.value = 'const x = 1;';
//   ed.onChange = (v) => { ... };
//   ed.destroy(); // 卸载时清理

// ── 语法定义 / Language grammar definitions ────────────────────────────────────

interface TokenRule {
  name: string;     // CSS class suffix: tok-<name>
  re: RegExp;       // 必须是全局正则 / must be global regex
}

interface LangDef {
  name: string;
  extensions: string[];
  rules: TokenRule[];
  // 行注释符号（用于智能缩进 toggle）
  comment?: string;
  blockComment?: [string, string];
}

// 关键字列表（合并大小写敏感 + 不敏感的场景用 \b 边界）
const TS_KEYWORDS = /\b(?:abstract|any|as|asserts|async|await|boolean|break|case|catch|class|const|constructor|continue|debugger|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|is|keyof|let|namespace|never|new|null|number|object|of|private|protected|public|readonly|return|satisfies|set|static|string|super|switch|symbol|this|throw|true|try|type|typeof|undefined|unknown|var|void|while|yield)\b/g;

const JS_KEYWORDS = /\b(?:break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|let|new|null|of|return|set|static|super|switch|this|throw|true|try|typeof|var|void|while|yield|undefined)\b/g;

const CSS_AT_RULES = /@(?:media|keyframes|import|charset|font-face|page|supports|namespace|document)\b/g;

const MD_HEADER = /^(#{1,6})\s.+$/gm;
const MD_LIST = /^(\s*[-*+]|\s*\d+\.)\s/gm;

const LANGS: Record<string, LangDef> = {
  typescript: {
    name: 'TypeScript',
    extensions: ['.ts', '.tsx', '.mts', '.cts'],
    comment: '//',
    blockComment: ['/*', '*/'],
    rules: [
      { name: 'comment', re: /\/\/[^\n]*/g },
      { name: 'comment', re: /\/\*[\s\S]*?\*\//g },
      { name: 'string', re: /`(?:\\.|[^`\\])*`/g },   // template literal
      { name: 'string', re: /"(?:\\.|[^"\\])*"/g },
      { name: 'string', re: /'(?:\\.|[^'\\])*'/g },
      { name: 'keyword', re: TS_KEYWORDS },
      { name: 'decorator', re: /@[A-Za-z_]\w*/g },
      { name: 'number', re: /\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b/gi },
      { name: 'builtin', re: /\b(?:console|window|document|process|require|module|exports|globalThis|Promise|Math|JSON|Object|Array|String|Number|Boolean|Error|Map|Set|Symbol|RegExp|Date)\b/g },
      { name: 'function', re: /\b([A-Za-z_]\w*)(?=\s*\()/g },
    ],
  },
  javascript: {
    name: 'JavaScript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    comment: '//',
    blockComment: ['/*', '*/'],
    rules: [
      { name: 'comment', re: /\/\/[^\n]*/g },
      { name: 'comment', re: /\/\*[\s\S]*?\*\//g },
      { name: 'string', re: /`(?:\\.|[^`\\])*`/g },
      { name: 'string', re: /"(?:\\.|[^"\\])*"/g },
      { name: 'string', re: /'(?:\\.|[^'\\])*'/g },
      { name: 'keyword', re: JS_KEYWORDS },
      { name: 'number', re: /\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b/gi },
      { name: 'builtin', re: /\b(?:console|window|document|process|require|module|exports|globalThis|Promise|Math|JSON|Object|Array|String|Number|Boolean|Error|Map|Set|Symbol|RegExp|Date)\b/g },
      { name: 'function', re: /\b([A-Za-z_]\w*)(?=\s*\()/g },
    ],
  },
  json: {
    name: 'JSON',
    extensions: ['.json', '.jsonc'],
    rules: [
      { name: 'key', re: /"(?:\\.|[^"\\])*"(?=\s*:)/g },
      { name: 'string', re: /"(?:\\.|[^"\\])*"/g },
      { name: 'number', re: /\b-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi },
      { name: 'keyword', re: /\b(?:true|false|null)\b/g },
    ],
  },
  css: {
    name: 'CSS',
    extensions: ['.css', '.scss', '.less'],
    comment: '//',
    blockComment: ['/*', '*/'],
    rules: [
      { name: 'comment', re: /\/\*[\s\S]*?\*\//g },
      { name: 'atrule', re: CSS_AT_RULES },
      { name: 'variable', re: /--[a-z][\w-]*/g },
      { name: 'variable', re: /\$[a-z][\w-]*/g },
      { name: 'string', re: /"(?:\\.|[^"\\])*"/g },
      { name: 'string', re: /'(?:\\.|[^'\\])*'/g },
      { name: 'number', re: /\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%|s|ms|deg|fr)?\b/gi },
      { name: 'selector', re: /[.#][a-z_][\w-]*/gi },
      { name: 'property', re: /[a-z-]+(?=\s*:)/gi },
    ],
  },
  html: {
    name: 'HTML',
    extensions: ['.html', '.htm', '.xml', '.svg'],
    rules: [
      { name: 'comment', re: /<!--[\s\S]*?-->/g },
      { name: 'tag', re: /<\/?[a-zA-Z][\w-]*/g },
      { name: 'tag', re: /\/?>/g },
      { name: 'attr', re: /\b[a-z-]+(?==)/gi },
      { name: 'string', re: /"(?:\\.|[^"\\])*"/g },
      { name: 'string', re: /'(?:\\.|[^'\\])*'/g },
    ],
  },
  markdown: {
    name: 'Markdown',
    extensions: ['.md', '.markdown', '.mdx'],
    rules: [
      { name: 'header', re: MD_HEADER },
      { name: 'list', re: MD_LIST },
      { name: 'codeblock', re: /```[\s\S]*?```/g },
      { name: 'inlinecode', re: /`[^`\n]+`/g },
      { name: 'bold', re: /\*\*[^*\n]+\*\*/g },
      { name: 'italic', re: /(?<!\*)\*[^*\n]+\*(?!\*)/g },
      { name: 'link', re: /\[[^\]]*\]\([^)]*\)/g },
      { name: 'comment', re: /^<!--[\s\S]*?-->/gm },
      { name: 'keyword', re: /^\s*(?:>)/gm },
    ],
  },
  python: {
    name: 'Python',
    extensions: ['.py', '.pyw'],
    comment: '#',
    rules: [
      { name: 'comment', re: /#[^\n]*/g },
      { name: 'string', re: /"""[\s\S]*?"""/g },
      { name: 'string', re: /"(?:\\.|[^"\\])*"/g },
      { name: 'string', re: /'(?:\\.|[^'\\])*'/g },
      { name: 'keyword', re: /\b(?:def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|try|except|finally|with|lambda|yield|global|nonlocal|assert|del|in|not|and|or|is|None|True|False|raise|async|await)\b/g },
      { name: 'builtin', re: /\b(?:print|len|range|enumerate|zip|map|filter|sorted|reversed|sum|min|max|abs|round|type|isinstance|super|open|str|int|float|bool|list|dict|set|tuple)\b/g },
      { name: 'number', re: /\b\d+(?:\.\d+)?\b/g },
      { name: 'decorator', re: /@[A-Za-z_]\w*/g },
      { name: 'function', re: /\b(def|class)\s+(\w+)/g },
    ],
  },
  shell: {
    name: 'Shell',
    extensions: ['.sh', '.bash', '.zsh', '.cmd', '.bat'],
    comment: '#',
    rules: [
      { name: 'comment', re: /#[^\n]*/g },
      { name: 'string', re: /"(?:\\.|[^"\\])*"/g },
      { name: 'string', re: /'(?:[^'\\])*'/g },
      { name: 'keyword', re: /\b(?:if|then|else|fi|for|in|do|done|while|case|esac|function|return|export|local|readonly|unset|shift|echo|printf|read|set|source|alias)\b/g },
      { name: 'variable', re: /\$\w+|\$\{[^}]+\}/g },
      { name: 'number', re: /\b\d+\b/g },
    ],
  },
  yaml: {
    name: 'YAML',
    extensions: ['.yml', '.yaml'],
    comment: '#',
    rules: [
      { name: 'comment', re: /#[^\n]*/g },
      { name: 'string', re: /"(?:\\.|[^"\\])*"/g },
      { name: 'string', re: /'(?:[^'\\])*'/g },
      { name: 'key', re: /^[a-z_][\w-]*(?=\s*:)/gim },
      { name: 'keyword', re: /\b(?:true|false|null|yes|no)\b/gi },
      { name: 'number', re: /\b\d+(?:\.\d+)?\b/g },
    ],
  },
};

// 通过文件扩展名推断语言 / Detect language from file extension
export function detectLang(filename: string): string {
  const lower = filename.toLowerCase();
  for (const [key, def] of Object.entries(LANGS)) {
    if (def.extensions.some((ext) => lower.endsWith(ext))) return key;
  }
  return 'plaintext';
}

// ── HTML 转义 / HTML escape ────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── 语法高亮核心 / Syntax highlighting engine ──────────────────────────────────

interface Span { start: number; end: number; cls: string; }

// 把文本 token 化为带 class 的 span 区间。
// 算法:对每个 rule 做 exec,收集所有匹配区间,按 start 排序后去重叠(先到先得)。
function tokenize(code: string, lang: string): Span[] {
  const def = LANGS[lang];
  if (!def) return [];
  const spans: Span[] = [];
  for (const rule of def.rules) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(code)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      // function 规则的特殊处理:捕获组 2 是函数名(python def/class)
      const cls = `tok-${rule.name}`;
      spans.push({ start, end, cls });
      if (m[0].length === 0) rule.re.lastIndex++; // 防 zero-width 死循环
    }
  }
  // 按 start 排序;同 start 时长的优先(让短 token 不遮盖长 token)
  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  // 去重叠:保留先到的,丢弃被覆盖的
  const result: Span[] = [];
  let lastEnd = 0;
  for (const sp of spans) {
    if (sp.start >= lastEnd) {
      result.push(sp);
      lastEnd = sp.end;
    }
  }
  return result;
}

// 把 span 列表转为 HTML(转义 + 包裹 <span>)
function highlight(code: string, lang: string): string {
  if (!code) return '';
  const spans = tokenize(code, lang);
  if (!spans.length) return escHtml(code);
  let html = '';
  let pos = 0;
  for (const sp of spans) {
    if (sp.start > pos) html += escHtml(code.slice(pos, sp.start));
    html += `<span class="${sp.cls}">${escHtml(code.slice(sp.start, sp.end))}</span>`;
    pos = sp.end;
  }
  if (pos < code.length) html += escHtml(code.slice(pos));
  return html;
}

// ── CodeEditor 组件 / CodeEditor component ─────────────────────────────────────

export interface CodeEditorOptions {
  lang?: string;            // 语言 key（typescript / json / markdown / ...）
  readOnly?: boolean;
  placeholder?: string;
  fontSize?: number;        // px
  minLines?: number;        // 最小显示行数(自动撑高模式)
  autoHeight?: boolean;     // true = 跟内容撑高(用于内联编辑器); false = 100% 填满容器(用于文件编辑器)
  tabSize?: number;         // Tab 宽度(空格数),默认 2
}

export class CodeEditor {
  private host: HTMLElement;        // 宿主容器
  private wrap!: HTMLElement;       // 代码区容器(行号 + 编辑区)
  private gutter!: HTMLElement;     // 行号槽（autoHeight 模式下可能未创建）
  private scroll!: HTMLElement;     // 滚动容器（overflow:auto）
  private highlightLayer!: HTMLElement; // <pre> 高亮层
  private ta!: HTMLTextAreaElement; // 透明输入层
  private _lang: string;
  private _value = '';
  private _opts: Required<CodeEditorOptions>;
  private _lineCount = 1;
  onChange: ((value: string) => void) | null = null;
  private destroyed = false;
  private rafId = 0;

  constructor(host: HTMLElement, opts: CodeEditorOptions = {}) {
    this.host = host;
    this._opts = {
      lang: opts.lang ?? 'plaintext',
      readOnly: opts.readOnly ?? false,
      placeholder: opts.placeholder ?? '',
      fontSize: opts.fontSize ?? 13,
      minLines: opts.minLines ?? 3,
      autoHeight: opts.autoHeight ?? false,
      tabSize: opts.tabSize ?? 2,
    };
    this._lang = this._opts.lang;
    this._buildDOM();
    this._bindEvents();
  }

  // ── DOM 构建 ──────────────────────────────────────────────────────────────
  private _buildDOM(): void {
    const auto = this._opts.autoHeight;
    this.host.classList.add('ce-host');
    this.host.innerHTML = '';

    // 内联模式（autoHeight）不需要滚动容器和行号槽的绝对定位
    this.wrap = document.createElement('div');
    this.wrap.className = auto ? 'ce-wrap ce-auto' : 'ce-wrap ce-full';

    if (!auto) {
      // 全屏模式：行号 + 滚动区
      this.gutter = document.createElement('div');
      this.gutter.className = 'ce-gutter';
      this.wrap.appendChild(this.gutter);
    }

    this.scroll = document.createElement('div');
    this.scroll.className = 'ce-scroll';

    // 高亮层（不可交互）
    this.highlightLayer = document.createElement('pre');
    this.highlightLayer.className = 'ce-highlight';
    this.highlightLayer.setAttribute('aria-hidden', 'true');

    // 输入层（透明文字）
    this.ta = document.createElement('textarea');
    this.ta.className = 'ce-input';
    this.ta.spellcheck = false;
    this.ta.wrap = 'off';
    this.ta.readOnly = this._opts.readOnly;
    if (this._opts.placeholder) this.ta.placeholder = this._opts.placeholder;

    this.scroll.appendChild(this.highlightLayer);
    this.scroll.appendChild(this.ta);
    this.wrap.appendChild(this.scroll);
    this.host.appendChild(this.wrap);
  }

  // ── 事件绑定 ──────────────────────────────────────────────────────────────
  private _bindEvents(): void {
    // 输入 → 更新高亮 + 行号 + 回调
    this.ta.addEventListener('input', () => {
      this._value = this.ta.value;
      this._scheduleRender();
      if (this.onChange) this.onChange(this._value);
    });

    // Tab 键 → 插入空格
    this.ta.addEventListener('keydown', (e) => this._onKeydown(e));

    // 滚动同步（高亮层跟随 textarea 滚动）
    if (!this._opts.autoHeight) {
      this.ta.addEventListener('scroll', () => {
        this.highlightLayer.scrollTop = this.ta.scrollTop;
        this.highlightLayer.scrollLeft = this.ta.scrollLeft;
        if (this.gutter) this.gutter.scrollTop = this.ta.scrollTop;
      });
    }
  }

  private _onKeydown(e: KeyboardEvent): void {
    const { tabSize } = this._opts;

    // Tab → 插入空格
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const start = this.ta.selectionStart;
      const end = this.ta.selectionEnd;

      // 选中文本 → 批量缩进/反缩进
      if (start !== end) {
        const before = this._value.slice(0, start);
        const sel = this._value.slice(start, end);
        const after = this._value.slice(end);

        if (e.shiftKey) {
          // 反缩进：删行首 tabSize 个空格
          const lines = sel.split('\n');
          const dedented = lines.map((l) => {
            let count = 0;
            while (count < tabSize && count < l.length && l[count] === ' ') count++;
            return l.slice(count);
          });
          const newVal = before + dedented.join('\n') + after;
          this._setValue(newVal, start, start + dedented.join('\n').length);
        } else {
          // 缩进：行首加空格
          const lines = sel.split('\n');
          const indented = lines.map((l) => ' '.repeat(tabSize) + l);
          const newVal = before + indented.join('\n') + after;
          this._setValue(newVal, start, start + indented.join('\n').length);
        }
      } else {
        // 无选区 → 插入空格
        const spaces = ' '.repeat(tabSize);
        const newVal = this._value.slice(0, start) + spaces + this._value.slice(end);
        this._setValue(newVal, start + tabSize, start + tabSize);
      }
      return;
    }

    // Enter → 智能缩进（匹配上一行的缩进）
    if (e.key === 'Enter' && !e.shiftKey) {
      const pos = this.ta.selectionStart;
      const lineStart = this._value.lastIndexOf('\n', pos - 1) + 1;
      const currentLine = this._value.slice(lineStart, pos);
      const indentMatch = currentLine.match(/^[ \t]*/);
      let indent = indentMatch ? indentMatch[0] : '';

      // 行尾是 { / [ / ( → 多缩进一级
      const charBefore = this._value[pos - 1];
      if (charBefore === '{' || charBefore === '[' || charBefore === '(') {
        indent += ' '.repeat(tabSize);
      }
      if (indent) {
        e.preventDefault();
        const insert = '\n' + indent;
        const newVal = this._value.slice(0, pos) + insert + this._value.slice(this.ta.selectionEnd);
        this._setValue(newVal, pos + insert.length, pos + insert.length);
      }
      return;
    }

    // Ctrl+/ → toggle 注释
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      this._toggleComment();
      return;
    }

    // Ctrl+A → 全选（修正 contenteditable 的默认行为）
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      this.ta.setSelectionRange(0, this._value.length);
      return;
    }
  }

  // 切换行注释 / Toggle line comments
  private _toggleComment(): void {
    const def = LANGS[this._lang];
    const marker = def?.comment;
    if (!marker) return;

    const start = this.ta.selectionStart;
    const end = this.ta.selectionEnd;
    const before = this._value.slice(0, start);
    const sel = this._value.slice(start, end);
    const after = this._value.slice(end);

    const lineStart = before.lastIndexOf('\n') + 1;
    const selFull = this._value.slice(lineStart, end);
    const lines = selFull.split('\n');

    // 检查是否所有行都已注释
    const allCommented = lines.every((l) => l.trimStart().startsWith(marker));

    if (allCommented) {
      const newLines = lines.map((l) => l.replace(new RegExp(`^(\\s*)${escapeRegex(marker)}\\s?`), '$1'));
      const newVal = this._value.slice(0, lineStart) + newLines.join('\n') + after;
      this._setValue(newVal, lineStart, lineStart + newLines.join('\n').length);
    } else {
      const newLines = lines.map((l) => l.trim() ? `${marker} ${l}` : l);
      const newVal = this._value.slice(0, lineStart) + newLines.join('\n') + after;
      this._setValue(newVal, lineStart, lineStart + newLines.join('\n').length);
    }
  }

  // ── 渲染 / Render ──────────────────────────────────────────────────────────
  private _scheduleRender(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this._render();
    });
  }

  private _render(): void {
    const val = this._value;

    // 高亮层 HTML（末尾加换行让最后一行高度正确）
    this.highlightLayer.innerHTML = highlight(val, this._lang) + '\n';

    // 行号
    this._lineCount = val.split('\n').length;
    if (this.gutter) {
      const nums: string[] = [];
      for (let i = 1; i <= this._lineCount; i++) nums.push(String(i));
      this.gutter.innerHTML = nums.map((n) => `<div class="ce-ln">${n}</div>`).join('');
    }

    // autoHeight: 撑高容器
    if (this._opts.autoHeight) {
      const lines = Math.max(this._lineCount, this._opts.minLines);
      this.wrap.style.setProperty('--ce-lines', String(lines));
      this.ta.style.height = 'auto';
      this.ta.style.height = this.ta.scrollHeight + 'px';
      this.highlightLayer.style.height = this.ta.scrollHeight + 'px';
    }
  }

  // ── 公开 API / Public API ──────────────────────────────────────────────────

  get value(): string { return this._value; }

  set value(v: string) {
    this._setValue(v, null, null);
  }

  private _setValue(v: string, selStart: number | null, selEnd: number | null): void {
    const wasFocused = document.activeElement === this.ta;
    this._value = v;
    this.ta.value = v;
    this._render();
    if (selStart != null && selEnd != null) {
      this.ta.setSelectionRange(selStart, selEnd);
    }
    if (wasFocused) this.ta.focus();
    if (this.onChange) this.onChange(v);
  }

  get lang(): string { return this._lang; }
  set lang(l: string) {
    this._lang = l;
    this._opts.lang = l;
    this._render();
  }

  focus(): void { this.ta.focus(); }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.host.innerHTML = '';
    this.host.classList.remove('ce-host');
    this.onChange = null;
  }
}

// 转义正则特殊字符 / Escape regex special chars
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── 辅助:用 CodeEditor 替换 textarea / Helper: replace textarea with CodeEditor ──
// 用于逐步迁移旧 textarea。找到宿主元素,创建 CodeEditor,把旧 textarea 的值和事件搬过去。
export function upgradeTextarea(
  host: HTMLElement,
  oldTa: HTMLTextAreaElement,
  opts: CodeEditorOptions = {},
): CodeEditor {
  const initial = oldTa.value;
  const ph = oldTa.placeholder;
  const ed = new CodeEditor(host, { ...opts, placeholder: opts.placeholder ?? ph });
  if (initial) ed.value = initial;
  // 隐藏旧 textarea（保留以便某些代码可能还引用它）
  oldTa.hidden = true;
  return ed;
}
