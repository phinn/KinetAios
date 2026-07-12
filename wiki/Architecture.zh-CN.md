> 🌐 Language: [English](Architecture) | **中文**

# 架构总览

KinetAios 是 Electron + TypeScript 应用,典型的三进程模型。

## 三层结构

```
┌────────────────────────────────────────────────────────┐
│  Main process (src/main/*)                            │
│  - app 生命周期、窗口、全局热键、IPC handler           │
│  - agent 运行时(三引擎)、SQLite、settings、CLI spawn │
│  - 完整 Node 访问                                     │
└────────────────────────────────────────────────────────┘
              ▲
              │ contextBridge (typed KinetAPI)
              ▲
┌────────────────────────────────────────────────────────┐
│  Preload (src/preload/preload.ts)                     │
│  - 唯一桥:把 KinetAPI 绑到 window.kinet               │
│  - ipcRenderer.invoke / on → ipcMain.handle / on      │
└────────────────────────────────────────────────────────┘
              ▲
              │ window.kinet.*
              ▲
┌────────────────────────────────────────────────────────┐
│  Renderer (src/renderer/*)                            │
│  - vanilla TS + HTML/CSS,esbuild bundle               │
│  - 无 Node 访问(contextIsolation: true)              │
│  - dashboard / quick panel / files window             │
└────────────────────────────────────────────────────────┘
```

## 单一真理源:`shared/types.ts`

`src/shared/types.ts` 被 main 和 renderer 同时 import,**纯类型 + 纯函数**(无 Node/DOM API)。

里面关键的东西:

- 所有共享类型(`Conversation`、`Turn`、`ChatMsg`、`AgentEvent`、`AppSettings`…)
- **`applyEvent(conv, ev)`** —— 把一个流式事件 fold 到当前 turn 的状态。**main 写入前调一次,renderer 渲染时调同一次**。事件如何更新状态改这一个地方就够(Swift 原版的 `apply()` 也是同思路)。
- `KinetAPI` interface —— preload 暴露给 renderer 的**契约**。

## `KinetAPI`:三层契约

加一个 main↔renderer 的能力 = 三处同步:

1. `KinetAPI` 加方法签名(`src/shared/types.ts`)
2. preload 加 `ipcRenderer.invoke` / `on`(`src/preload/preload.ts`)
3. main 加对应 `ipcMain.handle` / `on`(`src/main/main.ts`)

任一处缺失 → renderer 调用直接报错。三处对得上才能 ship。

`KinetAPI` 当前覆盖的方法见 `src/shared/types.ts:133`。粗分:
- 会话管理:`newConversation` / `send` / `cancel` / `deleteConversation` / `clearConversation` / `rename` / `setCwd` / `setEngine` / `setModel`
- 设置:`getSettings` / `saveSettings` / `testConnection`
- 文件:`pickDirectory` / `readFile` / `fileRead` / `fileWrite` / `listDir` / `shellOpen`
- Git:`gitSnapshot` / `gitDiff`
- 规则:`readRules` / `writeRules` / `readContext` / `writeContext`
- 记忆:`memoryList` / `memoryUpdate` / `memoryDelete` / `memoryExport` / `memoryImport`
- Skills / MCP:`listSkills` / `listMcp`
- 事件流:`onAgentEvent` / `onFilesCwd` / `onConversation` / `onConversationRemoved` / `onConfirmRequest` + `confirmResponse`
- 窗口:`openDashboard` / `openFiles` / `quickSubmit`

## 统一事件模型

每个引擎(Direct / Claude Code / Codex)都把自家流式格式 normalize 成同一个 `AgentEvent` union:

```ts
type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; args: string; result: string }
  | { type: 'cost'; usd: number; tokens: number; tokensIn?: number; tokensOut?: number }
  | { type: 'status'; text: string }
  | { type: 'sessionStarted'; id: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

引擎只管发事件;`TaskManager` 接到 → `applyEvent` 更新 `Conversation` → 持久化 → 推给 renderer → renderer 也调 `applyEvent` 更新视图。**一处定义,两边共用**。

## Main 进程的关键模块

| 模块 | 职责 |
|---|---|
| `main.ts` | 窗口、托盘、热键、IPC、shell-confirm 桥 |
| `TaskManager.ts` | 会话生命周期 + 引擎分发 + 后台记忆抽取 |
| `engines.ts` | `Engine` interface + 三实现 + 跨平台 CLI spawn |
| `AgentLoop.ts` | Direct 的 ReAct loop + 历史压缩 + 反应式 trim |
| `glm.ts` | Provider + OpenAI/Anthropic SSE 双协议流式 + 重试 |
| `tools.ts` | 10 个内置工具 + 跨平台 shell + dispatch_agent |
| `mcp.ts` | MCP client(扫描 + stdio + 重连) |
| `skills.ts` | skills / commands / agents / plugin 扫描 |
| `store.ts` | better-sqlite3 + FTS5 schema |
| `settings.ts` | 配置(API key 加密、语言) |

## Renderer 的关键模块

| 模块 | 职责 |
|---|---|
| `app.ts` | 主窗口逻辑(聊天 / 文件 / Git / 规则 tab) |
| `quick.ts` | 全局热键的快速面板 |
| `dashboard.ts` | 独立 metrics 窗口 |
| `files-pane.ts` | 文件树 + webview + 编辑器(独立窗口 & 内联 tab 共用) |
| `markdown.ts` | 极简 markdown 渲染器 |
| `i18n.ts`(shared) | 四语言 string table + `t(lang, key, params)` |

## SQLite schema

详见 `src/main/store.ts`。三张主要表:

- **`conversations`** + **`turns`** —— 会话与轮次(turn body 存为 JSON)
- **`history`** —— FTS5 虚表,供 `recall_memory` 全文搜
- **`memories`** —— 抽取出的长期事实(跨会话、跨引擎)

Schema 在 init 时幂等 migrate(`hasColumn` 防 ALTER 报错)。详见 [[Long-Term-Memory]]。

## Shell-confirm 桥

`shell`(Direct)和沙箱化的 CLI 引擎可能需要用户预批准。Main 不能弹 UI,所以 `main.ts` 的 `confirm()` 发 `confirm-request` 到 dashboard 窗口,把 resolver 暂存到 `pendingConfirms` map;renderer 的 modal 回 `confirm-response`;main 找到对应 resolver 解掉。

`approval: 'never'` 直接绕过(不弹)。

## 三引擎抽象

```ts
interface Engine {
  readonly name: EngineKind;
  run(opts: EngineRunOpts): Promise<void>;
}
```

三实现:`DirectEngine`(内置 ReAct)、`ClaudeCodeEngine`(spawn `claude -p`)、`CodexEngine`(spawn `codex exec`)。`TaskManager` 拥有所有会话,按 conv.engine 分发。详见 [[Engines]]。
