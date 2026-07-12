> 🌐 Language: [English](Tools-and-MCP) | **中文**

# 工具系统 + MCP

Direct 引擎内置 10 个工具 + 自动接入系统配置的 MCP 服务。Claude Code / Codex 用各自 CLI 的工具,不走这套。

## 10 个内置工具

| 工具 | 类型 | 用途 |
|---|---|---|
| `shell` | 写 | 跑 shell 命令(Windows 走 cmd.exe,Unix 走 sh)。**会先弹确认 modal**(除非 setting `approval: 'never'`) |
| `read_file` | 只读 | 读文件内容。返回 UTF-8 文本 |
| `write_file` | 写 | 写文件(path + content 直传,**唯一正确方式**;几 KB ~ 几百 KB 一次到位) |
| `edit_file` | 写 | 精准替换(`old_string` → `new_string`,`replace_all` 可选) |
| `grep` | 只读 | 递归内容搜索。返回匹配行 + 行号 |
| `glob` | 只读 | 按模式列文件(`**/*.ts`) |
| `web_fetch` | 只读 | 抓 URL,返回 markdown 化的正文 |
| `recall_memory` | 只读 | FTS5 全文搜历史(`history` 表) |
| `git_diff` | 只读 | 读 git diff(file / ref / cached 参数)。**不弹确认**(只读) |
| `dispatch_agent` | 写 | 派发只读子 agent(独立 history,见 [[Direct-Engine]]) |

## `shell` 工具

```
shell({ cmd: string, cwd?: string }) → string
```

- Windows 走 `cmd.exe /c <cmd>`
- Unix 走 `sh -c <cmd>`
- 输出合并 stdout + stderr,加 exit code
- **默认要确认**:renderer 弹 modal 显示命令,用户点确定才执行
- `approval: 'never'` 直接放行(不弹)

确认桥的细节见 [[Architecture]] 的「Shell-confirm 桥」。

## `write_file` 工具(重点)

baseSystemPrompt 反复强调:

> 写文件的唯一正确方式是 write_file 工具(path + content 直传)。
> write_file 没有长度限制,几 KB、几十 KB、几百 KB 都可以一次性写入。
> 永远不要因为「内容太长」而改用 shell echo/cat/heredoc,或 powershell Set-Content,或 base64 decode。
> 那些 shell/powershell 方式在 JSON+shell 双层转义下几乎必崩。

模型偶尔会想偷懒走 shell heredoc(看起来一行命令更短),系统提示明确禁止。理由:JSON arg 转义 + shell 引号转义 双层叠加,几乎必出错。

## `edit_file` 工具

```
edit_file({ path: string, old_string: string, new_string: string, replace_all?: boolean })
```

精准字符串替换。`old_string` 必须唯一(不唯一 + 没 `replace_all: true` → 失败,提示模型加更多上下文)。

适合小改;大改用 `write_file` 整个重写。

## `git_diff` 工具

```
git_diff({ file?: string, ref?: string, cached?: boolean })
```

参数组合:
- `{}` —— 整个 working tree 的 diff
- `{ file: "src/x.ts" }` —— 单文件 diff
- `{ ref: "main" }` —— 和分支比
- `{ cached: true }` —— 已 staged 的 diff(`--cached`)
- `{ file, ref }` —— 单文件和分支比

**只读,不弹确认**。是 Direct 引擎 v1.0 加的。

## 工具定义 + ToolCtx

工具定义在 `src/main/tools.ts`:

```ts
interface Tool {
  name: string;
  description: string;
  readOnly?: boolean;       // 决定能否并发
  parameters: JSONSchema;   // OpenAI/Anthropic tool schema
  run(args, ctx: ToolCtx): Promise<string>;
}
```

`ToolCtx` 是工具运行时上下文:`cwd`、`confirm`、`signal`、`spawn`(供 dispatch_agent 派子 agent)。

## 工具调用执行:并发 vs 串行

`runToolBatch`(`AgentLoop.ts:197`):

- 收集连续的只读段(`readOnly: true`)→ `Promise.all` 并发
- 遇到写工具 → 串行单个执行
- 结果按原 `toolCalls` 顺序回填(`tool_call_id` 配对)

为什么这样设计:
- 只读无副作用,并发跑省时间(读 5 个文件 = 5x 加速)
- 写工具有顺序依赖(shell 改了文件再 read_file 才能看见)→ 必须串行

## MCP(Model Context Protocol)

`src/main/mcp.ts`。

### 自动发现

启动时扫:
- `~/.claude.json`(Claude Desktop 配置)
- `~/.codex/config.toml`(Codex 配置)
- Claude Code 的 plugin 配置

提取所有 stdio MCP 服务配置(`command` + `args` + `env`),给每个起一个 client。

### 接入

- 每个 client 走 stdio(spawn 子进程,JSON-RPC 通信)
- 启动时调 `tools/list` 拿工具清单
- Direct 引擎每轮等最多 2s 让连接就绪,然后把所有 MCP 工具 merge 进 `tools` 数组
- 工具名前缀服务名(防冲突):`mcp__<server>__<tool>`
- 调用走 `tools/call`,结果 normalize 成字符串

### 自动重连

stdio 子进程挂了 → 自动重启 + 重新 `tools/list`。下一个 turn 又能用。

### 🔌 按钮

主窗口底部 **🔌 MCP** 按钮点开:列出当前连接的 MCP 服务 + 每个服务暴露的工具。**只读展示**,不能在这里改配置(改 `~/.claude.json` / `~/.codex/config.toml`,重启 app)。

## 工具结果截断

`truncateForModel`(`AgentLoop.ts:250`):

- 头尾各 3000 字符
- 中间 `…[省略 N 字符]…`
- 阈值 8192

**只截喂给模型的版本,UI 拿完整原文**(点步骤详情可见全)。详见 [[Direct-Engine]]。

## 何时扩展工具

加新工具:

1. `src/main/tools.ts` 加 `Tool` 实现(name / description / parameters / run)
2. 加进 `allTools()` 或 `readOnlyTools()`(看是否只读)
3. typecheck → ship

不需要改 AgentLoop、不改 glm、不改 IPC。ReAct loop 自动发现。

加 MCP 工具:**不用改代码**。装在本机的 MCP 服务自动被扫到。
