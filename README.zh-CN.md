# KinetAios

[English](README.md) | 简体中文

本地 AI agent 仪表盘,**跨平台(Windows 11 + macOS)**。并发跑多个会话、流式答案、shell/文件/搜索/MCP 工具、SQLite 历史 + 记忆、全局热键、每会话独立模型。

> 产品名可在 `brand.json` 里改(`productName`),所有界面显示处启动时读取。
> macOS 原版(原生 SwiftUI)在上一级目录 `../KinetAios`,两个项目**不共享代码** —— 这版是行为对齐的 TypeScript 重写(Electron)。

## 技术栈

- **Electron + TypeScript** —— 主进程跑 agent 运行时,渲染进程是原生 web UI。
- **better-sqlite3** —— SQLite + FTS5(历史 / `recall_memory` 全文搜索)。
- **无前端框架** —— 渲染层纯 vanilla TS + HTML/CSS,esbuild 打包。

## 功能

### 三个引擎(每会话可切,切换清跨引擎上下文)
- **Direct(Kaios)**:内置 ReAct 循环 + GLM/OpenAI 兼容 & Anthropic **双向 SSE 流式** Provider,带工具级并发、子 agent、上下文压缩与重试。
- **Claude Code**:spawn `claude -p --output-format stream-json`,解析 NDJSON,`--resume` 续接。
- **Codex**:spawn `codex exec --json`,解析 JSONL,`resume` 续接。

### Direct 工具(9 个)
`shell`(执行前确认)、`read_file`、`write_file`、`edit_file`(精确替换)、`grep`(递归搜内容)、`glob`(列文件)、`web_fetch`、`recall_memory`、`dispatch_agent`(只读子 agent —— 复用 ReAct 循环、独立上下文)。Claude/Codex 用各自 CLI 的工具体系。

### MCP
Direct 引擎自动接入系统配置的 MCP 服务(扫描 `~/.claude.json` / `~/.codex/config.toml` / Claude Desktop),stdio 客户端,工具并入 ReAct;意外断开自动重连。🔌 按钮可查看已连服务/工具。

### Skills / Commands / Agents
扫描 Claude Code 的 skills + commands + agents(含已装 plugin 的内容)和 Codex 的 skills,`/` 菜单或 ⚡ 按钮调用,body 注入 Direct。

### 其它
- **四语言 UI**:English / 简体中文 / 繁體中文 / 日本語,设置里切换(给模型看的字符串仍中文)
- **每会话独立模型**(可编辑下拉,OpenAI 兼容 + Anthropic 双协议)
- **文件附件**:📎 选 / 拖入多个文本文件(大文件只读开头),`@路径` 引用 cwd 内文件
- **AGENTS.md / CLAUDE.md**:cwd 下的规则文件自动注入 system prompt
- **长期记忆**:每轮后台抽取「关于用户的持久事实」注入下轮
- **托盘 + 全局热键** `Ctrl/Cmd+Alt+Space` 唤出快速面板(关窗即退出,热键运行时生效)
- **可配置品牌**(`brand.json`)、**API key 加密存储**(safeStorage:mac Keychain / Win DPAPI)
- 聊天左右气泡 + 头像、流式 + 思考中反馈、成本/token 统计

## 跑起来(Windows 11 / macOS)

需要 **Node.js 18+** 和联网(native 模块 `better-sqlite3` 要编译)。

```sh
cd KinetAiosWin
npm install      # 含 postinstall:为 Electron 重编 better-sqlite3
npm run build
npm start
```

> 国内网络 `npm install` 拉 Electron 二进制可能超时 —— `.npmrc` 已配 npmmirror 镜像,失败时也可手动 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`。

首次启动:点右上角 ⚙ → 填 **API Key**(+ Base URL / 模型,默认 GLM 智谱)→ 「测试连接」通了再发任务。

## 目录结构

```
KinetAiosWin/
  brand.json               # 产品名等品牌配置(启动读)
  package.json
  src/
    shared/types.ts         # 类型 + applyEvent(主/渲染共用,单一事实源)
    shared/i18n.ts          # 四语言字符串表 + t()
    main/
      main.ts               # 窗口 / 托盘 / 热键 / IPC / shell 确认桥
      TaskManager.ts        # 会话管理 + 引擎分派 + 记忆抽取
      engines.ts            # Engine 接口 + Direct/ClaudeCode/Codex + 跨平台 CLI spawn
      AgentLoop.ts          # ReAct 循环(Direct)+ 历史压缩 + 超长自缩
      glm.ts                # Provider + OpenAI/Anthropic SSE 流式 + 重试
      tools.ts              # 9 个工具 + 跨平台 shell(cmd.exe / sh)+ dispatch_agent
      mcp.ts                # MCP 客户端(扫描 + stdio + 重连)
      skills.ts             # skills/commands/agents/plugin 扫描
      brand.ts              # 品牌配置读取
      store.ts              # better-sqlite3 + FTS5
      settings.ts           # 配置(API key 加密落盘,lang)
    preload/preload.ts      # contextBridge 暴露的窄 API
    renderer/
      index.html quick.html styles.css
      app.ts                # 仪表盘逻辑
      quick.ts              # 快速面板逻辑
      markdown.ts           # 迷你 markdown 渲染
```

## 构建 / 开发

```sh
npm run build       # tsc 编译主进程 + esbuild 打包渲染进程 + 拷 brand.json
npm run typecheck   # 两边 typecheck(不产出)
npm start           # 启动(需先 build)
npm run dev         # build + start
```

## 打包

```sh
npm run dist         # 当前平台默认目标
```

- **Windows**:`release\KinetAios Setup <ver>.exe`(NSIS)。**必须在 Windows 上打**(mac 跨平台打 Windows + native 模块不可靠)。
- **macOS**:打 dmg。`npx electron-builder --mac`(需 mac 工具链)。
- electron-builder 会按 Electron 的 ABI 自动重编 `better-sqlite3`;`asar: false` 避免 native 模块在 asar 里加载报错。
- **未代码签名** → Windows SmartScreen / macOS Gatekeeper 会警告,手动放行。要消警告需签名证书 + Apple 公证。
- 图标默认是 Electron 的;换自己的:Windows 放 `build/icon.ico`(256×256),mac 放 `build/icon.icns`。

## 已知约束

- **关窗即退出**(不再后台常驻);全局热键只在 app 运行时生效。想要「关窗后台 + 热键常驻」可改回隐藏模式。
- 代码库索引/语义检索、子 agent、图片多模态、IDE 插件等见 `FEATURES.md` 路线图(未做)。
