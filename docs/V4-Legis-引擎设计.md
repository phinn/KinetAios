# V4 Engine(Legis)— 设计文档

> 状态:设计定稿,实施中。
> 数据来源:`history.db` 全量挖掘(5,584 turns / 30.7 万事件 / $712,2026-08~10)。
> 前置阅读:`KinetAios.md`(架构)、`KinetAiosPlugin.md`(插件 SOP)。

## 0. 一句话

V4 = V3 的路由/骨架 + **LLM 出场权重新设计**:LLM 只在「编译计划」和「断言失败唤回」时出场,纯工具节点由 Runtime 零 LLM 直跑;跑通的图沉淀为 Skill,出场次数随复用单调递减。

## 1. 为什么要 V4(数据,不是直觉)

| 事实 | 数值 | 推论 |
|---|---|---|
| top 5% turn 占总成本 | **68%**(top10%=86%,top25%=99%) | 只优化超长 turn 就够了,短问答别碰 |
| >80 步 turn | 738 个(13%),**占总成本 80%** | 马拉松 turn 是唯一靶子 |
| 同 turn 完全重复调用(工具+args 相同) | **48,467 次**(shell 占 21k) | 21% 调用是纯浪费,一层去重就能砍 |
| 跨会话重复 ≥3 次的调用 | 554 种(typecheck ×220 / sleep ×121 / snapshot ×412) | 有可沉淀的固定动作链 |
| 429 限流 | 157 次,无人值守任务直接死 | 需要 park + 退避 + 续跑,不是 kill |
| goal/supervisor verdict | 361 continue / 23 complete(**94% continue**) | LLM 自己验收不可靠,要确定性断言 |
| shell exit≠0 | 6.5%(exit1 为主) | 失败重试交给 Runtime 断言,不烧 LLM |
| cache 命中率 | 9 月 0% → 10 月 14% | 稳定前缀(system+早期 history)已在命中,但中间层反复变 |

**四类烧钱模式**(`$84`/935 步 top 会话归因):①无人值守马拉松 LLM 每步在场 ②重复劳动 ③重试螺旋(LLM 换姿势重试)④429 死亡。

## 2. 定位与形态

- 引擎 id:`directV4`,显示名 **Kaios v4 (Legis)**,内置实现 + 插件开关(与 claudeCode/codex 同模式:代码在 `src/main/V4/`,manifest 在 `plugins/kaios-v4/`,设置页可启用/禁用)。
- Direct 家族成员:共享 `directHistory`、参与引擎切换免清空逻辑、`ENGINE_POLICIES` 有独立策略包。
- 插件 manifest 无 `engine` 贡献点(那是 CLI 外挂引擎用的);**开关 = 插件启停**,引擎注册在 `buildEngines()` 检查 `pluginEngines()` 里是否有 `kaios-v4`(完全抄 claudeCode/codex 的 gating 方式)。

## 3. 架构总览

```
User Input
  → Router(V3 照搬,0 LLM:fast/std/legis-deep)
      ├ fast  → V1 ReAct(零开销,不变)
      ├ std   → V3 Streaming ReAct(嵌入式 verify,不变)
      └ deep  → Legis 流水线(本设计核心)
            ┌─────────────────────────────────────┐
            │ ① Compiler(LLM 出场 #1)            │
            │   forced tool_use submit_legis_plan  │
            │   产出:LegisPlan(节点+断言+契约)   │
            ├─────────────────────────────────────┤
            │ ② Runtime(0 LLM)                   │
            │   拓扑分层 → 同层只读并行/写串行     │
            │   ├ replay 节点:直跑工具链          │
            │   │   (exit0/输出断言,失败重试≤2)  │
            │   ├ agent 节点:子 ReAct(步数上限) │
            │   └ 全局:结果缓存 + 429 退避队列    │
            ├─────────────────────────────────────┤
            │ ③ 验收断言表(0 LLM)               │
            │   goal 的确定性验收替代 supervisor    │
            ├─────────────────────────────────────┤
            │ ④ 唤回(LLM 出场 #2..n)            │
            │   断言失败/计划外边 → 最小故障现场   │
            │   → 修复指令 → 补丁进图,续跑         │
            └─────────────────────────────────────┘
            ⑤ 沉淀:跑通的图 → skill(可选,后续)
```

## 4. 核心数据结构(`src/main/V4/plan.ts`)

```ts
// Legis 计划节点 — V3 DAGNode 的超集
export interface LegisNode {
  id: string;
  title: string;
  action: string;                    // 给 agent 节点的自然语言指令
  tools: string[];
  deps: string[];
  parallelizable: boolean;
  // ── V4 新增 ──
  kind: 'agent' | 'replay';          // replay=纯工具链,Runtime 直跑
  // replay 节点的确定性脚本:每步 {tool, args, assert}
  script?: Array<{
    tool: string;                    // shell / read_file / …
    args: Record<string, unknown>;
    assert?: Assertion[];            // 步级断言
  }>;
  asserts?: Assertion[];             // 节点级断言(所有步完成后校验)
  maxSteps?: number;                 // agent 节点的子 ReAct 步数保险丝
}

export interface Assertion {
  type: 'exitZero' | 'outputContains' | 'outputEmpty' | 'jsonParses'
      | 'fileExists' | 'fileNotExists' | 'lineCount' | 'durationMs';
  value?: string | number;
  negated?: boolean;
}

export interface LegisPlan {
  goal: string;
  nodes: LegisNode[];
  summary: string;
  // 验收断言表:整个 plan 跑完后的确定性验收(goal 的机器可判版本)
  acceptance: Assertion[];
}
```

## 5. 五个组件的设计要点

### 5.1 Compiler(legis-compiler.ts)

- 复用 V3 dag-planner 的 forced tool_use 模式:定义 `submit_legis_plan` 工具,schema 同 V3 submit_plan 加 `kind`/`script`/`asserts`/`acceptance` 字段,模型被迫结构化输出。
- Planner 工具集 = `readOnlyTools()`(探查可用,写工具不在手,防 planner 越权写文件)。
- **replay 判定**:模型在 script 里写出的纯工具序列(允许 planner 产出确定性动作链,如 `npm run typecheck` → exitZero 断言)。编译期校验:script 里只允许只读工具 + shell;写文件动作一律强制 agent 节点。
- 规划失败 → 退化 std(与 V3 相同的降级路径)。

### 5.2 Runtime(dag-executor 改造)

- 拓扑分层、同层只读并行/写串行、失败传播、M3 checkpoint(每节点完成整体覆写存档)—— **全部从 V3 dag-executor 复用**。
- replay 节点:遍历 script,直接 `tools.run(args, ctx)`,逐步校验 step assert;失败重试 ≤2 次(同 args 重试,不换姿势;退避 1s/4s)。仍失败 → 标 failed,等待唤回。
- agent 节点:调 `runAgentLoop`(maxSteps 保险丝,默认 8,与 V3 deep 相同),产出 stepMessages 进 execHistory。
- **429 退避**:捕获到 429/限流类错误时,不是立即 error 整个任务,而是 park 当前节点(记录 checkpoint),按 Retry-After 或 60s 指数退避(60/180/600s,上限 600)排队重试;超上限或用户 abort 才终态。复用 `isTransientError` 判定。暂不做全局熔断(V3 的主动 failover 已有 quota 5h 窗口查询),只在引擎内 park。

### 5.3 结果缓存(runtime-cache.ts)

- key = `sha1(tool + JSON(args) + cwd)`,value = result 字符串 + 命中统计。
- TTL 分级:read_file/grep/web_fetch 30s;shell(确定性命令)60s;browser_* 5s;write/edit 类不缓存。
- **范围**:同一 plan 执行期内 + 跨 turn(会话内)。跨会话默认关(项目状态可能已变,宁慢勿错)。
- 与数据对应:同 turn 21% 重复调用,其中 sleep/typecheck/snapshot 是大头 → sleep 这类永不缓存;typecheck 只在同一节点重试窗口内复用。

### 5.4 验收断言(acceptance)

- goal 模式(无人值守)时,Compiler 把 goal 编译成 acceptance 断言表(如 `[{exitZero: "npm run typecheck"}, {fileExists: "release/*.exe"}]`)。
- Runtime 跑完 DAG 后执行断言表(0 LLM)。**全过 → `[GOAL_COMPLETE]`;有失败 → 唤回**,最小故障现场 = 失败断言 + 该节点最近输出 + plan 摘要。
- 对应数据:supervisor 94% continue 的根因是 LLM 无法确证"是否完成"——V4 把"是否完成"变成确定性判断,LLM 只裁决"为什么没完成"。

### 5.5 唤回协议(re-call)

- 触发条件:①节点重试耗尽 ②acceptance 失败 ③agent 节点产出与 action 契约不符(粗判:输出为空/仅报错)。
- 输入:最小故障现场(节点 id、失败断言、tail 输出 600 字、plan 摘要)。**不带全量 execHistory** —— 这就是省 token 的核心:LLM 不用重新读一遍 800 步历史。
- LLM 返回补丁指令:`{nodeId, action', 修复说明}` 或 `{abort, 理由}`。补丁只改该节点(保留 deps),Runtime 从该节点续跑(复用 checkpoint)。
- 唤回上限:每节点 3 次,总上限 10 次;超限 → 任务终态 failed,错误信息含"断言失败详情"供用户裁决。

### 5.6 沉淀(可选,一期不做)

跑通的 plan → skill 正文的候选(断言 + script 段可直接复用)。涉及 skills 目录写权限与语义命名,放二期。

## 6. 接线清单(与 V3 完全同构)

| 文件 | 改动 |
|---|---|
| `src/main/V4/` 新建 | `index.ts`(DirectV4Engine)、`legis-compiler.ts`、`plan.ts`(类型)、`assertions.ts`、`runtime-cache.ts`、`dag-executor.ts`(V3 复制改造:replay 分支+429 park)、`router.ts`(复用 V3 的,重导出) |
| `src/shared/types.ts` | `BuiltinEngineKind` + `BUILTIN_ENGINE_KINDS` 加 `directV4`;`ENGINE_POLICIES` 加 directV4 策略包(与 V3 同值起步) |
| `src/main/engines.ts` | `buildEngines()`:import DirectV4Engine,`pluginNames.has('kaios-v4')` 时注册(抄 claudeCode gating) |
| `src/main/plugins.ts` | 无改动(插件 manifest 不含 engine spec,走通用的启停逻辑) |
| `plugins/kaios-v4/plugin.json` | manifest:category dev,无 tools/slash/prompt 贡献点 |
| `src/shared/i18n.ts` | 4 语言加 `engine.directV4` |
| `src/renderer/app.ts` | syncEngineSelect 的 want 数组 + 5522 默认引擎 option + 5637/5658 bot 引擎 option |
| `src/renderer/engine-colors.ts` | directV4 加色(琥珀 `#f0c441`,与 v1/v2/v3 三色区分) |
| `src/renderer/nexus.ts` `town.ts` `arena.ts` `styles.css` | directV4 色/label 补齐 |
| `src/main/TaskManager.ts` | 3 处 isDirectFam 加 directV4(297/985/1764);goal 无人值守链路复用 V3 的 Job 化(v4DeepBackground 直接复用 v3DeepBackground 设置) |

## 7. 验收标准(实施完成的定义)

1. `npm run typecheck` 通过。
2. App 启动 → 设置页插件列表出现「Kaios v4」卡片 → **默认关闭**;开关后引擎下拉出现 directV4。
3. 选 directV4 发「读一下 README.md 并总结」→ fast 路由(0 规划开销);发「重构 X」类任务 → 编译出 LegisPlan,事件流可见 `[compile]`/节点状态。
4. replay 节点在事件流里可见(工具名无 [子任务] 前缀、无 cost 事件)= 零 LLM 证明。
5. 429 模拟:人为打断 API(或 mock)→ 任务 park 而非死,退避后恢复续跑。
6. 「开始」goal 模式跑一个真实小任务:acceptance 断言表执行,断言失败发生唤回(事件流可见「唤回」状态)。

## 8. 风险与边界

- **replay 误判风险**:模型把需要判断的动作写成 replay(如把 edit 写进 script)→ 编译期校验拦截(白名单:只读工具+shell 的确定性命令)。shell 里的写命令无法静态判定,靠 step assert 兜底(写后 fileExists 校验)。
- **断言编写质量**:模型写的断言可能太松/太紧 → 编译期给 few-shot 断言示例 + 唤回时允许 LLM 修断言(补丁协议含修断言能力)。
- **缓存脏读**:TTL 短 + 只读工具 + 同会话,风险可控;跨会话关。
- **与 V3 并存**:V4 不是替换,V3 的 std/fast 分流不变;两引擎代码共享 router/dag-executor 骨架,分叉点仅 replay/断言/唤回/缓存。
- **验收链路依赖 goal** 模式:无 goal 的普通 deep 任务,acceptance 可为空(退化成 V3 deep 行为,验收靠收尾 synthesis,可接受)。

## 9. 实施顺序(一次 commit 一组)

1. `docs/V4-Legis-引擎设计.md`(本文档)
2. plan.ts + assertions.ts + runtime-cache.ts(纯逻辑,无接线)
3. legis-compiler.ts + dag-executor(V4 版)
4. DirectV4Engine(index.ts)+ engines.ts 注册 + 插件 manifest
5. types/i18n/renderer 接线(下拉、色、label)
6. TaskManager isDirectFam + goal/Job 链路
7. typecheck + 手动验证 + README/wiki 提及
