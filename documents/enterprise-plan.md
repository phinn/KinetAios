# KinetAios 企业版功能方案

> 从个人桌面工具到企业级 AI Agent 平台的架构演进规划

---

## 现状分析

KinetAios 目前是 **单进程 Electron + 本地 SQLite + 明文 API Key + 无用户体系** 的桌面工具。核心资产：

- ✅ 三引擎架构（Kaios ReAct / Claude Code / Codex）
- ✅ 9 个内置工具 + Plugin SDK
- ✅ MCP Bridge 多机协作（SSE/HTTP + JSON-RPC 2.0）
- ✅ SQLite + FTS5 全文检索 + 向量语义召回
- ✅ 成本追踪 + 预算熔断（perSession / daily）
- ✅ 三级上下文压缩 + 文件快照回滚
- ✅ 飞书/企业微信 Bot 集成基础
- ✅ 四语言 i18n + 四主题

企业化要改的不是引擎层，而是 **身份层**（谁在用）、**数据层**（数据归谁）、**管控层**（能做什么不能做什么）。

---

## P0 — 必须有的骨架（没有就别谈企业）

### 1. 多租户用户体系

现在 `settings.json` 是单用户全局态，API Key 明文存本地。企业版核心：**身份 + 权限 + 隔离**。

```
新增：
├── 认证层：SSO/OIDC（企业微信、飞书、Azure AD 已有 bot 集成基础）
├── 用户模型：user { id, name, email, role, deptId, createdAt }
├── 角色模型：RBAC — admin / teamLead / member / viewer
├── 会话归属：conversation 加 ownerId + visibility(private/team/public)
└── 记忆隔离：按 userId 切分 memory namespace，不串号
```

**最小落地**：`users` 表 + `conversations` 表加 `ownerId` + 启动时 SSO 登录拦截。SQLite 到 Postgres 的迁移可以后做，但数据模型现在就要留好 userId 字段。

### 2. 集中式 API Key 管理 + 用量配额

现在是每人自己填 API Key——企业必须统一管控。

```
方案：
├── Key 管理下沉到服务端（企业自建 LLM Gateway / 或代理层）
├── 桌面端不再持有 Key，请求带 userToken → 服务端代理转发
├── 用量统计按 user/team/dept 维度聚合（现有 cost event 基础已好）
├── 配额熔断：现有 budget { perSessionLimit, dailyLimit } 升级为服务端策略
└── 支持多模型路由（GLM/Claude/GPT 按成本/场景自动选择）
```

现在的 `budget` 字段 + `cost` event 颗粒度已经够用，差的是**服务端聚合层**。

### 3. 共享 Agent 工作区

团队协作的核心：Agent 和它的产出不只属于一个人。

```
├── 项目级共享：team workspace（对标 GitHub Org）
├── 会话共享：fork 一条对话给同事 → 他继承完整上下文继续
├── 快照/产出共享：Agent 生成的文件直接推到共享空间
├── Agent 模板：团队维护一套预设 Agent（带 system prompt + 工具白名单 + sandbox 策略）
└── 审计日志：谁在什么时候让 Agent 执行了什么 shell 命令（合规必需）
```

现在 `snapshots.ts` 做了文件快照，`teams.ts` 做了子 Agent 团队调度——但都是**本机单会话**的。企业版要把这些搬到共享层。

---

## P1 — 企业刚需差异化

### 4. 细粒度沙箱 + 工具权限策略

现在的沙箱是 `readOnly / workspaceWrite / fullAccess` 三档——个人够用，企业太粗。

```
升级方案：
├── 工具白名单：不同角色可用不同工具集（viewer 不能 shell，member 不能 write_file）
├── 路径限制：workspaceWrite 再加 allowedPaths / blockedPaths
├── 命令审查：shell 命令正则黑名单（rm -rf, chmod 777, curl 外发等）
├── 审批工作流：高危操作 → 推送给 teamLead 审批 → 执行
└── 网络隔离：web_fetch 的 SSRF 防护已做（v1.3.0），企业版加 egress proxy/whitelist
```

现在的 `ApprovalPolicy` 只有 `always/never`，企业需要第三档：`policyBased`——按规则自动判断是否需要审批。

### 5. 知识库 + RAG

企业最有价值的功能——让 Agent 理解企业内部知识。

```
├── 文档接入：企业 Wiki / Confluence / 飞书文档 / SharePoint
├── 向量化索引：现有 embedding-3 + FTS5 基础已好，扩展为多源索引
├── 代码库索引：企业 Git repo 全量 embedding，Agent 能搜代码
├── 权限感知：RAG 召回时按用户权限过滤（不能看到无权访问的文档）
└── 知识图谱：现有三元组记忆图谱升级为团队共享知识网络
```

现在的 `recall_memory` 是个人记忆，企业需要**组织级记忆**——团队共享的事实、决策、踩坑记录。

### 6. 管理后台

```
├── 用户管理：创建/禁用/角色分配
├── 用量看板：按人/团队/部门维度的 token 消耗 + 成本统计
├── Agent 审计日志：谁在什么时候执行了什么、结果如何
├── 共享模板管理：发布/更新/下架 Agent 模板
├── 合规导出：操作日志按时间段导出（SOC2 / ISO27001 需要）
└── 健康监控：各引擎在线状态、延迟、错误率
```

现有 Dashboard 窗口做了个人级 token 监控，企业版要扩展为**管理员视图**。

### 7. MCP Bridge → 企业服务网格

现在 MCP Bridge 是点对点的（A 机直连 B 机），企业需要**中心化编排**。

```
├── MCP Gateway：中心注册中心，统一服务发现
├── 团队算力池：空闲机器自动加入计算网格
├── 负载均衡：多台机器跑同一 Agent，按可用性路由
├── 安全通道：mTLS + 企业内部 CA
└── 任务队列：现有 cron.ts + watcher.ts 升级为持久化任务队列
```

---

## P2 — 真正拉开差距的

### 8. 企业 IM 深度集成（飞书/企微已打基础）

现在 `feishu.ts` 和 `wecom.ts` 已经做了 bot 单向通知。企业版要做**双向 Agent 交互**：

```
├── 飞书群里 @KinetAios 直接派活（带上下文继承）
├── Agent 产出物自动回推到飞书文档/多维表格
├── 审批流推送到 IM → 群内一键批准/拒绝
└── 每日/每周 Agent 工作汇报自动推送到群
```

### 9. CI/CD Pipeline Agent

```
├── Git hook 触发：commit → Agent 自动 code review
├── PR 审查：Agent 读 diff + 上下文 → 评论/打标
├── 自动修复：lint 错误 Agent 直接修 → 推 commit
├── 发布检查：版本号/CHANGELOG/i18n 完整性自动验证
└── 现有 snapshots.ts 做安全网——Agent 改错了自动回滚
```

### 10. 合规 + 数据驻留

```
├── 本地部署模式：全数据不出企业内网（LLM 也走私有部署）
├── 数据脱敏：Agent 处理的敏感数据自动 PII 检测 + 脱敏
├── 会话保留策略：自动过期清理 + 归档
├── DLP（数据防泄漏）：Agent 输出内容扫描，防内部信息外泄
└── GDPR/等保：数据导出权、被遗忘权、审计追踪链
```

---

## 落地路线图

```
Phase 1 (MVP 企业版)
  → 多用户 + SSO + 服务端 Key 管理 + 审计日志
  → 数据模型加 ownerId，不迁 DB 先用 SQLite WAL
  → 验证：3-5 人小团队可日常使用

Phase 2 (团队协作)
  → 共享工作区 + Agent 模板 + 配额管理 + 管理后台
  → MCP Gateway 中心化
  → 飞书/企微双向交互
  → 验证：20-50 人团队，2-3 个部门

Phase 3 (企业级)
  → RAG 知识库 + 细粒度沙箱 + 合规导出
  → CI/CD Agent + DLP
  → 验证：100+ 人，通过 SOC2/等保审计
```

---

## 架构变化示意

### 现在（个人版）

```
┌─────────────────────────────────┐
│       Electron Desktop App      │
│  ┌───────┐  ┌─────────────────┐ │
│  │Renderer│  │   Main Process  │ │
│  │ (UI)  │←→│                 │ │
│  └───────┘  │ ┌─────────────┐ │ │
│             │ │AgentRuntime │ │ │
│             │ │(ReAct+Tools)│ │ │
│             │ └──────┬──────┘ │ │
│             │        │        │ │
│             │  ┌─────┴──────┐ │ │
│             │  │ SQLite     │ │ │
│             │  │ (local)    │ │ │
│             │  └────────────┘ │ │
│             │  ┌────────────┐ │ │
│             │  │Settings.json│ │ │
│             │  │(API Key明文)│ │ │
│             │  └────────────┘ │ │
│             └─────────────────┘ │
└─────────────────────────────────┘
         ↕ (P2P MCP Bridge)
┌─────────────────────────────────┐
│       另一台 Electron App        │
└─────────────────────────────────┘
```

### 企业版目标

```
                    ┌─────────────────────┐
                    │   Enterprise Server │
                    │  ┌───────────────┐  │
                    │  │  Auth (SSO)   │  │
                    │  │  RBAC Engine  │  │
                    │  └───────┬───────┘  │
                    │  ┌───────┴───────┐  │
                    │  │ LLM Gateway   │  │
                    │  │(Key管理+路由) │  │
                    │  └───────┬───────┘  │
                    │  ┌───────┴───────┐  │
                    │  │ MCP Gateway   │  │
                    │  │(服务发现+编排)│  │
                    │  └───────┬───────┘  │
                    │  ┌───────┴───────┐  │
                    │  │ PostgreSQL    │  │
                    │  │(会话+审计+用量)│  │
                    │  └───────┬───────┘  │
                    │  ┌───────┴───────┐  │
                    │  │ RAG / 向量库  │  │
                    │  │(知识库+代码库)│  │
                    │  └───────────────┘  │
                    └─────────┬───────────┘
                 ┌────────────┼────────────┐
                 ↕            ↕            ↕
          ┌──────┴──┐  ┌─────┴───┐  ┌─────┴───┐
          │ Thin    │  │ Thin    │  │ Thin    │
          │ Client  │  │ Client  │  │ Client  │
          │ +本地执行│  │ +本地执行│  │ +本地执行│
          └─────────┘  └─────────┘  └─────────┘
```

**核心变化**：桌面端从「全量持有」退化为「Thin Client + 本地能力执行器」。引擎层（ReAct Loop、工具系统）不变，变化的是 Key/数据/权限/编排全部上收到服务端。

---

## 现有代码资产盘点（哪些可直接复用）

| 模块 | 文件 | 企业版复用方式 |
|---|---|---|
| ReAct Agent Loop | `AgentLoop.ts`, `DirectV2Engine.ts` | ✅ 核心引擎层完全复用 |
| 工具系统 | `tools.ts` | ✅ 工具定义复用，加权限拦截层 |
| 三引擎调度 | `engines.ts` | ✅ 复用，LLM 调用改走 Gateway |
| MCP Bridge | `mcp.ts`, `mcp-server.ts` | ✅ 升级为 MCP Gateway |
| 成本追踪 | `cost` event | ✅ 升级为服务端聚合 |
| 预算熔断 | `budget` 字段 | ✅ 升级为服务端策略 |
| 文件快照 | `snapshots.ts` | ✅ 升级为共享快照 |
| 子 Agent 团队 | `teams.ts` | ✅ 升级为跨机编排 |
| 飞书/企微 Bot | `feishu.ts`, `wecom.ts` | ✅ 升级为双向交互 |
| 定时任务 | `cron.ts` | ✅ 升级为持久化队列 |
| 插件系统 | `plugins.ts` | ✅ 加签名验证 |
| 知识图谱 | `memory-graph.ts` | ✅ 升级为团队共享 |
| SQLite + FTS5 | `store.ts` | ⚠️ 数据模型复用，后期迁 Postgres |
| settings.json | `settings.ts` | ❌ API Key 管理上收到服务端 |
| ApprovalPolicy | `types.ts` | ⚠️ 加 `policyBased` 第三档 |

---

*文档创建：2026-08-09*
*基于 KinetAios v1.3.0 架构分析*
