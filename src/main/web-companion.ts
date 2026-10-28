// Web Companion(手机伴侣):局域网 HTTP server + 二维码扫码接入。
// Web Companion: LAN HTTP server + QR-code onboarding for phone browsers.
//
// 场景:手机在同一局域网,扫桌面端弹出的二维码 → 打开内联 Web 页 →
//   1. 项目分组会话列表(与桌面侧栏同规则:cwd basename 分组,未分类兜底)
//   2. 搜索:标题/cwd 过滤 + FTS5 全文(store.searchEnriched,带会话跳转)
//   3. 看会话内容(只读切片)、继续/新建对话、取消运行中任务
//   4. 轻量轮询刷新(2s 运行中 / 5s 空闲;SSE 留待后续)
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
import os from 'node:os';
import QRCode from 'qrcode';
import { __getTM } from './main-instance';
import { getSettings } from './settings';
import { searchEnriched, stmt as dbStmt } from './store';
import type { TaskStep } from '../shared/types';

type SessionInfo = {
  id: string;
  title: string;
  status: string;
  statusNote: string | null;
  updatedAt: number;
  engine: string;
  turnCount: number;
  project: string;
  cwd: string;
  preview: string; // 最后一条 turn 的回答摘要(120 字),列表页免点开即可判断内容
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

/** 项目分组名:cwd basename;与桌面端 projName 同规则(home/空 = 未分类)。 */
export function projectName(cwd: string, homeDir: string, ungrouped: string): string {
  if (!cwd || cwd === homeDir) return ungrouped;
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return base || cwd;
}

/** 手机页单 turn 的展示切片(不透传 steps 全文/重载荷)。 */
function sliceTurn(t: {
  id: string; prompt: string; answer: string; error: string | null; done: boolean; ts: number;
  steps?: TaskStep[];
}) {
  // steps 精简片:手机端渲染工具轨迹(哪个工具、跑没跑完、结果摘要)。
  // 结果截 200 字 + 剥换行防串行;旧 turn 无 steps(undefined → 空数组)。
  // / Slim step chips for the phone: tool name + status + short result excerpt.
  const steps = (t.steps ?? []).slice(-30).map((s) => ({
    name: s.name,
    result: clamp(s.result || '', 200),
    pending: s.pending === true,
    outcome: s.outcome ?? null,
    durationMs: s.durationMs ?? null,
  }));
  return { id: t.id, prompt: t.prompt, answer: t.answer, error: t.error, done: t.done, ts: t.ts, steps };
}

function clamp(s: string, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
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
      res.end(pageHtml(this.token, uiStrings()));
      return;
    }

    // API:全部要求 header token(页面内 fetch 统一带)。
    if (!path.startsWith('/api/')) {
      return this.json(res, 404, { ok: false, error: 'not found' });
    }

    // 只读接口:全局状态 / 会话详情 / 全文搜索。
    if (method === 'GET' && path === '/api/state') {
      const payload = this.statePayload();
      const convId = this.url.searchParams.get('conv') ?? '';
      if (convId) payload.conv = this.convDetail(convId);
      return this.json(res, 200, payload);
    }
    if (method === 'GET' && path === '/api/search') {
      return this.json(res, 200, this.searchPayload(this.url.searchParams.get('q') ?? ''));
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

  /** 汇总当前会话状态(给 /api/state):含项目分组名 + 末条回答摘要。 */
  private statePayload(): Record<string, unknown> {
    const tm = __getTM();
    if (!tm) return { ok: true, convs: [], serverTs: Date.now() };
    const home = os.homedir();
    const ungrouped = getSettings().lang === 'en' ? 'Unfiled' : '未分类';
    const convs: SessionInfo[] = tm.list().map((c) => ({
      id: c.id,
      title: c.customTitle || c.firstPrompt || '(未命名)',
      status: c.status,
      statusNote: c.statusNote,
      updatedAt: c.updatedAt ?? c.createdAt,
      engine: c.engine,
      turnCount: c.turnCount ?? c.turns.length,
      project: projectName(c.cwd, home, ungrouped),
      cwd: c.cwd,
      // head 模式:末条预览直接从 store 标量查询拿,不 hydrate 整个 turns。
      preview: this.lastPreview(c.id),
    }));
    return { ok: true, convs, serverTs: Date.now() };
  }

  /** 末条 turn 摘要:一条 SQL 取 conv 最后一条 data,抽 prompt/answer/error。 */
  private lastPreview(convId: string): string {
    try {
      const row = lastTurnQuery(convId);
      if (!row) return '';
      const o = JSON.parse(row.data) as { prompt?: string; answer?: string; error?: string | null };
      return clamp(o.answer || o.prompt || o.error || '', 120);
    } catch {
      return '';
    }
  }

  /** 全文搜索:标题/cwd 内存过滤 + FTS5 内容检索(store.searchEnriched)。 */
  private searchPayload(q: string): Record<string, unknown> {
    const query = q.trim();
    if (!query) return { ok: true, convs: [], msgs: [] };
    const ql = query.toLowerCase();
    const tm = __getTM();
    const home = os.homedir();
    const ungrouped = getSettings().lang === 'en' ? 'Unfiled' : '未分类';
    // 1) 会话命中:标题/cwd/项目名模糊。
    const convs = tm
      ? tm.list()
          .filter((c) => {
            const title = (c.customTitle || c.firstPrompt || '').toLowerCase();
            const proj = projectName(c.cwd, home, ungrouped).toLowerCase();
            return title.includes(ql) || (c.cwd || '').toLowerCase().includes(ql) || proj.includes(ql);
          })
          .slice(0, 20)
          .map((c) => ({
            id: c.id,
            title: c.customTitle || c.firstPrompt || '(未命名)',
            project: projectName(c.cwd, home, ungrouped),
            updatedAt: c.updatedAt ?? c.createdAt,
          }))
      : [];
    // FTS5 MATCH 语法错误(query 含保留字)→ store 内部已降级为 LIKE,这里直传。
    let msgs: Array<{ role: string; content: string; convId: string | null; convTitle: string | null }> = [];
    try {
      msgs = searchEnriched(query, 30).map((r) => ({
        role: r.role,
        content: clamp(r.content, 160),
        convId: r.convId,
        convTitle: r.convTitle,
      }));
    } catch { /* db 异常降级为空结果 */ }
    return { ok: true, convs, msgs };
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
      // /api/send — sendDetached:入列即返回,不等整轮答案。修前阻塞版 send 要等答案
      // (HTTP 可能挂几分钟,手机锁屏/切后台即断),现在手机端"发出即回执",进度靠既有轮询。
      // / Fire-and-forget: HTTP round-trip no longer blocks on the full answer;
      // progress streams via the existing polling loop.
      // running 语义与桌面 sendCore 一致:goal 会话 = 修正队列(可见 ack turn),
      // 非 goal = 停旧开新 —— 主进程统一裁决,手机端不做二次拦截。
      const id = String(args.convId ?? '');
      const text = String(args.text ?? '').trim();
      if (!text) return this.json(res, 400, { ok: false, error: '缺少消息内容' });
      if (!tm.get(id)) return this.json(res, 404, { ok: false, error: '会话不存在' });
      void tm.sendDetached(id, text).catch(() => { /* 轮询会呈现 turn 错误态 */ });
      return this.json(res, 200, { ok: true });
    } catch (e) {
      return this.json(res, 500, { ok: false, error: (e as Error)?.message ?? String(e) });
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
}

/** 末条 turn 标量查询(prepare 一次复用;store 打开时才可调)。 */
export function lastTurnQuery(convId: string): { data: string } | undefined {
  return dbStmt(
    `SELECT data FROM turns WHERE conv_id=? ORDER BY created_at DESC LIMIT 1;`,
  ).get(convId) as { data: string } | undefined;
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

/** 手机页 UI 字符串(跟随桌面端语言设置;页面零依赖,由服务端渲染)。 */
function uiStrings(): Record<string, string> {
  const en = getSettings().lang === 'en';
  return en
    ? {
        search: 'Search chats & content…', projects: 'Projects', ungrouped: 'Unfiled',
        newChat: '+ New', running: 'Running', idle: 'Idle', cancel: 'Stop',
        loadTurns: 'Loading…', noTurns: '(No messages yet)', send: 'Send',
        sendPlaceholder: 'Message…', empty: 'No chats yet.\nTap “+ New” to start.',
        secConv: 'Chats', secMsg: 'Messages', searchEmpty: 'No results', back: 'Chats',
        queued: 'Queued — streaming below…', newHere: '+', newTitle: 'New chat in this project',
      }
    : {
        search: '搜索会话与内容…', projects: '项目', ungrouped: '未分类',
        newChat: '+ 新对话', running: '运行中', idle: '空闲', cancel: '停止',
        loadTurns: '加载对话…', noTurns: '(暂无消息)', send: '发送',
        sendPlaceholder: '输入消息…', empty: '还没有会话\n点「+ 新对话」开始',
        secConv: '会话', secMsg: '对话内容', searchEmpty: '无结果', back: '会话',
        queued: '已发出,回答流式生成中…', newHere: '+', newTitle: '在此项目新建对话',
      };
}

// ── 手机端页面(内联,零依赖)──
// token 由服务端渲染进页面;页面内 fetch 统一带 x-kinet-token header。
function pageHtml(token: string, L: Record<string, string>): string {
  const tokenJson = JSON.stringify(token);
  const LJson = JSON.stringify(L);
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
  header { position: sticky; top: 0; background: rgba(13,17,23,.94); backdrop-filter: blur(8px); padding: 10px 14px; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 10px; z-index: 10; }
  header h1 { font-size: 17px; font-weight: 600; flex: 1; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; flex: none; }
  .dot.off { background: #f85149; }
  .searchbar { padding: 10px 14px; position: sticky; top: 0; background: #0d1117; z-index: 9; }
  .searchbar input { width: 100%; background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 10px; padding: 9px 12px; font: inherit; }
  .searchbar input:focus { outline: none; border-color: #1f6feb; }
  main { padding: 0 14px 96px; }
  .proj { margin-bottom: 8px; }
  .proj-head { display: flex; align-items: center; gap: 8px; padding: 10px 4px 6px; color: #8b949e; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; cursor: pointer; user-select: none; }
  .proj-head .n { color: #6e7681; font-weight: 400; }
  .proj-head .chev { transition: transform .15s; }
  .proj-head .proj-new { margin-left: auto; width: 22px; height: 22px; line-height: 20px; text-align: center; border: 1px solid #30363d; border-radius: 8px; color: #8b949e; font-size: 15px; font-weight: 400; flex: none; }
  .proj-head .proj-new:active { background: #21262d; color: #e6edf3; }
  .proj.closed .chev { transform: rotate(-90deg); }
  .proj.closed .conv-list { display: none; }
  .conv { background: #161b22; border: 1px solid #21262d; border-radius: 12px; padding: 11px 13px; margin-bottom: 8px; }
  .conv.active { border-color: #1f6feb; }
  .conv .row1 { display: flex; gap: 8px; align-items: center; }
  .conv .title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: #21262d; color: #8b949e; flex: none; }
  .badge.running { background: #1f2937; color: #58a6ff; }
  .conv .preview { font-size: 12px; color: #8b949e; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conv .meta { font-size: 11px; color: #6e7681; margin-top: 3px; }
  .turns { margin-top: 10px; border-top: 1px solid #21262d; padding-top: 8px; }
  .turn { margin-bottom: 10px; }
  .turn .q { color: #79c0ff; font-size: 13px; margin-bottom: 4px; white-space: pre-wrap; word-break: break-word; }
  .turn .a { color: #e6edf3; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
  .steps { margin: 2px 0 6px; display: flex; flex-direction: column; gap: 3px; }
  .step { font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: #8b949e; background: #0d1117; border: 1px solid #21262d; border-radius: 7px; padding: 4px 8px; word-break: break-all; }
  .step b { color: #a5b1bd; font-weight: 600; }
  .step .ms { color: #6e7681; margin-left: 6px; }
  .step.run { border-color: #1f4a7a; animation: pulse 1.2s ease-in-out infinite; }
  .step.run b::after { content: " ⏳"; }
  .step.ok b::before { content: "✓ "; color: #3fb950; }
  .step.bad { border-color: #5c2321; }
  .step.bad b::before { content: "✗ "; color: #f85149; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
  .turn .a.running::after { content: "▍"; animation: blink 1s infinite; color: #58a6ff; }
  .turn .err { color: #f85149; font-size: 13px; margin-top: 4px; }
  @keyframes blink { 50% { opacity: 0; } }
  .btn { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
  .btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .btn:disabled { opacity: .5; }
  .composer { position: fixed; bottom: 0; left: 0; right: 0; background: #161b22; border-top: 1px solid #21262d; padding: 10px 14px; display: none; gap: 8px; padding-bottom: calc(10px + env(safe-area-inset-bottom)); }
  .composer.show { display: flex; }
  .composer textarea { flex: 1; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 10px; padding: 10px 12px; font: inherit; resize: none; height: 44px; }
  .empty { text-align: center; color: #8b949e; padding: 48px 0; white-space: pre-line; }
  .sec-title { color: #8b949e; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 12px 4px 6px; }
  .msg { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; }
  .msg .role { font-size: 11px; color: #6e7681; margin-bottom: 2px; }
  .msg .content { font-size: 13px; color: #c9d1d9; white-space: pre-wrap; word-break: break-word; }
  .msg .from { font-size: 11px; color: #58a6ff; margin-top: 4px; }
  .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid #58a6ff; border-top-color: transparent; border-radius: 50%; animation: rot 0.8s linear infinite; vertical-align: -1px; margin-right: 5px; }
  @keyframes rot { to { transform: rotate(360deg); } }
  .back { background: none; border: none; color: #58a6ff; font-size: 14px; cursor: pointer; padding: 4px; }
</style>
</head>
<body>
<header>
  <button class="back" id="back" style="display:none">‹ <span id="back-t"></span></button>
  <span class="dot" id="conn"></span>
  <h1 id="h-title">KinetAios</h1>
  <button class="btn primary" id="new">${L.newChat}</button>
</header>
<div class="searchbar"><input id="q" type="search" placeholder="${L.search}" /></div>
<main id="list"><div class="empty">…</div></main>
<div class="composer" id="composer">
  <textarea id="input" placeholder="${L.sendPlaceholder}"></textarea>
  <button class="btn primary" id="send">${L.send}</button>
</div>
<script>
const TOKEN = ${tokenJson};
const L = ${LJson};
const H = { 'Content-Type': 'application/json', 'x-kinet-token': TOKEN };
let convs = [];
let openId = null;    // 展开中的会话(会话详情模式)
let searchMode = false;
let searchTimer = null;
let timer = null;
let pollFast = false;  // 发送后 12s 内用 1.5s 快节拍,之后回落(接住 ack/首 token)
const collapsed = new Set(); // 折叠的项目组

function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
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

async function refresh() {
  try {
    const st = await api('/api/state');
    document.getElementById('conn').classList.remove('off');
    convs = st.convs || [];
    if (!searchMode && !openId) renderProjects();
  } catch (e) {
    document.getElementById('conn').classList.add('off');
  }
}

// ── 项目分组视图(默认)──
function renderProjects() {
  const el = document.getElementById('list');
  document.getElementById('composer').classList.remove('show');
  if (!convs.length) { el.innerHTML = '<div class="empty">' + esc(L.empty) + '</div>'; return; }
  const groups = new Map();
  for (const c of convs) {
    if (!groups.has(c.project)) groups.set(c.project, []);
    groups.get(c.project).push(c);
  }
  let html = '<div class="sec-title">' + esc(L.projects) + ' · ' + convs.length + '</div>';
  for (const [proj, list] of groups) {
    const closed = collapsed.has(proj);
    html += '<div class="proj' + (closed ? ' closed' : '') + '" data-proj="' + esc(proj) + '">' +
      '<div class="proj-head"><span class="chev">▾</span>' + esc(proj) + ' <span class="n">' + list.length + '</span>' +
      '<span class="proj-new" title="' + esc(L.newTitle || '') + '" data-newproj="' + esc(proj) + '">' + esc(L.newHere || '+') + '</span>' +
      (list.some((c) => c.status === 'running') ? '<span class="badge running">' + esc(L.running) + '</span>' : '') +
      '</div><div class="conv-list">';
    for (const c of list) {
      const badge = c.status === 'running'
        ? '<span class="badge running"><span class="spin"></span>' + esc(c.statusNote || L.running) + '</span>'
        : '<span class="badge">' + esc(c.engine) + '</span>';
      html += '<div class="conv" data-id="' + c.id + '">' +
        '<div class="row1"><div class="title">' + esc(c.title) + '</div>' + badge + '</div>' +
        (c.preview ? '<div class="preview">' + esc(c.preview) + '</div>' : '') +
        '<div class="meta">' + c.turnCount + ' · ' + fmtTs(c.updatedAt) + '</div>' +
        '</div>';
    }
    html += '</div></div>';
  }
  el.innerHTML = html;
  el.querySelectorAll('.proj-head').forEach((n) => {
    n.onclick = () => {
      const proj = n.parentElement.dataset.proj;
      if (collapsed.has(proj)) collapsed.delete(proj); else collapsed.add(proj);
      renderProjects();
    };
  });
  // 项目组头「+」:在该项目的 cwd 下新建会话(修前「+ 新对话」只能落 homedir=未分类)。
  el.querySelectorAll('[data-newproj]').forEach((n) => {
    n.onclick = async (ev) => {
      ev.stopPropagation(); // 别触发折叠
      const proj = n.dataset.newproj;
      const src = convs.find((c) => c.project === proj && c.cwd);
      try {
        const j = await api('/api/new', { cwd: src ? src.cwd : '' });
        await refresh();
        openConv(j.convId);
      } catch (e) { alert('error: ' + e.message); }
    };
  });
  el.querySelectorAll('.conv').forEach((n) => {
    n.onclick = () => openConv(n.dataset.id);
  });
}

async function openConv(id) {
  openId = id;
  searchMode = false;
  document.getElementById('q').value = '';
  document.getElementById('back').style.display = '';
  document.getElementById('back-t').textContent = L.back;
  document.getElementById('composer').classList.add('show');
  const el = document.getElementById('list');
  el.innerHTML = '<div class="empty"><span class="spin"></span>' + esc(L.loadTurns) + '</div>';
  await refreshDetail();
  window.scrollTo(0, document.body.scrollHeight);
}

async function refreshDetail() {
  if (!openId) return;
  try {
    const det = await api('/api/state?conv=' + encodeURIComponent(openId));
    const c = convs.find((x) => x.id === openId);
    renderDetail(det.turns || [], c);
  } catch (e) { /* keep */ }
}

function renderDetail(turns, c) {
  if (!openId) return;
  const el = document.getElementById('list');
  const head = c ? '<div class="conv active" style="margin-bottom:12px"><div class="row1"><div class="title">' + esc(c.title) + '</div>' +
    '<span class="badge" title="' + esc(c.cwd || '') + '">' + esc(c.project || '') + '</span>' +
    (c.status === 'running' ? '<span class="badge running"><span class="spin"></span>' + esc(c.statusNote || L.running) + '</span>' +
      '<button class="btn" data-cancel="1">' + esc(L.cancel) + '</button>' : '') + '</div></div>' : '';
  if (!turns.length) { el.innerHTML = head + '<div class="empty">' + esc(L.noTurns) + '</div>'; return; }
  el.innerHTML = head + turns.map((t) =>
    '<div class="turn">' +
      '<div class="q">🧑 ' + esc(t.prompt) + '</div>' +
      stepsHtml(t.steps) +
      (t.answer ? '<div class="a' + (t.done ? '' : ' running') + '">' + esc(t.answer) + '</div>' : (t.done ? '' : '<div class="a running"></div>')) +
      (t.error ? '<div class="err">⚠ ' + esc(t.error) + '</div>' : '') +
    '</div>'
  ).join('');
  const stop = el.querySelector('[data-cancel]');
  if (stop) stop.onclick = () => api('/api/cancel', { convId: openId }).then(() => refresh());
}

// 工具轨迹行:✓/⏳/✗ + 工具名 + 结果摘要(等宽小字)。无轨迹返回空串。
function stepsHtml(steps) {
  if (!steps || !steps.length) return '';
  return '<div class="steps">' + steps.map((s) => {
    const cls = s.pending ? 'run' : (s.outcome === 'error' ? 'bad' : 'ok');
    const ms = s.durationMs ? '<span class="ms">' + (s.durationMs > 999 ? (s.durationMs / 1000).toFixed(1) + 's' : s.durationMs + 'ms') + '</span>' : '';
    return '<div class="step ' + cls + '"><b>' + esc(s.name) + '</b>' + ms +
      (s.result ? '<br>' + esc(s.result) : '') + '</div>';
  }).join('') + '</div>';
}

function backToList() {
  openId = null;
  searchMode = false;
  document.getElementById('back').style.display = 'none';
  document.getElementById('composer').classList.remove('show');
  document.getElementById('q').value = '';
  renderProjects();
  refresh();
}
document.getElementById('back').onclick = backToList;

// ── 搜索:防抖 350ms;会话(标题/cwd/项目)+ 内容(FTS5)两组结果 ──
const qEl = document.getElementById('q');
qEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 350);
});

async function doSearch() {
  const q = qEl.value.trim();
  if (openId) { openId = null; document.getElementById('back').style.display = 'none'; document.getElementById('composer').classList.remove('show'); }
  if (!q) { searchMode = false; renderProjects(); return; }
  searchMode = true;
  const el = document.getElementById('list');
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    let html = '';
    if (r.convs.length) {
      html += '<div class="sec-title">' + esc(L.secConv) + '</div>' + r.convs.map((c) =>
        '<div class="conv" data-id="' + c.id + '"><div class="row1"><div class="title">' + esc(c.title) + '</div><span class="badge">' + esc(c.project) + '</span></div><div class="meta">' + fmtTs(c.updatedAt) + '</div></div>'
      ).join('');
    }
    if (r.msgs.length) {
      html += '<div class="sec-title">' + esc(L.secMsg) + '</div>' + r.msgs.map((m, i) =>
        '<div class="msg" data-i="' + i + '"><div class="role">' + (m.role === 'user' ? '🧑' : '🤖') + ' ' + esc(m.role) + '</div><div class="content">' + esc(m.content) + '</div>' +
        (m.convId ? '<div class="from">→ ' + esc(m.convTitle || '') + '</div>' : '') + '</div>'
      ).join('');
    }
    el.innerHTML = html || '<div class="empty">' + esc(L.searchEmpty) + '</div>';
    el.querySelectorAll('.conv').forEach((n) => { n.onclick = () => openConv(n.dataset.id); });
    el.querySelectorAll('.msg').forEach((n) => {
      const m = r.msgs[Number(n.dataset.i)];
      n.onclick = () => { if (m.convId) openConv(m.convId); };
    });
  } catch (e) { /* keep */ }
}

// ── 新对话 ──
document.getElementById('new').onclick = async () => {
  try {
    const j = await api('/api/new', {});
    await refresh();
    openConv(j.convId);
    document.getElementById('input').focus();
  } catch (e) { alert('error: ' + e.message); }
};

// ── 发送(fire-and-forget:发出即回执,不等整轮答案;进度靠轮询)──
document.getElementById('send').onclick = doSend;
document.getElementById('input').addEventListener('keydown', (e) => {
  // 手机软键盘没有 Ctrl/Cmd:Enter 直发,换行靠 textarea 自带「换行」键之外的场景。
  // 桌面习惯(⌘+Enter)保留兼容;Shift+Enter 换行。
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
});

// 乐观气泡:发送瞬间在详情底部插一条 prompt turn(done=false),
// 下一次 refreshDetail 会用真实 turn 覆盖 innerHTML —— 若主进程把消息 park 进
// goal 修正队列,真实 ack turn 会接替乐观气泡,语义自然收敛。
let optTurn = null;
function renderOptimistic(text) {
  if (!openId) return;
  const el = document.getElementById('list');
  const div = document.createElement('div');
  div.className = 'turn';
  div.id = 'opt';
  div.innerHTML = '<div class="q">🧑 ' + esc(text) + '</div>' +
    '<div class="a running" id="opt-a"></div>' +
    '<div class="meta" id="opt-note">' + esc(L.queued) + '</div>';
  el.appendChild(div);
  window.scrollTo(0, document.body.scrollHeight);
}
function clearOptimistic() { const n = document.getElementById('opt'); if (n) n.remove(); }

async function doSend() {
  const inp = document.getElementById('input');
  const text = inp.value.trim();
  if (!text) return;
  if (!openId) {
    const j = await api('/api/new', {}).catch(() => null);
    if (!j) return;
    openId = j.convId;
    document.getElementById('composer').classList.add('show');
  }
  inp.value = '';
  renderOptimistic(text);
  try {
    await api('/api/send', { convId: openId, text });
    // 200 即已入列;立即拉一次详情接住 ack/running turn,不等下个轮询节拍。
    pollFast = true;
    setTimeout(() => { pollFast = false; }, 12000);
    await refreshDetail();
  } catch (e) {
    // 失败回填:把文本放回输入框,乐观气泡撤掉,内容不丢。
    clearOptimistic();
    inp.value = text;
    alert('error: ' + e.message);
  }
  await refresh();
}

// 轮询:详情 2.5s / 列表 5s / 发送后短促 1.5s;页面隐藏时暂停(省电,回来自动刷新)。
function loop() {
  const step = openId ? refreshDetail() : Promise.resolve();
  Promise.allSettled([refresh(), step]).finally(() => {
    clearTimeout(timer);
    const idle = document.hidden;
    const gap = openId ? (pollFast ? 1500 : 2500) : 5000;
    timer = setTimeout(loop, idle ? Math.max(gap, 15000) : gap);
  });
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { clearTimeout(timer); loop(); } // 回到页面立即刷新,不等节拍
});
loop();
</script>
</body>
</html>`;
}

export const webCompanionServer = new WebCompanionServer();
