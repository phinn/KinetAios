> 🌐 Language: [English](MCP-Server.md) | **中文**

# MCP Server

KinetAios 内置 **MCP (Model Context Protocol) Server** —— 一个 HTTP+SSE 端点,把你的本地 agent 暴露给远程机器。其他 KinetAios 实例(或任何 MCP 兼容客户端)可以调用 `run_agent` 在你的机器上跑任务,拥有完整工具权限。

这是 [[Town]] 远程协作功能的基础。

## 工作原理

```
远程机器                                 你的机器(MCP Server)
     │                                            │
     │  POST /mcp  (JSON-RPC over HTTP)           │
     │  Authorization: Bearer <token>             │
     │ ─────────────────────────────────────────> │
     │                                            │  → run_agent(prompt, cwd, engine)
     │                                            │  → TaskManager 分发到引擎
     │                                            │  → 流式推送 AgentEvent
     │  <── SSE: data: {type:"token",...} ──────  │
     │  <── SSE: data: {type:"tool",...}  ──────  │
     │  <── SSE: data: {type:"done"}     ──────  │
     │                                            │
```

## 配置

在 **⚙ 设置 → 行为**:

| 设置 | 说明 |
|---|---|
| MCP Server 启用 | 开关 HTTP 监听 |
| 端口 | 默认 `0`(随机)→ 启动后状态栏显示实际端口 |
| Token | 自动生成;所有请求必须携带 |

服务端绑定 `0.0.0.0`(局域网可访问)。Token 在服务运行时显示在状态栏。

## 鉴权

- **Bearer token** 放在 `Authorization` 头(通过 HMAC-SHA256 归一化后恒定时间比较 —— 无长度时序泄漏)。
- SSE 端点**拒绝 URL 参数传 token**(防止被代理/CDN 日志记录)。
- 每条连接 5 分钟空闲超时。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/mcp` | JSON-RPC:`tools/list`、`tools/call`(`run_agent` 返回 SSE 流) |
| `GET` | `/mcp` | SSE 事件流(实时 agent 事件,只读) |
| `GET` | `/` | 健康检查:`{ ok: true, server, mcp: true }` |

## `run_agent` 工具

主要的远程工具。接受:

```json
{
  "prompt": "修复 src/utils.test.ts 里的失败测试",
  "cwd": "/home/user/project",
  "engine": "direct",
  "model": "glm-4.6"
}
```

返回 SSE 流,推送 `AgentEvent`(`token`、`tool`、`cost`、`status`、`done`、`error`)—— 与内部使用的统一事件联合类型一致。

### cwd 授权边界

`cwd` 可选,但**必须**落在运维方授权的根目录内。用 `KINET_MCP_CWD` 环境变量声明授权根(按路径分隔符分隔,如 `KINET_MCP_CWD=/home/user/project:/home/user/work`):

- 包含性校验在 agent 派发**之前**执行 —— `cwd` 越界直接拒绝,**零执行**(不发 prompt、不调任何工具)。
- 未声明授权根时,边界默认取用户 home 目录。
- 通用工具回退路径对 `cwd` 参数走同一道闸。

## 其他暴露的工具

- `list_conversations` —— 列出本地会话
- `export_session` —— 序列化会话用于交接(自动脱敏 API key/密码)
- `import_session` —— 反序列化会话(验证消息结构、role 白名单、长度限制)
- `sync_memories` —— 在机器间推送/拉取长期记忆(按 content 去重)
- `search_history` —— FTS5 全文搜索所有会话

## 安全

- **导出脱敏**:`exportSession` 在序列化前剥离匹配常见模式的 API key、密码和 token(`sk-...`、`api_key=...` 等)。
- **导入验证**:`importSession` 验证消息 role(白名单:system/user/assistant/tool)、content 类型,并强制长度限制(500 条消息、每条 50K 字符)。
- **僵尸连接清理**:SSE 连接追踪 backpressure;连续 3 次 write 失败 → destroy + 移出活跃列表。

## 关键源文件

- `src/main/mcp-server.ts` —— HTTP 服务、SSE 流、工具分派、鉴权
- `src/main/TaskManager.ts` —— `runAgent`、`exportSession`、`importSession`、`syncMemories`
- `src/shared/types.ts` —— `AgentEvent` 联合类型、`McpTool` 类型
