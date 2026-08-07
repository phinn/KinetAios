> 🌐 Language: [English](Messaging-Bots.md) | **中文**

# 消息机器人

KinetAios 可以通过 WebSocket 长连接接收**飞书**和**企业微信**消息,路由到任意 Agent 引擎处理后回复 —— 还能自动发送 Agent 产出的文件/图片。

这把你的 IM 应用变成了远程 Agent 终端:发一条文本消息,得到带文件附件的 AI 回复。

## 支持平台

| 平台 | SDK | 连接方式 |
|---|---|---|
| 飞书 / Lark | `@larksuiteoapi/node-sdk` | WebSocket 长连接 |
| 企业微信 | `@wecom/aibot-node-sdk` | WebSocket 长连接 |

均使用官方 SDK,内置心跳保活、断线指数退避重连、消息幂等去重。

## 配置

### 飞书

1. 进入[飞书开放平台](https://open.feishu.cn/app)→ 创建应用
2. 开启**机器人**能力
3. **事件订阅**中切换为**长连接模式**(非 HTTP 回调)
4. 订阅 `im.message.receive_v1` 事件
5. 复制 **App ID** 和 **App Secret** → 粘贴到 设置 → **消息** tab

### 企业微信

1. 进入[企业微信开发者后台](https://developer.work.weixin.qq.com/)→ 创建智能机器人
2. 从机器人管理页复制 **Bot ID** 和 **Secret**
3. 粘贴到 设置 → **消息** tab

### 配置字段

| 字段 | 说明 |
|---|---|
| 启用 | 开关机器人。切换后自动重连 |
| App ID / Bot ID | 飞书 App ID 或企微 Bot ID |
| App Secret / Secret | 对应密钥 |
| 引擎 | 处理消息的 Agent 引擎:`direct` / `directV2` / `claudeCode` / `codex` |
| 流式回复 | 开 → 先发"⏳ 正在思考…"占位,完成后替换为答案 |
| 默认工作目录 | Agent 工具调用(shell、文件操作)的工作目录 |

## 消息路由流程

```
IM 用户发送消息
    ↓
SDK WebSocket 接收
    ↓
Bridge (feishu.ts / wecom.ts) 归一化为文本
    ↓
斜杠指令? ── 是 → 立即处理并回复
    ↓ 否
入 per-user 串行队列
    ↓
TaskManager.send(convId, text)
    ↓
引擎处理(ReAct 循环 / CLI 调用)
    ↓
从最后一轮提取答案
    ↓
提取产出物(工具输出中的文件/图片路径)
    ↓
回复文本 + 上传并发送附件
```

## 斜杠指令

用户可直接在 IM 聊天中管理会话 —— 无需打开桌面端。

| 指令 | 动作 |
|---|---|
| `/new` | 开启新对话(清除当前上下文) |
| `/reset` | 清空当前会话的对话历史(保留会话,抹掉 turns) |
| `/list` | 显示最近 5 个会话,含时间戳和轮次 |
| `/switch N` | 切换到 `/list` 中的第 N 个会话 |
| `/context` | 显示当前会话信息(轮次、token、费用、cwd) |

无法识别的 `/...` 会显示帮助文本。

## 会话管理

### 按用户复用会话

同一用户的消息自动路由到同一会话,保持多轮上下文。映射 key 取决于聊天类型:

| 聊天类型 | Key 格式 | 行为 |
|---|---|---|
| 飞书单聊 | `feishu:${open_id}` | 每用户独立会话 |
| 飞书群聊 | `feishu:group:${chat_id}` | 全群共享一个会话 |
| 企微单聊 | `wecom:${userid}` | 每用户独立会话 |
| 企微群聊 | `wecom:group:${chatid}` | 全群共享一个会话 |

### 持久化

`feishuKey` / `wecomKey` 存储在 SQLite 的 `Conversation` 记录上。应用重启时,Bridge 扫描所有会话重建内存 `Map<key, convId>`。Map 查找未命中时,fallback 到 SQLite 全扫描。

### 淘汰机制

每个用户(或群)最多保留 **5 个会话**。超出时自动删除最旧的会话。

### 并发消息处理

同一用户的消息通过 per-user promise chain(`enqueue()`) **串行处理**。如果用户 A 快速连发 3 条消息,它们排队逐一执行。不同用户的消息并行处理。

这替代了旧的轮询方案(`while + setTimeout(2000)` 阻塞 120 秒)。

## 文件/图片自动发送(仅飞书)

当 Agent 在工具执行过程中产出文件或图片时,Bridge 自动:

1. **提取**工具输出(`write_file`、`shell`、`read_file`、`feishu_send_file`)中的文件路径
2. **上传**每个文件到飞书(`im.image.create` / `im.file.create`)
3. **回复**图片/文件类型的富媒体消息

支持类型:PNG、JPG、GIF、WebP(图片);PDF、DOC、XLS、PPT、MP4、MP3(文件)。

Agent 也可通过 `feishu_send_file` 工具主动发送文件。

## 来源提示

当会话来源是飞书或企微时,系统提示词中注入来源提示,让 Agent 知道它通过 IM 渠道通信:

- **飞书**:"你在飞书对话中回复。保持回复简洁。使用 `feishu_send_file` 发送文件。"
- **企微**:"你在企业微信对话中回复。保持回复简洁(支持 markdown,最长约 4000 字)。"

## 关键源文件

| 文件 | 职责 |
|---|---|
| `src/main/feishu.ts` | FeishuBridge:WS 连接、消息处理、文件上传 |
| `src/main/wecom.ts` | WeComBridge:WS 连接、消息处理 |
| `src/main/engines.ts` | `sourceHintSection()` — 注入 IM 上下文到系统提示词 |
| `src/main/tools.ts` | `feishuSendFile` 工具注册 |
| `src/shared/types.ts` | `FeishuBotConfig`、`WeComBotConfig`、`feishuKey`、`wecomKey` 字段 |
| `src/main/settings.ts` | 机器人默认配置 |
| `src/main/main.ts` | IPC handler、启动自动连接、设置变更重连 |
