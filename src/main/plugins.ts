// Plugin SDK v1: 用户把插件目录丢进 <userData>/plugins/<name>/,本 loader 扫一遍加载。
// ponytail: 工具扩展(Tool[])优先 —— Engine 注册要实现完整 AgentEvent 流式契约,SDK v1 留白。
// 信任模型:同 VSCode 扩展,用户自己装的本地代码 = 完全信任;无沙箱(沙箱会卡死 sync API)。
// 热重载:不做了,改完插件重启 app。后续要的话加个 watch + invalidate cache。
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { Tool } from './tools';

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  tools: Tool[]; // 该插件贡献的工具(可能为空)
  error?: string; // 加载失败时填上,UI 显示红色
}

let cache: LoadedPlugin[] | null = null;

// ponytail: 同步加载 + 进程级缓存。require() 自带 require.cache,二次调用零成本。
// 失败兜底:任一插件炸了不影响其它,记到 error 字段让 UI 露出来。
export function loadPlugins(): LoadedPlugin[] {
  if (cache) return cache;
  const root = path.join(app.getPath('userData'), 'plugins');
  const out: LoadedPlugin[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch {
    /* 目录不存在 = 没装插件,正常路径 */
    cache = [];
    return cache;
  }
  for (const dir of dirs) {
    const manifestPath = path.join(dir, 'plugin.json');
    const entryPath = path.join(dir, 'index.js');
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw) as PluginManifest;
      if (!manifest.name || !manifest.version) {
        out.push({ manifest: { name: path.basename(dir), version: '0' }, dir, tools: [], error: 'plugin.json 缺 name/version' });
        continue;
      }
      // 清 require.cache 让用户改完 index.js 重启后能拿到新代码(开发回路)。
      delete require.cache[require.resolve(entryPath)];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(entryPath) as { tools?: Tool[] };
      const tools = Array.isArray(mod.tools) ? mod.tools : [];
      out.push({ manifest, dir, tools });
    } catch (e) {
      out.push({
        manifest: { name: path.basename(dir), version: '0' },
        dir,
        tools: [],
        error: (e as Error)?.message ?? String(e),
      });
    }
  }
  cache = out;
  return out;
}

// 给 allTools() 用:把所有插件的工具摊平返回。无插件 = 空数组。
export function pluginTools(): Tool[] {
  return loadPlugins().flatMap((p) => p.tools);
}

// 给 UI 用:IPC handler 调这个,不暴露 require 路径等内部。
export function pluginListSnap(): Array<{ name: string; version: string; description?: string; author?: string; toolCount: number; error?: string; dir: string }> {
  return loadPlugins().map((p) => ({
    name: p.manifest.name,
    version: p.manifest.version,
    description: p.manifest.description,
    author: p.manifest.author,
    toolCount: p.tools.length,
    error: p.error,
    dir: p.dir,
  }));
}

// 强制重载(开发回路 / 设置页刷新按钮)。下次 loadPlugins() 会重新扫。
export function invalidatePluginCache(): void {
  cache = null;
}
