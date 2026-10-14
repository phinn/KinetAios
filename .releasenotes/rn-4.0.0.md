**发布日期:** 2026-10-14(自 v3.9.8 起 33 commits)

> 4.0.0 是里程碑版本:两大自研引擎正式落地 —— **V4 Legis(立法者)** 与 **V5 Phylum(种群进化)**,外加停止失效竞态修复与设置页引擎可见性闭环。

### 🏛️ V4 Legis 立法者引擎 —— 意图一次编译,断言失败才唤回 LLM

- **核心范式**:LLM 一次性把任务意图编译为**断言计划图**(节点 = IO 契约 + 断言,边 = 依赖与回退),Runtime 零 LLM 回放执行;断言失败 / schema 变化 / 计划外边才唤回最小故障现场的 LLM。对标 ReAct 逐步问 LLM 的旧范式,重复任务成本断崖式下降。
- **全链落地**:directV4 引擎插件化(无 bin 的内置开关型 spec)→ UI 全链(引擎下拉/色彩/四语/arena 图标)→ Direct 家族判定补齐(上下文实时化/配置档/断点续打)。
- **路由修复**:Legis 路由死区 + shell 长任务超时 600s,修 0 触发根因;分析任务判定放宽;前 2 轮工具步数 ≥8 或排障信号禁 fast 路径。
- **防双白烧**:立法退化不再从零重跑(显式继承 directHistory);路由决策落库存证。
- **探查预算断供**:planner 软约束三连败后的硬墙 —— 超预算轮次只留 submit_legis_plan,杜绝"12 轮只读白跑、0 立法产物"的事故重演。
- **可观测性**:legis/compile 结构化事件(节点/边/耗时/降级原因)透传到考古面板。
- **后台交接**:deep 任务 → 后台 Job 交接后 UI 状态贯通(handoff 语义),呼吸点/状态条持续到回贴。

### 🧬 V5 Phylum 种群进化引擎 —— 基因池 + 死亡归因 + 化石层

- **directV5 引擎插件化**(phylum-engine):基因三件套 / 死亡归因 / 硬约束表达,12 断言 + 种群进化烟囱最小闭环。
- **签名重量分池**:heavy/light 隔离基因池,heavy founder 32 步,根治误领重活。
- **挂起语义三连根修**:settle 抢跑踢出活体池 / 基因库纯内存重启清零 / Universe 同病;provider 侧错误(quota 429 / 5h 窗口 / network / auth)走挂起通道,不再误判个体死亡污染基因库。
- **无限循环事故三连根修**:重复动作熔断 / 进度门 / 上下文折叠,硬步墙 200 兜底。
- **步数预算对齐真实任务尺度**:founder 6→12 / 值域 8→40 / step_budget 补偿 +1→+4;maxTurns=0(无限轮)时完全跟随宿主设置。
- **化石层落地**:轨迹重放(档②)+ 收敛冻结路由(档①),种群终态 = 零 token 化石。
- **个体执行可视化**:tool_start 配对 + 每步 status + 流式 token 透传,V5 不再黑盒。

### 🛑 停止失效竞态修复(fb14b4d)—— 「点了停止还在跑」连根拔

- **事故**:running 中发新消息会并行第二个 engine.run;旧轮收尾 finally 无条件 `aborts.delete(id)` 误删新轮 AC → 之后点停止永远无效,引擎失控 40+ 分钟持续烧钱(DB 实锤)。
- **修复**:① sendCore 主路径双跑防线 —— running 中来新消息 = 停旧开新(与 renderer 行为一致,goal 频道不受影响);② finally 世代校验 —— 只删自己这代 AC。

### ⚙️ 设置页引擎可见性闭环

- 引擎贡献插件独立「引擎」分组置顶 + 卡片引擎徽章;V1/V2/V3 内置引擎以合成虚拟卡片接入(仅展示、无卸载);未注册分类插件归入 misc 不再静默消失;合成引擎卡点击不展开空详情面板。

### 🧰 其他

- 新插件 **vm-console**:VNC 截屏 OCR + QMP send-key 固化。
- AgentLoop:假设升级 nudge / 折叠保留 text 摘要 / 长 IO 任务轮数放宽;shell 工具结果带时间戳头部与 exit code 尾部。
- metrics:tool/call 事件补 outcome 三档埋点,失败率可统计。

---

**English**

**Release date:** 2026-10-14 (33 commits since v3.9.8)

> 4.0.0 is a milestone: two homegrown engines ship — **V4 Legis (the Legislator)** and **V5 Phylum (population evolution)** — plus the stop-button race fix and the engine-visibility loop closed in Settings.

### 🏛️ V4 Legis engine — compile intent once, wake the LLM only on assertion failure

- **Core paradigm**: the LLM compiles task intent once into an **assertion plan graph** (nodes = IO contracts + assertions, edges = dependencies & fallbacks); the runtime replays with zero LLM calls. The LLM is woken only on assertion failure / schema drift / out-of-plan edges, with a minimal fault scene. Versus the ReAct pattern of asking the LLM every step, repeated-task cost drops off a cliff.
- **Full-chain landing**: directV4 engine pluginized (bin-less built-in toggle spec) → full UI wiring (engine dropdown / colors / 4 languages / arena icon) → Direct-family checks completed (live context / config profile / resume).
- **Router fixes**: Legis routing dead-zone + 600s timeout for long shell tasks (root cause of zero triggers); analysis-task detection loosened; ≥8 tool steps in first 2 turns or triage signals disable the fast path.
- **No double burn**: legis degradation inherits directHistory explicitly instead of restarting from zero; routing decisions persisted as evidence.
- **Probe-budget cutoff**: hard wall after three soft-constraint failures — over-budget turns only allow submit_legis_plan, preventing a repeat of the "12 probe turns, zero legis output" incident.
- **Observability**: legis/compile structured event (nodes / edges / duration / degradation reason) surfaced in the archaeology panel.
- **Background handoff**: deep task → background Job keeps UI state alive via handoff semantics; breathing dot / status bar persist until re-attach.

### 🧬 V5 Phylum engine — gene pool + death attribution + fossil layer

- **directV5 pluginized** (phylum-engine): gene trio / death attribution / hard-constraint expression; 12 assertions + population-evolution smoke loop as the minimal closed experiment.
- **Signature-weight pools**: heavy/light gene pools isolated, heavy founder gets 32 steps — no more light insects claiming heavy work.
- **Suspension semantics, root-fixed ×3**: settled-race eviction from live pool / in-memory gene bank reset on restart / Universe same-disease check; provider-side errors (quota 429 / 5h window / network / auth) route to the suspension channel instead of polluting the gene bank as fake deaths.
- **Infinite-loop incident, root-fixed ×3**: repeated-action circuit breaker / progress gate / context folding, with a hard 200-step wall as backstop.
- **Step budgets aligned to real task scale**: founder 6→12 / range 8→40 / step_budget compensation +1→+4; maxTurns=0 (unlimited) fully follows host settings.
- **Fossil layer**: trajectory replay (tier ②) + convergence freeze routing (tier ①); terminal population state = zero-token fossils.
- **Individual execution visibility**: tool_start pairing + per-step status + streaming token passthrough — V5 is no longer a black box.

### 🛑 Stop-button race fix (fb14b4d) — "I pressed stop but it kept running", uprooted

- **Incident**: sending a new message while running started a second engine.run in parallel; the old turn's epilogue finally unconditionally `aborts.delete(id)` deleted the new turn's AbortController — every subsequent stop press was a no-op while the engine burned tokens for 40+ minutes (confirmed in DB).
- **Fix**: ① sendCore double-run guard — a new message during running = stop-old-start-new (same as renderer behavior; goal channel unaffected); ② generation check in finally — only delete its own generation's AC.

### ⚙️ Engine visibility loop closed in Settings

- Engine-contributing plugins get a dedicated top-pinned "Engines" group with engine badges on cards; V1/V2/V3 built-in engines appear as synthetic display-only cards (no uninstall); unregistered-category plugins fall into misc instead of vanishing silently; synthetic engine cards no longer open an empty detail panel.

### 🧰 Other

- New plugin **vm-console**: VNC screenshot OCR + QMP send-key solidified.
- AgentLoop: hypothesis-upgrade nudge / folded summaries keep text / relaxed turn budget for long-IO tasks; shell results now carry a timestamp header and exit-code footer.
- metrics: tool/call events gain a three-tier outcome stamp — failure rate is now computable.

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.9.8...v4.0.0
