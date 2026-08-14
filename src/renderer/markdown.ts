// Minimal markdown → HTML. Mirrors the spirit of Swift MarkdownText.swift (mini block + inline).
// Safe: all text is HTML-escaped first; links restricted to http(s). LLM output is untrusted.
// Fenced code blocks use a \x00…\x00 placeholder so they can't collide with prose digits.
export function renderMarkdown(src: string): string {
  if (!src) return '';

  // 1) Pull fenced code blocks out so block/inline rules never touch their content.
  const blocks: string[] = [];
  let text = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const i = blocks.length;
    const langLabel = lang ? `<span class="code-lang">${esc(lang)}</span>` : '';
    // 行号:每行包 span.cl,CSS counter 显示行号(>12 行才显示,短代码块不加噪)
    // Line numbers via CSS counter; only for blocks longer than 12 lines.
    const raw = code.replace(/\n$/, '');
    const lineCount = raw.split('\n').length;
    const numbered = lineCount > 12
      ? raw.split('\n').map((l: string) => `<span class="cl">${esc(l)}</span>`).join('\n')
      : esc(raw);
    blocks.push(`<div class="code-block">${langLabel}<pre class="code${lineCount > 12 ? ' has-ln' : ''}"><code>${numbered}</code></pre></div>`);
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
      for (const h of headerCells) tbl += `<th>${inline(h)}</th>`;
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

    // ── 任务列表 / Task lists (- [ ] / - [x]) ──
    if (/^[-*+]\s+\[[ xX]\]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const checked = /^\s*[-*+]\s+\[[xX]\]\s+/.test(lines[i]);
        const text = lines[i].replace(/^[-*+]\s+\[[ xX]\]\s+/, '');
        const cb = checked ? 'checked' : '';
        items.push(`<li class="task-item"><input type="checkbox" ${cb} disabled /><span class="task-text${checked ? ' task-done' : ''}">${inline(text)}</span></li>`);
        i++;
      }
      out.push(`<ul class="task-list">${items.join('')}</ul>`);
      continue;
    }
    // ── 无序列表 / Unordered lists ──
    if (/^[-*+]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^[-*+]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
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
