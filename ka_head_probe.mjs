import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:9225/devtools/page/967F278C0F634292850346242947DBBE');
let msgId = 0; const pending = new Map();
ws.on('message', d => { const x = JSON.parse(d); if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); } });
await new Promise(res => ws.on('open', res));
const cdp = (m,p) => new Promise((res,rej) => { const i=++msgId; pending.set(i,d=>d.error?rej(new Error(JSON.stringify(d.error))):res(d.result)); ws.send(JSON.stringify({id:i,method:m,params:p})); });
const expr = `(() => {
  const head = document.querySelector('.chat-head');
  if (!head) return 'no head';
  const out = {theme: document.documentElement.dataset.theme, layers: []};
  const els = [head, head.querySelector('.ch-title'), head.querySelector('.ch-env'), head.querySelector('.ch-tabs'), head.querySelector('.cht.active')];
  for (const el of els) {
    if (!el) continue;
    const cs = getComputedStyle(el);
    out.layers.push({
      sel: String(el.className).slice(0,28),
      bg: cs.backgroundImage !== 'none' ? 'GRAD:'+cs.backgroundImage.slice(0,45) : (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : 'transparent'),
      border: cs.borderTopWidth !== '0px' ? cs.borderTopColor.slice(0,28)+' '+cs.borderTopWidth : 'none',
      shadow: cs.boxShadow !== 'none' ? cs.boxShadow.slice(0,55) : 'none'
    });
  }
  out.tabs = [...head.querySelectorAll('.cht')].slice(0,3).map(t => {
    const cs = getComputedStyle(t);
    return {t: t.textContent, bw: cs.borderTopWidth, bg: cs.backgroundColor};
  });
  return JSON.stringify(out);
})()`;
const r = await cdp('Runtime.evaluate', {expression: expr, returnByValue: true});
console.log(r.result.value);
ws.close(); process.exit(0);
