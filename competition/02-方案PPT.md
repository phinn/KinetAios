# 方案 PPT 大纲（20 页）

---

## 第 1 页：封面

**KinetAios × AgentTeams**
本地优先的增强型多智能体协同分析平台

副标题：自研开源 Agent 引擎驱动的企业设备运维数据分析 Agent 团队

---

## 第 2 页：问题背景

**企业设备运维数据分析的痛点**

- 设备停机率数据散落在多个 Excel/CSV 文件中，格式不统一
- 经销商交叉分析需要跨表关联，人工处理耗时长
- 异常检测需要统计建模，业务人员缺乏工具
- 分析报告需要可视化+定期更新，依赖稀缺的数据工程师

**核心矛盾**：数据复杂度在增长，但分析能力无法规模化。

---

## 第 3 页：现有方案的不足

| 方案 | 问题 |
|------|------|
| 传统 BI 报表 | 固定模板，无法应对临时分析需求 |
| 单 Agent 数据分析 | 上下文有限，复杂任务容易跑偏 |
| 标准 AgentTeams Worker | 只有 LLM 调用能力，无法操作文件/执行代码 |
| 纯代码脚本 | 每次需求变更都要改代码，不够灵活 |

**我们需要**：多 Agent 协同调度 + 每个 Agent 有真正的工具执行力。

---

## 第 4 页：方案概览

**KinetAios × AgentTeams = 编排能力 × 执行能力**

```
┌─ AgentTeams ──────────────────────────────────┐
│  Manager Agent（任务编排+监控+验证）            │
│    ├── Worker-数据工程师 (KinetAios MCP)      │
│    ├── Worker-分析师     (KinetAios MCP)      │
│    └── Worker-报告员     (KinetAios MCP)      │
└───────────────────────────────────────────────┘
         ↕ MCP 协议（Higress 网关）
┌─ KinetAios Engine ────────────────────────────┐
│  ReAct 循环 + 12 工具 + 18 插件 + 长期记忆     │
└───────────────────────────────────────────────┘
```

**一句话**：AgentTeams 管"谁做什么"，KinetAios 管"怎么做"。

---

## 第 5 页：AgentTeams 角色编排

**Manager-Worker 分工模型**

| 角色 | 引擎 | SOUL.md 定位 | AGENT.md 约束 |
|------|------|-------------|--------------|
| **Manager** | OpenClaw | "你是设备运维分析团队的主管" | 不直接处理数据，只做任务拆解和结果验收 |
| **Worker-数据工程师** | KinetAios MCP | "你擅长数据清洗和预处理" | 输出标准格式 CSV，处理缺失值 |
| **Worker-分析师** | KinetAios MCP | "你是设备停机率分析专家" | 使用 Pandas 做统计分析，输出结构化结论 |
| **Worker-报告员** | KinetAios MCP | "你负责数据可视化" | 生成 ECharts 暗色主题 HTML 报告 |

---

## 第 6 页：任务拆解流程

**用户请求 → Manager 拆解 → Worker 并行执行 → 结果汇总**

示例任务：「分析 Q3 设备停机率，对比各经销商，找出异常」

```
Manager 拆解:
  ① [数据工程师] 清洗 Q3 停机率 Excel → 标准化 CSV
  ② [分析师] 基于①的 CSV → 按经销商聚合，计算停机率排名
  ③ [分析师] 对②的结果 → 做 3σ 异常检测，标记偏离经销商
  ④ [报告员] 基于②③ → 生成 ECharts 可视化 HTML 报告

状态追踪:
  每步完成 → Matrix 房间通知 → Manager 确认 → 触发下一步
```

---

## 第 7 页：上下文传递机制

**三层上下文保障**

| 层级 | 机制 | 实现 |
|------|------|------|
| **Worker 间** | MinIO 共享文件 | 数据工程师输出 CSV → 分析师读取，文件即接口 |
| **Worker 内** | KinetAios ReAct 循环 | 上下文溢出自动压缩（Reactive Trim + History Compaction） |
| **跨任务** | KinetAios 长期记忆 | SQLite+FTS5 自动提取持久事实，跨会话注入 |

**关键创新**：KinetAios 的 `export_session` / `import_session` 支持任务级上下文交接，Manager 可在 Worker 间迁移未完成任务。

---

## 第 8 页：KinetAios 增强能力

**标准 Worker vs KinetAios Worker**

| 能力 | OpenClaw Worker | KinetAios Worker |
|------|----------------|-----------------|
| LLM 调用 | ✅ | ✅ |
| 文件读写 | ❌ | ✅ read_file / write_file / edit_file |
| Shell 执行 | ❌ | ✅ shell（沙箱+确认） |
| 代码搜索 | ❌ | ✅ grep / glob |
| Web 搜索 | ❌ | ✅ web_search / web_fetch |
| Excel/CSV 处理 | ❌ | ✅ office-suite 18 工具 |
| 子 Agent 派发 | ❌ | ✅ dispatch_agent |
| 长期记忆 | ❌ | ✅ recall_memory (FTS5+embedding) |
| 文件快照回滚 | ❌ | ✅ .kinet-snapshots/ |
| PDF/OCR/Word | ❌ | ✅ office-suite |

---

## 第 9 页：Higress AI 网关

**统一模型路由 + MCP 托管**

```
Worker → Higress → ┌─ Qwen-Max（分析推理）
                    ├─ DeepSeek-V3（代码生成）
                    └─ KinetAios MCP Server（工具调用）
```

- **Token 管控**：每个 Worker 独立额度，超限自动限流
- **模型 Fallback**：主模型超时自动切备用
- **MCP 托管**：KinetAios MCP Server 注册到 Higress，Worker 通过消费者令牌访问
- **零凭证架构**：Worker 持"工牌式"令牌，永不接触真实 API Key

---

## 第 10 页：Nacos 配置与治理中心

**Agent 配置 + Skills/MCP 注册发现**

| 治理对象 | Nacos 能力 |
|----------|-----------|
| Worker SOUL.md / AGENT.md | 动态配置，无需重启容器即可更新角色设定 |
| Skills 注册 | 统一管理 KinetAios office-suite 工具集和自定义 Skills |
| MCP Server 目录 | 注册 KinetAios MCP 实例地址，Worker 按需发现 |
| 模型路由策略 | Higress 从 Nacos 拉取最新路由规则 |

---

## 第 11 页：PolarDB-PG 数据层

**设备数据 + Agent 记忆 + 审计日志**

| 数据域 | 表设计 | 索引 |
|--------|--------|------|
| 设备停机记录 | `downtime_records(device_id, dealer_id, start_at, end_at, reason)` | B-tree(device_id, dealer_id) |
| 经销商维度 | `dealers(dealer_id, region, tier)` | B-tree(region) |
| Agent 记忆（向量） | `agent_memories(id, content, embedding, conv_id, created_at)` | pgvector HNSW(embedding) |
| 审计日志 | `audit_logs(agent_id, action, ts, detail)` | BRIN(ts) |

**可替换性**：数据层通过 MCP 协议抽象，PolarDB-PG 可替换为 SQLite/MySQL/任意数据库，不影响 Agent 逻辑。

---

## 第 12 页：RocketMQ 事件驱动

**异步任务分发 + 状态流转**

```
用户请求 → RocketMQ Topic[task-request]
  ├── Manager 消费 → 拆解子任务
  ├── 子任务 → RocketMQ Topic[task-fragment]
  │     ├── Worker-数据工程师 消费
  │     ├── Worker-分析师 消费
  │     └── Worker-报告员 消费
  └── 完成通知 → RocketMQ Topic[task-complete]
        └── Manager 汇总 → 验证 → 推送结果
```

- **可靠性**：消息持久化，Worker 宕机后任务可重投
- **顺序保证**：同一任务内子任务按依赖关系串行，无依赖的并行
- **死信队列**：3 次失败的任务进入 DLQ，Manager 人工介入

---

## 第 13 页：云 Skills 集成

**按需加载领域技能**

| Skills 来源 | 用途 |
|-------------|------|
| skills.aliyun.com 官方 | OCR 识别、PDF 生成等标准能力 |
| KinetAios office-suite 插件 | Excel 读写、CSV 分析、Word 生成 |
| KinetAios 自定义 Skills | 设备停机率分析模板、经销商排名算法 |

**鉴权处理**：Worker 通过 Higress 消费者令牌访问 Skills，凭证集中管控，Worker 零接触明文密钥。

---

## 第 14 页：安全边界设计

**四层安全防护**

| 层级 | 机制 | 实现 |
|------|------|------|
| **网络层** | Higress 网关 | 统一入口、限流、Token 管控、WAT 双身份 |
| **Agent 层** | KinetAios 沙箱 | 三级（readOnly/workspaceWrite/fullAccess），远程 Agent 强制降为 workspaceWrite |
| **数据层** | PolarDB-PG | 行级权限、审计日志、Agent 记忆隔离 |
| **文件层** | KinetAios 快照 | 每次 write/edit 前存入 `.kinet-snapshots/`，一键回滚 |

**SSRF 防护**：KinetAios 拦截内网 IP、云元数据端点（169.254.169.254）、DNS rebinding。

---

## 第 15 页：异常分支处理

**任务失败时的优雅降级**

```
Worker 执行失败
  ├── 工具超时 → KinetAios 5min 超时保护 → 返回错误摘要
  ├── LLM 调用失败 → Higress 自动 Fallback 备用模型
  ├── 数据质量问题 → Worker 通知 Manager → Manager 决定:
  │     ├── 补充说明后重试
  │     ├── 换一个 Worker 处理
  │     └── 标记为需人工介入 → Matrix 房间 @人类
  └── 上下文溢出 → KinetAios 自动压缩历史 → 继续执行
```

**Manager 验证机制**：Manager 检查 Worker 输出是否符合 AGENT.md 约定的格式，不符合则打回重做（最多 3 轮）。

---

## 第 16 页：AgentScope Studio 可观测

**Agent 推理轨迹记录 + 质量评估**

| 观测维度 | 指标 | 来源 |
|----------|------|------|
| **推理质量** | 任务完成率、重试次数、工具调用准确率 | AgentScope Studio Trace |
| **成本效率** | Token 消耗 / 任务、模型调用次数 | Higress 网关日志 |
| **执行性能** | 端到端时延、工具执行耗时 | KinetAios AgentLoop 日志 |
| **可靠性** | 失败率、超时率、回滚次数 | RocketMQ DLQ + 快照日志 |

**数据飞轮**：AgentLoop Collect → Analyze → Evaluate → Optimize，持续优化 Agent Prompt 和工具配置。

---

## 第 17 页：UnifiedModel 数据建模

**统一实体关系语义层**

```
.unifiedmodel
  Entity: Device
    - device_id: string (PK)
    - model: string
    - install_date: date
    Relations:
      → Dealer (installed_by)
      → DowntimeRecord (has_many)

  Entity: Dealer
    - dealer_id: string (PK)
    - region: string
    - tier: enum(核心/一级/二级)
    Relations:
      → Device (installs)
      → DowntimeRecord (services)

  Entity: DowntimeRecord
    - record_id: string (PK)
    - device_id: string (FK)
    - dealer_id: string (FK)
    - duration_hours: float
    - reason: string
```

Agent 通过 UnifiedModel 的 SPL 查询接口统一访问设备/经销商/停机记录，无需关心底层存储。

---

## 第 18 页：完整技术架构图

（见 `04-架构图.md` 的 Mermaid 图，PPT 中渲染为完整架构图）

---

## 第 19 页：开源计划与社区贡献

**已开源**：
- KinetAios Agent 引擎：https://github.com/phinn/KinetAios （GPL v3）
- 完整 MCP Server 实现、12 工具、18 插件、跨会话记忆

**计划贡献**：
- `kinetaios-worker-template`：AgentTeams 标准 Worker 模板，一键创建增强 Worker
- `office-suite-skills`：办公技能包，供 skills.aliyun.com 社区使用
- `device-analytics-soulpack`：设备运维分析 SOUL.md + AGENT.md 模板集

**可复用性**：任何 AgentTeams 用户只需将 KinetAios MCP Server 地址配入 Worker 的 MCP Server 绑定，即可获得增强能力，无需改 AgentTeams 代码。

---

## 第 20 页：总结与亮点

**三个差异化优势**：

1. **自研引擎不是薄壳** — KinetAios 的 ReAct 循环 + 12 工具让 Worker 真正能干活
2. **MCP 协议原生对接** — 零侵入接入 AgentTeams 生态，标准 MCP JSON-RPC
3. **真实业务场景验证** — 设备运维+CRM 数据分析，非玩具 Demo

**技术栈全景**：
AgentTeams（编排）+ KinetAios（执行）+ Higress（网关）+ Nacos（治理）+ PolarDB-PG（数据）+ RocketMQ（消息）+ AgentScope Studio（可观测）+ 云 Skills（能力扩展）

---

## 附：答辩可能被问到的问题

**Q: 为什么不直接用标准 Worker？**
A: 标准 Worker 无法操作文件系统、执行代码或处理 Excel。真实数据分析场景中，Worker 需要读 CSV、跑 Pandas、生成图表——这些都需要本地工具能力，而 KinetAios 正好提供了。

**Q: KinetAios 和 AgentTeams 是什么关系？**
A: 上下游。AgentTeams 是编排层（Manager），KinetAios 是执行层（增强 Worker）。两者通过标准 MCP 协议对接，互不侵入。

**Q: 如果不用 KinetAios，能用别的替代吗？**
A: 可以。KinetAios MCP Server 遵循标准 MCP JSON-RPC，任何 MCP 客户端都能调用。但 KinetAios 的优势是开箱即用——12 工具+18 插件+ReAct 循环+记忆系统，不用组装。
