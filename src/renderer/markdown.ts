// Minimal markdown → HTML. Mirrors the spirit of Swift MarkdownText.swift (mini block + inline).
// Safe: all text is HTML-escaped first; links restricted to http(s). LLM output is untrusted.
// Fenced code blocks use a \x00…\x00 placeholder so they can't collide with prose digits.
// P1: 代码块接零依赖语法高亮(highlight.ts)+ 自带复制按钮(点击走 app.ts 的事件委托,
//     流式稳定前缀渲染出的块同样有按钮 — 不再只在 done 后补挂);
//     列表重写为缩进树解析,支持嵌套列表(LLM 输出里极常见),任务列表 [x] 任意层级可用。
import { highlightCode } from './highlight';

const COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';

export function renderMarkdown(src: string): string {
  if (!src) return '';

  // 1) Pull fenced code blocks out so block/inline rules never touch their content.
  const blocks: string[] = [];
  let text = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const i = blocks.length;
    const langLabel = lang ? `<span class="code-lang">${esc(lang)}</span>` : '';
    // 行号:每行包 span.cl,CSS counter 显示行号(>12 行才显示,短代码块不加噪)
    // 语法高亮(highlight.ts):token 按行切分发射,行号模式不会撕断跨行 span。
    const raw = code.replace(/\n$/, '');
    const lineCount = raw.split('\n').length;
    const hi = highlightCode(raw, typeof lang === 'string' ? lang : '');
    const numbered = lineCount > 12
      ? hi.split('\n').map((l: string) => `<span class="cl">${l}</span>`).join('\n')
      : hi;
    // 复制按钮随块发射(含流式新增块);点击由 #turns 上的事件委托统一处理。
    blocks.push(`<div class="code-block">${langLabel}<button class="code-copy ghost" data-code-copy>${COPY_ICON}</button><pre class="code${lineCount > 12 ? ' has-ln' : ''}"><code>${numbered}</code></pre></div>`);
    return `\x00${i}\x00`;
  });

  text = esc(text); // escape everything that remains (\x00 placeholders survive — esc ignores them)
  const lines = text.split('\n');
  const out: string[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join('<br>'))}</p>`);
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\x00(\d+)\x00$/); // code-block placeholder on its own line
    if (fence) {
      flushPara();
      out.push(blocks[+fence[1]]);
      i++;
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }
    // ── 水平分割线 / Horizontal rule (---, ***, ___) ──
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^&gt;\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(quote.join('<br>'))}</blockquote>`);
      continue;
    }
    // ── 表格 / Tables (GFM pipe-tables) ──
    // | col1 | col2 |     ← header row
    // |------|------|     ← separator
    // | a    | b    |     ← data rows
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara();
      const parseRow = (raw: string): string[] =>
        raw.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());

      const headerCells = parseRow(line);
      i += 2; // skip header + separator
      const bodyRows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        bodyRows.push(parseRow(lines[i]));
        i++;
      }

      let tbl = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
      for (const hh of headerCells) tbl += `<th>${inline(hh)}</th>`;
      tbl += '</tr></thead><tbody>';
      for (const row of bodyRows) {
        tbl += '<tr>';
        for (const c of row) tbl += `<td>${inline(c)}</td>`;
        tbl += '</tr>';
      }
      tbl += '</tbody></table></div>';
      out.push(tbl);
      continue;
    }

    // ── 列表(嵌套 + 任务列表)──
    // 缩进树解析:同层同级,2+ 空格更深一层;`- [x]` 任务项任意层级可用。
    // 之前是扁平单层 — LLM 输出的嵌套清单会被错拍成平级。
    if (/^(\s*)([-*+]|\d+\.)\s+/.test(line)) {
      flushPara();
      const items: RawItem[] = [];
      while (i < lines.length) {
        const m2 = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (!m2) break;
        const indent = m2[1].replace(/\t/g, '  ').length;
        const ordered = /\d+\./.test(m2[2]);
        let txt = m2[3];
        let checked: boolean | null = null;
        const tm = txt.match(/^\[([ xX])\]\s+(.*)$/);
        if (tm) { checked = tm[1].toLowerCase() === 'x'; txt = tm[2]; }
        items.push({ indent, ordered, checked, text: txt });
        i++;
      }
      out.push(renderList(buildTree(items)));
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();

  let html = out.join('\n');
  html = html.replace(/\x00(\d+)\x00/g, (_m, idx) => blocks[+idx]);
  return html;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── 嵌套列表 ──
type RawItem = { indent: number; ordered: boolean; checked: boolean | null; text: string };
type LNode = { indent: number; ordered: boolean; checked: boolean | null; text: string; children: LNode[] };

/** 线性列表行 → 缩进树。栈式解析:出栈到不比当前更深的层,然后挂为栈顶的孩子/根。 */
function buildTree(items: RawItem[]): LNode[] {
  const roots: LNode[] = [];
  const stack: LNode[] = [];
  for (const it of items) {
    const node: LNode = { ...it, children: [] };
    while (stack.length && stack[stack.length - 1].indent >= it.indent) stack.pop();
    if (!stack.length) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}

function renderList(nodes: LNode[]): string {
  if (!nodes.length) return '';
  const ordered = nodes[0].ordered; // 一层的列表类型取首项
  const tag = ordered ? 'ol' : 'ul';
  const lis = nodes.map((n) => {
    const inner = n.checked != null
      ? `<input type="checkbox" ${n.checked ? 'checked' : ''} disabled /><span class="task-text${n.checked ? ' task-done' : ''}">${inline(n.text)}</span>`
      : inline(n.text);
    return `<li>${inner}${renderList(n.children)}</li>`;
  });
  return `<${tag}>${lis.join('')}</${tag}>`;
}

// Inline formatting on already-escaped text: code, links, bold, italic, strikethrough, images.
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, c) => `<code class="ic">${c}</code>`)
    .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, (_m, alt, src) => `<img src="${src.replace(/"/g, '&quot;')}" alt="${alt}" loading="lazy" />`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, t, u) => `<a href="${u.replace(/"/g, '&quot;')}" target="_blank" rel="noreferrer">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_]+)_/g, '$1<em>$2</em>');
}
