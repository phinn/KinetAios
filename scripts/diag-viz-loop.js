// 诊断:消息内 HTML 卡片「宽度一直不停地变宽」的回路复现(2026-11-24)。
// diagnostic: reproduce the viz-card width-grow loop end-to-end.
//
// 做法 / How: 从 src/renderer/app.ts 抽出真实的注入脚本(boot),把 iframe 初始宽设成
// 6px 模拟「首次上报发生在布局完成前」,宿主侧分别跑旧公式（w+18/w+2 直接用返回值）
// 与新判定（VizWidth.planVizWidth）,每 200ms 采样卡片宽。
// 预期: old 每次 +2px 一路爬升(实测 392→542, 2.4s 内 85 次上报); new 恒定,上报 3~4 次即停。
//
// 跑法 / Run:  env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/diag-viz-loop.js
// (ELECTRON_RUN_AS_NODE 必须去掉,否则 electron 以纯 node 启动,拿不到 app 模块)
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/app.ts'), 'utf8');
const m = appSrc.match(/const boot = `([\s\S]*?)`;/);
if (!m) throw new Error('没能从 app.ts 抽出 boot 脚本');
const NEW_BOOT = m[1].replace(/\$\{fid\}/g, 'test-frame');
const OLD_BOOT = NEW_BOOT.replace(`b.style.width='max-content'`, `b.style.width='fit-content'`);
if (OLD_BOOT === NEW_BOOT) throw new Error('boot 里没找到 max-content 量宽,抽取失败');

// 判定模块打成浏览器 IIFE,直接内联进被测页面
const out = path.join(ROOT, 'scripts/tmp/viz-width.iife.js');
fs.mkdirSync(path.dirname(out), { recursive: true });
buildSync({ entryPoints: [path.join(ROOT, 'src/renderer/viz-width.ts')], bundle: true, format: 'iife', globalName: 'VIZ', outfile: out, logLevel: 'warning' });
const VIZ_IIFE = fs.readFileSync(out, 'utf8');

const HOST = path.join(path.dirname(out), 'viz-loop-host.html');
fs.writeFileSync(HOST, '<!DOCTYPE html><html><body style="margin:0">host</body></html>');

// 病态卡片:固定宽图块 + 会换行的正文(模型生成的卡片最常见的形态,也是实测里会爬的那种)
const CONTENT = `<div style="width:360px;height:60px;background:#ddd"></div>
<p>这是一段很长的说明文字，用来模拟模型生成的卡片正文，它会自动换行排满容器宽度。</p>`;
const docWith = (boot) => `<!DOCTYPE html><html><head><meta charset="utf-8"><script>${boot}</script></head><body style="margin:0">${CONTENT}</body></html>`;

const guard = setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 40000);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900 });
  await win.loadFile(HOST);
  const results = {};
  for (const [mode, boot] of [['old', OLD_BOOT], ['new', NEW_BOOT]]) {
    results[mode] = await win.webContents.executeJavaScript(`(async () => {
      ${VIZ_IIFE}
      document.body.innerHTML = '';
      const card = document.createElement('div');
      card.style.cssText = 'width:100%;border:1px solid #ccc;box-sizing:border-box';
      const f = document.createElement('iframe');
      // 初始 6px:模拟首次上报发生在布局完成前(卡片刚插入 innerHTML / 字体未就绪)
      f.style.cssText = 'display:block;width:6px;height:160px;border:0';
      f.dataset.vizId = 'test-frame';
      card.appendChild(f);
      document.body.appendChild(card);
      const mode = ${JSON.stringify(mode)};
      const reports = [];
      let narrow = false;
      window.addEventListener('message', (ev) => {
        const d = ev.data;
        if (!d || d.type !== 'viz-height' || d.id !== 'test-frame') return;
        reports.push({ w: d.w, frameW: f.clientWidth, cardW: Math.round(card.getBoundingClientRect().width) });
        if (typeof d.w !== 'number' || d.w <= 0) return;
        if (mode === 'old') {
          // 旧实现:基准父宽 + 迟滞 + 直接 w+18 / w+2
          const base = card.parentElement.clientWidth - 2;
          narrow = narrow ? d.w < base * 0.92 : d.w < base * 0.78;
          card.classList.toggle('viz-narrow', narrow);
          if (narrow) { card.style.width = (d.w + 18) + 'px'; f.style.width = (d.w + 2) + 'px'; }
          else { card.style.width = ''; f.style.width = ''; }
        } else {
          const plan = VIZ.planVizWidth({ measuredW: d.w, frameW: f.clientWidth, parentW: card.parentElement.clientWidth, wasNarrow: narrow });
          narrow = plan.narrow;
          card.classList.toggle('viz-narrow', narrow);
          if (plan.narrow && plan.cardW != null && plan.frameW != null) {
            if (Math.abs(Math.round(card.getBoundingClientRect().width) - plan.cardW) >= 1) card.style.width = plan.cardW + 'px';
            if (Math.abs(f.clientWidth - plan.frameW) >= 1) f.style.width = plan.frameW + 'px';
          } else if (!plan.narrow) { card.style.width = ''; f.style.width = ''; }
        }
      });
      f.src = URL.createObjectURL(new Blob([${JSON.stringify(docWith(boot))}], { type: 'text/html' }));
      const samples = [];
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 200));
        samples.push(Math.round(card.getBoundingClientRect().width));
      }
      return { samples, reports: reports.slice(0, 8), reportCount: reports.length };
    })()`);
  }
  for (const mode of ['old', 'new']) {
    const r = results[mode];
    console.log(`\n[${mode}] 卡片宽采样(每 200ms): ${r.samples.join(' → ')}`);
    console.log(`[${mode}] 上报次数=${r.reportCount} 前几次 w/frame/card: ${r.reports.map((x) => `${x.w}/${x.frameW}/${x.cardW}`).join('  ')}`);
  }
  console.log('\n判读:old 应逐格 +2 爬升(回路),new 应恒定且上报次数个位数。\n');
  clearTimeout(guard);
  app.exit(0);
});
