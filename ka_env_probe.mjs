import WebSocket from 'ws';
const TID = process.argv[2];
const ws = new WebSocket(`ws://127.0.0.1:9225/devtools/page/${TID}`);
let msgId = 0; const pending = new Map();
ws.on('message', d => { const x = JSON.parse(d); if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); } });
await new Promise(res => ws.on('open', res));
const cdp = (m,p) => new Promise((res,rej) => { const i=++msgId; pending.set(i,d=>d.error?rej(new Error(JSON.stringify(d.error))):res(d.result)); ws.send(JSON.stringify({id:i,method:m,params:p})); });
const expr = `(() => {
  const q = s => document.querySelector(s);
  const env = q('.ch-env'), eng = q('#engine-select'), cwd = q('#cwd-label, .ch-cwd'), sep = q('.ch-env-sep');
  const styleOf = el => { if (!el) return null; const cs = getComputedStyle(el);
    return { bg: cs.backgroundImage !== 'none' ? 'GRAD' : cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopColor.slice(0,26), shadow: cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0,60) }; };
  return JSON.stringify({ theme: document.documentElement.dataset.theme, env: styleOf(env), eng: styleOf(eng), cwd: styleOf(cwd), sepDisplay: sep ? getComputedStyle(sep).display : 'n/a' });
})()`;
const r = await cdp('Runtime.evaluate', {expression: expr, returnByValue: true});
console.log(r.result.value);
ws.close(); process.exit(0);
