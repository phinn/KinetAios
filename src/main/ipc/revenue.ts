// 收入渠道追踪 IPC — revenue dashboard 数据层
// Revenue dashboard: track income sources (ASC sales, freelance platforms, digital goods).
// 数据存 userData/revenue-items.json(运行时可增删);仓库不带任何种子/真实收入数据,
// 条目通过导入/导出 JSON 在环境间迁移。收入数字是隐私数据,绝不进 git。
// Revenue data lives only in userData/revenue-items.json; repo carries zero seed data.
// Items move between environments via symmetric JSON import/export (same discipline as promo).
import { ipcMain, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { RevenueItem } from '../../shared/types';

let cache: RevenueItem[] | null = null;

function revenueFile(): string {
  return path.join(app.getPath('userData'), 'revenue-items.json');
}

function loadItems(): RevenueItem[] {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(revenueFile(), 'utf-8'));
    if (Array.isArray(raw)) {
      cache = raw as RevenueItem[];
      return cache;
    }
  } catch {
    /* 首次无文件 → 空列表 First run: no file yet */
  }
  cache = [];
  return cache;
}

function saveItems(): void {
  try {
    fs.writeFileSync(revenueFile(), JSON.stringify(cache ?? [], null, 2));
  } catch {
    /* 写失败下次重读,不致命 Write failure is non-fatal; cache stays consistent */
  }
}

export function register(): void {
  ipcMain.handle('revenue-list', () => loadItems());

  ipcMain.handle(
    'revenue-add',
    (_e, input: { name?: string; kind?: string; note?: string; metrics?: Record<string, unknown> }) => {
      const items = loadItems();
      const name = String(input?.name || '').trim();
      if (!name) return { ok: false, error: '名称必填' };
      const id = 'rv-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const item: RevenueItem = {
        id,
        name,
        kind: (String(input?.kind || 'manual') || 'manual') as RevenueItem['kind'],
        metrics: (input?.metrics && typeof input.metrics === 'object' ? input.metrics : {}) as RevenueItem['metrics'],
        note: String(input?.note || '').trim() || undefined,
        addedAt: new Date().toISOString(),
      };
      items.unshift(item);
      cache = items;
      saveItems();
      return { ok: true, items };
    },
  );

  ipcMain.handle('revenue-remove', (_e, id: string) => {
    const items = loadItems();
    const next = items.filter((i) => i.id !== String(id));
    if (next.length === items.length) return { ok: false, error: '未找到该条目' };
    cache = next;
    saveItems();
    return { ok: true, items: next };
  });

  // 快捷改数:深合并 metrics —— 传入的 key 覆盖,null/空串=删除该 key,未提及的保留。
  // Quick metrics patch: shallow per-key merge, null/'' deletes the key, untouched keys survive.
  // 盖 checkedAt 作为「最近核对时间」(汇总卡显示)。
  ipcMain.handle('revenue-metrics', (_e, input: { id: string; metrics: Record<string, unknown> }) => {
    const items = loadItems();
    const it = items.find((i) => i.id === String(input?.id));
    if (!it) return { ok: false, error: '未找到该条目' };
    const patch = input?.metrics;
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'metrics 必须是对象' };
    const merged: Record<string, unknown> = { ...((it.metrics as Record<string, unknown>) ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '') delete merged[k];
      else merged[k] = v;
    }
    it.metrics = merged as RevenueItem['metrics'];
    it.checkedAt = new Date().toISOString();
    cache = items;
    saveItems();
    return { ok: true, items };
  });

  // 导入条目 JSON(整体替换,格式 = export 原样;用于把个人数据带进新环境/换机)
  ipcMain.handle('revenue-import', (_e, payload: unknown) => {
    try {
      const arr = JSON.parse(typeof payload === 'string' ? payload : JSON.stringify(payload));
      if (!Array.isArray(arr)) return { ok: false, error: '格式错误:应为条目数组' };
      const seen = new Set<string>();
      const next: RevenueItem[] = [];
      for (const raw of arr) {
        const it = raw as RevenueItem;
        if (!it || typeof it.name !== 'string' || !it.name) continue;
        const id =
          typeof it.id === 'string' && it.id
            ? it.id
            : 'rv-' + Math.random().toString(36).slice(2, 10);
        if (seen.has(id)) continue;
        seen.add(id);
        next.push({
          ...it,
          id,
          metrics: (it.metrics && typeof it.metrics === 'object' ? it.metrics : {}) as RevenueItem['metrics'],
        });
      }
      cache = next;
      saveItems();
      return { ok: true, items: next };
    } catch (err) {
      return { ok: false, error: `解析失败:${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // 导出全部条目(JSON 字符串;文件本身即隐私数据,存哪由用户定)
  ipcMain.handle('revenue-export', () => {
    return { ok: true, json: JSON.stringify(loadItems(), null, 2) };
  });
}
