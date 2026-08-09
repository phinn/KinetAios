// CDP 截图脚本:启动 Chrome → 加载本地文件 → 截图保存
// 用法: node scripts/capture-nexus.js <url> <output.png> [width] [height]
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const url = process.argv[2];
const out = process.argv[3];
const w = parseInt(process.argv[4] || '1440', 10);
const h = parseInt(process.argv[5] || '900', 10);

if (!url || !out) { console.error('usage: node capture-nexus.js <url> <out.png> [w] [h]'); process.exit(1); }

const port = 9223;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--remote-debugging-port=' + port,
  '--window-size=' + w + ',' + h,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

function fetchJson(pathname) {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:' + port + pathname, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

async function waitForChrome() {
  for (let i = 0; i < 50; i++) {
    try { await fetchJson('/json/version'); return; }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  throw new Error('Chrome not ready');
}

(async () => {
  try {
    await waitForChrome();
    // 找到 or 创建一个新 tab
    let tabs = await fetchJson('/json');
    let target = tabs.find(t => t.type === 'page') || (await fetchJson('/json/new?about:blank'));
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.on('message', msg => {
      const m = JSON.parse(msg);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    function send(method, params = {}) {
      return new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, m => m.error ? rej(m.error) : res(m.result));
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    }
    await new Promise(r => ws.once('open', r));
    await send('Page.enable');
    // 导航到目标 URL
    const navP = new Promise(r => ws.once('message', m => { const d = JSON.parse(m); if (d.method === 'Page.loadEventFired') r(); }));
    await send('Page.navigate', { url });
    await navP;
    // 等动画/Canvas 渲染一帧
    await new Promise(r => setTimeout(r, 800));
    // 截图
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.resolve(out), Buffer.from(shot.data, 'base64'));
    console.log('saved', out);
    ws.close();
    chrome.kill();
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e);
    chrome.kill();
    process.exit(1);
  }
})();