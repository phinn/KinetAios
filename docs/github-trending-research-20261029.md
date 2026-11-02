# GitHub 热门仓库功能调研 → KinetAiosWin 增强清单

> 2026-10-29 | 调研对象:GitHub trending(月榜)+ agent CLI 桌面端赛道
> 方法:逐仓拆 README/源码结构 → 对照本仓现状(FEATURES.md/IMPROVEMENTS.md 已通读) → 按「真空区/已反超/噪音」三分类
> 结论先行:**2 个结构性真空 + 4 个低成本增强 + 2 个确认不需要追**

---

## 一、调研对象与本仓现状对照

| 热门仓库 | 定位 | 对本仓的价值 |
|---|---|---|
| **obra/superpowers** (307k★) | 9+ 编码代理通用「技能工作流方法论」:composable skills + 强制工作流(brainstorm→plan→TDD→review) | ⭐⭐⭐⭐⭐ 技能调度协议,直接可抄 |
| **JetBrains/thinkrail** (5.3k★, incubator) | pi 引擎套壳 IDE:git-worktree 隔离工作区、SPEC.md 活规格图、Settled 架子、锚定评审 | ⭐⭐⭐⭐⭐ 并行任务隔离,结构性补强 |
| **HKUDS/DeepTutor** (trending) | 三层可审计记忆的教育 agent | ⭐⭐ 场景不同,借小件(记忆用量仪表) |
| AstrBot / 其它 bot 框架 | 插件市场 | 本仓 plugin marketplace.json 已规划(P2),方向重合 |

**本仓已有、被验证反超的点**(调研确认不丢人,反而领先):
- 三引擎(Direct/claude/codex CLI)+统一事件流,superpowers 只适配各家 CLI,没有自家 ReAct 引擎
- 长期记忆全链(SQLite FTS5 + embedding cosine + memory-sync Git 同步 37138 facts)——DeepTutor 的三层记忆是应用内概念,无跨机同步
- V5 Ralph 循环 / V5 疤痕库 / loop 预算看门狗——superpowers 的"强制工作流"是 prompt 级,我们是执行器级
- ⌘P 速跳 / 项目组折叠 / 四语 i18n——桌面端打磨度超多数 trending 仓库

---

## 二、结构性真空 ①:git worktree 任务隔离(thinkrail)

### 现状痛点
Direct 引擎跑长任务(Ralph loop / 多文件重构)时,`shell` 工具直接在会话 cwd 里改工作区。
- 用户同时手动改同一目录 → agent 与人互踩
- 任务失败 → 工作区半脏状态,回滚靠 git 手工
- 多会话并行同项目 → edit_file 冲突无隔离

thinkrail 的解法:**每个会话可从 repo 切一个 `git worktree` workspace**,agent 全程在 worktree 里干活;
完成 → diff 审查 → merge 好分支 → 删 worktree;闲置/完成的 worktree 落到 per-project "Settled shelf" 架子上。

### 落地方案(KinetAiosWin 版)
```
TaskManager 开工前 hook:
  conv.policy.workspace = 'main' | 'worktree'
  worktree 模式:git worktree add .kinet/worktrees/<convId-short> -b kinet/<convId-short>
  之后该会话所有 shell/edit_file 的 cwd 钉死在 worktree 目录(shell 工具已有 cwd 参数,加 enforce 层)
完成 settle:展示 diff → 用户批准 → merge 回原分支 → worktree remove
闲置 >48h → 自动 prune + 侧栏「Settled」分组
```
- 侵入面小:shell 工具 cwd 钉死 = 在 `tools.ts` 的 shell 实现里加一个 conv 级 workspace root 前缀
- UI:侧栏会话条目加 worktree 徽章;完成时 confirm 桥接现有的 `confirm()` 面板走 settle 审批
- 与 Ralph 天然契合:loop 的每次 iteration 产物在隔离区,accept 才 merge——把 V5 ralph-accept 的 accept 语义落到 git 分支

### 优先级理由
这是「agent 桌面端 vs CLI」的差异化硬功能——CLI claude/codex 没有 worktree 编排,WorkBuddy 也没有
(10-29 UX 对照报告确认)。做了就是本仓独有的第二增长点。

---

## 三、结构性真空 ②:活规格图 SPEC.md(thinkrail)

### 现状痛点
- 项目知识现在只有三条通道:KinetAios.md(手写)、memory blocks(自动抽取,全局)、lessons(踩坑短句)。
  「这个项目的目标/架构决策/模块约定」没有 agent **主动维护**的结构化载体,跨会话 intent 容易断
- persona 串味刚修(ae44ead),本质是「项目级知识」与「全局画像」分不清——SPEC 正是项目级知识的正确容器

### thinkrail 的形态
`SPEC.md` 文件图谱长在代码旁边,agent 通过专属 `spec_*` 工具 read/search/maintain;
工作台把 spec graph 渲染成树。intent "survives the session"。

### 落地方案
```
新增工具 spec_read / spec_write(或合并 spec_search):
  定位 <cwd>/SPEC.md(或 .kinet/SPEC.md),不存在时从 git log + KinetAios.md 播种
systemPrompt 注入:项目有 SPEC 时在 sourceHint 段附加「项目规格摘要(前 N 行)」
    —— 与现有 engines.ts:561 的注入顺序对齐,插在 goal 之后
编辑收敛:spec_write 走 tool-spill 管道(已有),大改先 diff 后写
```
- 成本低:一个新工具 + systemPrompt 一行注入,复用 read/write 工具骨架
- 与 memory 体系分工明确:SPEC=项目事实(随 repo 提交),memory=用户事实(随人走)

---

## 四、低成本增强(各 ≤1 天,直接抄)

### 4.1 技能工作流编排(superpowers 的 brainwork→plan→TDD→review 链)
本仓 `skills.ts` + `~/.claude/skills` 已有载体,**缺的是「技能间的调度协议」**:superpowers 的核心
不是技能本身,是「哪个阶段强制用哪个技能」的 state machine(brainstorm 产出 plan→plan 卡住 TDD→
review 按 severity 阻断)。落法:
- skills.ts 加 `workflow` 类技能(SKILL.md frontmatter `workflow: brainstorm|plan|tdd|review`)
- AgentLoop 在 plan-approve 后注入对应 workflow 技能提示;review 技能可返回 `BLOCKING` 置信度
- 最小版:先把 security-audit 技能标成 review 类,绑定到「改了 src/main/**」的会话完成时点

### 4.2 记忆用量仪表(DeepTutor v1.5.11 的 live memory usage in Settings)
设置页记忆区加一行:`SQLite 37138 facts | blocks 3/3 块用量 78% | FTS 索引 220MB`。
SQL 三个 count + page_count*page_size,半小时活。配合已有的 memory-sync 状态行。

### 4.3 「每步一 commit + 独立可 review」(thinkrail shared plan)
长任务 plan 的每个 step 完成 → 自动 `git commit`(消息=step 标题)。复用 V5 已有的 step 完成事件,
Ralph 场景价值最大(iteration 产物逐个落 commit,accept 后 squash)。

### 4.4 上下文满主动建议新对话(WorkBuddy 报告已列,本次再确认是行业共识)
thinkrail/superpowers 都有等价物。token 预算超阈值 → 对话内插一条系统建议卡「开新对话并携带摘要」
——本仓已有会话摘要机制(episodic),缺的只是 UI 触发点。

---

## 五、确认不追的(防止过度工程)

| 功能 | 来源 | 不追理由 |
|---|---|---|
| agentic IDE 化(文件树/diff 视图/内嵌编辑器) | thinkrail | WorkBuddy 对照报告已判:表达层小步补,不做 IDE |
| 插件市场 | AstrBot/DeepTutor | 本仓 P2 已规划 marketplace.json,等 agent-policy 落地后做 |
| 多 provider auth 托管 | thinkrail | 本仓「你的凭证你的 key」设计更干净,不引入账号体系 |
| 教育场景三层记忆 | DeepTutor | 场景不同;本仓 memory 已有 FTS+embedding+Git 同步三件套 |
| 浏览器形态(CLI 开同一 app in browser) | thinkrail | web-companion 已覆盖远程访问诉求 |

---

## 六、建议落地顺序(结合 UX 报告的 P0)

1. **P0-1 流中间态信息分级**(UX 报告遗留,表达层最高痛点)
2. **P0-2 worktree 任务隔离** —— 本报告最大增量,差异化硬功能
3. **P0-3 SPEC.md 活规格** —— 项目知识容器,成本极低收益高
4. P1 技能工作流编排(security-audit 绑 review 时点先行)
5. P1 记忆用量仪表 / 每步一 commit / 上下文满建议卡
6. P2 marketplace.json(维持原规划)

> 注:1/4/6 与既有 UX 报告、技术债清单重合处不重复展开;本文档新增的是 2(worktree)、3(SPEC)
> 两个结构性项及逐项落地方案。
