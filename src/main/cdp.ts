// ── CDP (Chrome DevTools Protocol) client + agent-owned Chrome instance ──
// 方案 A:给 agent 一个专属 Chrome 实例(profile 独立),DOM 级操作零鼠标零键盘零前台,
// 与用户物理隔离 —— 用户看 B 站,agent 在自己的后台窗口里操作它自己的网页。
// 自写 raw WebSocket 客户端(ws 已在 dependencies),不引入 Playwright/Puppeteer。
// Plan A: a dedicated Chrome instance (isolated profile) driven at the DOM level via CDP —
// no mouse, no keyboard, no focus. The user keeps the screen; the agent works its own pages
// in the background. Hand-rolled CDP over `ws` (already a dependency); no Playwright.
//
// 生命周期:首个 browser_* 工具调用时惰性拉起 Chrome(独立 user-data-dir),进程随 app 退出清理。
// Launch is lazy (first browser_* call); the child process is killed on app quit.

import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';

// ── Chrome 进程管理 ── Chrome process management ──

let chromeProc: ChildProcess | null = null;
let chromePort = 0;
let chromeStarting: Promise<string> | null = null; // 并发去重:同时多个工具调用只拉起一次

function chromeBinCandidates(): string[] {
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const lf = process.env['LOCALAPPDATA'] ?? '';
    return [
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(lf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
}

// agent 专属 profile:与用户日常 Chrome 完全隔离(登录态独立、无扩展、无历史)。
function agentProfileDir(): string {
  // Electron userData 下的子目录,随 app 卸载走
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app?.getPath) return path.join(app.getPath('userData'), 'agent-chrome-profile');
  } catch { /* fallthrough */ }
  return path.join(os.tmpdir(), 'kinetaios-agent-chrome');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function httpGetJson(url: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`CDP HTTP 响应非 JSON: ${(e as Error).message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** 确保 agent Chrome 已启动并返回 DevTools 端口。 */
export async function ensureAgentChrome(): Promise<string> {
  // 已在跑:验证 DevTools 端口还活着(用户手动关掉 Chrome 的场景)
  if (chromeProc && chromePort) {
    try {
      await httpGetJson(`http://127.0.0.1:${chromePort}/json/version`, 2000);
      return String(chromePort);
    } catch {
      // 端口死了 → 当作未启动,重新拉
      try { chromeProc.kill(); } catch { /* already dead */ }
      chromeProc = null; chromePort = 0;
    }
  }
  if (chromeStarting) return chromeStarting;

  chromeStarting = (async () => {
    const bin = chromeBinCandidates().find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
    if (!bin) throw new Error('未找到 Chrome/Edge/Chromium。请安装 Google Chrome 后重试。');

    const port = await freePort();
    const profile = agentProfileDir();
    fs.mkdirSync(profile, { recursive: true });
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
      '--disable-background-networking', '--disable-component-update',
      '--window-size=1440,900',
      // 不加 --headless:窗口留在后台即可,headless 模式部分网站(验证码/风控)会拦
      'about:blank',
    ];
    const child = spawn(bin, args, { stdio: 'ignore', detached: false });
    child.on('exit', () => { if (chromeProc === child) { chromeProc = null; chromePort = 0; } });
    chromeProc = child;
    chromePort = port;

    // 轮询等 DevTools HTTP 就绪(Chrome 启动要 1-3s)
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Chrome 启动后立即退出(端口被占用或 profile 损坏)');
      try {
        await httpGetJson(`http://127.0.0.1:${port}/json/version`, 1500);
        return String(port);
      } catch { await new Promise((r) => setTimeout(r, 300)); }
    }
    throw new Error('Chrome DevTools 端口 15s 内未就绪');
  })();

  try {
    return await chromeStarting;
  } finally {
    chromeStarting = null;
  }
}

/** app 退出时清理 Chrome 子进程。main.ts 的 will-quit 钩子调用。 */
export function killAgentChrome(): void {
  if (chromeProc) {
    try { chromeProc.kill(); } catch { /* already dead */ }
    chromeProc = null; chromePort = 0;
  }
}

// ── Tab(页面)管理 ── Tab management ──

interface CdpTarget { id: string; title: string; url: string; type: string; webSocketDebuggerUrl?: string }

async function listTargets(): Promise<CdpTarget[]> {
  const port = await ensureAgentChrome();
  const targets: CdpTarget[] = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
  return targets.filter((t) => t.type === 'page');
}

export async function listTabs(): Promise<Array<{ id: string; title: string; url: string }>> {
  return (await listTargets()).map((t) => ({ id: t.id, title: t.title, url: t.url }));
}

async function findTarget(tabId?: string, urlSubstr?: string): Promise<CdpTarget> {
  const pages = await listTargets();
  if (!pages.length) throw new Error('agent Chrome 中没有打开的页面(意外状态)');
  if (tabId) {
    const hit = pages.find((t) => t.id === tabId);
    if (!hit) throw new Error(`未找到 tab "${tabId}",用 browser_tabs 查看现有 tab`);
    return hit;
  }
  if (urlSubstr) {
    const hit = pages.find((t) => t.url.toLowerCase().includes(urlSubstr.toLowerCase()));
    if (!hit) throw new Error(`未找到 URL 含「${urlSubstr}」的 tab,用 browser_tabs 查看现有 tab`);
    return hit;
  }
  return pages[0]; // 无参 → 第一个页面(通常是 agent 刚 navigate 的那个)
}

// ── CDP WebSocket 会话 ── CDP WebSocket session ──
// 一次工具调用 = 一个连接 + 一串命令。CDP 的 Runtime.evaluate 默认在当前 frame 执行,
// 每命令 await 回包,顺序语义天然串行,无需跨调用维持会话状态。

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void }

class CdpSession {
  private ws: WebSocket;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private events: Array<{ method: string; params: any }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    // P0-fix: 必须挂 error handler —— 目标 tab 意外关闭/导航跳转时 socket 会 emit error,
    // 没有监听器就是 uncaught exception,直接崩掉 Electron main 进程。
    // Must attach an 'error' listener: an unexpectedly closed tab/navigation makes the
    // socket emit 'error'; without a handler that's an uncaught exception in main.
    ws.on('error', () => {
      for (const [, p] of this.pending) p.reject(new Error('CDP 连接已断开(tab 已关闭或导航中)'));
      this.pending.clear();
    });
    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        this.events.push({ method: msg.method, params: msg.params });
      }
    });
  }

  static async connect(url: string): Promise<CdpSession> {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { ws.close(); reject(new Error('CDP WebSocket 连接超时')); }, 10000);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    return new CdpSession(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时(15s)`));
      }, 15000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  takeEvents(): Array<{ method: string; params: any }> {
    const out = this.events;
    this.events = [];
    return out;
  }

  async close(): Promise<void> {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// ── 页面操作原语 ── Page operation primitives ──

// Runtime.evaluate + awaitPromise:selector 等待(CDP 没有 waitForSelector,自己轮询)
async function evalInPage<T>(s: CdpSession, expr: string): Promise<T> {
  const r = await s.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`页面 JS 异常: ${d.exception?.description ?? d.text ?? 'unknown'}`);
  }
  return r.result?.value as T;
}

// 等待 selector 出现(最多 timeoutMs)。用 MutationObserver 比轮询快且不漏。
async function waitForSelector(s: CdpSession, selector: string, timeoutMs: number, visible: boolean): Promise<void> {
  const ok = await evalInPage<boolean>(s, `
    new Promise((resolve) => {
      const q = () => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        if (${visible ? 'true' : 'false'}) {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
        }
        return true;
      };
      if (q()) return resolve(true);
      const ob = new MutationObserver(() => { if (q()) { ob.disconnect(); resolve(true); } });
      ob.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      setTimeout(() => { ob.disconnect(); resolve(false); }, ${timeoutMs});
    })`);
  if (!ok) throw new Error(`元素未出现: ${selector}(等待 ${timeoutMs}ms)`);
}

// 滚动到元素可见位置
function scrollIntoViewExpr(selector: string): string {
  return `(function(){ const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' }); })()`;
}

// 合成点击:mouseMoved 预移动 + 真实 mousedown/mouseup(比 el.click() 兼容性好 —— React/Vue 的
// 合成事件系统、关闭的 shadow DOM 宿主都能收到)。坐标取元素中心。
// mouseMoved 必须发:部分框架组件(自定义 dropdown/hover 菜单)只在收到过 pointer 移动后
// 才响应 press —— 知乎发布实录同款坑(CDP 多步 mouseMoved 轨迹才点中)。
// Synthetic click: mouseMoved warm-up + real mousedown/mouseup (better compat than
// el.click() for React/Vue synthetic events and closed shadow roots). The move is
// required: hover-aware components ignore presses without a preceding pointer move.
async function realClick(s: CdpSession, selector: string): Promise<void> {
  await waitForSelector(s, selector, 10000, true);
  await s.send('Runtime.evaluate', { expression: scrollIntoViewExpr(selector) });
  // Input.dispatchMouseEvent 的坐标系是 CSS 像素相对视口,中心点直接从 getBoundingClientRect 拿
  const { x, y } = await evalInPage<{ x: number; y: number }>(s, `
    (function(){ const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('gone');
      const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const common = { x, y, pointerType: 'mouse' as const };
  // 预移动:hover 状态就位(两步,模拟真实轨迹起点→目标)
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common, button: 'none', clickCount: 0 });
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common, button: 'left', clickCount: 1 });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common, button: 'left', clickCount: 1 });
}

// ── 导出:工具实现层直接调 ── Exported tool implementations ──

export async function browserNavigate(url: string, newTab: boolean): Promise<string> {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const targets = await listTargets();
  let target: CdpTarget;
  if (newTab || !targets.length) {
    // 新 tab:PUT /json/new?url= (Chrome 111+ 要求 PUT,GET 已废弃)
    const port = await ensureAgentChrome();
    target = await new Promise<CdpTarget>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: Number(port), path: `/json/new?${encodeURIComponent(url)}`, method: 'PUT' }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.end();
    });
  } else {
    target = targets[0];
  }
  const s = await CdpSession.connect(target.webSocketDebuggerUrl!);
  try {
    await s.send('Page.enable');
    await s.send('Page.navigate', { url });
    // 等主 frame load 事件(12s 上限;导航已发出,事件只是收尾确认)
    await Promise.race([
      (async () => {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          if (s.takeEvents().some((e) => e.method === 'Page.loadEventFired')) return;
          await new Promise((r) => setTimeout(r, 150));
        }
      })(),
      new Promise((r) => setTimeout(r, 12500)), // 兜底:慢站点不卡死工具
    ]);
    return `✅ 已导航到 ${url} (tab ${target.id}${newTab ? ', 新建' : ''})`;
  } finally { await s.close(); }
}

export async function browserSnapshot(tabId?: string, urlSubstr?: string): Promise<string> {
  const t = await findTarget(tabId, urlSubstr);
  const s = await CdpSession.connect(t.webSocketDebuggerUrl!);
  try {
    // 结构化快照:交互元素抽出 tag/text/aria/selector。比全 DOM 干净,LLM 可直接引用 selector。
    const data = await evalInPage<{ url: string; title: string; elements: Array<{ i: number; tag: string; text: string; sel: string; aria?: string; value?: string }> }>(s, `
      (function() {
        const els = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="textbox"], summary, label[for]'));
        const out = [];
        let i = 0;
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue; // 不可见跳过
          const st = getComputedStyle(el);
          if (st.visibility === 'hidden' || st.display === 'none') continue;
          i++;
          // 稳定 selector:优先 id,再 name/唯一 class,最后 nth-of-type 链
          let sel = '';
          if (el.id) sel = '#' + CSS.escape(el.id);
          else {
            const name = el.getAttribute('name');
            if (name) sel = el.tagName.toLowerCase() + '[name="' + name + '"]';
            else {
              // nth-of-type 路径(最多 4 层)
              const parts = [];
              let cur = el;
              for (let d = 0; d < 4 && cur && cur !== document.body; d++) {
                const parent = cur.parentElement;
                if (!parent) break;
                const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
                const idx = same.indexOf(cur) + 1;
                parts.unshift(cur.tagName.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + idx + ')' : ''));
                cur = parent;
              }
              sel = parts.join(' > ');
            }
          }
          const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || '').trim().slice(0, 80);
          const aria = el.getAttribute('aria-label') || undefined;
          const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : undefined;
          out.push({ i, tag: el.tagName.toLowerCase(), text, sel, aria, value });
          if (out.length >= 150) break; // 上限,防巨型页面爆 token
        }
        return { url: location.href, title: document.title, elements: out };
      })()`);
    const lines = data.elements.map((e) => {
      const attrs = [e.tag, e.aria ? `aria="${e.aria}"` : '', e.value !== undefined ? `value="${e.value.slice(0, 40)}"` : ''].filter(Boolean).join(' ');
      return `[${e.i}] <${attrs}> ${e.text || '(无文本)'} | sel: ${e.sel}`;
    });
    return `📄 ${data.title}\n🔗 ${data.url}\n\n可交互元素 ${data.elements.length} 个:\n${lines.join('\n')}\n\n(用 browser_click/select/type 时 selector 从上面复制)`;
  } finally { await s.close(); }
}

export async function browserClick(selector: string, tabId?: string, urlSubstr?: string): Promise<string> {
  const t = await findTarget(tabId, urlSubstr);
  const s = await CdpSession.connect(t.webSocketDebuggerUrl!);
  try {
    await realClick(s, selector);
    return `✅ 已点击 ${selector}`;
  } finally { await s.close(); }
}

export async function browserType(selector: string, text: string, clearFirst: boolean, submit: boolean, tabId?: string, urlSubstr?: string): Promise<string> {
  const t = await findTarget(tabId, urlSubstr);
  const s = await CdpSession.connect(t.webSocketDebuggerUrl!);
  try {
    await waitForSelector(s, selector, 10000, true);
    // native setter + input 事件:React/Vue 受控组件只认 native setter 赋值
    // (知乎发布实录踩坑:直接 el.value = x 不触发框架状态更新)。
    // clear=false = 追加语义:先读原值拼接,再整体 setter 赋值 —— 直接对 el.value
    // += 不会走 setter,同样不触发框架更新。
    // clear=false = append semantics: read existing value, concat, then set via the
    // native setter once — `el.value += x` bypasses the setter and React misses it.
    await evalInPage(s, `
      (async function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('元素不存在: ${selector.replace(/'/g, "\\'")}');
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        ${clearFirst ? 'el.select && el.select();' : 'var _prev = el.value;'}
        setter.call(el, ${clearFirst ? '' : '(_prev ?? "") + '} ${JSON.stringify(text)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    if (submit) await realClick(s, 'button[type="submit"], form button:not([type])');
    return `✅ 已输入 ${text.length} 字符到 ${selector}${submit ? ' 并提交' : ''}`;
  } finally { await s.close(); }
}

export async function browserSelect(selector: string, value: string, tabId?: string, urlSubstr?: string): Promise<string> {
  const t = await findTarget(tabId, urlSubstr);
  const s = await CdpSession.connect(t.webSocketDebuggerUrl!);
  try {
    await waitForSelector(s, selector, 10000, false);
    const ok = await evalInPage<string>(s, `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el || el.tagName !== 'SELECT') return 'ERR notselect';
        const opt = Array.from(el.options).find((o) => o.value === ${JSON.stringify(value)} || o.text.trim() === ${JSON.stringify(value)});
        if (!opt) return 'ERR nooption:' + Array.from(el.options).map((o) => o.value).join(',').slice(0, 200);
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(el, opt.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'OK';
      })()`);
    if (ok === 'ERR notselect') throw new Error(`${selector} 不是 <select> 元素`);
    if (ok.startsWith('ERR nooption')) throw new Error(`选项不存在。可用: ${ok.slice('ERR nooption:'.length)}`);
    return `✅ 已选择 ${value}`;
  } finally { await s.close(); }
}

export async function browserEval(expr: string, tabId?: string, urlSubstr?: string): Promise<string> {
  const t = await findTarget(tabId, urlSubstr);
  const s = await CdpSession.connect(t.webSocketDebuggerUrl!);
  try {
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      return `❌ JS 异常: ${d.exception?.description ?? d.text}`;
    }
    const v = r.result?.value;
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? String(v);
  } finally { await s.close(); }
}

export async function browserScreenshot(tabId?: string, urlSubstr?: string): Promise<{ ok: boolean; base64?: string; error?: string; note?: string }> {
  const t = await findTarget(tabId, urlSubstr);
  const s = await CdpSession.connect(t.webSocketDebuggerUrl!);
  try {
    // captureBeyondViewport=false 只拍视口内容(和真实浏览器看到的一致)
    const r = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return { ok: true, base64: r.data, note: `窗口内容截图成功 (${t.title})` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally { await s.close(); }
}

export async function browserTabs(action: 'list' | 'close' | 'activate', tabId?: string): Promise<string> {
  if (action === 'list') {
    const tabs = await listTabs();
    return tabs.map((t, i) => `[${i}] ${t.id} "${t.title}" ${t.url}`).join('\n') || '(无 tab)';
  }
  if (!tabId) throw new Error('close/activate 需要 tab_id(用 browser_tabs action=list 查看)');
  const targets = await listTargets();
  const t = targets.find((x) => x.id === tabId);
  if (!t) throw new Error(`未找到 tab ${tabId}`);
  if (action === 'close') {
    const port = await ensureAgentChrome();
    await httpGetJson(`http://127.0.0.1:${port}/json/close/${tabId}`);
    return `✅ 已关闭 tab ${tabId}`;
  }
  // activate:Chrome 111+ /json/activate 也要求 PUT... 实测 /json/activate GET 在多数版本仍可用,
  // 但 agent Chrome 不在前台展示,activate 意义不大 — 用 CDP Target.activateTarget 更稳。
  const port = await ensureAgentChrome();
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(port), path: '/json/activate/' + tabId, method: 'PUT' }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end();
  });
  return `✅ 已激活 tab ${tabId}`;
}
