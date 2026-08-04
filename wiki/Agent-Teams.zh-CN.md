# Agent Teams 多 Agent 团队

> 多 agent 团队协作 —— 派出一组具名的 sub-agent,各自拥有独立 history,并行执行,汇报结果。

## 概览

Agent Teams 让 LLM(或用户手动)在一个会话内创建一组专业 sub-agent。每个 member 拥有:

- **独立 history** —— 持久化到 SQLite(`team_members.history`),跨多轮团队交互保留
- **只读工具** —— `read_file`、`grep`、`glob`、`web_fetch`、`web_search`、`recall_memory`、`recall_fact`(与 `dispatch_agent` 相同)
- **实时可视化** —— token 流、工具调用、状态变化、最终回答全部在 Team tab 实时显示

Team 按会话隔离:每个 team 挂在 `conv:<convId>:team:<timestamp>` 下,与其他会话互不干扰。

## 架构

```
┌──────────────────────────────────────────────┐
│ 主会话 (Direct / DirectV2 引擎)               │
│                                               │
│  LLM 调 spawn_team → 创建 team_members        │
│  LLM 调 team_broadcast → ──────────────┐      │
│  LLM 调 team_send → ─────────────────┐ │      │
│                                      ▼ ▼      │
│  ┌──────────────────────────────────────────┐ │
│  │ teams.ts: runMember / runMembersParallel │ │
│  │  · 每个 member: AgentLoop + readOnlyTools│ │
│  │  · 单 member 3 分钟超时                   │ │
│  │  · Broadcast: Promise.allSettled (并行)  │ │
│  │  · TeamEvent → emitTeamEvent → renderer  │ │
│  └──────────────────────────────────────────┘ │
│                                               │
│  结果以文本返回给主 LLM 循环                   │
└──────────────────────────────────────────────┘
                    │ IPC
                    ▼
┌──────────────────────────────────────────────┐
│ Renderer: Team Tab                            │
│  · Member 卡片 + 实时状态指示器               │
│  · Token 流式预览                             │
│  · 手动发送/广播/创建/删除                     │
└──────────────────────────────────────────────┘
```

## LLM 驱动使用(工具)

LLM 通过四个内置工具自主管理 team:

| 工具 | 用途 |
|------|------|
| `spawn_team` | 创建含 N 个具名 member 的 team |
| `team_broadcast` | 给所有 member 发同一条消息(并行执行) |
| `team_send` | 给某个 member 单独发消息 |
| `team_close` | 删除 team 及所有 member 数据 |

### 示例流程

```
用户: "审查这个项目的架构,从数据库、API、前端三个角度"

LLM:
  1. spawn_team({ members: [
       { name: "db-reviewer", role: "数据库架构评审" },
       { name: "api-reviewer", role: "API 设计评审" },
       { name: "fe-reviewer", role: "前端架构评审" }
     ] })
     → team_id: "conv:abc:team:xyz"

  2. team_broadcast({ team_id, message: "审查项目架构,各自从自己的角度分析" })
     → [3 个 member 并行运行]
     → ### db-reviewer (数据库架构评审)
       分析了 store.ts 的 schema...
     → ### api-reviewer (API 设计评审)
       分析了 IPC handler 结构...
     → ### fe-reviewer (前端架构评审)
       分析了 app.ts 的渲染逻辑...

  3. team_send({ team_id, member_name: "db-reviewer", message: "深入看下 FTS5 索引设计" })
     → 单 member 追问,带上之前的 history

  4. team_close({ team_id })
```

## 手动操控(Team Tab)

Dashboard 中的 Team tab(👥)提供完整的手动控制:

- **创建 Team** —— 点击「新建」,输入成员 `name1:role1, name2:role2`
- **给 Member 发消息** —— 点击 member 卡片上的 💬 直接发送
- **广播** —— 点击 📢 同时给所有 member 发消息
- **删除 Team** —— 点击 🗑 清除 team 及所有数据
- **刷新** —— 点击刷新图标从数据库重新加载 team 状态

### 实时可视化

Member 运行时(无论由 LLM 还是手动触发):

- 🔵 蓝点 = 运行中
- 🟢 绿点 = 完成
- 🔴 红点 = 失败
- ⚪ 灰点 = 空闲

Member 卡片实时显示 token 流和工具调用的预览。

## 并行执行

`team_broadcast` 使用 `Promise.allSettled` 并发执行所有 member。每个 member 拥有:

- 独立的 `AbortController` + 3 分钟超时
- 独立的 `AgentLoop` 实例 + 只读工具集
- 独立的成本追踪(聚合后作为单个 `cost` 事件上报)

`team_send` 执行单个 member —— 无需并行。

## 数据模型

```sql
CREATE TABLE team_members(
  team_id TEXT,          -- "conv:<convId>:team:<ts>"
  member_id TEXT,        -- = member name(团队内唯一)
  name TEXT,
  role TEXT,
  history TEXT,          -- JSON: ChatMsg[] 序列化的成员 history
  last_message TEXT,     -- 最近发给该 member 的消息
  last_result TEXT,      -- 最近一次回答
  status TEXT,           -- 'idle' | 'running' | 'done' | 'failed'
  created_at REAL,
  updated_at REAL,
  PRIMARY KEY(team_id, member_id)
);
```

## IPC 通道

| 通道 | 方向 | 用途 |
|------|------|------|
| `team-list` | renderer → main | 列出会话下所有 team |
| `team-create` | renderer → main | 创建新 team |
| `team-delete` | renderer → main | 删除 team |
| `team-list-members` | renderer → main | 列出 team 下所有 member |
| `team-send-member` | renderer → main | 给单个 member 发消息 |
| `team-broadcast` | renderer → main | 广播给所有 member |
| `team-event` | main → renderer | 实时 `TeamEvent` 流 |

## MVP 限制

- **仅只读工具** —— member 不能写文件或执行 shell 命令(设计上出于安全考虑)
- **Member 间不能直接通信** —— member 之间不能互发消息;用 `recall_fact` 共享数据
- **按会话隔离** —— team 不能跨主会话共享
- **每个 team 上限 8 个 member** —— 防止 token 爆炸
- **单 member 3 分钟超时** —— 防止 API 挂起导致永久阻塞
