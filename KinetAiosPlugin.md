# KinetAiosPlugin.md — 插件开发标准流程

> **每次开发插件（新增 / 修改 / 调试）时严格按照本文件执行。** 这不是建议，是 checklist。
>
> 本文件由 `KinetAios.md` 关联引用。项目核心规范见 [`KinetAios.md`](./KinetAios.md)。

## 0. 先理解架构

插件是运行在 **main 进程**的 Node 模块，由 `src/main/plugins.ts` 同步加载、进程级缓存。一个插件可以贡献 **5 种东西**，任选组合：

| 贡献点 | manifest 字段 | 文件类型 | 作用 |
|--------|--------------|----------|------|
| **Tools** | `tools` | JS (index.js) | 给 Direct 引擎注册自定义工具（函数调用） |
| **Slash 命令** | `slashCommands` | 目录下的 *.md | 注册 `/命令` 快捷指令（frontmatter + prompt 模板） |
| **System Prompt** | `systemPrompt` | .md 文件 | 追加到 Direct 引擎的 system prompt，注入领域知识/角色设定 |
| **Panel（面板）** | `panel` | .html 文件 | v2.1: 注入为 iframe srcdoc 的全屏交互视图 |
| **Hooks** | `hooks` | JS (entry#exportName) | v2: 仅 `onActivate(ctx)` 生命周期回调 |

## 1. 创建目录

```
plugins/<plugin-name>/
  plugin.json      ← 必须存在，否则不加载
```

- 目录名 = 插件名（惯例，非强制）
- 开发模式扫描项目根 `plugins/`（非 packaged）；用户安装的扫描 `<userData>/plugins/`
- **改完插件必须重启 app**（进程级缓存，无热重载）

## 2. 编写 plugin.json（manifest）

**必填字段**：`name`、`version`

**完整字段参考**（对照 `PluginManifest` 接口，`src/main/plugins.ts`）：

```jsonc
{
  // ── 必填 / Required ──
  "name": "my-plugin",           // 唯一标识，不能含空格
  "version": "1.0.0",            // semver

  // ── 元数据 / Metadata ──
  "description": "一句话描述",
  "author": "KinetAios",
  "category": "education",       // 见下方分类表（必须用已注册的分类！）
  "icon": "icon.svg",            // 相对插件目录的 SVG 路径（缺省按分类自动生成）
  "homepage": "https://...",
  "license": "MIT",

  // ── 引擎范围 / Engine scope ──
  "engines": ["direct"],         // 默认 ["direct"]；可多选 ["direct","claudeCode","codex"]

  // ── 权限声明（告知性质，不做运行时拦截） ──
  "permissions": ["shell", "fs", "network"],

  // ── 贡献点（任选组合，全部可选） ──
  "tools": "index.js#tools",           // "file.js#exportName"，默认 "index.js#tools"
  "slashCommands": "commands",          // 目录路径（相对插件目录），其下 *.md 成为 slash 命令
  "systemPrompt": "system-prompt.md",   // 文件路径（相对插件目录），内容追加到 system prompt
  "hooks": "index.js#hooks",            // entryPath#exportName，v2 仅支持 onActivate
  "panel": "panel.html",               // v2.1: HTML 文件路径
  "panelTitle": "我的面板",              // panel 在侧栏菜单的标题
  "panelIcon": "icon.svg"              // panel 在侧栏菜单的 SVG 图标
}
```

## 3. ⚠️ 分类注册（最容易遗漏的步骤）

**category 必须是已注册的分类**。如果用了新分类，必须同时在以下 4 处注册（漏一处 → 插件在设置页不显示）：

| # | 文件 | 位置 | 改什么 |
|---|------|------|--------|
| 1 | `src/main/plugins.ts` | `PluginCategory` 类型联合 | 加 `'newcat'` |
| 2 | `src/main/plugins.ts` | `CATEGORY_COLORS` 对象 | 加 `'newcat': '#色值'` |
| 3 | `src/renderer/app.ts` | `PLUGIN_CATS` 数组 | 加 `'newcat'` |
| 4 | `src/shared/i18n.ts` | `settings.plugins.cat.newcat` | **4 种语言各加一行** |

**已注册的分类**（8 个）：

| 分类 | zh-CN | en | zh-TW | ja | 色值 |
|------|-------|-----|-------|-----|------|
| `office` | 办公 | Office | 辦公 | オフィス | `#2d5a3d` |
| `dev` | 开发 | Dev | 開發 | 開発 | `#3b5998` |
| `media` | 媒体 | Media | 媒體 | メディア | `#8b3a62` |
| `data` | 数据 | Data | 資料 | データ | `#5a4a2d` |
| `system` | 系统 | System | 系統 | システム | `#444444` |
| `creative` | 创意 | Creative | 創意 | クリエイティブ | `#6b3d9e` |
| `education` | 教育 | Education | 教育 | 教育 | `#b8860b` |
| `misc` | 其它 | Misc | 其他 | その他 | `#666666` |

> 复用已有分类不需要改任何文件。**只有新增分类才需要动上面 4 处。**

## 4. 编写贡献点（按需）

### 4a. Tools（自定义工具）

文件：`index.js`（或 manifest `tools` 字段指定的 JS 文件）

```javascript
// Tool 接口签名见 src/main/tools.ts
// Tool { name; description; parameters(JSON Schema); readOnly?; run(args, ctx) }
// ctx.cwd = 当前会话工作目录; ctx.confirm(cmd) 让用户确认 shell 命令
module.exports = {
  tools: [
    {
      name: 'my_tool',
      description: '工具描述（AI 靠这段话判断何时调用）',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '参数说明' },
        },
        required: ['input'],
      },
      readOnly: true,  // 只读工具可同轮并发; 写工具留空 → 串行
      async run(args, ctx) {
        // ctx.cwd — 工作目录
        // ctx.confirm(cmd) — 弹窗让用户确认(写/shell 操作前)
        // ctx.signal — AbortSignal(会话取消时触发)
        return `结果文本(纯字符串)`;
      },
    },
  ],
};
```

**注意事项**：
- `run()` 返回值必须是 **string**（不是对象/数字）
- `readOnly: true` 的工具可以同轮并发执行；写工具（shell/fs 操作）不加 `readOnly`
- 工具只在 **Direct 引擎**生效（Claude Code / Codex 用各自内置工具）
- 可以 `require('child_process')`、`require('https')` 等 Node 内置模块

### 4b. Slash 命令

目录：manifest `slashCommands` 指定的目录（如 `commands/`），每个 `.md` 文件 = 一个命令

```markdown
---
name: my-command
description: 命令的一句话说明（用户输入 / 时看到）
---

你是命令的 prompt 模板。用户输入 /my-command 后，这段内容作为 prompt 发送给 AI。
可以用 Markdown 结构化输出。
```

**frontmatter 格式**：`name` + `description`（与 `src/main/skills.ts` 的 skill 格式一致）。

### 4c. System Prompt

文件：manifest `systemPrompt` 指定的 .md 文件（如 `system-prompt.md`）

- 内容**原样追加**到 Direct 引擎的 base system prompt 末尾
- 标题行用 `# 插件扩展: <name>` 格式（引擎会自动加这个标题）
- 适合注入：领域知识、角色设定、工具使用指南、输出格式约束
- **只在 manifest.engines 包含当前引擎时注入**

### 4d. Panel（v2.1 面板）

文件：manifest `panel` 指定的 HTML 文件（如 `panel.html`）

- 主进程启动时一次性读入，注入为 iframe 的 `srcdoc`（同源隔离）
- iframe sandbox 限制：`allow-scripts` 开，`allow-same-origin` 关
- 面板内通过 `window.kinet`（preload）与主进程通信
- `panelTitle` + `panelIcon` 控制侧栏菜单显示
- **修改 panel.html 需要重启 app**（srcdoc 不热更新）

## 5. 图标（可选但建议）

文件：`icon.svg`（相对插件目录），在 `plugin.json` 的 `icon` 字段引用

- 没有图标 → 按分类色自动生成（首字母方块）
- SVG 内容会被内联嵌入（`readFileSync` → 传到 renderer）
- 设置页容器固定 `40×40px`，CSS 用 `width:100%; height:100%` 强制 SVG 填满容器
- **SVG 的 `width`/`height` 属性不影响最终渲染尺寸**（被 CSS 覆盖），但 `viewBox` 决定坐标系
- 建议 `viewBox="0 0 40 40"`，所有图形画在这个坐标系内
- ⚠️ 不要在 SVG 标签上写固定 `width="N" height="N"` 期望控制大小 —— 统一由 CSS 容器决定

## 6. 验证 Checklist

开发完成后，逐项检查：

- [ ] `plugin.json` 有 `name` + `version`（否则报错 "plugin.json 缺 name/version"）
- [ ] `category` 是已注册的分类（否则设置页不显示）
- [ ] 如新增分类：4 处已全部注册（`PluginCategory` / `CATEGORY_COLORS` / `PLUGIN_CATS` / i18n ×4 语言）
- [ ] `npm run typecheck` 通过（如果新增了 TS 类型）
- [ ] `npm run build` 通过
- [ ] 启动 app → 设置页 → 插件列表 → 能看到新插件
- [ ] 启用/禁用开关正常工作（开关后侧栏 panel 菜单同步刷新）
- [ ] 图标尺寸与其他插件一致（40×40，不应偏大或偏小）
- [ ] 每个贡献点功能正常（工具能调用 / slash 命令能触发 / system prompt 生效 / panel 能打开）
- [ ] 插件加载失败时不影响其它插件（loader 有 try-catch 兜底，但 manifest 语法错误要提前排查）

## 7. Git 提交

```bash
git add -A
git commit -m "feat(plugin): 新增 <name> 插件 — <一句话描述>"
```

## 参考插件

| 插件 | 目录 | 贡献点组合 | 适合参照场景 |
|------|------|-----------|-------------|
| `examples/echo` | `plugins/examples/echo/` | 仅 tools | 最小骨架，复制改造 |
| `office-suite` | `plugins/office-suite/` | tools + slash + prompt | 完整工具型插件 |
| `low-altitude` | `plugins/low-altitude/` | tools + slash + prompt | 行业领域插件 |
| `brainstorm` | `plugins/brainstorm/` | prompt + panel | 面板型插件（Excalidraw） |
| `math-practice` | `plugins/math-practice/` | prompt + panel | 面板型插件（教育） |
