> 🌐 Language: [English](Home) | **中文**

# KinetAios Wiki

欢迎来到 KinetAios wiki。这里是**功能手册**——给已经装好 app、想深挖每个功能怎么用、怎么工作的用户。

> 项目介绍(给陌生访客)请看主 repo 的 [README](https://github.com/phinn/KinetAios)。Wiki 不重复 README,而是逐个功能区展开:**怎么用 + 怎么工作 + 常见问题**。

## 这是什么

KinetAios 是一个本地优先的 AI agent 仪表盘,跨平台(Windows 11 + macOS)。多会话并发、流式回答、shell/文件/搜索/MCP 工具、SQLite 历史 + 长期记忆、全局热键、每会话独立模型。

技术栈:**Electron + TypeScript**、**better-sqlite3 + FTS5**、**无前端框架**(vanilla TS + HTML/CSS,esbuild 打包)。

## 30 秒上手

```sh
cd KinetAiosWin
npm install      # postinstall 重建 better-sqlite3 给 Electron 用
npm run build
npm start
```

第一次启动 → 右上角 ⚙ → 填 API Key(+ Base URL / 模型;默认 GLM 智谱)→ 「测试连接」通过 → 给 KinetAios 下达任务。

详见 [[Getting-Started]]。

## 功能矩阵

| 功能 | 入口 | Wiki 页 |
|---|---|---|
| 三引擎切换(Direct / Claude Code / Codex) | 会话头部引擎选择 | [[Engines]] |
| Direct 引擎工作原理 | — | [[Direct-Engine]] |
| 10 个内置工具 + MCP | 自动注入 | [[Tools-and-MCP]] |
| 长期记忆抽取与注入 | 🧠 按钮 | [[Long-Term-Memory]] |
| Skills / Commands / Agents | `/` 或 ⚡ | [[Skills]] |
| 文件浏览器 + 内置浏览器 + 编辑器 | 🌐 按钮 / 「文件」tab | [[Files-and-Preview]] |
| Git 状态 / 历史 / 文件 diff / commit show | 「Git」tab | [[Git-Integration]] |
| 项目规则 + 项目背景 | 「规则」tab / Workbench 「背景」 | [[Rules-and-Context]] |
| Workbench(项目卡片总览) | 📂 按钮 | [[Workbench]] |
| 设置(API / 行为 / 价格 / 界面 / 记忆) | ⚙ 按钮 | [[Settings]] |
| 全局热键快速面板 | `Ctrl/Cmd+Alt+Space` | [[Global-Hotkey]] |
| 四语言切换 | ⚙ → 界面 → 语言 | [[i18n]] |
| 架构总览(main / preload / renderer) | — | [[Architecture]] |
| 开发与打包(typecheck / build / dist / CI) | — | [[Development]] |

## 约定

- 中文为主,代码标识符、CLI flag、文件名保留英文。
- 引用其他页用 `[[Page-Name]]`(GitHub wiki 自动渲染成链接,文件名对应 `Page-Name.md`)。
- 代码引用格式 `src/path/file.ts:line` —— 在本地 repo 里直接点开。
- 标了 `ponytail:` 的代码片段是刻意的 MVP 简化,后续按需扩。

## 同步本 wiki 到 GitHub

本 wiki 的 markdown 源在主 repo 的 `wiki/` 目录里。把它们推到 GitHub wiki 的步骤见 [[Wiki-Sync]]。
