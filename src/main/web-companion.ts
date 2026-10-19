// Web Companion(手机伴侣):局域网 HTTP server + 二维码扫码接入。
// Web Companion: LAN HTTP server + QR-code onboarding for phone browsers.
//
// 场景:手机在同一局域网,扫桌面端弹出的二维码 → 打开内联 Web 页 →
//   1. 看会话列表 + 最近对话内容(只读,脱敏:不含 directHistory/traj 等重载荷)
//   2. 继续/新建对话(走 TaskManager.sendDetached,与桌面端同一数据面)
//   3. 轻量轮询刷新运行中的会话(SSE 复杂度高,轮询 2s 足够手机场景)
//
// 安全(对齐 mcp-server.ts 的既有实践):
//   - 绑定 0.0.0.0(局域网可达),token 必须非空(URL query 携带,启动时强制)
//   - 连续鉴权失败限速(同 LocalMcpServer 的 AUTH_PENALTY 机制)
//   - 只读 + 发消息两种操作;不暴露 shell/文件工具
//
// ponytail: 手机页是单文件内联 HTML(无框架、无构建),轮询而非 SSE。
//           未来要"手机实时流式"再升级 SSE;当前覆盖"离开电脑也能看进度/插话"。

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import QRCode from 'qrcode';
import { __getTM } from './main-instance';
import { getSettings } from './settings';

type SessionInfo = {
  id: string;
  title: string;
  status: string;
  updatedAt: number;
  engine: string;
  turnCount: number;
};

/** 从 URL query 取 token(query 顺序无关;兼容 ?x=1&token=t 与 ?token=t&x=1)。 */
function queryToken(url: string): string {
  try {
    const u = new URL(url, 'http://x');
    return u.searchParams.get('token') ?? '';
  } catch {
    return '';
  }
}

/** 手机页单 turn 的展示切片(不透传 steps 全文/重载荷)。 */
function sliceTurn(t: { id: string; prompt: string; answer: string; error: string | null; done: boolean; ts: number; statusNote?: string | null }) {
  return {
    id: t.id,
    prompt: t.prompt,
    answer: t.answer,
    error: t.error,
    done: t.done,
    ts: t.ts,
  };
}

export class WebCompanionServer {
  private server: http.Server | null = null;
  private token = '';
  /** 当前请求的 URL 对象(query 解析用),handle() 入口刷新。 */
  private url = new URL('/', 'http://x');
  private port = 18110;
  // 鉴权失败限速(照搬 LocalMcpServer 的参数:60s 窗口内 10 次失败 → 罚 60s)。
  private authFailures: number[] = [];
  private penaltyUntil = 0;
  private static readonly AUTH_FAIL_WINDOW_MS = 60_000;
  private static readonly AUTH_FAIL_THRESHOLD = 10;
  private static readonly AUTH_PENALTY_MS = 60_000;

  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * 生成接入二维码(SVG 字符串)。取所有非内部网卡的 IPv4,优先 192.168.*(家庭/办公最常见),
   * 二维码内容 = 第一个候选 URL。URL 列表同时返回,给 UI 兜底展示。
   */
  async buildQr(port: number, token: string): Promise<{ qrSvg: string; urls: string[]; url: string }> {
    const urls = lanUrls(port, token);
    const url = urls[0] ?? `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
    // 二维码里放第一个 URL;errorCorrectionLevel=M 平衡密度与扫码成功率。
    const qrSvg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    return { qrSvg, urls, url };
  }

  async start(port: number, token: string): Promise<void> {
    if (this.server) await this.stop();
    // 安全闸:空 token 拒绝启动(桌面端 UI 已提前拦,这里兜底)。
    if (!token || !token.trim()) {
      throw new Error('安全限制:必须设置访问令牌(token),否则局域网内任何设备都能操控本机 Agent。');
    }
    this.token = token;
    this.port = port;
    this.authFailures = [];
    this.penaltyUntil = 0;
    this.server = http.createServer((req, res) => this.handle(req, res));
    // 手机端 send 请求可能等整轮(阻塞 send),关闭默认 2min 超时。
    this.server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '0.0.0.0', () => resolve());
    });
    console.log(`[web-companion] listening on 0.0.0.0:${port}`);
  }

  async stop(): Promise<void> {
    const srv = this.server;
    this.server = null;
    if (!srv) return;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    console.log('[web-companion] stopped');
  }

  status(): { running: boolean; port: number; urls: string[] } {
    const s = getSettings();
    const port = this.isRunning() ? this.port : (s.webRemote?.port ?? 18110);
    const urls = this.isRunning() ? lanUrls(this.port, this.token) : [];
    return { running: this.isRunning(), port, urls };
  }

  // ── 请求路由 ──
  private handle(req: IncomingMessage, res: ServerResponse): void {
    // URL 对象缓存给本请求用(query 解析)。
    try { this.url = new URL(req.url ?? '/', 'http://x'); } catch { this.url = new URL('/', 'http://x'); }
    const now = Date.now();
    if (now < this.penaltyUntil) {
      return this.json(res, 429, { ok: false, error: '鉴权失败次数过多,请稍后再试' });
    }
    // 鉴权:token 走 URL query(二维码直开)或 header(页面内 fetch 携带)。
    // 语义:两者都没带 = 匿名,拒绝;任一带了但不匹配 = 疑似探测,记失败并限速。
    const qt = queryToken(req.url ?? '');
    const ht = String(req.headers['x-kinet-token'] ?? '');
    const provided = qt || ht;
    if (!provided || provided !== this.token) {
      this.authFailures = this.authFailures.filter((t) => now - t < WebCompanionServer.AUTH_FAIL_WINDOW_MS);
      this.authFailures.push(now);
      if (this.authFailures.length >= WebCompanionServer.AUTH_FAIL_THRESHOLD) {
        this.penaltyUntil = now + WebCompanionServer.AUTH_PENALTY_MS;
        this.authFailures = [];
      }
      return this.json(res, 401, { ok: false, error: 'token 无效' });
    }

    const path = (req.url ?? '').split('?')[0];
    const method = (req.method ?? 'GET').toUpperCase();

    // 页面本体(GET /):内联 HTML,无外部依赖。
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageHtml(this.token));
      return;
    }

    // API:全部要求 header token(页面内 fetch 统一带)。
    if (!path.startsWith('/api/')) {
      return this.json(res, 404, { ok: false, error: 'not found' });
    }

    // 静态数据接口(只读)。?conv=<id> 附加返回该会话最近 turns(手机端展开会话用)。
    if (method === 'GET' && path === '/api/state') {
      const payload = this.statePayload();
      const convId = this.url.searchParams.get('conv') ?? '';
      if (convId) payload.conv = this.convDetail(convId);
      return this.json(res, 200, payload);
    }

    // 写操作:发消息 / 新建会话 / 取消。
    if (method === 'POST' && (path === '/api/send' || path === '/api/new' || path === '/api/cancel')) {
      let body = '';
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 256 * 1024) req.destroy(); // 256KB 上限,防滥用
        body += c.toString('utf8');
      });
      req.on('end', () => {
        void this.handleAction(path, body, res);
      });
      return;
    }

    return this.json(res, 404, { ok: false, error: 'not found' });
  }

  /** 汇总当前会话状态(给 /api/state)。 */
  private statePayload(): Record<string, unknown> {
    const tm = __getTM();
    if (!tm) return { ok: true, convs: [], serverTs: Date.now() };
    const convs: SessionInfo[] = tm.list().map((c) => ({
      id: c.id,
      title: c.customTitle || c.firstPrompt || '(未命名)',
      status: c.status,
      updatedAt: c.updatedAt ?? c.createdAt,
      engine: c.engine,
      turnCount: c.turnCount ?? c.turns.length,
    }));
    return { ok: true, convs, serverTs: Date.now() };
  }

  /** 单会话详情:最近 20 turns 的展示切片(turns 未加载时 hydrate)。 */
  private convDetail(convId: string): { ok: boolean; turns?: unknown[]; error?: string } {
    const tm = __getTM();
    if (!tm) return { ok: false, error: 'Agent 尚未初始化' };
    let conv = tm.get(convId);
    if (!conv) return { ok: false, error: '会话不存在' };
    if (conv.turnsLoaded === false) conv = tm.hydrate(convId) ?? conv;
    const turns = (conv.turns ?? []).slice(-20).map(sliceTurn);
    return { ok: true, turns };
  }

  /** 写操作(发消息/新建/取消)。发消息用阻塞版 send:手机端等答案再刷新,语义直观。 */
  private async handleAction(path: string, body: string, res: ServerResponse): Promise<void> {
    const tm = __getTM();
    if (!tm) return this.json(res, 503, { ok: false, error: 'Agent 尚未初始化' });
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(body || '{}') as Record<string, unknown>; } catch { /* 空 body 容忍 */ }

    try {
      if (path === '/api/new') {
        const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : os.homedir();
        const conv = tm.newConversation(cwd);
        return this.json(res, 200, { ok: true, convId: conv.id });
      }
      if (path === '/api/cancel') {
        const id = String(args.convId ?? '');
        tm.cancel(id);
        return this.json(res, 200, { ok: true });
      }
      // /api/send
      const id = String(args.convId ?? '');
      const text = String(args.text ?? '').trim();
      if (!text) return this.json(res, 400, { ok: false, error: '缺少消息内容' });
      if (!tm.get(id)) return this.json(res, 404, { ok: false, error: '会话不存在' });
      await tm.send(id, text); // 阻塞版:答案就绪后返回(手机端"发出去→看回答"直觉)
      return this.json(res, 200, { ok: true });
    } catch (e) {
      return this.json(res, 500, { ok: false, error: (e as Error)?.message ?? String(e) });
    }
  }

  /** 读取单个会话的最近 turns(给 /api/state?conv=xxx;也可独立端点)。 */
  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
}

/** 收集本机所有非内部 IPv4 的局域网地址,拼出带 token 的接入 URL(192.168 优先)。 */
export function lanUrls(port: number, token: string): string[] {
  const q = `?token=${encodeURIComponent(token)}`;
  const addrs: string[] = [];
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const it of list ?? []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      addrs.push(`http://${it.address}:${port}/${q}`);
    }
  }
  // 192.168.* 最常见,排前面;10.* 次之(公司网);172.* 最后。
  addrs.sort((a, b) => score(b) - score(a));
  return addrs;
  function score(u: string): number {
    if (u.includes('//192.168.')) return 3;
    if (u.includes('//10.')) return 2;
    if (u.includes('//172.')) return 1;
    return 0;
  }
}

// ── 手机端页面(内联,零依赖)──
// token 由服务端渲染进页面;页面内 fetch 统一带 x-kinet-token header。
function pageHtml(token: string): string {
  const tokenJson = JSON.stringify(token);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<title>KinetAios</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #e6edf3; font: 15px/1.5 -apple-system, "PingFang SC", "Segoe UI", Roboto, sans-serif; padding-bottom: env(safe-area-inset-bottom); }
  header { position: sticky; top: 0; background: rgba(13,17,23,.92); backdrop-filter: blur(8px); padding: 12px 16px; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 10px; z-index: 10; }
  header h1 { font-size: 17px; font-weight: 600; flex: 1; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; }
  .dot.off { background: #f85149; }
  main { padding: 12px 16px 90px; }
  .conv { background: #161b22; border: 1px solid #21262d; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
  .conv.active { border-color: #1f6feb; }
  .conv .row1 { display: flex; gap: 8px; align-items: center; }
  .conv .title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: #21262d; color: #8b949e; }
  .badge.running { background: #1f2937; color: #58a6ff; }
  .conv .meta { font-size: 12px; color: #8b949e; margin-top: 4px; }
  .turns { margin-top: 10px; border-top: 1px solid #21262d; padding-top: 8px; }
  .turn { margin-bottom: 10px; }
  .turn .q { color: #79c0ff; font-size: 13px; margin-bottom: 4px; white-space: pre-wrap; word-break: break-word; }
  .turn .a { color: #e6edf3; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
  .turn .a.running::after { content: "▍"; animation: blink 1s infinite; color: #58a6ff; }
  .turn .err { color: #f85149; font-size: 13px; margin-top: 4px; }
  @keyframes blink { 50% { opacity: 0; } }
  .btn { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
  .btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .btn:disabled { opacity: .5; }
  .composer { position: fixed; bottom: 0; left: 0; right: 0; background: #161b22; border-top: 1px solid #21262d; padding: 10px 16px; display: flex; gap: 8px; padding-bottom: calc(10px + env(safe-area-inset-bottom)); }
  .composer textarea { flex: 1; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 10px; padding: 10px 12px; font: inherit; resize: none; height: 44px; }
  .empty { text-align: center; color: #8b949e; padding: 48px 0; }
  .spin { display: inline-block; width: 14px; height: 14px; border: 2px solid #58a6ff; border-top-color: transparent; border-radius: 50%; animation: rot 0.8s linear infinite; vertical-align: -2px; margin-right: 6px; }
  @keyframes rot { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<header>
  <span class="dot" id="conn"></span>
  <h1>KinetAios</h1>
  <button class="btn primary" id="new">+ 新对话</button>
</header>
<main id="list"><div class="empty">加载中…</div></main>
<div class="composer">
  <textarea id="input" placeholder="输入消息,继续当前对话…"></textarea>
  <button class="btn primary" id="send">发送</button>
</div>
<script>
const TOKEN = ${tokenJson};
const H = { 'Content-Type': 'application/json', 'x-kinet-token': TOKEN };
let convs = [];
let openId = null;   // 展开中的会话
let busy = false;    // 阻塞 send 进行中
let timer = null;

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
function fmtTs(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// 拉全局会话列表;展开的会话追加拉 turns 详情。
async function refresh() {
  try {
    const st = await api('/api/state');
    document.getElementById('conn').classList.remove('off');
    convs = st.convs || [];
    render();
    if (openId && !busy) {
      const det = await api('/api/state?conv=' + encodeURIComponent(openId));
      renderTurns(openId, det.turns || []);
    }
  } catch (e) {
    document.getElementById('conn').classList.add('off');
  }
}

function render() {
  const el = document.getElementById('list');
  if (!convs.length) { el.innerHTML = '<div class="empty">还没有会话<br><br>点右上角「+ 新对话」开始</div>'; return; }
  el.innerHTML = convs.map((c) => {
    const open = c.id === openId;
    const badge = c.status === 'running'
      ? '<span class="badge running"><span class="spin"></span>运行中</span>'
      : '<span class="badge">' + esc(c.engine) + '</span>';
    return '<div class="conv' + (open ? ' active' : '') + '" data-id="' + c.id + '">' +
      '<div class="row1"><div class="title">' + esc(c.title) + '</div>' + badge + '</div>' +
      '<div class="meta">' + c.turnCount + ' 轮 · ' + fmtTs(c.updatedAt) + (open ? ' · 点击收起' : ' · 点击展开') + '</div>' +
      (open ? '<div class="turns" id="turns-' + c.id + '"><div class="meta">加载对话…</div></div>' : '') +
      '</div>';
  }).join('');
  el.querySelectorAll('.conv').forEach((n) => {
    n.onclick = (e) => {
      if (e.target.closest('.turns') && !e.target.closest('.conv')) return;
      const id = n.dataset.id;
      openId = (openId === id) ? null : id;
      render();
      if (openId) refresh();
    };
  });
}

function renderTurns(convId, turns) {
  if (openId !== convId) return;
  const box = document.getElementById('turns-' + convId);
  if (!box) return;
  if (!turns.length) { box.innerHTML = '<div class="meta">(暂无对话)</div>'; return; }
  box.innerHTML = turns.map((t) =>
    '<div class="turn">' +
      '<div class="q">🧑 ' + esc(t.prompt) + '</div>' +
      (t.answer ? '<div class="a' + (t.done ? '' : ' running') + '">' + esc(t.answer) + '</div>' : (t.done ? '' : '<div class="a running"></div>')) +
      (t.error ? '<div class="err">⚠ ' + esc(t.error) + '</div>' : '') +
    '</div>'
  ).join('');
  box.scrollIntoView({ block: 'nearest' });
}

document.getElementById('new').onclick = async () => {
  try {
    const j = await api('/api/new', {});
    openId = j.convId;
    await refresh();
    document.getElementById('input').focus();
  } catch (e) { alert('新建失败: ' + e.message); }
};

document.getElementById('send').onclick = doSend;
document.getElementById('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doSend();
});

async function doSend() {
  const inp = document.getElementById('input');
  const btn = document.getElementById('send');
  const text = inp.value.trim();
  if (!text || busy) return;
  if (!openId) {
    const j = await api('/api/new', {}).catch(() => null);
    if (!j) return;
    openId = j.convId;
  }
  busy = true; btn.disabled = true; btn.textContent = '…';
  inp.value = '';
  render();
  try {
    // 阻塞 send:等答案。期间轮询只刷列表不再拉详情,答案一次性上屏。
    await api('/api/send', { convId: openId, text });
  } catch (e) { alert('发送失败: ' + e.message); }
  busy = false; btn.disabled = false; btn.textContent = '发送';
  await refresh();
}

// 轮询:busy 时 3s 刷列表(看运行状态),空闲 5s。
function loop() {
  refresh().finally(() => {
    clearTimeout(timer);
    timer = setTimeout(loop, busy ? 3000 : 5000);
  });
}
loop();
</script>
</body>
</html>`;
}

export const webCompanionServer = new WebCompanionServer();
