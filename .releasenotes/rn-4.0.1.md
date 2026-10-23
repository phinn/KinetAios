**发布日期:** 2026-10-20(自 v4.0.0 起 5 commits)

> 4.0.1 是「生态调研落地」版本:把 2026-10 的 GitHub agent 生态调研(docs/agent-ecosystem-research-20261020.md)中 ROI 最高的六项直接落进主干 —— 工具输出落盘回捞、hindsight 式 lessons 教训记忆、目标预算分级降级、声明式策略沙箱、插件名契约、V5 疤痕库持久化。定位:agent 的「长时记忆 + 自我约束」基建周。

### 🗂️ 工具输出溢出落盘 + grep 回捞(context-mode 思路)

- **>8K 字符的工具输出**全文落盘 `userData/tool-outputs/<convId>/`(每轮 seq 命名),发给模型前截断并附回捞提示 —— 「截断丢信息」变成「截断可回捞」。
- 新增只读工具 **`grep_tool_output`**(pattern / file / context 行数),正则回捞历史溢出输出;截图类输出不走 spill(视觉内容必须原样可见)。
- 对标碾压点:Claude Code 截断即丢失,只能用户手动重跑。

### 📒 lessons 教训记忆层(hindsight: learn ≠ remember)

- **memories 表新增 `scope_cwd` 列**,kind=`lesson` 与 fact/rule 三分流:fact = 用户/项目事实,rule = 助手行为约束,lesson = 「这次踩的坑 → 下次怎么绕」的技术教训。
- lesson 绑定仓库 cwd:仓库级教训优先于全局教训注入;提取标准 = 修复报错 / 调试通 / 反直觉机制,格式「场景+做法+原因」≤40 字。
- 系统提示新增「📒项目教训」常驻注入区(最多 8 条);教训**排除出语义检索池**,避免与热区规则重复占位。
- 新增 **`lesson_manage`** 工具(list / forget / revise,校验 kind 防误删)。

### 🎯 目标预算分级降级(paperclip 治理思路)

- goal 预算从「100% 硬停」升级为**三级**:80% 注入收敛提示(促使主动收尾)→ 95% 替换为强制收尾指令 → 100% 硬停。
- **成本 + 时长双轨**同款分级;注入点位于用户方向修正之后(用户意图永远优先)。

### 🛡️ agent.policy.json 声明式策略沙箱(OpenShell 式单机最小版)

- 仓库根或用户级放一份 `agent.policy.json`,shell 工具执行前静态校验:**deny**(命中直接拒绝,不弹确认)/ **ask**(强制人工确认并标注规则来源)/ **allow**(文档化白名单);deny > ask > allow,第一条命中生效。
- 策略文件随 git 提交团队共享;损坏 JSON / 非法正则 = 忽略该策略并告警,策略层永不阻断主流程;无文件 = 零开销旁路。
- 落点在宿主自杀守卫、git 跨仓库守卫之后、用户 confirm 之前,与既有机械闸互补。

### 🔌 插件名契约:marketplace.json(paperclip 式)

- **插件 name 是不变身份**:目录名 / settings 引用 / 引擎 id 全部锚定它;改名必须走 renames 迁移,旧名进 retired 永久退役(禁止新插件复用,防旧目录残留撞名)。
- `plugins/marketplace.json` 声明 `{ name, retired, renames }`;加载器启动时**幂等迁移**存量引用(disabledPlugins + pluginEngineSettings 键),用户无感升级。

### 🧬 V5 疤痕库持久化 —— 还 4.0.0 技术债

- 4.0.0 已落 state.json(活体/账本/配子原子快照),但**疤痕遗传通路**(lineage → 最近死亡归因)在引擎层纯内存:死亡与替补出生之间 app 重启,疤痕丢失,定向突变退化成盲目克隆。
- 修复:疤痕挪进 GeneRegistry(`recordScar` / `scarOf`),随 state.json 快照/回读(向后兼容,旧快照无 scars 字段自动为空)。

---

**English**

**Release date:** 2026-10-20 (5 commits since v4.0.0)

> 4.0.1 is the "ecosystem research landing" release: the six highest-ROI items from our October GitHub agent-ecosystem research (docs/agent-ecosystem-research-20261020.md) land directly on main — tool-output spill & grep-back, hindsight-style lesson memory, tiered goal-budget degradation, declarative policy sandbox, plugin name contract, and V5 scar persistence. Theme week: long-term memory + self-constraint infrastructure for agents.

### 🗂️ Tool-output spill + grep-back (context-mode idea)

- Tool outputs over 8K chars are **spilled in full** to `userData/tool-outputs/<convId>/` (per-turn seq), truncated for the model with a retrieval hint — truncation no longer loses information.
- New read-only tool **`grep_tool_output`** (pattern / file / context lines) to regex-search spilled history; screenshots bypass spill (visual content must stay visible).

### 📒 Lesson memory layer (hindsight: learn ≠ remember)

- **`scope_cwd` column added to memories**; kind=`lesson` joins fact/rule in a three-way split: facts = user/project truth, rules = assistant behavior constraints, lessons = technical "we hit this pit → go around it next time" knowledge.
- Lessons are repo-scoped: repo-level lessons outrank global ones at injection; extraction criteria = fixed errors / things that finally worked / counter-intuitive mechanics, phrased as "scenario + approach + why" ≤40 chars.
- System prompt gains a persistent "📒 Project Lessons" section (top 8); lessons are **excluded from the semantic recall pool** to avoid double-occupying slots with hot rules.
- New **`lesson_manage`** tool (list / forget / revise, with kind validation to prevent accidental deletes).

### 🎯 Tiered goal-budget degradation (paperclip-style governance)

- Goal budgets go from "hard stop at 100%" to **three tiers**: 80% injects a wrap-up nudge → 95% swaps in a forced-finish instruction → 100% hard stop.
- Same tiering for **cost and duration**; injection happens after user steering corrections (user intent always wins).

### 🛡️ agent.policy.json declarative sandbox (OpenShell-style, single-machine minimal)

- Drop an `agent.policy.json` at repo root or user level; the shell tool statically checks it before execution: **deny** (blocked outright, no confirm dialog) / **ask** (forced confirmation labeled with the rule) / **allow** (documented whitelist); deny > ask > allow, first match wins.
- The policy file ships with the repo for team sharing; broken JSON / invalid regex = that policy ignored with a warning — the policy layer never blocks the app; no file = zero-cost passthrough.
- It slots after the host-suicide and cross-repo git guards, before user confirm — complementary to the existing mechanical gates.

### 🔌 Plugin name contract: marketplace.json (paperclip-style)

- **A plugin's name is its immutable identity**: directory name, settings references, and engine ids all anchor to it; renames must go through the renames table, with old names moved to retired (never reusable by new plugins, preventing stale-directory collisions).
- `plugins/marketplace.json` declares `{ name, retired, renames }`; the loader **idempotently migrates** existing references (disabledPlugins + pluginEngineSettings keys) on startup — upgrades are invisible to users.

### 🧬 V5 scar persistence — paying off 4.0.0 debt

- 4.0.0 already shipped state.json (atomic snapshot of live genomes/ledgers/gametes), but the **scar-inheritance channel** (lineage → latest death attribution) lived in an in-process map: if the app restarted between a death and its replacement's birth, scars vanished and directed mutation degraded to blind cloning.
- Fix: scars moved into GeneRegistry (`recordScar` / `scarOf`), snapshotted with state.json (backward compatible — old snapshots without scars load as empty).

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.0.0...v4.0.1
