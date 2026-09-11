// UX 诊断:受控复现 新增/删除频道 时侧栏 keyed 渲染是否产生重复/残留。
// 用法:node scripts/diag-sidebar.cjs  (需应用以 --remote-debugging-port=9222 启动)
const http = require('node:http');

function cdpSend(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}

async function evalInPage(wsUrl, expression) {
  const WebSocket = (await import('ws')).default;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    ws.on('open', () => {
      const rid = ++id;
      pending.set(rid, (m) => resolve(m.result?.result?.value));
      ws.send(JSON.stringify({ id: rid, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); reject(new Error('timeout')); } }, 8000);
    });
    ws.on('error', reject);
  });
}

const DUMP = `(() => {
  const items = [...document.querySelectorAll('#conv-list li[data-cid]')].map(li => ({
    cid: (li.dataset.cid || '').slice(0, 8),
    title: (li.querySelector('.title')?.textContent || '').slice(0, 14),
    group: (li.closest('li.sb-proj')?.dataset.cwd || '(top)').split('/').pop(),
  }));
  const groups = [...document.querySelectorAll('#conv-list li.sb-proj')].map(p => ({
    cwd: (p.dataset.cwd || '').split('/').pop(),
    dom: p.querySelectorAll('li[data-cid]').length,
    headerCount: p.querySelector('.sb-pcount')?.textContent,
  }));
  const cids = items.map(i => i.cid);
  const dupCids = cids.filter((c, i) => cids.indexOf(c) !== i);
  return JSON.stringify({ total: items.length, dupCids, groups, items }, null, 1);
})()`;

(async () => {
  const targets = await cdpSend('http://127.0.0.1:9222/json/list');
  const page = targets.filter((t) => t.type === 'page')[0];
  if (!page) { console.error('no page target'); process.exit(1); }
  const evalNow = (expr) => evalInPage(page.webSocketDebuggerUrl, expr);

  console.log('=== 初始 ===');
  console.log(await evalNow(DUMP));

  console.log('=== 点击 新建 ===');
  await evalNow(`document.getElementById('btn-new').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 1800));
  console.log(await evalNow(DUMP));

  console.log('=== 点击 删除(btn-del → 确认弹窗 → confirm-ok)===');
  await evalNow(`document.getElementById('btn-del').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 400));
  console.log('modal visible:', await evalNow(`document.getElementById('confirm-modal').classList.contains('show')`));
  await evalNow(`document.getElementById('confirm-ok').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 1800));
  console.log(await evalNow(DUMP));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
