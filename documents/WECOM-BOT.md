# 企业微信智能机器人接入指南

> KinetAios 通过 `@wecom/aibot-node-sdk` 接入企业微信「智能机器人」的 WebSocket 长连接模式。
> 企信用户 @机器人 → KinetAios Agent 处理 → 回复到企信。

---

## 一、前提条件

| 条件 | 说明 |
|---|---|
| 企业微信管理员 | 需要管理后台权限来创建机器人 |
| 企业微信版本 | 智能机器人为较新功能，建议确认企信已更新至最新版 |
| KinetAios ≥ 2.2.0 | 已内置 `@wecom/aibot-node-sdk` |
| API Key | KinetAios 设置中至少配好一个引擎的 API Key（如智谱 GLM） |
| 运行环境 | KinetAios 需保持运行状态，关掉即断连 |

---

## 二、在企业微信管理后台创建智能机器人

### 步骤 1：进入智能机器人管理页

1. 浏览器打开 **企业微信管理后台**：https://work.weixin.qq.com/
2. 用管理员的企业微信扫码登录
3. 进入 **「应用管理」→「智能机器人」**

> 如果找不到入口，直接访问：https://work.weixin.qq.com/wework_admin/robot

### 步骤 2：创建机器人

1. 点击 **「创建机器人」**（或「新建」）
2. 填写机器人名称（如「AI 助手」）和描述
3. 选择可见范围（哪些部门/成员可以使用）
4. 完成创建

### 步骤 3：获取 Bot ID 和 Secret

创建完成后，在机器人的 **「开发配置」** 或 **「API 配置」** 页面，你会看到：

| 凭证 | 说明 |
|---|---|
| **Bot ID** | 机器人的唯一标识（形如 `1234567890abcdef`） |
| **Secret** | 调用密钥（形如 `xxxxxxxxxxxxxxxxxxxxxxxxxx`），点击「重置」可获取 |

> ⚠️ Secret 只在创建/重置时显示一次，请立即复制保存。

### 步骤 4：确认连接模式

智能机器人默认使用 **WebSocket 长连接** 模式（区别于旧的 Webhook 回调模式）。
SDK 的 WebSocket 地址 `wss://openws.work.weixin.qq.com` 已内置，无需额外配置。

> 私有部署企业需在管理端查看对应的长连接地址，填入 KinetAios 高级设置中（如支持）。

---

## 三、在 KinetAios 中配置

### 步骤 1：打开设置

1. 启动 KinetAios
2. 点击左侧边栏的 **⚙ 设置** 按钮
3. 切换到 **「高级」**（Advanced）tab

### 步骤 2：找到「企业微信机器人」区块

在高级设置页面中，向下滑动找到 **「企业微信机器人」** 卡片。

### 步骤 3：填写配置

| 字段 | 填什么 | 示例 |
|---|---|---|
| ✅ 启用 | 勾选以启用 | — |
| **Bot ID** | 从步骤 3 获取的 Bot ID | `1a2b3c4d5e6f` |
| **Secret** | 从步骤 3 获取的 Secret | `xxxxxxxxx` |
| **处理引擎** | 收到企信消息后用哪个 Agent 引擎处理 | `Kaios (Direct)` |
| **流式回复** | 开启后企信里先显示「⏳ 正在思考…」，完成后替换为完整回复 | ✅ 推荐开启 |
| **默认工作目录** | Agent 执行 shell/文件操作时的工作目录 | `C:\Users\you\Projects` |

### 步骤 4：保存

点击设置面板底部的 **「保存」** 按钮。

保存后 KinetAios 会：
1. 自动创建 `WSClient`，连接 `wss://openws.work.weixin.qq.com`
2. 发送认证帧（botId + secret）
3. 认证成功后开始监听企信消息

> 修改 Bot ID / Secret / 启用状态后再次保存，会自动断开旧连接并重新初始化。

---

## 四、使用

### 在企信中 @机器人

1. 打开企业微信（桌面端或手机端）
2. 在单聊或群聊中 **@机器人名字**
3. 发送你的问题

```
@AI助手 帮我看一下今天有哪些文件改动了
@AI助手 写一个 Python 快速排序
@AI助手 解释一下这段报错日志 FATAL error: Connection refused
```

### 处理流程

```
企信用户 @机器人 发消息
  │
  ▼
企信服务器 → WebSocket 推送到 KinetAios
  │
  ▼
KinetAios WeComBridge 收到 message.text 事件
  │
  ▼
创建独立 Agent 会话 → TaskManager.send(text)
  │  (引擎执行 ReAct 循环：可调 shell/read_file/web_search 等工具)
  ▼
处理完成 → 提取最终 answer
  │
  ▼
回复到企信（Markdown 格式，超 4000 字自动截断）
```

### 流式回复体验

- 流式开启：企信先显示「⏳ 正在思考…」→ 完成后替换为完整 Markdown 回复
- 流式关闭：直接等待处理完成，一次性回复（复杂问题可能等 10-30 秒）

---

## 五、故障排查

### 连不上 / 没反应

| 检查项 | 方法 |
|---|---|
| KinetAios 是否运行 | 任务栏托盘有图标，且应用未退出 |
| Bot ID / Secret 是否正确 | 到企信后台重新核对，Secret 可尝试重置后重新填入 |
| 引擎 API Key 是否有效 | 在 KinetAios 聊天框里发一条消息测试引擎是否正常响应 |
| 网络是否能到企信服务器 | 浏览器访问 `wss://openws.work.weixin.qq.com` 是否可达 |

### 认证失败

Secret 不正确或已被重置。到企信后台重新获取 Secret，在 KinetAios 设置中更新并保存。

### 回复很慢

- 复杂问题（多步 ReAct 循环）耗时较长属正常现象
- 检查引擎的 model 是否响应缓慢，可在 KinetAios 聊天框里直接发同样的问题对比速度
- 关闭「流式回复」可减少一次中间帧发送，但不显著加速

### 消息被截断

企信单条消息有长度限制（约 4000 字 / 20480 字节），超长内容会自动截断并追加「(内容过长已截断)」。

---

## 六、架构说明

```
src/main/wecom.ts          ← WeComBridge 单例（WSClient + 消息路由）
src/shared/types.ts        ← WeComBotConfig 类型定义
src/main/settings.ts       ← 默认配置（enabled=false）
src/main/main.ts           ← app ready 后初始化 + IPC handler
src/preload/preload.ts     ← renderer IPC 桥接
src/renderer/app.ts        ← 设置面板 UI
src/shared/i18n.ts         ← 四语言国际化
```

### 关键设计

- **每条企信消息 → 独立 Agent 会话**：不复用上下文，避免跨用户污染
- **引擎可选**：Direct / DirectV2 / Claude Code / Codex
- **自动重连**：SDK 内置指数退避重连（1s→2s→4s→…→30s 上限），`maxReconnectAttempts: -1` 无限重连
- **心跳保活**：SDK 自动维护，无需手动处理
