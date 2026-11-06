// Minimal markdown → HTML. Mirrors the spirit of Swift MarkdownText.swift (mini block + inline).
// Safe: all text is HTML-escaped first; links restricted to http(s). LLM output is untrusted.
// Fenced code blocks use a \x00…\x00 placeholder so they can't collide with prose digits.
// P1: 代码块接零依赖语法高亮(highlight.ts)+ 自带复制按钮(点击走 app.ts 的事件委托,
//     流式稳定前缀渲染出的块同样有按钮 — 不再只在 done 后补挂);
//     列表重写为缩进树解析,支持嵌套列表(LLM 输出里极常见),任务列表 [x] 任意层级可用。
import { highlightCode } from './highlight';

const COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';

// 超大代码块跳过语法高亮(只做转义):highlight 逐 token 正则扫描 + 上万 span,
// 是 2026-09-13 renderer 内存暴涨 2.3GB → cppgc Fatal 崩溃的放大器之一。
// 显示上等价(只是无颜色),数据/复制按钮不受影响。
// Oversized code blocks skip tokenizing (escape only) — highlight is the main
// memory amplifier for huge blocks; display stays correct, just colorless.
const HIGHLIGHT_MAX_CHARS = 20_000;

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
    // ── 可视化卡片(viz-card):```html 且为完整文档片段 → sandbox iframe 直渲 + 源码折叠 ──
    // Viz card: a ```html fence holding a full-enough document renders as a live
    // sandboxed iframe with the source tucked into a <details>; falls back to a
    // normal highlighted code block for fragments.
    if (typeof lang === 'string' && lang.toLowerCase() === 'html' && isVizCardDoc(raw)) {
      blocks.push(renderVizCard(raw, blocks.length));
      return `\x00${blocks.length - 1}\x00`;
    }
    const hi = raw.length > HIGHLIGHT_MAX_CHARS ? esc(raw) : highlightCode(raw, typeof lang === 'string' ? lang : '');
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
// esc 的逆操作:用于从 DOM textContent 还原 viz-card 原始 HTML(esc 只转义这三种实体)。
// Inverse of esc: recover raw viz-card HTML from DOM textContent (esc escapes exactly these).
export function decodeHTMLEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
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

// ── 可视化卡片(viz-card)────────────────────────────────────────────
// 判定:文档级 HTML(有 <div|table|svg|section 等布局标签 + 最小体量)才算卡片;
// 否则退回普通代码块(纯 <p> 一行式的「伪 html」不该渲染成图)。
// Viz-card gate: only document-ish HTML (layout tags + minimum size) becomes a
// card; trivial one-liner "html" fences stay as normal highlighted code.
const VIZCARD_MIN_CHARS = 80;
function isVizCardDoc(src: string): boolean {
  if (src.length < VIZCARD_MIN_CHARS) return false;
  return /<(div|table|svg|section|ul|ol|header|main|canvas)\b/i.test(src);
}

// 渲染:标题头 + 操作条(下载 HTML/下载图片/复制代码/查看代码)+ sandbox iframe
// (srcdoc blob URL)+ 源码折叠(查看代码 = 展开 details)。主题透传由 app.ts 处理。
// Card shell: header + action bar (download HTML/image, copy & view code) +
// sandboxed iframe fed by blob: URL + collapsible source ("view code" opens it).
// Theme pass-through handled in app.ts via postMessage.
function renderVizCard(src: string, idx: number): string {
  const blobUrl = `vizcard://${idx}`; // 运行时由 app.ts 替换为真实 blob URL
  const dlIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const imgIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
  const copyIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  const codeIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
  return (
    `<div class="viz-card" data-viz-card="${idx}">` +
    `<div class="viz-head"><span class="viz-head-title" data-viz-title data-i18n="viz.title">可视化卡片</span>` +
    `<div class="viz-actions">` +
    `<button class="ghost viz-btn" data-viz-dl>${dlIcon}<span data-i18n="viz.download">下载到本地</span></button>` +
    `<button class="ghost viz-btn" data-viz-dlimg>${imgIcon}<span data-i18n="viz.downloadImg">下载为图片</span></button>` +
    `<button class="ghost viz-btn" data-viz-copy>${copyIcon}<span data-i18n="viz.copyCode">复制代码</span></button>` +
    `<button class="ghost viz-btn" data-viz-view>${codeIcon}<span data-i18n="viz.viewCode">查看代码</span></button>` +
    `</div></div>` +
    // ⚠️ sandbox 绝不能加 allow-same-origin:blob: URL 与宿主同源,
    // allow-scripts + allow-same-origin 同时开启等于取消沙箱 —— 内层脚本可访问
    // parent.document 逃逸到宿主 renderer,进而拿到 window.kinet 的 shell 等能力。
    // 内层量自身 document.body 尺寸不需要同源(脚本就在文档内跑),保持 allow-scripts 即可。
    // ⚠️ NEVER add allow-same-origin: blob: shares the host origin, so
    // allow-scripts + allow-same-origin cancels the sandbox (inner script could
    // reach parent.document → window.kinet → shell). Measuring the inner
    // document's own body needs no same-origin grant.
    `<div class="viz-frame-wrap"><iframe class="viz-frame" sandbox="allow-scripts" data-viz-src="${blobUrl}" src="about:blank" title="visualization"></iframe>` +
    `<div class="viz-frame-msg" hidden></div></div>` +
    `<details class="viz-src"><summary data-i18n="viz.src">源码</summary>` +
    `<div class="code-block"><span class="code-lang">html</span><button class="code-copy ghost" data-code-copy>${COPY_ICON}</button>` +
    `<pre class="code"><code>${esc(src)}</code></pre></div></details></div>`
  );
}


function inline(s: string): string {
  return s
    // 折叠批次引用降权:模型常把 AgentLoop 的机械折叠标记当正文复述,机械行混进叙述观感差
    // (2026-10-30 用户截图)。四种形态(批次行/续取提示/截图占位/摘要行)统一弱化成 chip。
    // / Demote folded-marker echoes: the model sometimes restates AgentLoop's mechanical
    // fold markers in prose; render all four forms as muted chips instead of plain text.
    .replace(/\[已折叠工具调用批次: ([^\]]*)\]/g, (_m, desc) => `<span class="fold-chip">⌘ ${desc}</span>`)
    .replace(/\[(?:本条工具结果|截图)已折叠[^\]]*\]/g, '<span class="fold-chip">⌘ 已折叠</span>')
    .replace(/\[已折叠 ([^\]]+)\] (([^<\n]{1,80})…) ?(?:\[截图已折叠[^\]]*\])?/g, (_m, name, head) => `<span class="fold-chip">⌘ 已折叠 ${name}: ${head}…</span>`)
    .replace(/`([^`]+)`/g, (_m, c) => `<code class="ic">${c}</code>`)
    .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, (_m, alt, src) => `<img src="${src.replace(/"/g, '&quot;')}" alt="${alt}" loading="lazy" />`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, t, u) => `<a href="${u.replace(/"/g, '&quot;')}" target="_blank" rel="noreferrer">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_]+)_/g, '$1<em>$2</em>');
}
