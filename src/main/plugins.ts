// Plugin SDK v2: 用户把插件目录丢进 <userData>/plugins/<name>/, 本 loader 扫一遍加载。
// ponytail: 工具扩展(Tool[])优先 —— Engine 注册要实现完整 AgentEvent 流式契约, SDK v2 留白。
// 信任模型: 同 VSCode 扩展, 用户自己装的本地代码 = 完全信任; 无沙箱(沙箱会卡死 sync API)。
// 热重载: 不做了, 改完插件重启 app。后续要的话加个 watch + invalidate cache。
// v2 新增: slashCommands / systemPrompt / hooks 贡献点 + 分类/图标/权限/引擎范围元数据。
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { Tool } from './tools';
import type { SkillInfo, EngineKind } from '../shared/types';
import { getSettings, saveSettings } from './settings';

// ── v2 类型 ──────────────────────────────────────────────

export type PluginCategory = 'office' | 'dev' | 'media' | 'data' | 'system' | 'misc';

export interface PluginManifest {
  // v1 必填
  name: string;
  version: string;
  description?: string;
  author?: string;
  // v2 新增: 元数据
  category?: PluginCategory;
  icon?: string; // 相对路径, 指向插件目录内的 SVG 文件
  homepage?: string;
  license?: string;
  // v2 新增: 引擎范围(默认 ["direct"])
  engines?: EngineKind[];
  // v2 新增: 权限声明(告知性质, 不做运行时拦截)
  permissions?: string[];
  // v2 新增: 贡献点
  tools?: string; // entryPath#exportName, 默认 "index.js#tools"
  slashCommands?: string; // 目录路径(相对插件目录), 其下 *.md 成为 slash 命令
  systemPrompt?: string; // 文件路径(相对插件目录), 内容追加到 system prompt
  hooks?: string; // entryPath#exportName, v2 仅支持 onActivate
  // v2.1 新增: 渲染层扩展 —— 声明一个 panel.html, renderer 注入为独立全屏视图。
  // panel.html 内可用 <script> 操作 DOM, 通过 window.kinet (preload) 与 main 进程通信。
  panel?: string; // HTML 文件路径(相对插件目录)
  panelTitle?: string; // panel 在侧栏菜单中显示的标题
  panelIcon?: string; // panel 在侧栏菜单中的 SVG 图标文件路径
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  tools: Tool[];
  slashCommands: SkillInfo[]; // v2 新增
  systemPromptText?: string; // v2 新增: 已读入的 prompt 文本
  panelHtml?: string; // v2.1 新增: 已读入的 panel HTML
  error?: string;
}

// hooks 存储不序列化到 snap —— 函数不能走 IPC。
interface PluginHooksStore {
  onActivate?: (ctx: PluginContext) => void;
}
const hooksMap = new Map<string, PluginHooksStore>();

export interface PluginContext {
  pluginDir: string;
  userData: string;
  log(msg: string): void;
}

let cache: LoadedPlugin[] | null = null;

// ── 工具函数 ──────────────────────────────────────────────

// 解析 "file.js#exportName" 语法: 分割文件名和导出名, require 后取对应属性。
// 无 # → 返回整个 module(v1 行为)。
function resolveExport(entrySpec: string, dir: string): unknown {
  const [file, exportName] = entrySpec.split('#');
  const fullPath = path.join(dir, file);
  // 清 require.cache 让用户改完重启后拿到新代码(开发回路)。
  delete require.cache[require.resolve(fullPath)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(fullPath);
  return exportName ? mod[exportName] : mod;
}

// 扫描插件目录下的 *.md 作为 slash 命令, 复用 skills.ts 的 frontmatter 解析格式。
function scanSlashCommands(cmdDir: string, pluginName: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(cmdDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of ents) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    try {
      const content = fs.readFileSync(path.join(cmdDir, ent.name), 'utf8');
      const parsed = parseFrontmatter(content, ent.name.replace(/\.md$/, ''));
      out.push({
        name: parsed.name,
        description: parsed.description,
        source: 'plugin',
        type: 'command',
      });
    } catch {
      /* 跳过读不了的 */
    }
  }
  // 记到 pluginName 前缀避免与 ~/.claude/skills 同名冲突(skills.ts 先到先得)
  void pluginName;
  return out;
}

// 解析 frontmatter(name + description); body = 闭合 --- 后的全部。
// 与 skills.ts 的 parseSkill 逻辑一致, 这里独立一份避免循环依赖。
function parseFrontmatter(content: string, fallbackName: string): { name: string; description: string; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { name: fallbackName, description: '', body: content };
  const fm = m[1];
  const body = m[2];
  const line = (key: string): string | undefined => fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1];
  const clean = (s?: string): string => (s ? s.trim().replace(/^["']|["']$/g, '') : '');
  return { name: clean(line('name')) || fallbackName, description: clean(line('description')), body };
}

// 读取插件 slash 命令的完整 body(loadSkillBody 用)。返回 {body, dir} 或 null。
// 暴露给 skills.ts 调用。
export function loadPluginCommandBody(name: string): { body: string; dir: string } | null {
  for (const p of loadPlugins()) {
    const found = p.slashCommands.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (found) {
      // 从磁盘重新读 body(缓存只存了 SkillInfo, 不含 body)
      const cmdDir = p.manifest.slashCommands ? path.join(p.dir, p.manifest.slashCommands) : p.dir;
      const filePath = path.join(cmdDir, `${found.name}.md`);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = parseFrontmatter(content, found.name);
        return { body: parsed.body, dir: cmdDir };
      } catch {
        return { body: '', dir: cmdDir };
      }
    }
  }
  return null;
}

// ── 加载主流程 ──────────────────────────────────────────────

// ponytail: 同步加载 + 进程级缓存。require() 自带 require.cache, 二次调用零成本。
// 失败兜底: 任一插件炸了不影响其它, 记到 error 字段让 UI 露出来。
export function loadPlugins(): LoadedPlugin[] {
  if (cache) return cache;
  const root = path.join(app.getPath('userData'), 'plugins');
  const out: LoadedPlugin[] = [];
  let dirs: string[] = [];
  // 用户安装的插件 — User-installed plugins.
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch {
    /* 目录不存在 = 没装插件, 正常路径 */
  }
  // 开发模式: 同时扫描项目源码目录的 plugins/ — Dev mode: also scan source-tree plugins/.
  // 通过 app.isPackaged 判断: 打包后不扫源码目录。
  if (!app.isPackaged) {
    // __dirname 在 dist/main/ 下, 往上两级到项目根。
    const devRoot = path.resolve(__dirname, '..', '..', 'plugins');
    try {
      const devDirs = fs
        .readdirSync(devRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(devRoot, d.name));
      // 排除 examples/ 子目录本身(只取直接子目录), 并去重(用户安装的优先)
      const existing = new Set(dirs.map((d) => path.basename(d)));
      for (const dd of devDirs) {
        const base = path.basename(dd);
        if (base === 'examples') {
          // 扫描 examples/ 下的子目录 — scan subdirs of examples/.
          try {
            const exDirs = fs
              .readdirSync(dd, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => path.join(dd, d.name));
            for (const ed of exDirs) {
              const eb = path.basename(ed);
              if (!existing.has(eb)) dirs.push(ed);
            }
          } catch { /* examples/ 不存在 */ }
          continue;
        }
        if (!existing.has(base)) dirs.push(dd);
      }
    } catch {
      /* 源码 plugins/ 目录不存在, 跳过 */
    }
  }
  if (!dirs.length) {
    cache = [];
    return cache;
  }
  for (const dir of dirs) {
    const manifestPath = path.join(dir, 'plugin.json');
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw) as PluginManifest;
      if (!manifest.name || !manifest.version) {
        out.push({
          manifest: { name: path.basename(dir), version: '0' },
          dir,
          tools: [],
          slashCommands: [],
          error: 'plugin.json 缺 name/version',
        });
        continue;
      }

      // 1. 工具(v1 逻辑 + v2 entryPath#exportName 语法)
      const toolsEntry = manifest.tools ?? 'index.js#tools';
      let tools: Tool[] = [];
      try {
        const exported = resolveExport(toolsEntry, dir) as Record<string, unknown>;
        if (Array.isArray(exported)) {
          // entryPath 无 # → 可能直接是 Tool[](不太可能但兼容)
          tools = exported as Tool[];
        } else if (exported && typeof exported === 'object' && Array.isArray(exported.tools)) {
          // 标准: { tools: [...] }
          tools = exported.tools as Tool[];
        }
        // 如果都没有(如插件只贡献 slashCommands)→ tools 留空, 不报错
      } catch (toolErr) {
        // 工具加载失败不阻断整体 —— 可能插件只贡献 slashCommands / systemPrompt
        void toolErr;
      }

      // 2. Slash 命令(v2 新增)
      const slashCommands: SkillInfo[] = manifest.slashCommands
        ? scanSlashCommands(path.join(dir, manifest.slashCommands), manifest.name)
        : [];

      // 3. System prompt(v2 新增)
      let systemPromptText: string | undefined;
      if (manifest.systemPrompt) {
        try {
          systemPromptText = fs.readFileSync(path.join(dir, manifest.systemPrompt), 'utf8');
        } catch {
          /* 读不了 → 跳过 */
        }
      }

      // 3.5 Panel HTML(v2.1 新增 — 渲染层扩展)
      let panelHtml: string | undefined;
      if (manifest.panel) {
        try {
          panelHtml = fs.readFileSync(path.join(dir, manifest.panel), 'utf8');
        } catch {
          /* 读不了 → 跳过 */
        }
      }

      // 4. Hooks(v2 新增 — 仅 onActivate)
      if (manifest.hooks) {
        try {
          const hooks = resolveExport(manifest.hooks, dir) as PluginHooksStore | undefined;
          if (hooks && typeof hooks.onActivate === 'function') {
            hooksMap.set(manifest.name, { onActivate: hooks.onActivate });
            const ctx: PluginContext = {
              pluginDir: dir,
              userData: app.getPath('userData'),
              log: (msg: string) => console.log(`[plugin:${manifest.name}] ${msg}`),
            };
            try {
              hooks.onActivate(ctx);
            } catch (hookErr) {
              console.error(`[plugin:${manifest.name}] onActivate failed:`, hookErr);
            }
          }
        } catch {
          /* hooks 加载失败不阻断 */
        }
      }

      out.push({ manifest, dir, tools, slashCommands, systemPromptText, panelHtml });
    } catch (e) {
      out.push({
        manifest: { name: path.basename(dir), version: '0' },
        dir,
        tools: [],
        slashCommands: [],
        error: (e as Error)?.message ?? String(e),
      });
    }
  }
  cache = out;
  return cache;
}

// ── 导出: 工具 ──────────────────────────────────────────────

// 辅助: 判断插件是否被禁用(读 settings.disabledPlugins)。 — Helper: is plugin disabled?
function isPluginEnabled(name: string): boolean {
  try {
    const disabled = getSettings().disabledPlugins ?? [];
    return !disabled.includes(name);
  } catch {
    return true; // settings 读不了 → 默认启用(不阻断插件)
  }
}

// 给 allTools() 用: 把所有【已启用】插件的工具摊平返回。无插件 = 空数组。
export function pluginTools(): Tool[] {
  return loadPlugins().filter((p) => isPluginEnabled(p.manifest.name)).flatMap((p) => p.tools);
}

// ── 导出: System Prompt(v2 新增) ──────────────────────────────

// 给 engines.ts 用: 当前引擎的插件 system prompt 拼接。
// 遍历 engines 包含当前引擎且【已启用】的插件, 读取 systemPromptText, 用标题分隔拼接。
export function pluginSystemPrompts(engine: EngineKind): string {
  return loadPlugins()
    .filter((p) => isPluginEnabled(p.manifest.name))
    .filter((p) => !p.manifest.engines || p.manifest.engines.includes(engine))
    .filter((p) => p.systemPromptText?.trim())
    .map((p) => `\n\n# 插件扩展: ${p.manifest.name}\n${p.systemPromptText}`)
    .join('');
}

// ── 导出: Slash 命令(v2 新增) ──────────────────────────────

// 给 skills.ts 的 listSkills() 用: 【已启用】插件贡献的 slash 命令列表。
export function pluginSlashCommands(): SkillInfo[] {
  return loadPlugins()
    .filter((p) => isPluginEnabled(p.manifest.name))
    .flatMap((p) => p.slashCommands.map((s) => ({ ...s, source: 'plugin' as const })));
}

// ── 导出: IPC snap(v2 扩展) ──────────────────────────────

// 默认 SVG 图标(内联, 按分类着色)
const CATEGORY_COLORS: Record<PluginCategory, string> = {
  office: '#2d5a3d',
  dev: '#3b5998',
  media: '#8b3a62',
  data: '#5a4a2d',
  system: '#444444',
  misc: '#666666',
};

function defaultIconSvg(category: PluginCategory): string {
  const color = CATEGORY_COLORS[category] ?? '#666';
  const letter = category[0]?.toUpperCase() ?? 'P';
  return `<svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40" rx="8" fill="${color}"/><text x="20" y="27" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="white" text-anchor="middle">${letter}</text></svg>`;
}

// 给 UI 用: IPC handler 调这个, 不暴露 require 路径等内部。
export function pluginListSnap(): Array<{
  name: string;
  version: string;
  description?: string;
  author?: string;
  category: PluginCategory;
  icon?: string;
  permissions: string[];
  engines: EngineKind[];
  toolCount: number;
  slashCommandCount: number;
  tools: { name: string; description: string }[];
  slashCommands: { name: string; description: string }[];
  systemPrompt?: string;
  enabled: boolean;
  error?: string;
  dir: string;
}> {
  return loadPlugins().map((p) => {
    const cat = p.manifest.category ?? 'misc';
    // 读图标 SVG 内容(如果声明了)
    let iconSvg: string | undefined;
    if (p.manifest.icon) {
      try {
        iconSvg = fs.readFileSync(path.join(p.dir, p.manifest.icon), 'utf8');
      } catch {
        iconSvg = defaultIconSvg(cat);
      }
    } else {
      iconSvg = defaultIconSvg(cat);
    }
    return {
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      author: p.manifest.author,
      category: cat,
      icon: iconSvg,
      permissions: p.manifest.permissions ?? [],
      engines: p.manifest.engines ?? ['direct'],
      toolCount: p.tools.length,
      slashCommandCount: p.slashCommands.length,
      tools: p.tools.map((t) => ({ name: t.name, description: t.description })),
      slashCommands: p.slashCommands.map((s) => ({ name: s.name, description: s.description ?? '' })),
      systemPrompt: p.systemPromptText,
      hasPanel: !!p.panelHtml,
      panelTitle: p.manifest.panelTitle ?? p.manifest.name,
      panelIcon: p.manifest.panelIcon ? (() => { try { return fs.readFileSync(path.join(p.dir, p.manifest.panelIcon!), 'utf8'); } catch { return undefined; } })() : undefined,
      enabled: isPluginEnabled(p.manifest.name),
      error: p.error,
      dir: p.dir,
    };
  });
}

// ── 导出: 安装/卸载(v2 新增) ──────────────────────────────

// 安装插件: 复制目录到 <userData>/plugins/<name>/, 然后 invalidate cache。
export function installPlugin(sourcePath: string): { ok: boolean; name?: string; error?: string } {
  try {
    const basename = path.basename(sourcePath);
    const dest = path.join(app.getPath('userData'), 'plugins', basename);
    // 如果已存在同名, 先删除(覆盖安装)
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      /* 不存在无所谓 */
    }
    // 递归复制目录
    copyDirSync(sourcePath, dest);
    invalidatePluginCache();
    // 验证: 尝试加载看有没有 plugin.json
    const manifestPath = path.join(dest, 'plugin.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return { ok: true, name: manifest.name ?? basename };
    } catch {
      return { ok: true, name: basename };
    }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 卸载插件: 删除 <userData>/plugins/<name>/ 目录, 然后 invalidate cache。
export function uninstallPlugin(name: string): { ok: boolean; error?: string } {
  try {
    const dest = path.join(app.getPath('userData'), 'plugins', name);
    fs.rmSync(dest, { recursive: true, force: true });
    hooksMap.delete(name);
    invalidatePluginCache();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// 启用/禁用插件: 修改 settings.disabledPlugins, 然后 invalidate cache。
// Enable/disable plugin: modify settings.disabledPlugins, then invalidate cache.
export function togglePlugin(name: string, enabled: boolean): { ok: boolean; error?: string } {
  try {
    const s = getSettings();
    let disabled = s.disabledPlugins ?? [];
    if (enabled) {
      disabled = disabled.filter((n) => n !== name);
    } else {
      if (!disabled.includes(name)) disabled = [...disabled, name];
    }
    saveSettings({ ...s, disabledPlugins: disabled });
    invalidatePluginCache();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

// ── 导出: Panel 数据(v2.1 新增 — 渲染层扩展) ────────────────

// 返回所有已启用且有 panel 的插件, 含 HTML 内容供 renderer 注入。
export function pluginPanelsSnap(): Array<{ name: string; title: string; icon?: string; html: string }> {
  return loadPlugins()
    .filter((p) => p.panelHtml && isPluginEnabled(p.manifest.name))
    .map((p) => ({
      name: p.manifest.name,
      title: p.manifest.panelTitle ?? p.manifest.name,
      icon: p.manifest.panelIcon ? (() => { try { return fs.readFileSync(path.join(p.dir, p.manifest.panelIcon!), 'utf8'); } catch { return undefined; } })() : undefined,
      html: p.panelHtml!,
    }));
}

// 强制重载(开发回路 / 设置页刷新按钮)。下次 loadPlugins() 会重新扫。
export function invalidatePluginCache(): void {
  cache = null;
}
