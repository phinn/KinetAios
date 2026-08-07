> 🌐 Language: [English](Session-Management.md) | **中文**

# 会话管理

高级会话操作:**分支**、**导出/导入(交接)**、**跨会话引用**和**任务图**。

## 分支(Branch)

在对话中右键任意 turn → **从此分支**。这会深拷贝到该点为止的所有 turns 和 steps,生成新会话,创建一个分叉。

- 新会话继承相同的引擎、模型、cwd 和 `directHistory`。
- 原会话不受影响。
- 适合探索不同方案而不丢失原始线索。

```ts
// TaskManager
branchFrom(convId: string, turnId: string): string  // 返回新 convId
```

## 导出/导入(会话交接)

序列化完整会话状态,用于跨机交接(通过 [[MCP-Server]] 或手动 JSON)。

**导出**生成:

```json
{
  "version": 1,
  "conv": {
    "engine": "direct",
    "model": "glm-4.6",
    "cwd": "/home/user/project",
    "turns": [...],
    "directHistory": [...],
    "engineSessionId": "...",
    "cost": 0.03,
    "tokens": 15000
  },
  "exportedAt": 1234567890
}
```

**安全**:`directHistory` 中的 API key、密码和 token 在序列化前自动脱敏为 `[REDACTED]`(正则匹配:`sk-...`、`api_key=...` 等)。

**导入**验证:
- 消息 role 必须在白名单内:`system`、`user`、`assistant`、`tool`。
- content 类型检查(string 或 ContentPart[])。
- 长度限制:最多 500 条消息,每条最多 50K 字符。
- `engine`、`model`、`cwd` 验证为非空字符串。

## 跨会话引用

会话之间可以建立关联,展示依赖关系(如「会话 B 从会话 A 分支」)。**任务图**以 DAG(有向无环图)渲染:

- **节点**:会话(以标题或首条 prompt 标注)。
- **边**:分支关系、pipeline stage 链接。
- 可交互:点节点打开对应会话。

## 任务图

以 DAG 可视化所有会话及其关系:

| 边类型 | 含义 |
|---|---|
| Branch | 会话从另一个会话分支 |
| Pipeline | 会话是 pipeline 的一个 stage |
| Reference | 手动跨会话关联 |

通过 `TaskManager.taskGraph()` 编程式访问 → 返回 `{ nodes: TaskGraphNode[], edges: TaskGraphEdge[] }`。

## 侧栏排序与活动时间

每个会话都有 `updatedAt` 时间戳,在以下时机自动更新:

- **用户发消息** 时
- **引擎事件** 流入时(token / tool / done / error)
- **/goal 命令** 执行时

侧栏默认按 `updatedAt` 倒序排列(最近活跃在最上面),无需手动操作。底部 **🕐** 按钮可切换回创建顺序。

每条频道右侧显示相对时间:

| 时间跨度 | 显示 |
|---|---|
| < 1 分钟 | `刚刚` |
| < 1 小时 | `N分钟前` |
| < 1 天 | `N小时前` |
| 1–2 天 | `昨天` |
| 2–7 天 | `N天前` |
| 7 天–1 年 | `MM-DD` |
| > 1 年 | `YYYY-MM-DD` |

hover 显示完整日期时间。

旧会话无 `updatedAt` 时 fallback 到 `createdAt`。

## 机器人会话管理(飞书 / 企微)

来源是飞书或企微的会话带有 `feishuKey` / `wecomKey` 字段,将 IM 用户映射到会话。完整功能概览见 [[Messaging-Bots]]。

### Key 格式

| 来源 | 单聊 | 群聊 |
|---|---|---|
| 飞书 | `feishu:${open_id}` | `feishu:group:${chat_id}` |
| 企微 | `wecom:${userid}` | `wecom:group:${chatid}` |

### 持久化与恢复

应用启动时,Bridge 扫描 SQLite 中所有带 `feishuKey` / `wecomKey` 的会话,重建内存 `Map<key, convId>`。Map 查找未命中时 fallback 到 SQLite 扫描 —— 确保会话跨重启不断裂。

### IM 斜杠指令

| 指令 | 动作 |
|---|---|
| `/new` | 开启新对话 |
| `/reset` | 清空当前会话历史 |
| `/list` | 显示历史会话 |
| `/switch N` | 切换到第 N 个会话 |
| `/context` | 显示会话信息 |

### 淘汰机制

每用户(或每群)上限 **5 个会话**。超出时自动删除最旧的。

### 并发

同一用户消息通过 per-user promise chain 串行处理。不同用户并行。

## 关键源文件

- `src/main/TaskManager.ts` —— `branchFrom`、`exportSession`、`importSession`、`taskGraph`
- `src/main/mcp-server.ts` —— 远程 `export_session` / `import_session` 工具
- `src/shared/types.ts` —— `TaskGraphNode`、`TaskGraphEdge`
- `src/main/store.ts` —— `conversations` 表的 `branch_info`、`pipeline_id`、`updated_at` 列
