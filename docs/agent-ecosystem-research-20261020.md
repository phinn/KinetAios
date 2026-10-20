# GitHub AI/Agent 生态调研 → KinetAiosWin 可借鉴功能清单

> 2026-10-20。数据源:GitHub Trending(monthly)+ 12 个高价值仓库 README 深读。
> 基线:以 v4.0.0(V4 Legis / V5 Phylum / V2 引擎家族 + team/workflow/codemode/browser 组/cron)为当前能力面,
> 7 月的 FEATURES.md 对标矩阵已过时(上面标的 ✗ 项如 grep/glob、edit_file、@文件、AGENTS.md、todo 清单、子 agent 均已落地)。

---

## 一、Trending 信号(月榜,均为 2026-10 数据)

| 仓库 | Stars | 定位 | 与 KinetAiosWin 的关系 |
|------|-------|------|------------------------|
| paperclipai/paperclip | 104K | 「AI agent 公司」编排层:org chart/预算/治理/目标对齐 | ⭐ 直接竞品方向,借鉴价值最高 |
| vectorize-io/hindsight | 51K | agent 记忆系统(学习而非回忆,带论文+benchmark) | ⭐ 记忆系统下一代参照 |
| mksglu/context-mode | 31K | 上下文治理:工具输出落盘 + FTS5 检索 + 代码化执行 | ⭐ 与我们已有 SQLite/FTS5 天然契合 |
| cloudflare/security-audit-skill | 32K | 6 阶段安全审计 skill(ledger/断言/可复跑) | skill 形态的天花板样例 |
| NVIDIA/OpenShell | 16K | agent 零信任沙箱:内核级策略 + 策略形式化验证 | 沙箱远期方向 |
| agent-substrate/substrate | 5.6K | K8s 上百万 agent 微 VM 快照恢复(<400ms) | 云端架构,暂不适用 |
| HKUDS/CLI-Anything | 55K | 把一切软件包装成 agent 可用 CLI(cli-hub 生态) | 工具生态思路 |
| heygen-com/hyperframes | 67K | HTML→确定性 MP4 渲染框架(为 agent 设计) | 可作为内置 skill |
| cursor/plugins | 13K | Cursor 官方插件市场(orchestrate/thermos/ralph-loop) | 插件市场对标 |
| anthropics/claude-plugins-official | 43K | Claude 插件目录规范(plugin.json/marketplace.json) | 我们的 KinetAiosPlugin.md 对标 |
| anthropics/knowledge-work-plugins | 30K | 知识工作场景插件包 | 场景化 skill 打包 |
| obra/superpowers | — | 可组合 skill 的完整开发方法论(brainstorm→plan→TDD→debug) | ⭐ Direct 引擎行为升级参照 |

旁证:trending 月榜前 20 里 agent 相关占 8 席;「agent 编排/记忆/上下文治理/沙箱」四条主线全部在榜 —— 方向选择正确。

---

## 二、可借鉴功能(按 ROI 排序)

> **落地进度(2026-10-20 排期执行)**
> | # | 项 | 状态 | commit |
> |---|-----|------|--------|
> | 1 | 工具输出落盘+grep_tool_output 回捞 | ✅ 已落地 | b381ed9 |
> | 5 | lessons 记忆层(hindsight learn≠remember,scope_cwd 仓库过滤+常驻注入+lesson_manage) | ✅ 已落地 | b381ed9 / 2aba683 |
> | 4 | 预算治理(80%预警/95%强制收尾分级降级,时长同款) | ✅ 已落地(分级注入版; budgets 表+设置页面板待续) | 2aba683 |
> | 11 | agent.policy.json 声明式沙箱(deny/ask/allow 静态闸,mtime 缓存,坏 JSON 旁路) | ✅ 已落地 | 0c3beaf |
> | 8 | 插件市场契约(marketplace.json name 不可变+retired+renames 幂等迁移) | ✅ 已落地(加载器侧;市场 UI 待续) | 0c3beaf |
> | 6 | V5 基因池持久化 | ✅ 债务实况修正:4.0.0 已有 state.json/templates.json;本轮补齐疤痕库持久化缺口 | ac874a9 |
> | 2 | security-audit skill 内置 | ✅ 已落地 | f3459c2 |
> | 3 | Ralph Loop 自迭代基因型 | ⬜ 待做 | — |

### P0 · 立即做(几小时~2 天,直接增强现有能力)

**1. 工具输出「落盘 + 检索」模式**(context-mode 核心思想)
- 现状:我们已有 `truncateForModel()` 头尾截断(IMPROVEMENTS #8),截掉的中间段直接丢失。
- 借鉴:超长工具输出(>32K)截断的同时**全文落盘** `userData/tool-outputs/<conv>/<seq>.txt`,给 agent 一个新工具 `grep_tool_output(pattern, seq)` 走 FTS5/grep 检索回捞。
- 落点:`AgentLoop.ts` 的工具结果回填处 + `tools.ts` 加一个只读工具。改动 <100 行,把「截断丢信息」变成「截断可回捞」。
- 对标碾压点:Claude Code 没有这层,它靠用户手动 re-run。

**2. 安全审计 skill 内置**(cloudflare/security-audit-skill)
- 我们已有 skills 机制和 `~/.claude/skills` 扫描,但**自带 skill 为零**。
- 借鉴其方法论做成 `skills/security-audit/`:侦察→狩猎→验证→裁决(confirmed/needs_validation/rejected)→ledger 落盘→可复跑(增量只验变更源文件)。正好吃我们已有的 FTS5(ledger 检索)和 todo 工具。
- 这是把「V4 Legis 断言计划」哲学复用在安全场景,叙事自洽。

**3. Ralph Loop / 自迭代循环作为 V5 内置拓扑**(cursor/plugins 的 ralph-loop)
- V5 Phylum 已有种群进化,但「同一个任务让 agent 自引用迭代直到验收」是另一个正交拓扑,实现极薄:一个 while 验收断言不满足就带着上一轮 diff 重新进入的循环 + 轮数熔断(我们已有熔断器)。
- 可先做成 V5 的一种基因型,验证后再暴露为引擎选项。

### P1 · 本月做(1-2 周)

**4. Agent 目标/预算治理面板**(paperclip 核心)
- paperclip 的本质:goal → budget(时间/token/钱)→ governance(审批)→ 成本归因,全是「公司治理」隐喻。
- 我们已有 token 统计和 cron,缺的是**目标级聚合**:给一个长期任务(或 cron 任务)设月度 token/USD 预算,超限告警/降级(如自动切到便宜模型)。
- 落点:`store.ts` 加 budgets 表 + TaskManager 汇总时校验 + 设置页一节。这是「agent 仪表盘」定位的自然延伸,且是 paperclip 已验证的付费点。

**5. 多 agent 记忆共享层**(hindsight + letta)
- 我们的记忆是「关于用户的事实」,缺「**关于任务/代码库的学习**」:hindsight 的核心区分是 remember(回忆历史)vs **learn**(把「这次踩的坑→下次怎么绕」沉淀成可复用教训)。
- 落点:memory 提取时增加一类 `lessons`(repo 范围,带 cwd 过滤 —— IMPROVEMENTS #12 已有 schema 基础),注入时按当前 cwd 相关性检索。我们的死循环熔断、超时、VFR 坑这类教训正该进这层。
- 本机 790 个 Claude session 分析(IMPROVEMENTS 一节)就是这种「教训库」的手工版,正好产品化。

**6. 超时/长任务「快照-恢复」**(substrate 思想,单机版)
- substrate 把闲置 agent 快照出内存、请求到达 <400ms 恢复。单机版对应物:**会话级断点续传已有了,但进程重启后 V4/V5 的基因池/化石层是纯内存清零**(rn-4.0.0 已记此坑)。
- 借鉴:把 gene pool/fossil 序列化到 SQLite(重启恢复),使「种群进化」跨会话累积。这是 V5 从演示走向生产的关键一步。

**7. CLI-for-Agent 规范**(cursor/plugins 的 cli-for-agent skill)
- 给我们自己的内置工具做一遍「agent 可靠性审计」:flags 带示例、错误可恢复、幂等、dry-run。scope_diag/sigrok 这类新工具尤其需要。
- 产物是一份内部 checklist + 对 tools.ts 的补丁,顺手把 IMPROVEMENTS #1/#2(cd 滥用/Edit 前必 Read)做成 hook。

### P2 · 季度做(差异化护城河)

**8. 插件市场 + marketplace.json 规范**(claude-plugins-official)
- 我们有 KinetAiosPlugin.md(SOP),缺分发。借鉴其目录结构(`/plugins` + `marketplace.json` + name 不可变 + renames 迁移表)建 `kinet-plugin-market` 仓库。
- 关键细节直接抄:**plugin name 是不可变 slug**,改名必须走 renames 映射自动迁移 —— 这个坑他们已经替我们踩过。

**9. HTML→视频/富产物渲染管线**(hyperframes)
- KinetBrief 已有「数据分析→HTML 报告」产线。把 hyperframes 思路(HTML/CSS/seekable 动画→确定性 MP4)接到 Direct 引擎作为一个重型 skill,agent 可直接产出宣传视频/演示动画。
- 与我们已有的 video_gen(文生视频)互补:hyperframes 管「确定性 UI 动画」,video_gen 管「生成式画面」。

**10. 浏览器自动化引擎对齐**(browser-use / UI-TARS)
- 我们 agent Chrome 组已能覆盖 DOM 级操作,但缺 **vision 兜底**(CAPTCHA/Canvas/非 DOM 场景)。
- browser-use 的分层(hosted cloud / 本地 CLI / 库)值得抄:做一个「browser-use 兼容层」不如把 UI-TARS 的 vision-action 模型作为 browser 组的 fallback 引擎选项(需要多模态输入,依赖 #29 图片输入先行)。

**11. Zero-trust 沙箱策略文件**(OpenShell)
- 我们的沙箱目前是「approval: always/never + 确认模态」。OpenShell 的抽象是**声明式 policy 文件**:每个 agent 声明可触路径/网络/凭据,内核强制。
- 单机可用最小版:每会话可选挂一份 `agent.policy.json`(allow 路径前缀 + 禁网域名 + 环境变量白名单),shell 工具执行前静态校验。不用内核级,Electron 层做就有 80% 价值。

**12. 记忆写入的对抗性防护**(hindsight 的 claim 结构)
- IMPROVEMENTS #37(记忆注入 prompt injection 防护)还挂着。hindsight 给每个记忆带 provenance(来源回合/置信度/衰减),借鉴:记忆入库时带 `source_turn` + `confidence`,注入时低置信度记忆降权,来源不可溯的记忆不入库。

---

## 三、明确不抄的(避免过度设计)

| 仓库 | 不抄理由 |
|------|----------|
| agent-substrate/substrate | K8s 微 VM 编排,是云厂商生意;单机桌面端快照恢复(上面 #6)已吃到精髓 |
| freellmapi | 免费聚合 API 是灰色地带,与我们本地优先+付费 API 定位冲突 |
| ECC | 营销驱动的全家桶(AGPL+强制 telemetrtry 味道),组件思路可参考但不引依赖 |
| ghidra/financial-services 等 | 垂直场景,与产品无关 |
| gpui-kit/impeccable | Rust UI 框架,与我们 Electron 栈不符 |

---

## 四、执行摘要(给下一轮排期)

1. **本周可动工**:#1 工具输出落盘检索(最薄、最自洽、Claude Code 没有)→ #2 security-audit skill → #7 CLI-for-Agent 自审
2. **本月主线**:#4 预算治理(产品叙事:「agent 仪表盘」对「agent 公司」的降维)→ #5 lessons 记忆层(吃掉本机 790 session 分析的方法论)→ #6 V5 基因池持久化(还 rn-4.0.0 的技术债)
3. **季度护城河**:#8 插件市场(生态卡位,对标 anthropics 官方目录规范)→ #11 policy 沙箱(安全叙事上桌)
4. 所有 P0/P1 项遵守:双语注释、`npm run typecheck`、release note 中英双语、tag 前跑 pre-tag-check.sh
