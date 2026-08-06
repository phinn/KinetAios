> 🌐 Language: [English](Home.md) | **中文**

# KinetAios Wiki

欢迎来到 KinetAios wiki。这是**功能手册** —— 给已安装 app、想深入了解各功能怎么运作的用户。

> 项目介绍(首次访客)请看主 repo 的 [README](https://github.com/phinn/KinetAios)。Wiki 不重复 README —— 它展开每个功能区域:**怎么用 + 怎么工作 + 常见问题**。

## 这是什么

KinetAios 是本地优先的 AI agent 仪表盘,跨平台(Windows 11 + macOS)。并发跑多个会话、流式答案、用 shell/文件/搜索/MCP 工具、SQLite 历史 + 长期记忆、全局热键、每会话独立模型。

技术栈:**Electron + TypeScript**、**better-sqlite3 + FTS5**、**无前端框架**(vanilla TS + HTML/CSS,esbuild 打包)。

## 30 秒快速开始

```sh
cd KinetAiosWin
npm install      # postinstall 为 Electron 重编 better-sqlite3
npm run build
npm start
```

首次启动 → 右上角 **⚙** → 填 **API Key**(+ Base URL / 模型,默认 GLM 智谱)→ 「测试连接」通了 → 发任务。

详见 [[Getting-Started]]。

## 功能矩阵

| 功能 | 入口 | Wiki 页面 |
|---|---|---|
| 三引擎切换(Direct / Claude Code / Codex) | 会话头部引擎选择器 | [[Engines]] |
| Direct 引擎内幕(ReAct, 压缩, 校准) | — | [[Direct-Engine]] |
| 12 个内置工具 + web_search/web_fetch | 自动注入 | [[Tools-and-MCP]] |
| MCP 客户端 + MCP 服务端(远程 agent) | 🔌 按钮 / 配置 | [[Tools-and-MCP]] |
| 长期记忆 + 记忆图谱 | 🧠 按钮 | [[Long-Term-Memory]] |
| 插件系统 v2.2(工具/面板/hooks) | 🔌 插件按钮 | [[Plugin-System]] |
| Skills / Commands / Agents | `/` 或 ⚡ | [[Skills]] |
| Pipeline(跨引擎编排) | 编程式调用 | [[Pipeline]] |
| 会话分支 + 导出/导入 | 右键菜单 / MCP | [[Session-Management]] |
| 上下文检查器 + 压缩可视化 | 聊天头部检查器按钮 | [[Direct-Engine]] |
| 文件浏览 + 多标签预览 | 🌐 按钮 / "文件" tab | [[Files-and-Preview]] |
| Git status / history / diff / commit show | "Git" tab | [[Git-Integration]] |
| 项目规则 + 项目上下文 | "规则" tab / 工作台"背景" | [[Rules-and-Context]] |
| 工作台(项目卡片概览) | 📂 按钮 | [[Workbench]] |
| 仪表盘(成本/token 分析) | 📊 按钮 | [[Dashboard]] |
| Town 视图(远程节点可视化) | 🏘️ 按钮 | [[Town]] |
| 实时语音对话(豆包 WS) | 聊天区 🎤 | [[Voice-Chat]] |
| 多模态(图片 + 语音 + 截图) | 聊天区 📎 / 🎤 / 📸 | [[Multimodal]] |
| 全局搜索(所有会话) | `Ctrl/Cmd+K` | [[Global-Search]] |
| 设置(API / 行为 / 价格 / 界面 / 记忆) | ⚙ 按钮 | [[Settings]] |
| 全局热键快速面板 | `Ctrl/Cmd+Alt+Space` | [[Global-Hotkey]] |
| 四语言切换 | ⚙ → 界面 → 语言 | [[i18n]] |
| 架构概览(main / preload / renderer) | — | [[Architecture]] |
| 开发与打包(typecheck / build / dist / CI) | — | [[Development]] |

## 约定

- 英文为主;中文(`.zh-CN.md`)为可切换镜像。
- 代码标识符、CLI flag、文件名在两个版本中保持英文。
- 跨页链接用 `[[Page-Name]]`(GitHub wiki 自动渲染;文件名对应 `Page-Name.md`)。
- 代码引用用 `src/path/file.ts:line` —— 本地 repo 里可点击。
- 代码中 `ponytail:` 标记是有意的 MVP 简化。

## 把 wiki 推到 GitHub

本 wiki 的 markdown 源在主 repo 的 `wiki/` 目录。推到 GitHub wiki 的方法见 [[Wiki-Sync]]。
