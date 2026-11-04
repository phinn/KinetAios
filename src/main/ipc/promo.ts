// 推广 PR/渠道状态追踪 IPC — promo dashboard 数据层
// Promo dashboard: track upstream PR / issue / directory-site status, refreshable on demand.
// 数据存 userData/promo-items.json(运行时可增删);仓库不带任何种子/真实推广数据,
// 条目通过「导入 JSON」进入(export/import 为对称 JSON,文件本身即个人数据,可自行备份)。
import { app, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

// ── 类型 ── Types (与 shared/types.ts PromoItem 同构,shared 侧为 pure 契约) ──
type PromoKind = 'pr' | 'issue' | 'discourse' | 'url' | 'manual';
interface PromoItem {
  id: string;
  name: string;
  url: string;
  kind: PromoKind;
  group?: string;
  note?: string;
  addedAt: string;
  status?: string;
  title?: string;
  updatedAt?: string;
  checkedAt?: string;
  detail?: string;
}


// ── 存储 ── Persistence (userData/promo-items.json) ──
function promoFile(): string {
  return path.join(app.getPath('userData'), 'promo-items.json');
}
let cache: PromoItem[] | null = null;

function loadItems(): PromoItem[] {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(promoFile(), 'utf8');
    cache = JSON.parse(raw) as PromoItem[];
  } catch {
    // 无种子:空表起步,数据经「导入 JSON」进入(隐私设计:真实推广数据不进开源仓库)
    cache = [];
  }
  return cache;
}
function saveItems(): void {
  try {
    fs.writeFileSync(promoFile(), JSON.stringify(cache ?? [], null, 2));
  } catch { /* 写失败下次重读,不致命 */ }
}

// ── URL → id slug ──
function slugOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return url.toLowerCase().slice(0, 80);
  }
}

// ── GitHub token(走 git credential fill,跨平台;失败降级匿名) ──
// Token via `git credential fill` (osxkeychain/manager-core 均可),cached;null = anonymous.
let ghToken: string | null | undefined;
function getGhToken(): Promise<string | null> {
  if (ghToken !== undefined) return Promise.resolve(ghToken);
  return new Promise((resolve) => {
    try {
      const p = spawn('git', ['credential', 'fill'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { p.kill(); }, 5000);
      p.stdout.on('data', (d) => { out += String(d); });
      p.on('close', () => {
        clearTimeout(timer);
        const m = out.match(/^password=(.+)$/m);
        ghToken = m ? m[1].trim() : null;
        resolve(ghToken);
      });
      p.on('error', () => { clearTimeout(timer); ghToken = null; resolve(null); });
      p.stdin.write('protocol=https\nhost=github.com\n\n');
      p.stdin.end();
    } catch {
      ghToken = null;
      resolve(null);
    }
  });
}

// ── 单条刷新 ── Refresh one item ──
async function fetchText(url: string, headers: Record<string, string> = {}, ms = 12000): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(ms), redirect: 'follow' });
  const body = await res.text();
  return { status: res.status, body };
}

async function refreshOne(it: PromoItem): Promise<void> {
  const checkedAt = new Date().toISOString();
  try {
    if (it.kind === 'manual') {
      it.status = it.status || 'manual';
      it.checkedAt = checkedAt;
      return;
    }
    if (it.kind === 'pr' || it.kind === 'issue') {
      // github.com/owner/repo/(pull|issues)/N → api repos/owner/repo/(pulls|issues)/N
      const m = it.url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/);
      if (!m) { it.status = 'unknown'; it.detail = 'URL 无法解析 GitHub PR/issue'; it.checkedAt = checkedAt; return; }
      const apiPath = `repos/${m[1]}/${m[2]}/${it.kind === 'pr' ? 'pulls' : 'issues'}/${m[3]}`;
      const token = await getGhToken();
      const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'KinetAios-promo' };
      if (token) headers['Authorization'] = `token ${token}`;
      const { status, body } = await fetchText(`https://api.github.com/${apiPath}`, headers);
      if (status === 404) { it.status = 'closed'; it.detail = '404(被删或转存)'; it.checkedAt = checkedAt; return; }
      if (status === 403) { it.status = it.status || 'unknown'; it.detail = 'API 限流,保留上次状态'; it.checkedAt = checkedAt; return; }
      if (status !== 200) { it.status = it.status || 'unknown'; it.detail = `HTTP ${status}`; it.checkedAt = checkedAt; return; }
      const d = JSON.parse(body) as {
        state?: string; merged?: boolean; merged_at?: string | null; closed_at?: string | null;
        title?: string; updated_at?: string; comments?: number; pull_request?: unknown;
      };
      it.title = d.title || it.title;
      it.updatedAt = d.updated_at || it.updatedAt;
      if (it.kind === 'pr') {
        it.status = d.merged ? 'merged' : d.state === 'open' ? 'open' : 'closed';
        it.detail = d.merged
          ? `merged ${String(d.merged_at || '').slice(0, 10)}`
          : d.state === 'open'
            ? `open · 💬${d.comments ?? 0} · 动态 ${String(d.updated_at || '').slice(0, 10)}`
            : `closed ${String(d.closed_at || '').slice(0, 10)}`;
      } else {
        it.status = d.state === 'open' ? 'open' : 'closed';
        it.detail = `${d.state === 'open' ? 'open' : 'closed'} · 💬${d.comments ?? 0} · 动态 ${String(d.updated_at || '').slice(0, 10)}`;
      }
      it.checkedAt = checkedAt;
      return;
    }
    if (it.kind === 'discourse') {
      // Discourse topic JSON:可见→200;staff 审核中→匿名 403/404
      const { status, body } = await fetchText(`${it.url.replace(/\/+$/, '')}.json`);
      if (status === 200) {
        try {
          const d = JSON.parse(body) as { title?: string; posts_count?: number; last_posted_at?: string };
          it.status = 'live';
          it.title = d.title || it.title;
          // 注意:URL 指向的若非自荐帖本体(如模板帖),标题会显形 — 一眼可辨
          it.detail = `已可见「${String(d.title || '').slice(0, 24)}」📝${d.posts_count ?? '?'}楼 · 最后 ${String(d.last_posted_at || '').slice(0, 10)}`;
        } catch { it.status = 'live'; it.detail = '已可见(解析降级)'; }
      } else if (status === 403 || status === 404) {
        it.status = 'review';
        it.detail = '匿名不可见 = 仍在 staff 审核队列(勿重投)';
      } else {
        it.status = it.status || 'unknown'; it.detail = `HTTP ${status}`;
      }
      it.checkedAt = checkedAt;
      return;
    }
    // url:目录站存活检查(HEAD 405 时降级 GET)
    try {
      let st = 0;
      try {
        const r = await fetch(it.url, { method: 'HEAD', signal: AbortSignal.timeout(12000), redirect: 'follow' });
        st = r.status;
      } catch { st = 0; }
      if (st === 405 || st === 403 || st === 0) {
        const r2 = await fetchText(it.url, {}, 15000);
        st = r2.status;
      }
      it.status = st >= 200 && st < 400 ? 'live' : `http-${st}`;
      it.detail = st >= 200 && st < 400 ? `在线 HTTP ${st}` : `HTTP ${st}`;
    } catch (e) {
      it.status = it.status || 'unknown';
      it.detail = '网络失败: ' + String(e).slice(0, 80);
    }
    it.checkedAt = checkedAt;
  } catch (e) {
    it.status = it.status || 'unknown';
    it.detail = '刷新失败: ' + String(e).slice(0, 80);
    it.checkedAt = checkedAt;
  }
}

// ── 仓库 stars(Homebrew 门槛上下文) ──
async function fetchRepoStars(): Promise<number | null> {
  const token = await getGhToken();
  const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'KinetAios-promo' };
  if (token) headers['Authorization'] = `token ${token}`;
  try {
    const { status, body } = await fetchText('https://api.github.com/repos/phinn/KinetAios', headers);
    if (status !== 200) return null;
    const d = JSON.parse(body) as { stargazers_count?: number };
    return d.stargazers_count ?? null;
  } catch { return null; }
}

// ── IPC 注册 ── Register channels ──
export function register(): void {
  ipcMain.handle('promo-list', () => {
    return { ok: true, items: loadItems() };
  });

  ipcMain.handle('promo-refresh', async () => {
    const items = loadItems();
    // 并发 6,避免触发限流;GitHub 匿名 60/h,带 token 5000/h
    const queue = items.filter((i) => i.kind !== 'manual');
    let idx = 0;
    const worker = async () => {
      while (idx < queue.length) {
        const it = queue[idx++];
        await refreshOne(it);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    saveItems();
    const stars = await fetchRepoStars();
    return { ok: true, items, stars };
  });

  ipcMain.handle('promo-add', (_e, input: { url?: string; name?: string; note?: string; group?: string }) => {
    const url = String(input?.url || '').trim();
    if (!url) return { ok: false, error: 'url 必填' };
    let kind: PromoKind = 'url';
    let derivedName = '';
    if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) kind = 'pr';
    else if (/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(url)) kind = 'issue';
    else if (/\/t\/\d+/.test(url)) kind = 'discourse'; // 通用 Discourse topic URL(任意实例)
    const items = loadItems();
    const id = slugOf(url);
    if (items.some((i) => i.id === id)) return { ok: false, error: '该链接已在列表中' };
    if (!derivedName) {
      const m = url.match(/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/);
      derivedName = m ? `${m[1]} #${m[2]}` : (() => { try { return new URL(url).host; } catch { return url; } })();
    }
    const item: PromoItem = {
      id, url, kind,
      name: String(input?.name || '').trim() || derivedName,
      group: String(input?.group || '').trim() || 'open-active',
      note: String(input?.note || '').trim() || undefined,
      addedAt: new Date().toISOString(),
    };
    items.unshift(item);
    cache = items;
    saveItems();
    // 立即刷这一条,用户马上能看到状态
    void refreshOne(item).then(() => saveItems());
    return { ok: true, items };
  });

  ipcMain.handle('promo-remove', (_e, id: string) => {
    const items = loadItems();
    const next = items.filter((i) => i.id !== String(id));
    if (next.length === items.length) return { ok: false, error: '未找到该条目' };
    cache = next;
    saveItems();
    return { ok: true, items: next };
  });

  // 导入条目 JSON(整体替换,格式 = export 原样;用于把个人数据带进新环境/换机)
  ipcMain.handle('promo-import', (_e, payload: unknown) => {
    try {
      const arr = JSON.parse(typeof payload === 'string' ? payload : JSON.stringify(payload));
      if (!Array.isArray(arr)) return { ok: false, error: '格式错误:应为条目数组' };
      const seen = new Set<string>();
      const next: PromoItem[] = [];
      for (const raw of arr) {
        const it = raw as PromoItem;
        if (!it || typeof it.url !== 'string' || !it.url) continue;
        const id = typeof it.id === 'string' && it.id ? it.id : slugOf(it.url);
        if (seen.has(id)) continue;
        seen.add(id);
        next.push({ ...it, id });
      }
      cache = next;
      saveItems();
      return { ok: true, items: next };
    } catch (err) {
      return { ok: false, error: `解析失败:${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // 导出全部条目(JSON 字符串;文件本身即个人数据,存哪由用户定)
  ipcMain.handle('promo-export', () => {
    return { ok: true, json: JSON.stringify(loadItems(), null, 2) };
  });
}
