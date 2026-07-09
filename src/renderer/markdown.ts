// Minimal markdown → HTML. Mirrors the spirit of Swift MarkdownText.swift (mini block + inline).
// Safe: all text is HTML-escaped first; links restricted to http(s). LLM output is untrusted.
// Fenced code blocks use a \x00…\x00 placeholder so they can't collide with prose digits.
export function renderMarkdown(src: string): string {
  if (!src) return '';

  // 1) Pull fenced code blocks out so block/inline rules never touch their content.
  const blocks: string[] = [];
  let text = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const i = blocks.length;
    blocks.push(`<pre class="code"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
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

// Inline formatting on already-escaped text: code, links, bold, italic.
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, c) => `<code class="ic">${c}</code>`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, t, u) => `<a href="${u}" target="_blank" rel="noreferrer">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_]+)_/g, '$1<em>$2</em>');
}
