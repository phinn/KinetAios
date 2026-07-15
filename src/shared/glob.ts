// Shared glob → regex converter. Used by tools.ts (grep/glob) and watcher.ts (.kinet-watch.json).
// Pure function, no Node/DOM deps — safe for both main and renderer.
// 简单 glob → regex:** 跨目录、* 单段、? 单字符。

export function globToRegex(pat: string): RegExp {
  const s = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\x02')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\x02/g, '(?:.*/)?');
  return new RegExp('^' + s + '$');
}
