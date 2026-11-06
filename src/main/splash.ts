// 启动动画(splash):独立 frameless 小窗先出,主窗就绪后淡出。
// Splash screen: a small frameless window shows first, fades out when the dashboard is ready.
//
// 生命周期(永不挡门的安全设计):
//   createSplash() → app ready 即 show(主窗 createDashboard(show:false) 之后才建)
//   dismissSplash(reason) → 三条路都会调:主窗 did-finish-load / 12s 超时 / 主窗创建失败
//   崩溃回退:splash 自身 crashed/unresponsive 也直接销毁,绝不让一个坏动画挡住 app。
//
// 自定义(Plugin SDK v4 贡献点):插件 plugin.json 声明 "splash": "splash.html",
// 主进程读文件(escape-proof),设置 → 外观 里选择。内置两款:'default'(星云)'orbit'(轨道)。
// Lifecycle (never blocks the app):
//   createSplash() shows immediately; dismissSplash() is called from all three exits:
//   dashboard did-finish-load / 12s timeout / dashboard creation failure. A broken splash
//   (crash/unresponsive) destroys itself — the animation can never hold the app hostage.
// Customization (Plugin SDK v4 contribution): declare "splash": "splash.html" in plugin.json;
// the file is read by main (escape-proof) and selectable in Settings → Appearance.
// Built-ins: 'default' (brand nebula) and 'orbit'.

import { BrowserWindow } from 'electron';
import { getSettings } from './settings';
import { getBrand } from './brand';
import { loadPlugins, isPluginEnabled } from './plugins';

let splashWin: BrowserWindow | null = null;
let dismissed = false;
// show 时刻:dismissSplash 据此补足「最短展示时长」(showMs)再淡出。
// When the splash was shown — used to honor the minimum-display (showMs) on dismiss.
let splashShownAt = 0;
// 兜底闹钟:splash 存活超过 12s 强制关(主窗卡死/加载慢也不能让人盯着动画干等)。
// Safety alarm: force-dismiss after 12s regardless (a hung dashboard must not hold the splash).
let alarm: ReturnType<typeof setTimeout> | null = null;

/** 创建并显示启动动画窗(选 'none' 时跳过)。Create & show the splash window (skipped when 'none'). */
// 尺寸统一一处:420×260(内置两款按此设计;插件款自适应 letterbox 居中)
const SPLASH_W = 420;
const SPLASH_H = 260;

export function createSplash(): void {
  const kind = getSettings().splash?.kind ?? 'default';
  if (kind === 'none') return;
  let html = splashLoaderHtml(kind);
  if (!html) return; // 未知类型/插件读不到 → 无动画直接进主窗(fail-open)

  splashWin = new BrowserWindow({
    width: SPLASH_W,
    height: SPLASH_H,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#141418',
    center: true,
    show: false,
    webPreferences: {
      // 纯展示窗:不需要 node/preload,关 contextIsolation 之外的能力,内容只是 CSS 动画。
      // Pure presentation: no node, no preload — content is CSS animation only.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splashWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  splashWin.once('ready-to-show', () => {
    if (!splashWin || dismissed) return;
    splashWin.show();
    splashShownAt = Date.now();
    // 闹钟必须在 show 后才挂:加载失败时 ready-to-show 不来,window-all-closed 兜底太晚。
    alarm = setTimeout(() => dismissSplash('timeout'), 12000);
  });
  // splash 自身崩了 → 直接销毁,别挡主窗(fail-open)
  splashWin.webContents.on('render-process-gone', () => dismissSplash('crashed'));
  splashWin.on('closed', () => { splashWin = null; });
}

/**
 * 关闭启动动画(幂等,多路触发只生效一次):300ms 淡出后销毁。
 * 若 showMs 未播满,延后到播满再淡出(最短展示时长承诺)。
 * Dismiss the splash (idempotent — first caller wins): 300ms fade-out, then destroy.
 * If showMs hasn't elapsed yet, wait it out first (minimum-display guarantee).
 */
export function dismissSplash(reason = 'manual'): void {
  if (dismissed || !splashWin || splashWin.isDestroyed()) { dismissed = true; return; }
  const shownAt = splashShownAt;
  const minMs = Math.max(0, Math.min(6000, getSettings().splash?.showMs ?? 1400));
  const wait = shownAt > 0 ? Math.max(0, minMs - (Date.now() - shownAt)) : minMs;
  const doDismiss = () => {
    if (dismissed) return;
    dismissed = true;
    if (alarm) { clearTimeout(alarm); alarm = null; }
    try {
      const win = splashWin;
      if (!win || win.isDestroyed()) return;
      win.webContents.executeJavaScript(
        'document.documentElement.classList.add("splash-out")'
      ).catch(() => { /* 淡出失败就直接关 */ });
      setTimeout(() => { try { if (!win.isDestroyed()) win.close(); } catch { /* already gone */ } }, 320);
    } catch {
      try { splashWin?.close(); } catch { /* already gone */ }
    }
  };
  if (wait > 0) setTimeout(doDismiss, wait); else doDismiss();
}

// ── 贡献点:插件 splash ──────────────────────────────────────────────

/**
 * 收集所有启用插件的 splash 贡献 → 设置面板选择器数据源。
 * Collect splash contributions from enabled plugins — the picker's data source.
 */
// 设置面板可选清单:内置两款 + 已装插件贡献款。renderer 据此渲染选择器。
export function splashOptions(): Array<{ value: string; label: string; kind: 'builtin' | 'plugin' }> {
  const builtin = [
    { value: 'default', label: 'Nebula · 星云脉冲', kind: 'builtin' as const },
    { value: 'orbit', label: 'Orbit · 轨道环', kind: 'builtin' as const },
  ];
  const plugins = pluginSplashSnap().map((p) => ({
    value: `plugin:${p.name}`,
    label: `${p.name} (plugin)`,
    kind: 'plugin' as const,
  }));
  return [...builtin, ...plugins];
}

// 预览:在独立小窗播一次指定款(3s 自动关)。插件款同样经加载器 iframe 注入。
export function splashPreview(kind: string): void {
  if (splashWin && !splashWin.isDestroyed()) splashWin.close();
  const w = new BrowserWindow({
    width: SPLASH_W,
    height: SPLASH_H,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: false,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  w.setMenuBarVisibility(false);
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashLoaderHtml(String(kind)) ?? '<body style="background:#1b1b1f"></body>'));
  w.once('ready-to-show', () => w.show());
  setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 3200);
}

// 已启用插件的 splash 贡献清单(读 splashHtml 已读入缓存)。加载失败/未启用的插件不出现。
export function pluginSplashSnap(): Array<{ name: string; html: string }> {
  return loadPlugins()
    .filter((p) => p.splashHtml && isPluginEnabled(p.manifest.name))
    .map((p) => ({ name: p.manifest.name, html: p.splashHtml! }));
}

/**
 * 内置两款动画的 HTML(自包含,零外链)。同步暴露给设置面板预览用。
 * Built-in splash HTML (self-contained, zero external resources). Also used by the
 * settings preview — exposed synchronously via IPC 'splash-builtins'.
 */
export function builtinSplashHtml(kind: 'default' | 'orbit'): string {
  const brand = getBrand().productName;
  if (kind === 'orbit') return orbitHtml(brand);
  return nebulaHtml(brand);
}

export function splashLoaderHtml(kind: string): string | null {
  if (kind === 'default' || kind === 'orbit') return builtinSplashHtml(kind);
  if (kind.startsWith('plugin:')) {
    const name = kind.slice('plugin:'.length);
    const p = pluginSplashSnap().find((x) => x.name === name);
    return p?.html ?? null;
  }
  return null;
}

// ── 内置款 1:品牌星云(渐变呼吸 + 粒子上浮 + 标题淡入)───────────────
function nebulaHtml(brand: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%;background:#141418;overflow:hidden;font-family:-apple-system,"SF Pro Display","Segoe UI",sans-serif}
  .stage{position:relative;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
    transition:opacity .3s ease}
  html.splash-out .stage{opacity:0}
  /* 星云:三层径向渐变交错呼吸 */
  .nebula{position:absolute;inset:0;filter:blur(2px)}
  .nebula i{position:absolute;border-radius:50%;mix-blend-mode:screen}
  .nebula i:nth-child(1){width:220px;height:220px;left:20%;top:10%;background:radial-gradient(circle,rgba(124,92,255,.55),transparent 70%);animation:breathe 2.4s ease-in-out infinite}
  .nebula i:nth-child(2){width:180px;height:180px;right:16%;top:30%;background:radial-gradient(circle,rgba(64,156,255,.5),transparent 70%);animation:breathe 2.4s ease-in-out .6s infinite}
  .nebula i:nth-child(3){width:150px;height:150px;left:34%;bottom:8%;background:radial-gradient(circle,rgba(255,94,158,.42),transparent 70%);animation:breathe 2.4s ease-in-out 1.2s infinite}
  @keyframes breathe{0%,100%{transform:scale(.92);opacity:.6}50%{transform:scale(1.08);opacity:1}}
  /* 核心光点 */
  .core{position:relative;width:56px;height:56px;border-radius:16px;
    background:linear-gradient(135deg,#7c5cff,#409cff);box-shadow:0 0 34px rgba(124,92,255,.65);
    animation:corePulse 2s ease-in-out infinite}
  .core::after{content:"";position:absolute;inset:14px;border-radius:8px;background:rgba(255,255,255,.92);
    clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
  @keyframes corePulse{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}
  /* 品牌名 + 底部进度弧 */
  .title{position:relative;font-size:17px;font-weight:600;letter-spacing:.14em;color:#e8e6f2;opacity:0;animation:rise .9s ease .35s forwards}
  .sub{position:relative;font-size:11px;color:#8b88a3;letter-spacing:.08em;opacity:0;animation:rise .9s ease .55s forwards}
  @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .bar{position:relative;width:120px;height:2px;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:4px;opacity:0;animation:rise .9s ease .7s forwards}
  .bar i{position:absolute;left:-40%;width:40%;height:100%;border-radius:2px;background:linear-gradient(90deg,transparent,#7c5cff,#409cff,transparent);animation:scan 1.3s linear infinite}
  @keyframes scan{to{left:100%}}
  </style></head><body><div class="stage">
  <div class="nebula"><i></i><i></i><i></i></div>
  <div class="core"></div>
  <div class="title">${brand}</div>
  <div class="sub">LOCAL-FIRST · AI AGENT</div>
  <div class="bar"><i></i></div>
  </div></body></html>`;
}

// ── 内置款 2:轨道(中心核 + 双轨道点环绕)──────────────────────────
function orbitHtml(brand: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%;background:#141418;overflow:hidden;font-family:-apple-system,"SF Pro Display","Segoe UI",sans-serif}
  .stage{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;transition:opacity .3s ease}
  html.splash-out .stage{opacity:0}
  .sys{position:relative;width:120px;height:120px}
  .core{position:absolute;left:50%;top:50%;width:30px;height:30px;margin:-15px;border-radius:9px;
    background:linear-gradient(135deg,#7c5cff,#409cff);box-shadow:0 0 26px rgba(124,92,255,.6);animation:corePulse 2.2s ease-in-out infinite}
  @keyframes corePulse{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
  .ring{position:absolute;inset:0;border-radius:50%;border:1px solid rgba(255,255,255,.09)}
  .ring.r2{inset:18px}
  .sat{position:absolute;left:50%;top:50%;width:120px;height:120px;margin:-60px;animation:spin 1.9s linear infinite}
  .sat::before{content:"";position:absolute;left:8px;top:50%;width:7px;height:7px;margin-top:-3px;border-radius:50%;background:#8f7bff;box-shadow:0 0 10px rgba(143,123,255,.9)}
  .sat.s2{width:84px;height:84px;margin:-42px;animation:spin 1.2s linear infinite reverse}
  .sat.s2::before{left:auto;right:6px;background:#4fc3ff;box-shadow:0 0 10px rgba(79,195,255,.9)}
  @keyframes spin{to{transform:rotate(360deg)}}
  .title{font-size:17px;font-weight:600;letter-spacing:.14em;color:#e8e6f2;opacity:0;animation:rise .9s ease .3s forwards}
  @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .bar{width:120px;height:2px;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden;opacity:0;animation:rise .9s ease .55s forwards}
  .bar i{display:block;height:100%;width:40%;margin-left:-40%;border-radius:2px;background:linear-gradient(90deg,transparent,#7c5cff,#409cff,transparent);animation:scan 1.3s linear infinite}
  @keyframes scan{to{margin-left:100%}}
  </style></head><body><div class="stage">
  <div class="sys"><div class="ring"></div><div class="ring r2"></div>
    <div class="core"></div><div class="sat"></div><div class="sat s2"></div></div>
  <div class="title">${brand}</div>
  <div class="bar"><i></i></div>
  </div></body></html>`;
}
