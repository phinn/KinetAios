**发布日期:** 2026-10-19(自 v3.9.4 起 15 commits)

### 🧬 Code Mode + Workflow —— 用 JS 编排工具链、阶段化多 agent 流水线

- **Code Mode 工具** `codemode`(38b8d9f / facfdaf / 0c158d1)—— 模型写一段 JavaScript,跑在 QuickJS-WASM 沙箱里,通过 `tools.*` 调用其它工具。嵌套调用与中间结果**不进 LLM 上下文**,只回传 return 值:批量打标 N 个条目、`Promise.allSettled` 并行只读调用、把大输出过滤成小摘要,全部一次调用完成,上下文零膨胀。嵌套调用复用各工具自身的审批/沙箱/隐私闸(codemode 是编排层不是提权层);每次执行独立 worker + VM,超时 terminate、abort 透传、内存受 wasm32 上限约束、console 限流;Direct 双引擎接入,并行确认弹窗语义(多弹窗只保留最后一个)已写进 prompt。
- **Workflow 编排** `workflow_run`(f44ad50 / 2439b3e / 5e248d3)—— team 超集:阶段串行 × 阶段内成员并行,上一阶段全部产出自动汇总注入下一阶段 prompt。适合「并行调研 → 交叉评审 → 终审合成」的分阶段流水线(阶段上限 7,单阶段成员上限 8)。聊天流内嵌工作流卡:阶段时间轴(绿完成 / 橙发光进行 / 灰待跑)+ 成员胶囊网格,增量按签名替换,保留展开状态。

### 🎯 Goal 会话:运行中方向修正

- 运行中发消息不再被静默丢弃(2a6be6c)—— goal 循环跑到一半时,新消息进修正队列,监工 UI 同步可见,下一轮注入修正方向。
- 修复「停止后发消息全部蒸发」(626571e)—— 根因链:点停止 → cancel 清修正队列,但 goalLoopLive 未撤;秒发「继续」命中修正队列分支 park 进队列;随后引擎收尾的 Auto-Loop 不查 aborted 照样接力,循环顶见 initialAc 已 abort 立即 break,出口 clearCorrection 把刚 park 的修正无声丢弃。三处根治:收尾不再接力 / 停止时撤销 loop 存活标记 / park 与 clear 的时序互斥。

### ⚡ 性能:长跑会话截图 token 泄漏根治(b6aa313)

- **根因**:截图走数组 content(多模态)后,`foldOldToolResults` 的 `typeof content === 'string'` 判断把截图消息整体排除在折叠之外 → 472 张 2560×1440 截图永不回收,每步全量重发。实测 KinetVM 主会话 603M input tokens,68 次 ≥500K 的调用占 32%。
- **修复**:① fold 纳入多模态消息,image part 换占位文本(最近 3 张豁免,保留近期视觉上下文);② `estMsgChars` 图片按固定 ~2K tokens 计入估算 —— 不能按 base64 字符折算(vision 按 tile 计费,按字符会高估数百倍把 trim 吓成全砍);③ 折叠触发阈值 150K→80K,保留最近工具结果 10→6;④ 全屏截图上限 2560×1440→1600×900(vision token ~4×);⑤ `browser_screenshot` CDP clip 限宽 1600×1200(视觉确认专用,点击本就走 DOM selector)。
- **效果预估**:同规模长跑会话 input 603M → ~250-300M,≥500K 的巨调用基本消失。

### 📦 仓库与发布流程

- contributor loop 基建(5b5b582):3 个 ISSUE 模板 + 双语 CONTRIBUTING + README badge;release 流程治本(273d9c3):双语 checklist 写进项目规则 + `scripts/pre-tag-check.sh` 机械校验,补齐 3.8.1~3.9.0 历史漏掉的英文段。

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.9.4...v3.9.5

---

**English**

### 🧬 Code Mode + Workflow — Orchestrate toolchains in JS, staged multi-agent pipelines

- **Code Mode tool** `codemode` (38b8d9f / facfdaf / 0c158d1) — the model writes JavaScript that runs in a QuickJS-WASM sandbox and calls other tools via `tools.*`. Nested calls and intermediate results **never enter the LLM context**; only the return value comes back: batch-tag N items, fan out read-only calls with `Promise.allSettled`, or filter a huge tool output down to a short summary — one call, zero context bloat. Nested calls reuse each tool's own approval / sandbox / privacy gates (codemode is an orchestration layer, not a privilege escalation); every execution gets its own worker + VM with timeout terminate, abort propagation, a wasm32 memory ceiling, and console rate-limiting; wired into the Direct engine on both protocols, with the parallel-approval semantics (only the last of multiple pending confirmations survives) written into the prompt.
- **Workflow orchestration** `workflow_run` (f44ad50 / 2439b3e / 5e248d3) — a superset of teams: stages run serially while members within a stage run in parallel, and every output of the previous stage is auto-summarized into the next stage's prompts. Built for "parallel research → cross review → final synthesis" pipelines (up to 7 stages, 8 members per stage). The chat stream renders an inline workflow card: a stage timeline (green done / glowing orange running / grey pending) plus a member capsule grid, updated incrementally by signature with expand/collapse state preserved.

### 🎯 Goal sessions: mid-run steering

- Messages sent while a goal loop is running are no longer silently dropped (2a6be6c) — they enter a correction queue, visible in the supervisor UI, and get injected on the next round to adjust direction.
- Fixed "messages sent after Stop all vanish" (626571e) — root-cause chain: Stop cancels and clears the correction queue but leaves goalLoopLive armed; a quick follow-up "continue" parks into the correction queue; the engine's finishing Auto-Loop then relays without checking aborted, the loop top sees the aborted initialAc and breaks immediately, and the exit's clearCorrection silently discards the just-parked correction. Fixed in three places: no relaying after teardown / loop-liveness marker revoked on stop / park-vs-clear ordering made mutually exclusive.

### ⚡ Performance: root-cause fix for screenshot token leakage in long-running sessions (b6aa313)

- **Root cause**: once screenshots moved to array content (multimodal), `foldOldToolResults`'s `typeof content === 'string'` check excluded them from folding entirely — 472 screenshots at 2560×1440 were never reclaimed and resent in full on every step. Measured: one KinetVM main session burned 603M input tokens; 68 calls at ≥500K each accounted for 32%.
- **Fix**: ① folding now covers multimodal messages — image parts are replaced with placeholder text (the 3 most recent are exempt, keeping recent visual context); ② `estMsgChars` counts each image at a fixed ~2K tokens — not by base64 length (vision bills per tile; per-character math overestimates by orders of magnitude and would scare trim into gutting history); ③ fold trigger threshold 150K→80K, recent tool results kept 10→6; ④ full-screen capture capped at 1600×900 (down from 2560×1440, ~4× fewer vision tokens); ⑤ `browser_screenshot` clips via CDP to 1600×1200 (visual confirmation only — clicks already go through DOM selectors).
- **Projected effect**: a same-scale long-running session drops from 603M to ~250-300M input tokens; ≥500K mega-calls basically disappear.

### 📦 Repo & release process

- Contributor loop groundwork (5b5b582): 3 issue templates + bilingual CONTRIBUTING + README badge. Release-process root fix (273d9c3): the bilingual checklist is now part of the project rules plus a mechanical `scripts/pre-tag-check.sh` gate, and the missing English sections of releases 3.8.1–3.9.0 were backfilled.

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.9.4...v3.9.5
