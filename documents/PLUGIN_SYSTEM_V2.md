# Plugin System v2 — 设计文档

> KinetAios v1.3.0 → v1.4.0  
> 2025-01 · Status: Draft

---

## 目录

1. [现状分析](#1-现状分析)
2. [设计目标](#2-设计目标)
3. [Manifest v2 规范](#3-manifest-v2-规范)
4. [贡献点（Contribution Points）](#4-贡献点contribution-points)
5. [插件生命周期与 Hooks](#5-插件生命周期与-hooks)
6. [权限模型](#6-权限模型)
7. [加载器升级](#7-加载器升级)
8. [System Prompt 注入](#8-system-prompt-注入)
9. [Slash 命令扩展](#9-slash-命令扩展)
10. [设置页 UI 升级](#10-设置页-ui-升级)
11. [安装与分发](#11-安装与分发)
12. [IPC 契约变更](#12-ipc-契约变更)
13. [i18n 四语言](#13-i18n-四语言)
14. [示例插件：office-suite](#14-示例插件office-suite)
15. [实施计划](#15-实施计划)

---

## 1. 现状分析

### 1.1 已有能力（v1）

| 能力 | 实现文件 | 说明 |
|---|---|---|
| 工具扩展 | `plugins.ts` → `pluginTools()` | 插件导出 `{ tools: Tool[] }`，合并进 `allTools()` |
| Manifest | `plugin.json` | 仅 `name` / `version` / `description` / `author` |
 | 加载机制 | `require(index.js)` 同步 + 进程级缓存 | 重启 app 才生效；`invalidatePluginCache()` 手动刷新 |
| 失败兜底 | try/catch per plugin | 单插件炸不影响其它，error 回传 UI |
| UI 管理 | 设置页 → `s-plugin-list` | 平铺列表 + 重载按钮 |
| 自定义工具 | SQLite `custom_tools` 表 | UI 注册 shell 命令模板，`$ARG_<param>` 替换 |
| Skills 扫描 | `skills.ts` | 扫 `~/.claude/` + `~/.codex/` + 已装 Claude 插件路径 |

### 1.2 现有架构关键路径

```
插件目录 (<userData>/plugins/<name>/)
  └── plugin.json + index.js
       └── module.exports = { tools: [...] }
            └── plugins.ts: loadPlugins() → LoadedPlugin[]
                 └── pluginTools() → Tool[]
                      └── tools.ts: allTools() = [...builtin, ...plugin, ...custom]
                           └── engines.ts: Direct run → tools 传入 AgentLoop
```

System prompt 组装链（`engines.ts:153`）：

```
baseSystemPrompt          ← engines.ts 导出的常量
  + skillSection          ← 用户输入 /<skill> 时注入 skill body
  + rulesSection          ← AGENTS.md / CLAUDE.md / KINET.md
  + rulesBlock            ← KINET.md 内容
  + contextBlock          ← KINET-CONTEXT.md
```

Slash 菜单数据源（`app.ts:2452`）：

```
api.listSkills() → SkillInfo[] ← skills.ts: scan()
  数据源: ~/.claude/skills, ~/.claude/commands, ~/.claude/agents,
          ~/.codex/skills, ~/.codex/skills/.system,
          ~/.claude/plugins/installed_plugins.json → installPath/{commands,agents,skills}
```

### 1.3 局限

| # | 局限 | 影响 |
|---|---|---|
| L1 | **只能贡献 Tool[]** | 插件无法添加 Slash 命令、UI 面板、系统提示词 |
| L2 | **无分类/元数据** | 设置页是一维平铺，插件多了找不到 |
| L3 | **无权限声明** | 插件隐式获得完整主进程权限，用户不知情 |
| L4 | **无生命周期 hooks** | 插件不能在对话开始/工具调用时执行逻辑 |
| L5 | **手动文件夹安装** | 无打包格式，无拖拽安装 |
| L6 | **plugin.json 与 skills.ts 割裂** | KinetAios 原生插件不自动进 Slash 菜单，只有 Claude/Codex 的才进 |

---

## 2. 设计目标

### 2.1 核心原则

1. **渐进式** — v2 是 v1 的超集，现有插件不改一行代码仍能跑
2. **零运行时依赖** — 不引入 npm 包做插件加载/沙箱
3. **信任模型不变** — 本地代码 = 完全信任（同 VSCode 扩展），权限声明是「告知」而非「限制」
4. **单文件交付** — 设计文档、示例插件都遵循项目零依赖哲学

### 2.2 v2 新增能力一览

| 贡献点 | 说明 | 优先级 |
|---|---|---|
| `tools` | 已有，不变 | — |
| `slashCommands` | 插件贡献 Slash 命令（.md 文件） | P0 |
| `systemPrompt` | 追加到 Direct 引擎 system prompt | P0 |
| `hooks` | 生命周期回调（onActivate / onConversationStart / onToolCall） | P1 |
| `category` + `icon` | Manifest 元数据扩展 | P0 |
| `permissions` | 声明式权限告知 | P1 |
| `engines` | 指定插件只在某些引擎生效 | P0 |

---

## 3. Manifest v2 规范

### 3.1 完整字段

```jsonc
{
  // ── 必填（同 v1）──
  "name": "office-suite",           // 唯一标识，英文+连字符
  "version": "1.0.0",                // semver

  // ── 可选（同 v1）──
  "description": "办公工具套件",
  "author": "Kinet",

  // ── v2 新增：元数据 ──
  "category": "office",              // office | dev | media | data | system | misc
  "icon": "icon.svg",               // 相对路径，内联 SVG（零外部图片）
  "homepage": "https://github.com/...",  // 可选，插件主页
  "license": "MIT",

  // ── v2 新增：引擎范围 ──
  "engines": ["direct"],            // 可选，默认 ["direct","claude","codex"] 全部
                                     // direct = Kaios 引擎

  // ── v2 新增：权限声明（告知性质）──
  "permissions": ["shell", "fs", "net"],  // 声明插件需要哪些能力

  // ── v2 新增：贡献点 ──
  "tools": "index.js#tools",        // 已有：工具导出（支持 entryPath#exportName 语法）
  "slashCommands": "commands/",      // 新增：Slash 命令目录（.md 文件）
  "systemPrompt": "prompts/office.md",  // 新增：追加 system prompt
  "hooks": "index.js#hooks"         // 新增：生命周期 hooks
}
```

### 3.2 向后兼容

v1 的 `plugin.json` 只有 `name` / `version` / `description` / `author`，加载器先按 v1 解析。新字段全部可选，缺省含义：

| 字段 | 缺省值 | 说明 |
|---|---|---|
| `category` | `"misc"` | 归入「其它」 |
| `icon` | 内置默认 SVG | 类别对应颜色的圆角方块 |
| `engines` | `["direct"]` | v1 行为：只给 Direct/Kaios 引擎供工具 |
| `permissions` | `[]` | 不声明（兼容 v1） |
| `tools` | `"index.js#tools"` | v1 默认入口 |
| `slashCommands` | 不扫描 | — |
| `systemPrompt` | 不注入 | — |
| `hooks` | 不调用 | — |

### 3.3 `entryPath#exportName` 语法

v1 硬编码 `require(entryPath).tools`。v2 支持 manifest 字段写 `"index.js#tools"` 或 `"lib/hooks.js#default"`，加载器按 `#` 分割：

```ts
function resolveExport(entrySpec: string, dir: string): unknown {
  const [file, exportName] = entrySpec.split('#');
  const fullPath = path.join(dir, file);
  delete require.cache[require.resolve(fullPath)];
  const mod = require(fullPath);
  return exportName ? mod[exportName] : mod;
}
```

> 向后兼容：如果 manifest 里没有 `tools` 字段（v1 插件），回退到 `require('index.js').tools`。

---

## 4. 贡献点（Contribution Points）

### 4.1 tools（已有，不变）

```js
// index.js
module.exports = {
  tools: [
    {
      name: 'create_doc',
      description: '创建 Word 文档',
      parameters: { type: 'object', properties: { ... }, required: [...] },
      async run(args, ctx) { ... }
    }
  ]
};
```

加载后摊平到 `allTools()` → Direct 引擎 ReAct loop 可调用。

### 4.2 slashCommands（新增）

插件目录下的 `commands/*.md` 自动成为 Slash 命令，出现在 `/` 菜单：

```
plugins/office-suite/
  └── commands/
       ├── make-doc.md        → /make-doc
       └── convert-table.md   → /convert-table
```

每个 `.md` 文件格式（兼容 `skills.ts` 的 frontmatter 解析）：

```markdown
---
name: make-doc
description: 根据描述生成 Word 文档
---
你是一个文档生成助手。请根据用户的描述：
1. 用 create_doc 工具创建 .docx 文件
2. 文件名取自用户描述的第一行
3. 正文按 Markdown 结构组织
```

**加载逻辑**：`plugins.ts` 调用 `skills.ts` 已有的 `parseSkill()` 函数扫描 `commands/` 目录，结果合并到 `LoadedPlugin.slashCommands: SkillInfo[]`。然后在 `engines.ts` 组装 skillSection 时，插件贡献的 slash 命令与 `~/.claude/skills` 的命令合并到同一个 list。

**与现有 skills.ts 的关系**：

```
Slash 菜单数据源（v2）:
  api.listSkills() → [
    ...skills.ts 扫描的 ~/.claude/ + ~/.codex/ skills,      // 已有
    ...plugins.ts 扫描的 <userData>/plugins/*/commands/*.md  // v2 新增
  ]
```

### 4.3 systemPrompt（新增）

插件可贡献一段 Markdown 文本，追加到 Direct 引擎的 system prompt 尾部：

```
plugins/office-suite/
  └── prompts/
       └── office.md
```

`office.md` 内容：

```markdown
# 办公套件扩展

你可以使用以下办公工具：
- create_doc: 创建 Word 文档(.docx)
- excel_to_csv: Excel 转 CSV
- pdf_extract: 从 PDF 提取文本

当用户要求创建或转换文档时，优先使用这些专用工具而非 shell 命令。
```

**注入位置**（`engines.ts:153`）：

```ts
// v1
systemPrompt: baseSystemPrompt + skillSection + rulesSection + rulesBlock + contextBlock

// v2（追加 pluginPromptSection）
systemPrompt: baseSystemPrompt + skillSection + rulesSection + rulesBlock + contextBlock + pluginPromptSection
```

`pluginPromptSection` 由 `plugins.ts` 导出的 `pluginSystemPrompts(convEngine)` 生成：遍历所有 `engines` 包含当前引擎的插件，读取 `systemPrompt` 文件内容，用 `# 插件: <name>` 标题分隔拼接。

### 4.4 hooks（P1，后续实现）

```js
// index.js
module.exports = {
  tools: [...],
  hooks: {
    onActivate(ctx) {
      console.log('office-suite activated');
    },
    onConversationStart(convId) {
      // 对话开始时的初始化
    },
    onToolCall(toolName, args) {
      // 工具调用前的拦截/日志
      // return false 可阻止调用（P1 暂不实现拦截，仅日志）
    }
  }
};
```

**Hook 上下文** `PluginContext`：

```ts
interface PluginContext {
  pluginDir: string;        // 插件自己的目录（找资源用）
  userData: string;         // app.getPath('userData')
  log(msg: string): void;   // 写到主进程日志（不暴露 console）
}
```

> ponytail: hooks 执行同步，无超时保护。v2 只支持 `onActivate`（加载时一次性调用）。`onConversationStart` / `onToolCall` 留到 v2.1。

---

## 5. 插件生命周期与 Hooks

```
App 启动
  └── store init
       └── loadPlugins()  ← 扫描 <userData>/plugins/*/
            ├── 读 plugin.json → manifest
            ├── resolveExport('index.js#tools') → Tool[]
            ├── 扫描 commands/*.md → SkillInfo[]
            ├── 读 prompts/*.md → systemPrompt 内容
            └── 调 hooks.onActivate(pluginCtx)  ← v2 新增
                 └── 缓存到 LoadedPlugin[]
                      └── allTools() 合并工具
                      └── listSkills() 合并 slash 命令
                      └── systemPrompt 组装时合并

设置页「重载」
  └── invalidatePluginCache()
       └── loadPlugins()  ← 重新走一遍上面流程
```

---

## 6. 权限模型

### 6.1 设计原则

**声明 ≠ 强制**。权限字段是给用户看的「告知标签」，不做运行时沙箱拦截。

理由：
- 信任模型 = 本地代码完全信任（同 VSCode 扩展、同 Claude Code MCP）
- 插件代码跑在主进程，有完整 Node.js 能力，做沙箱会卡死同步 API
- 用户自装本地代码 = 已隐式授权

### 6.2 权限标签

| 标签 | 含义 | 典型插件 |
|---|---|---|
| `shell` | 通过工具或子进程执行 shell 命令 | 构建/部署工具 |
| `fs` | 读写文件系统 | 文档处理 |
| `net` | 发出网络请求 | API 集成 |
| `native` | 调用 Electron native API | 窗口管理 |

### 6.3 UI 展示

设置页插件卡片上以小标签展示声明的权限，帮助用户判断插件安全性：

```
┌────────────────────────────┐
│ 📦 Office Suite     v1.0.0 │
│ 办公工具套件                │
│ 🔧 3 tools · 🏷️ office     │
│ ⚠️ shell · fs               │
└────────────────────────────┘
```

---

## 7. 加载器升级

### 7.1 类型定义（`src/main/plugins.ts`）

```ts
// v2 LoadedPlugin —— v1 超集
export interface PluginManifest {
  // v1
  name: string;
  version: string;
  description?: string;
  author?: string;
  // v2 新增
  category?: PluginCategory;
  icon?: string;
  homepage?: string;
  license?: string;
  engines?: EngineKind[];
  permissions?: string[];
  tools?: string;             // entryPath#exportName，默认 "index.js#tools"
  slashCommands?: string;     // 目录路径，默认不扫描
  systemPrompt?: string;      // 文件路径，默认不注入
  hooks?: string;             // entryPath#exportName
}

export type PluginCategory = 'office' | 'dev' | 'media' | 'data' | 'system' | 'misc';

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  tools: Tool[];
  slashCommands: SkillInfo[];   // v2 新增
  systemPromptText?: string;    // v2 新增：已读入的 prompt 文本
  error?: string;
}

// hooks 单独存（不序列化到 snap）
interface PluginHooksStore {
  onActivate?: (ctx: PluginContext) => void;
}
const hooksMap = new Map<string, PluginHooksStore>();
```

### 7.2 加载流程伪代码

```ts
export function loadPlugins(): LoadedPlugin[] {
  if (cache) return cache;
  const root = path.join(app.getPath('userData'), 'plugins');
  const out: LoadedPlugin[] = [];

  for (const dir of listDirs(root)) {
    try {
      const manifest = JSON.parse(readPluginJson(dir));

      // 1. 工具（v1 逻辑 + v2 entryPath#exportName 语法）
      const toolsEntry = manifest.tools ?? 'index.js#tools';
      const tools = resolveTools(toolsEntry, dir);

      // 2. Slash 命令（v2 新增）
      const slashCommands = manifest.slashCommands
        ? scanSlashCommands(path.join(dir, manifest.slashCommands), manifest.name)
        : [];

      // 3. System prompt（v2 新增）
      const systemPromptText = manifest.systemPrompt
        ? fs.readFileSync(path.join(dir, manifest.systemPrompt), 'utf8')
        : undefined;

      // 4. Hooks（v2 新增 — 仅 onActivate）
      if (manifest.hooks) {
        const hooks = resolveExport(manifest.hooks, dir);
        if (typeof hooks?.onActivate === 'function') {
          hooksMap.set(manifest.name, { onActivate: hooks.onActivate });
          safeCall(() => hooks.onActivate(makePluginCtx(dir)));
        }
      }

      out.push({ manifest, dir, tools, slashCommands, systemPromptText });
    } catch (e) {
      out.push(errorPlugin(dir, e));
    }
  }
  cache = out;
  return cache;
}
```

### 7.3 新增导出函数

```ts
// 给 engines.ts 用：当前引擎的插件 system prompt 拼接
export function pluginSystemPrompts(engine: EngineKind): string {
  return loadPlugins()
    .filter(p => !p.manifest.engines || p.manifest.engines.includes(engine))
    .filter(p => p.systemPromptText?.trim())
    .map(p => `\n\n# 插件扩展: ${p.manifest.name}\n${p.systemPromptText}`)
    .join('');
}

// 给 slash 菜单用：插件的 slash 命令
export function pluginSlashCommands(): SkillInfo[] {
  return loadPlugins().flatMap(p =>
    p.slashCommands.map(s => ({ ...s, source: 'plugin' as const }))
  );
}
```

### 7.4 engines.ts 改动

```ts
// engines.ts 第 153 行
// v1:
systemPrompt: baseSystemPrompt + skillSection + rulesSection + rulesBlock + contextBlock

// v2:
import { pluginSystemPrompts } from './plugins';
const pluginSection = pluginSystemPrompts('direct');
systemPrompt: baseSystemPrompt + skillSection + rulesSection + rulesBlock + contextBlock + pluginSection
```

### 7.5 skills.ts 改动

`listSkills()` 返回时合并插件 slash 命令：

```ts
// skills.ts
import { pluginSlashCommands } from './plugins';

export function listSkills(): SkillInfo[] {
  const builtin = [...ensure().values()]
    .map(({ body: _body, ...info }) => info);
  const pluginCmds = pluginSlashCommands();  // v2 新增
  return [...builtin, ...pluginCmds]
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

### 7.6 tools.ts 改动

`allTools()` 加入引擎过滤参数（可选优化，P1）：

```ts
// v1
export function allTools(): Tool[] {
  const { pluginTools } = require('./plugins');
  return [...builtinTools(), ...pluginTools(), ...customTools()];
}

// v2（可选：按引擎过滤插件工具）
export function allTools(engine: EngineKind = 'direct'): Tool[] {
  const { pluginToolsForEngine } = require('./plugins');
  return [...builtinTools(), ...pluginToolsForEngine(engine), ...customTools()];
}
```

> ponytail: 引擎过滤是可选的。v2 第一版可以先不做过滤（所有插件工具对所有引擎可见），后续加 `pluginToolsForEngine(engine)` 做精细控制。

---

## 8. System Prompt 注入

### 8.1 注入链（v2 完整版）

```
[baseSystemPrompt]           ← 引擎身份 + 工具使用准则（已有）
[skillSection]               ← 用户 /<skill> 调用的 body（已有）
[rulesSection]               ← AGENTS.md / CLAUDE.md（已有）
[rulesBlock]                 ← KINET.md（已有）
[contextBlock]               ← KINET-CONTEXT.md（已有）
[pluginPromptSection]        ← v2 新增：插件的 systemPrompt 拼接
```

### 8.2 缓存影响分析

当前 system prompt 变化会打穿 Anthropic prompt cache。插件 prompt 的影响：

- **base + rules + context 部分不变** → cache 前缀仍然有效
- **pluginPromptSection 拼在尾部** → 只有尾部 cache 失效，前缀命中最长前缀仍 hit
- 对 GLM/OpenAI 兼容接口无影响（无 prompt cache）

> 结论：pluginPromptSection 放在拼接链尾部，对缓存友好。

### 8.3 Token 预算

插件 system prompt 总量限制 4000 tokens（约 6000 字符）。超过的插件按 manifest 中声明顺序截断，末尾追加 `\n[更多插件提示词已截断]`。

---

## 9. Slash 命令扩展

### 9.1 数据流

```
用户在输入框打 /make-doc
  └── app.ts: handleSlash()
       └── openSlash('make-doc')
            └── api.listSkills()
                 └── skills.ts: listSkills()
                      └── [...~/.claude/skills, ...pluginSlashCommands()]
                           └── 匹配 "make-doc"
                                └── 用户按 Enter
                                     └── composer.value = "/make-doc "
                                          └── 发送 → engines.ts
                                               └── loadSkillBody('make-doc')
                                                    └── 注入到 skillSection
```

### 9.2 `loadSkillBody` 适配

当前 `loadSkillBody()` 只查 `skills.ts` 的内部 cache。v2 需要让它也能查到插件的 slash 命令 body：

```ts
// skills.ts
export function loadSkillBody(name: string): string | null {
  // 1. 先查原有 skill cache
  const s = ensure().get(name.toLowerCase());
  if (s) return formatSkillBody(s);

  // 2. 再查插件 slash 命令（v2 新增）
  const pluginCmd = pluginSlashCommands().find(
    c => c.name.toLowerCase() === name.toLowerCase()
  );
  if (pluginCmd) {
    const body = loadPluginCommandBody(pluginCmd);
    if (body) return formatPluginBody(body, pluginCmd);
  }

  return null;
}
```

### 9.3 Slash 菜单显示

Slash 菜单中插件命令的 tag 从 `claude·skill` 变为 `plugin·command`，帮助用户区分来源：

```
┌──────────────────────────────────────┐
│  make-doc      plugin·command        │
│  根据描述生成 Word 文档                │
├──────────────────────────────────────┤
│  code-review   claude·skill          │
│  系统性代码审查                       │
└──────────────────────────────────────┘
```

---

## 10. 设置页 UI 升级

### 10.1 布局变化

**v1（平铺列表）**：
```
插件
┌──────────────────────────────┐
│ office-suite v1.0.0          │
│ 3 tools                      │
├──────────────────────────────┤
│ docker-manager v0.2.0        │
│ 5 tools                      │
└──────────────────────────────┘
```

**v2（分类卡片）**：
```
插件                              [拖放安装]
┌──────────────────────────────────────────┐
│ 📦 办公 (1)                               │
│  ┌──────────────────────────────────┐    │
│  │ 📄 Office Suite          v1.0.0  │    │
│  │ 办公工具套件                      │    │
│  │ 3 tools · office · shell · fs    │    │
│  └──────────────────────────────────┘    │
│                                          │
│ 📦 开发 (1)                               │
│  ┌──────────────────────────────────┐    │
│  │ 🐳 Docker Manager        v0.2.0  │    │
│  │ Docker 容器管理                   │    │
│  │ 5 tools · dev · shell            │    │
│  └──────────────────────────────────┘    │
│                                          │
│ 📦 其它 (0)                               │
│  暂无插件                                 │
└──────────────────────────────────────────┘
                              [重新加载]
```

### 10.2 分类定义

```ts
const PLUGIN_CATEGORIES = [
  { key: 'office', icon: '📄', label: 'settings.plugins.cat.office' },
  { key: 'dev',    icon: '🔧', label: 'settings.plugins.cat.dev' },
  { key: 'media',  icon: '🎬', label: 'settings.plugins.cat.media' },
  { key: 'data',   icon: '🗃️', label: 'settings.plugins.cat.data' },
  { key: 'system', icon: '⚙️', label: 'settings.plugins.cat.system' },
  { key: 'misc',   icon: '📦', label: 'settings.plugins.cat.misc' },
] as const;
```

> 图标用 SVG inline（项目惯例），上面 emoji 仅示意。

### 10.3 拖拽安装（P1）

```
拖放 .kinet-plugin 文件或文件夹到设置页
  └── main.ts: IPC 'plugin-install'
       ├── .kinet-plugin = zip → 解压到 <userData>/plugins/<name>/
       ├── 文件夹 → 复制到 <userData>/plugins/<name>/
       └── invalidatePluginCache() → 重新加载
            └── 返回安装结果
```

> ponytail: v2 先做文件夹拖放（复制目录），.kinet-plugin zip 格式留到后续。

### 10.4 错误展示

加载失败的插件卡片边框变红，显示错误：

```
┌──────────────────────────────────┐  ← 红色边框
│ ⚠️ broken-plugin         v0.1.0  │
│ 加载失败                          │
│ Error: Cannot find module 'pandoc'│  ← 截断的错误消息
│                     [查看详情]    │
└──────────────────────────────────┘
```

---

## 11. 安装与分发

### 11.1 安装方式（v2 范围）

| 方式 | v2 支持 | 说明 |
|---|---|---|
| 手动放文件夹 | ✅ 已有 | 把目录复制到 `<userData>/plugins/<name>/` |
| 拖放文件夹 | ✅ P1 | 设置页拖放区域 |
| 拖放 .zip | 🔜 P2 | 需要解压逻辑 |
| 插件市场 | 🔜 P3 | 需要 registry + 下载 |

### 11.2 .kinet-plugin 格式（P2 规划）

```
office-suite.kinet-plugin (zip)
  ├── plugin.json
  ├── index.js
  ├── icon.svg
  ├── commands/
  └── prompts/
```

本质是 zip，改后缀名。解压时验证 `plugin.json` 的 `name` + `version` 必填。

### 11.3 卸载

设置页插件卡片右上角加「删除」按钮：
- 删除 `<userData>/plugins/<name>/` 目录
- `invalidatePluginCache()` 刷新

---

## 12. IPC 契约变更

### 12.1 新增 IPC

```ts
// preload.ts 新增
pluginInstall: (sourcePath: string) => ipcRenderer.invoke('plugin-install', sourcePath),
pluginUninstall: (name: string) => ipcRenderer.invoke('plugin-uninstall', name),
```

### 12.2 变更 IPC

```ts
// plugin-list 返回结构扩展
// v1:
pluginList(): Promise<{ ok: boolean; items?: PluginSnapV1[]; error?: string }>;

// v2:
pluginList(): Promise<{ ok: boolean; items?: PluginSnapV2[]; error?: string }>;

interface PluginSnapV2 {
  name: string;
  version: string;
  description?: string;
  author?: string;
  category: PluginCategory;        // 新增
  icon?: string;                   // 新增：SVG 内容（非路径）
  permissions: string[];           // 新增
  engines: EngineKind[];           // 新增
  toolCount: number;
  slashCommandCount: number;       // 新增
  error?: string;
  dir: string;
}
```

### 12.3 main.ts 新增 handler

```ts
ipcMain.handle('plugin-install', async (_e, sourcePath: string) => {
  // 复制目录到 <userData>/plugins/<basename>/
  // 如果是 zip → 解压（P2）
  // invalidatePluginCache()
});

ipcMain.handle('plugin-uninstall', (_e, name: string) => {
  // fs.rmSync(<userData>/plugins/<name>/, { recursive: true })
  // invalidatePluginCache()
});
```

---

## 13. i18n 四语言

### 13.1 新增 key

```ts
// 分类标签
'settings.plugins.cat.office': '办公' / 'Office' / '辦公' / 'オフィス'
'settings.plugins.cat.dev':    '开发' / 'Dev' / '開發' / '開発'
'settings.plugins.cat.media':  '媒体' / 'Media' / '媒體' / 'メディア'
'settings.plugins.cat.data':   '数据' / 'Data' / '資料' / 'データ'
'settings.plugins.cat.system': '系统' / 'System' / '系統' / 'システム'
'settings.plugins.cat.misc':   '其它' / 'Misc' / '其他' / 'その他'

// 新增 UI 文案
'settings.plugins.install':    '拖放插件文件夹到此处安装' / 'Drop a plugin folder here to install' / ...
'settings.plugins.uninstall':  '卸载' / 'Uninstall' / '解除安裝' / 'アンインストール'
'settings.plugins.uninstallConfirm': '确定卸载 {name}？' / 'Uninstall {name}?' / ...
'settings.plugins.permissions': '权限' / 'Permissions' / '權限' / '権限'
'settings.plugins.slashCommands': '{count} 个命令' / '{count} commands' / ...
'settings.plugins.installSuccess': '安装成功: {name}' / 'Installed: {name}' / ...
'settings.plugins.installFailed': '安装失败: {error}' / 'Install failed: {error}' / ...
```

### 13.2 修改 key

```ts
// v1
'settings.plugins.desc': '把插件目录放到 <userData>/plugins/<name>/ 下...'

// v2
'settings.plugins.desc': '管理已安装的插件。拖放文件夹安装，或手动放到 <userData>/plugins/<name>/ 下。'
```

---

## 14. 示例插件：office-suite

完整目录结构：

```
office-suite/
├── plugin.json
├── index.js
├── icon.svg
├── commands/
│   ├── make-doc.md
│   └── convert-table.md
└── prompts/
    └── office.md
```

### plugin.json

```json
{
  "name": "office-suite",
  "version": "1.0.0",
  "description": "办公工具套件：文档创建、格式转换、表格提取",
  "author": "Kinet",
  "category": "office",
  "icon": "icon.svg",
  "engines": ["direct"],
  "permissions": ["shell", "fs"],
  "tools": "index.js#tools",
  "slashCommands": "commands/",
  "systemPrompt": "prompts/office.md"
}
```

### index.js（三个工具）

```js
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function execAsync(cmd, cwd, timeout = 60000) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.killed) resolve('⏱ 执行超时');
      else if (err) resolve(`❌ ${err.message}\n${stderr}`);
      else resolve(stdout || stderr || '✅ 完成');
    });
  });
}

module.exports = {
  tools: [
    {
      name: 'create_doc',
      description: '创建 Word 文档(.docx)。用 pandoc 把 Markdown 转 docx。',
      parameters: {
        type: 'object',
        properties: {
          output: { type: 'string', description: '输出文件路径(.docx)' },
          content: { type: 'string', description: '文档内容(Markdown 格式)' },
          title: { type: 'string', description: '文档标题(一级标题)' }
        },
        required: ['output', 'content']
      },
      readOnly: false,
      async run(args, ctx) {
        const tmp = path.join(ctx.cwd, `.tmp-${Date.now()}.md`);
        const titleLine = args.title ? `# ${args.title}\n\n` : '';
        fs.writeFileSync(tmp, titleLine + String(args.content));
        const out = await execAsync(
          `pandoc "${tmp}" -o "${args.output}"`,
          ctx.cwd
        );
        try { fs.unlinkSync(tmp); } catch {}
        return out.includes('完成') || out.includes('✅')
          ? `已创建文档: ${args.output}`
          : out;
      }
    },
    {
      name: 'excel_to_csv',
      description: '将 Excel 文件(.xlsx/.xls)转为 CSV。需要 python3 + openpyxl。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Excel 文件路径' },
          output: { type: 'string', description: '输出 CSV 路径' },
          sheet: { type: 'string', description: '工作表名(可选,默认第一个)' }
        },
        required: ['input', 'output']
      },
      readOnly: false,
      async run(args, ctx) {
        const py = `import openpyxl, csv, sys
wb = openpyxl.load_workbook("${args.input}")
ws = wb["${args.sheet}"] if "${args.sheet}" else wb.active
with open("${args.output}", "w", newline="", encoding="utf-8") as f:
    csv.writer(f).writerows(ws.iter_rows(values_only=True))
print("done")`;
        return execAsync(`python3 -c '${py.replace(/'/g, "'\\''")}'`, ctx.cwd);
      }
    },
    {
      name: 'pdf_extract_text',
      description: '从 PDF 提取纯文本。需要 pdftotext(poppler-utils)。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'PDF 文件路径' },
          pages: { type: 'string', description: '页码范围(可选,如 1-5)' }
        },
        required: ['input']
      },
      readOnly: true,
      async run(args, ctx) {
        const pageFlag = args.pages ? ` -f ${args.pages}` : '';
        return execAsync(
          `pdftotext${pageFlag} "${args.input}" -`,
          ctx.cwd
        );
      }
    }
  ]
};
```

### icon.svg

```svg
<svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
  <rect width="40" height="40" rx="8" fill="#2d5a3d"/>
  <text x="20" y="27" font-family="system-ui,sans-serif" font-size="18" font-weight="700"
        fill="white" text-anchor="middle">W</text>
</svg>
```

### commands/make-doc.md

```markdown
---
name: make-doc
description: 根据自然语言描述生成 Word 文档
---
你是文档生成助手。请根据用户的描述：

1. 将用户描述解析为文档结构（标题、章节、列表）
2. 用 create_doc 工具创建 .docx 文件，output 路径取自描述中的文件名（或自动命名）
3. content 参数用 Markdown 格式组织正文
4. 创建完成后告知用户文件路径
```

### commands/convert-table.md

```markdown
---
name: convert-table
description: 将 Excel 表格转为 CSV 或在对话中展示
---
你是表格处理助手。请根据用户需求：

1. 如果用户提供了 .xlsx 文件路径，用 excel_to_csv 工具转换
2. 如果用户想查看特定 sheet，在 sheet 参数中指定
3. 转换后读取 CSV 内容，在对话中用 Markdown 表格展示前 20 行
```

### prompts/office.md

```markdown
你可以使用以下办公工具：

- **create_doc**: 创建 Word 文档(.docx)，通过 pandoc 将 Markdown 转 docx
- **excel_to_csv**: 将 Excel 文件转为 CSV
- **pdf_extract_text**: 从 PDF 提取纯文本

当用户要求创建、转换或提取文档内容时，优先使用这些专用工具。
这些工具依赖系统命令(pandoc / python3 / pdftotext)，如果工具报错可能是依赖未安装。
```

---

## 15. 实施计划

### 阶段 0：设计评审（本文档）

- [x] 梳理现有架构
- [x] 定义 v2 manifest 规范
- [x] 定义贡献点
- [ ] 用户评审

### 阶段 1：核心加载器（P0）

改动文件：
- [ ] `src/main/plugins.ts` — Manifest 扩展 + slashCommands 扫描 + systemPrompt 读取 + hooks
- [ ] `src/main/skills.ts` — `listSkills()` 合并插件命令 + `loadSkillBody()` 查插件命令
- [ ] `src/main/engines.ts` — system prompt 拼接加 `pluginSystemPrompts()`
- [ ] `src/main/tools.ts` — `allTools()` 可选加引擎过滤
- [ ] `src/shared/types.ts` — `PluginManifest` 类型扩展 + `PluginSnapV2`

验证：`npm run typecheck` 通过 + 创建 office-suite 插件目录，启动 app 确认工具/slash 命令/system prompt 生效。

### 阶段 2：UI 升级（P0）

改动文件：
- [ ] `src/renderer/app.ts` — 插件列表从平铺改为分类卡片
- [ ] `src/renderer/styles.css` — 新增 `.s-plugin-card` / `.s-plugin-cat` 等样式
- [ ] `src/shared/i18n.ts` — 新增分类标签 + 安装/卸载文案（四语言）

验证：设置页看到分类卡片，图标和权限标签正确展示。

### 阶段 3：安装/卸载（P1）

改动文件：
- [ ] `src/main/main.ts` — 新增 `plugin-install` / `plugin-uninstall` IPC handler
- [ ] `src/preload/preload.ts` — 新增 `pluginInstall` / `pluginUninstall`
- [ ] `src/shared/types.ts` — KinetAPI 新增两个方法
- [ ] `src/renderer/app.ts` — 拖放区域 + 卸载按钮 + 确认弹窗

### 阶段 4：示例插件 + 文档（P0）

- [ ] 创建 `examples/plugins/office-suite/` 完整示例
- [ ] 更新 README 插件开发段落
- [ ] 编写 Plugin SDK API 参考

### 预估工作量

| 阶段 | 文件数 | 代码行 | 时间 |
|---|---|---|---|
| 阶段 1 核心加载器 | 5 | ~300 | 2h |
| 阶段 2 UI 升级 | 3 | ~250 | 1.5h |
| 阶段 3 安装卸载 | 4 | ~150 | 1h |
| 阶段 4 示例+文档 | 3 | ~200 | 1h |
| **合计** | **~12** | **~900** | **~5.5h** |

---

## 附录 A：类型变更汇总

### `src/shared/types.ts`

```ts
// v2 新增类型
export type PluginCategory = 'office' | 'dev' | 'media' | 'data' | 'system' | 'misc';

export type PluginSnap = {
  name: string;
  version: string;
  description?: string;
  author?: string;
  category: PluginCategory;
  icon?: string;              // SVG 内容字符串
  permissions: string[];
  engines: EngineKind[];
  toolCount: number;
  slashCommandCount: number;
  error?: string;
  dir: string;
};

// KinetAPI 扩展
export interface KinetAPI {
  // v1（签名变更）
  pluginList(): Promise<{ ok: boolean; items?: PluginSnap[]; error?: string }>;
  pluginReload(): Promise<{ ok: boolean; count?: number; error?: string }>;
  // v2 新增
  pluginInstall(sourcePath: string): Promise<{ ok: boolean; name?: string; error?: string }>;
  pluginUninstall(name: string): Promise<{ ok: boolean; error?: string }>;
}
```

### `src/main/plugins.ts`

```ts
// v2 导出
export function loadPlugins(): LoadedPlugin[];
export function pluginTools(): Tool[];                          // v1 不变
export function pluginToolsForEngine(engine: EngineKind): Tool[];  // v2 新增（可选）
export function pluginSystemPrompts(engine: EngineKind): string;   // v2 新增
export function pluginSlashCommands(): SkillInfo[];                // v2 新增
export function pluginListSnap(): PluginSnap[];                    // v2 签名变更
export function invalidatePluginCache(): void;                     // v1 不变
```

---

## 附录 B：文件改动清单

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `src/main/plugins.ts` | **重写** | Manifest 解析 + 多贡献点加载 |
| `src/main/skills.ts` | **修改** | `listSkills()` + `loadSkillBody()` 合并插件命令 |
| `src/main/engines.ts` | **小改** | system prompt 拼接加 `pluginSystemPrompts()` |
| `src/main/tools.ts` | **小改** | `allTools()` 可选引擎过滤 |
| `src/main/main.ts` | **新增** | `plugin-install` / `plugin-uninstall` handler |
| `src/preload/preload.ts` | **新增** | `pluginInstall` / `pluginUninstall` |
| `src/shared/types.ts` | **修改** | `PluginManifest` 扩展 + `PluginSnap` + KinetAPI |
| `src/shared/i18n.ts` | **新增** | 分类标签 + 安装/卸载文案（×4 语言） |
| `src/renderer/app.ts` | **重写** | 插件设置区域 → 分类卡片 |
| `src/renderer/styles.css` | **新增** | 插件卡片样式 |
| `examples/plugins/office-suite/*` | **新建** | 示例插件 |

---

## 附录 C：与竞品对比

| 能力 | KinetAios v2 | Claude Code (plugins) | VSCode Extensions | Cursor |
|---|---|---|---|---|
| 工具扩展 | ✅ Tool[] | ✅ MCP tools | ✅ Command API | ❌ 封闭 |
| Slash 命令 | ✅ commands/*.md | ✅ commands/ | ✅ via keybinds | ❌ |
| System prompt | ✅ prompts/*.md | ✅ via CLAUDE.md | ❌ | ❌ |
| 生命周期 hooks | ✅ P1 | ❌ | ✅ activation events | ❌ |
| 分类管理 | ✅ 6 类 | ❌ 平铺 | ✅ marketplace | ❌ |
| 权限声明 | ✅ 告知性 | ❌ | ✅ enforced | ❌ |
| 热重载 | ✅ 手动按钮 | ❌ 重启 | ✅ auto reload | — |
| 本地优先 | ✅ 无市场依赖 | ✅ 本地文件 | ❌ 需 marketplace | ❌ 云端 |
