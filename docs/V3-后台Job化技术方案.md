# V3 deep 路径后台 Job 化技术方案

> 目标：把 V3 deep 路径（DAG 执行）从「阻塞会话的同步执行」改造为「后台 Job」，补齐与 DeepSeek Harness 的执行底座差距。分四个里程碑，每个独立可交付、可回退。

## 0. 现状与问题

当前调用链（全部 await 串行，阻塞整个会话 turn）：

```
V3 index.run() → routeTask()==deep
  → executeDeepPath()            [deep-path.ts:30]
    → executeDAG()               [dag-executor.ts:56]
      → for level of topologicalLevels():
          for node of level:  await executeNode()   [dag-executor.ts:229]
```

痛点：
1. **阻塞**：deep 任务动辄十几分钟，期间会话不能发消息、不能看别的会话
2. **不可取消粒度粗**：只有整条 conv `signal`，用户想停只能中止整个 turn
3. **无断点**：`completed/failed/blocked` 集合和 `stepMessages` 全在内存（`executeDAG` 局部变量），进程重启/崩溃后整个 DAG 从头来
4. **同层串行**：拓扑分层后同层节点依然逐个 await，并行能力没兑现
5. **不可观测**：进度只有 todo 卡 + 滚动 status，没有"随时回读中间产物"的通道

## 1. 总体设计

新增一个引擎无关的 **JobManager**，V3 deep 路径接入为第一个消费者：

```
┌────────────┐   routeTask()==deep    ┌──────────────────┐
│ V3 index   │ ─────────────────────▶ │ JobManager       │
│ (立即返回)  │                        │  - 提交/取消/查询  │
└────────────┘                        │  - 持久化 SQLite  │
      │                               └────────┬─────────┘
      │ send job_id                            │ spawn
      ▼                                        ▼
┌────────────┐   onEvent 流       ┌──────────────────┐
│ renderer   │ ◀──────────────── │ JobWorker        │
│ (Job 面板)  │   (conv_events)   │ executeDAG()     │
└────────────┘                    └──────────────────┘
```

核心原则：**Job 只换执行位置，不换执行语义**。`executeDAG` / `executeNode` 内部逻辑不动，动的只是：谁调它、signal 从哪来、事件往哪流、断点存哪。

## 2. 里程碑 M1 — JobManager 基础设施

### 2.1 新文件 `src/main/JobManager.ts`

```ts
export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'killed';
export type JobKind = 'v3-deep';   // 后续扩展 'batch' | 'dispatch'
export interface JobRecord {
  id: string;              // uuid
  convId: string;          // 归属会话(回写结果用)
  turnId: string;
  kind: JobKind;
  status: JobStatus;
  payload: string;         // JSON: DAGPlan + history 快照 + policy 等执行输入
  checkpoint: string;      // JSON: M3 断点(completed 节点集 + 各节点 stepMessages)
  result: string | null;   // 最终 DAGExecResult
  error: string | null;
  createdAt: number; updatedAt: number;
}
```

职责与 API（参照 TaskManager 的 emitter 模式）：

- `submitJob(kind, convId, turnId, payload): JobRecord` — 入库 + 入队
- `killJob(id, reason?)` — 触发该 job 自己的 `AbortController`（不是 conv 的）
- `listJobs(convId?)` / `getJobOutput(id, sinceSeq?)` — 增量读 job 产出
- 内部 worker 池：默认并发 2 个 running job（可配），queued FIFO
- 每个 job 独立 `AbortController`；conv 被删除时级联 kill（挂 `conversations` 删除钩子）

### 2.2 持久化

新表 `jobs`（复用 history.db，better-sqlite3 已就绪）：

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, conv_id TEXT, turn_id TEXT,
  kind TEXT, status TEXT,
  payload TEXT, checkpoint TEXT, result TEXT, error TEXT,
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX jobs_conv ON jobs(conv_id);
```

启动时 hydrate：`running/queued` 状态的 job 一律标记为 `failed('app 重启,任务中断')`（M3 落地断点后改为 `paused`，可从断点恢复）。

### 2.3 IPC（main.ts + preload + renderer）

- `job:list` / `job:output` / `job:kill` / `job:submit`（后者 M2 用）
- renderer：会话头部加 Job 指示条（running 数 + 进度），详情弹层展示 `getJobOutput` 增量流

**交付判据**：JobManager 单元测试（提交/取消/并发上限/重启 hydrate）；IPC 全链路手测。

## 3. 里程碑 M2 — deep 路径接入（解阻塞）

### 3.1 V3 index 改造（`src/main/V3/index.ts:276` 附近）

`routeTask()==deep` 时不再 `await executeDeepPath`，改为：

1. `submitJob('v3-deep', convId, turnId, payload)` — payload 含 plan 所需全部输入（systemPrompt、memoryBlock、history、policy、settings 快照）
2. 立即往会话发一条 assistant 消息：`"🚀 任务复杂度判定为 deep，已转入后台执行（Job xxx）。完成后结果自动回贴本会话，期间可继续对话。"` + 初始 todo 卡
3. job 的 `onEvent` 桥接到 conv 既有事件流（复用 `conv_events` append-only 表，加 `seq` 列支持增量拉取）——**渲染侧零改动**，todo 卡、status、token 流全部照旧
4. 完成后：`result.stepMessages` 按 V2 的 spill 归一写回 `conv` 历史（`deep-path.ts` 现在的返回值语义），发 done 事件

### 3.2 signal 解耦

- job 用自己的 AbortController；conv 的 stop 按钮对 running job 显示为「kill job」
- `signal.aborted` 检查点在 `executeDAG` 层级循环已存在，无需改动

### 3.3 fast/std 不动

M2 只切 deep（它才值得后台化）；std 保持同步（用户等的就是它的即时反馈）。

**交付判据**：deep 任务提交后 3 秒内会话可继续输入；kill 后 DAG 当层收尾、下游不再启动；job 结果自动回贴。

## 4. 里程碑 M3 — 节点级断点续跑

### 4.1 executeDAG 增加 checkpoint 出入参

```ts
interface DAGCheckpoint {
  completed: string[];              // 已完成节点 id
  execHistory: ChatMsg[];           // 截至断点的执行历史
  nodeOutputs: Record<string, string>; // nodeId → summary(下游 prompt 依赖)
}
```

- 每个节点状态迁移时调 `onCheckpoint(snapshot)`（JobManager 收到后写 `jobs.checkpoint` 列，节点级写放大可接受：DAG 节点数 typically <30）
- `executeDAG` 启动时接受初始 checkpoint：预填 `completed` 集，拓扑循环跳过已完成节点

### 4.2 恢复语义

- app 重启：`running` → `paused`；用户在 Job 面板点「继续」→ 从 checkpoint 重新 `executeDAG`，provider/tools 从 payload 快照重建
- 节点失败重试耗尽 → job 标 `failed` 但 checkpoint 保留，可修完环境后从断点继续（现在是整图作废）

**交付判据**：kill 掉跑到一半的 deep job → 重启 app → 继续 → 只跑剩余节点；产物与一次跑完等价（用固定 mock provider 做确定性测试）。

## 5. 里程碑 M4 — 同层并行 + fan-out

### 5.1 同层节点并发

`executeDAG` 的 per-level 循环改为受限并发：

```ts
const CONCURRENCY = policy.dagConcurrency ?? 2;  // 默认 2,防 provider 限流
await runWithConcurrency(level.nodes, CONCURRENCY, node => executeNode(...));
```

- 写工具节点强制串行（V3 dag-executor 已有此判定的注释先例：任何含 shell/write/edit 的节点不并行）
- 同层并行时 `execHistory` 合并策略：并行节点各自从 `historyNow` 分叉，全部完成后按完成顺序拼接段（与 V3 streaming-executor 的既有语义对齐）

### 5.2 dispatch_agent 升级（可选独立交付）

`runCliOneShot` 的 5 分钟 timeout / 10MB maxBuffer 是子任务天花板；改为可提交 `kind:'dispatch'` 的 job，返回 job_id，子任务结果经 `getJobOutput` 回收。这一步做完，千文件级批量任务才有入口。

**交付判据**：无依赖多节点 DAG 实测耗时 ≤ max(单节点) × 1.3；限流错误触发自动降并发。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 并行节点打爆 provider 限流 | `dagConcurrency` 默认 2；AgentLoop 已有 `isTransientError` 退避，叠加并发降级（连续 429 → 并发 -1） |
| better-sqlite3 单写者 | JobManager 集中写 jobs 表；事件流只 append conv_events（现有模式） |
| job 事件与会话消息乱序 | conv_events 加单调 `seq`，renderer 按 seq 排序渲染 |
| 后台 job 烧钱失控 | Job 面板实时显示累计 costUSD（cost 事件已存在）；kill 一键停止 |
| payload 含全量 history 体积大 | checkpoint/history 落库前过 `compactHistory` 同款压缩；单 job payload 上限 5MB，超出拒收 |

## 7. 不做什么（明确出范围）

- std/fast 路径后台化 —— 破坏即时反馈的交互契约
- 跨会话共享 job —— job 强绑定 conv，级联删除
- 分布式/多机执行 —— 单机 app，不引入队列服务

## 8. 建议排期

| 里程碑 | 工作量估算 | 依赖 |
|---|---|---|
| M1 JobManager + IPC | 2-3 天 | 无 |
| M2 deep 接入 | 2 天 | M1 |
| M3 断点续跑 | 2 天 | M2 |
| M4 并行 + fan-out | 2-3 天 | M2（M4b 依赖 M3 更稳） |

合计约 8-10 个工作日。M1+M2 完成即获得「会话不阻塞 + 可取消」两个最痛的收益，可以先发一个版本验证。

---

## 9. 实施记录(2026-09-18)

四个里程碑全部落地,typecheck + 11/11 测试文件通过(`scripts/test/95-jobs.test.ts` 新增 11 用例):

- **M1** `src/main/JobManager.ts` + `jobs` 表(store.ts)+ IPC `job-list/job-get/job-kill/job-resume/job-dispatch` + preload API
- **M2** V3 deep 分支按设置 `v3DeepBackground`(默认开,设置页四语开关)提交后台 job;结果经 `TaskManager.appendJobResult` 回贴新 turn(directHistory 仅会话空闲时采纳,防分叉);事件走独立 `job-event` 频道;renderer 右上角 Job pill(运行数 + 成本 + 终止/继续)
- **M3** `executeDAG` 新增 `initialCheckpoint`/`onCheckpoint`;节点完成即整体覆写存档;kill/失败后 `resume(id)` 从断点续跑;重启时带断点的 job → `paused` 可恢复,无断点 → `failed`
- **M4** 同层只读节点按 `policy.dagConcurrency`(缺省 3)分批并行,写节点保持串行;`runCliOneShot` 支持 `timeoutMs` 覆写(同步路径仍 5 分钟),`JobManager.submitDispatch` 提供长时 CLI 子任务后台化(缺省 30 分钟)
- **附带修复**:`emitTeamEvent` 从 main.ts 抽到 `src/main/team-events.ts`(打破 engines/V3/DirectV2 → main 的循环依赖,测试 bundle 不再拉入整个主进程)
