// ── 版本更新检查(GitHub Releases)──
// 设计要点:
// - 单一来源 api.github.com/releases/latest,8s 超时,失败不重试(用户网络对 GitHub 不稳定,快速失败 + 可手动重试)。
// - 结果缓存 userData/update-check.json,24h 内静默检查直接吃缓存,不打 API。
// - 手动点「检查更新」强制走网络(force=true)。
// - 启动后 8s 静默检查一次,发现新版本推 'update-available' → renderer toast,不打扰主流程。
import { app, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isNewerVersion } from '../shared/version';
import type { UpdateInfo } from '../shared/version';

const REPO_API = 'https://api.github.com/repos/phinn/KinetAios/releases/latest';
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 静默检查节流:24h
const FETCH_TIMEOUT = 8_000;

interface CacheShape {
  checkedAt: number;
  latest: string | null;
  url: string | null;
  notes: string | null;
}

function cachePath(): string {
  return path.join(app.getPath('userData'), 'update-check.json');
}

async function readCache(): Promise<CacheShape | null> {
  try {
    const raw = await readFile(cachePath(), 'utf8');
    const c = JSON.parse(raw) as CacheShape;
    return typeof c.checkedAt === 'number' ? c : null;
  } catch {
    return null;
  }
}

async function writeCache(c: CacheShape): Promise<void> {
  try {
    await writeFile(cachePath(), JSON.stringify(c), 'utf8');
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

/** 拉远端最新 release。失败抛错(调用方转成 error 字段)。 */
async function fetchLatestRelease(): Promise<{ tag: string; url: string; notes: string | null }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(REPO_API, {
      signal: ac.signal,
      headers: { 'User-Agent': 'KinetAios-Update-Check', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { tag_name?: string; html_url?: string; body?: string; draft?: boolean; prerelease?: boolean };
    if (!j.tag_name) throw new Error('no tag_name');
    return {
      tag: j.tag_name,
      url: j.html_url || 'https://github.com/phinn/KinetAios/releases',
      notes: j.body ? j.body.slice(0, 600) : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检查更新。force=false 时:24h 内有缓存 → 直接用缓存(不发网络)。
 * 返回的 info 永远 resolved(错误放 error 字段),renderer 不用 try/catch。
 */
export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  const current = app.getVersion();
  const base: UpdateInfo = { current, latest: null, hasUpdate: false, url: null, notes: null, checkedAt: Date.now(), fromCache: false, error: null };

  if (!force) {
    const cache = await readCache();
    if (cache && Date.now() - cache.checkedAt < CACHE_MAX_AGE) {
      return {
        ...base,
        latest: cache.latest,
        url: cache.url,
        notes: cache.notes,
        hasUpdate: cache.latest ? isNewerVersion(cache.latest, current) : false,
        checkedAt: cache.checkedAt,
        fromCache: true,
      };
    }
  }

  try {
    const rel = await fetchLatestRelease();
    await writeCache({ checkedAt: Date.now(), latest: rel.tag, url: rel.url, notes: rel.notes });
    return { ...base, latest: rel.tag, url: rel.url, notes: rel.notes, hasUpdate: isNewerVersion(rel.tag, current) };
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError' ? '检查超时(GitHub 连接不稳定)' : `检查失败:${e instanceof Error ? e.message : String(e)}`;
    return { ...base, error: msg };
  }
}

/**
 * 注册 IPC + 启动静默检查。
 * getWin: 取主窗口(可能未创建/已销毁),发现新版本时推 'update-available'。
 */
export function registerUpdateIpc(getWin: () => BrowserWindow | null): void {
  ipcMain.handle('check-update', (_e, force?: boolean) => checkForUpdate(!!force));
  ipcMain.handle('app-version', () => app.getVersion());

  // 启动静默检查:延迟 8s(避开启动网络风暴),只在真有新版本时打扰用户。
  setTimeout(async () => {
    const info = await checkForUpdate(false);
    if (info.hasUpdate && !info.fromCache) {
      // 缓存命中说明 24h 内已经提醒过路径上的某次检查,不再重复推;只有新检查出更新才推。
      getWin()?.webContents?.send?.('update-available', info);
    }
  }, 8_000).unref?.();
}
