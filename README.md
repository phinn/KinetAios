# KinetAiosWin

KinetAios 的 **Windows 11 版本**。同一产品(本地 AI agent 仪表盘:并发跑任务、流式答案、shell/文件/抓网页/记忆工具、SQLite 历史、全局热键),换成了 Windows 能跑的技术栈。

> macOS 原版(原生 SwiftUI)在上一级目录 `../KinetAios`。两个项目**不共享代码** —— Swift/SwiftUI 不能跑 Windows GUI,这版是行为对齐的 TypeScript 重写。

## 技术栈

- **Electron + TypeScript** —— 主进程跑 agent 运行时,渲染进程是原生 web UI。
- **better-sqlite3** —— SQLite + FTS5(历史 / `recall_memory` 全文搜索),与原版 schema 同构(MVP 子集)。
- **无前端框架** —— 渲染层纯 vanilla TS + HTML/CSS,esbuild 打包。

## 范围(已实现)

- **三个引擎**(chat-head 下拉切换,切换清跨引擎上下文):
  - **Direct(Kaios)**:`AgentLoop`(ReAct)+ GLM/OpenAI 兼容 & Anthropic **双向 SSE 流式** Provider(逐行移植自 `GLMProvider.swift`)。
  - **Claude Code**:spawn `claude -p --output-format stream-json`,解析 NDJSON 事件(`stream_event`/`assistant`/`user`/`result`/`system.init`),`--resume` 续接,`--append-system-prompt` 注入记忆(逐行移植自 `ClaudeCodeEngine.swift`)。
  - **Codex**:spawn `codex exec --json`,解析 JSONL(`item.completed`/`turn.completed`/`command_executed` 等),`resume` 续接,记忆前置进 prompt(逐行移植自 `CodexEngine.swift`)。
- 跨平台 CLI spawn:Windows `.cmd` 走 `shell:true`(Node 对 .cmd 直启有限制),unix/`.exe` 直启干净 argv;PATH 注入 npm-global 等常见目录。
- 5 个工具(Direct 专用):`shell`(执行前确认)、`read_file`、`write_file`、`web_fetch`、`recall_memory`。Claude/Codex 用各自 CLI 的工具体系。
- 仪表盘 UI:会话列表(实时状态点)+ 多轮详情(流式答案 + 工具步骤)+ 输入条 + 引擎下拉 + 设置面板(含沙盒/计划模式)。
- **全局热键** `Ctrl+Alt+Space` 唤出快速面板。
- SQLite 持久化:会话/轮/跨轮上下文/CLI session id(重启可 `--resume`)/长期记忆。
- 长期记忆:每轮后台抽取「关于用户的持久事实」注入下轮。

**暂不做(原版有,这版留到以后)**:群聊、营销工作台、Scout、OpenClaw 引擎、终端/文件/命令面板、License、自动更新、项目扫描。

## 在 Windows 11 上跑起来

需要 **Node.js 18+**(自带 npm)和联网(native 模块 `better-sqlite3` 要编译)。

```bat
cd KinetAiosWin
npm install
npm run build
npm start
```

首次启动:点右上角 ⚙ → 填 **API Key**(+ Base URL / 模型,默认 GLM 智谱)→ 「测试连接」通了再发任务。

> 全局热键 `Ctrl+Alt+Space` 唤出快速面板(可改 `src/main/main.ts` 里的 `CommandOrControl+Alt+Space`)。

## 目录结构

```
KinetAiosWin/
  package.json
  tsconfig.main.json        # 主进程 + preload(CommonJS)
  tsconfig.renderer.json    # 渲染进程(DOM,仅 typecheck)
  src/
    shared/types.ts         # 类型 + applyEvent(主/渲染共用,单一事实源)
    main/
      main.ts               # 窗口 / 热键 / IPC / shell 确认桥
      TaskManager.ts        # 会话管理 + 引擎分派 + 记忆抽取
      engines.ts            # Engine 接口 + Direct/ClaudeCode/Codex + 跨平台 CLI spawn
      AgentLoop.ts          # ReAct 循环(Direct 用)
      glm.ts                # Provider + OpenAI/Anthropic SSE 流式
      tools.ts              # 5 个工具 + 跨平台 shell(cmd.exe / sh)
      store.ts              # better-sqlite3 + FTS5
      settings.ts           # JSON 配置(userData/settings.json)
    preload/preload.ts      # contextBridge 暴露的窄 API
    renderer/
      index.html quick.html styles.css
      app.ts                # 仪表盘逻辑
      quick.ts              # 快速面板逻辑
      markdown.ts           # 迷你 markdown 渲染(转义 + 仅 http(s) 链接)
```

## 构建 / 开发

```bat
npm run build       # tsc 编译主进程 + esbuild 打包渲染进程
npm run typecheck   # 两边都 typecheck(不产出)
npm start           # 启动(需先 build)
npm run dev         # build + start
```

## 打包成 Windows 安装包(NSIS `.exe`)

**必须在 Windows 上打**(mac 跨平台打 Windows + native 模块不可靠,也没法验证)。

```bat
cd KinetAiosWin
npm install
npm run dist
```

产出 `release\KinetAios Setup 0.1.0.exe`(NSIS 安装包:可选安装目录、建桌面/开始菜单快捷方式)。只试装不出安装包:`npm run pack` → `release\win-unpacked\KinetAios.exe`。

- electron-builder 会按 Electron 的 ABI 自动重编 `better-sqlite3`(Windows 工具链);`asar: false` 避免 native 模块在 asar 里加载报 `cannot find module .node`。
- 配置在 `package.json` 的 `"build"` 块(productId、安装包行为、target=nsis)。
- **未代码签名** → 首次运行 Windows SmartScreen 会警告,点「更多信息 → 仍要运行」。要消警告需代码签名证书。
- 图标默认是 Electron 的;换自己的放 `build/icon.ico`(256×256)。

## 已知约束

- **API key 明文存** `userData/settings.json`。单用户本地 dev tool 够用;正式分发前换 Windows Credential Manager。
- **这版无法在 macOS 上构建验证 Windows 二进制** —— 但代码可在这台 mac 上 `npm install` + `npm run typecheck` + `npm start`(Electron 跨平台,核心逻辑能冒烟跑)。真·Windows 行为(cmd.exe shell、路径、热键)需在 Windows 上验。
