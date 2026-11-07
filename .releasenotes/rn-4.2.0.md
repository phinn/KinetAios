**发布日期:** 2026-11-07(自 v4.1.0 起 9 commits)

# v4.2.0 — ask_user 决策卡 / 定时任务级模型 / 收入追踪

## 新功能
- **ask_user 决策卡(agent 需要你拍板时)** — 对标 Claude Code AskUserQuestion:`ask_user` 工具让 agent 在分叉点弹出结构化选项卡(2-6 个选项+说明文字),单选互斥/多选计数、「其他」自由输入非空即接管、Enter 提交/Esc 取消;答案回灌进对话继续执行,取消/超时回降级信号不挂死。跨主题一致性:浅色遮罩玻璃组(tahoe Liquid Glass)全量入册,选项行/输入框玻璃化,选中态高亮 `:has(input:checked)` 零 JS
- **定时任务级模型配置** — cron_tasks 加 model 列(存模型配置档 id,空=跟随全局默认);编辑卡下拉选档(「跟随全局默认」+全部 profiles,name+model 显示)、列表行 ·model· 徽标;dispatcher 每次触发 `setConvProfile` 钉频道模型,老频道改绑/清绑下一轮即生效;`cron_add`/`cron_update` 工具全链透传,agent 也能帮你建定时任务并指定模型;i18n 四语
- **收入追踪 tab(marketing-kit 插件)** — ASC/App Store Connect、闲鱼、Payhip、Fiverr 四渠道收入快照,照 promo 面板模式落地;渠道 kind 收敛为 `asc|manual`,UI 文案去平台专名

## 修复
- **cron 表达式 UI 保存恒失败(存量真 bug)** — `cron_validate` 直接透传 `parseCron` 的成功形态(含 match 闭包),跨 IPC 结构化克隆必炸「An object could not be cloned」→ UI 保存任何合法表达式恒失败(非法反而走报错分支所以从未暴露);修=`validateCron` 只返回 `{ok}|{ok,error}`,闭包留进程内调度器
- **决策卡「点提交没反应」(发布前 E2E 抓出)** — 上游 commit 只建了发送端(preload)与 resolver 表,main 侧 `ipcMain.on('ask-response')` 收据监听器整行缺失,renderer 发往无人接收通道,agent 永挂;补收据监听器(与 confirm-response 同构)+ mock LLM 全链 E2E 落库验证
- **决策卡渲染崩坏** — 全局 `input{width:100%}` 命中 radio 占满整行,label 挤成 11px 竖条文字不可见、行高 170px;radio 豁免 `width:auto` 恢复行内横排;顺删与真实 DOM 不匹配的死规则块
- **决策卡超时/中止残留锁焦点** — main 侧 10 分钟超时或 abort 解脱 resolver 后,渲染层卡片无感知继续锁屏(trapFocus),提交空打;新增 `ask-dismiss` 通道同步关卡,迭代弹新卡自动解脱旧卡,按 `activeAskId` 精确匹配防误关

---

**English**

**Release date:** 2026-11-07 (9 commits since v4.1.0)

# v4.2.0 — ask_user Decision Card / Per-Task Cron Model / Revenue Tracking

## New
- **ask_user decision card (when the agent needs you to decide)** — parity with Claude Code AskUserQuestion: the `ask_user` tool pops a structured option card at decision forks (2-6 options with descriptions), single-choice mutual exclusion / multi-select with count, free-text "Other" that takes over when non-empty, Enter to submit / Esc to cancel; the answer flows back into the conversation and execution continues, cancel/timeout returns a fallback signal so the agent never hangs. Cross-theme consistency: the light-scrim glass group (tahoe Liquid Glass) now covers the card, option rows and inputs are glassified, selected state highlights via zero-JS `:has(input:checked)`
- **Per-task cron model config** — cron_tasks gains a model column (stores a model-profile id; empty = follow the global default); the edit card gets a profile dropdown ("follow global default" + all profiles, name+model display) and list rows show a ·model· badge; the dispatcher pins the conversation's model via `setConvProfile` on every trigger, so rebinding/unbinding old channels takes effect next run; `cron_add`/`cron_update` tools pass the field end-to-end so the agent can create scheduled tasks with a model too; i18n in four languages
- **Revenue tracking tab (marketing-kit plugin)** — revenue snapshots across four channels: ASC/App Store Connect, Xianyu, Payhip, Fiverr, following the promo-panel pattern; channel kind narrowed to `asc|manual`, platform proper nouns removed from UI copy

## Fixed
- **cron expression always failed to save from the UI (pre-existing real bug)** — `cron_validate` passed through `parseCron`'s success form verbatim (containing a match closure), which always blew up across IPC structured clone ("An object could not be cloned") → saving any *valid* expression from the UI always failed (invalid ones hit the error branch instead, which is why it never surfaced); fix: `validateCron` returns only `{ok}|{ok,error}`, the closure stays in the in-process scheduler
- **Decision card "submit does nothing" (caught by pre-release E2E)** — the upstream commit built only the sender (preload) and the resolver table; the main-side `ipcMain.on('ask-response')` receipt listener was missing entirely, so the renderer sent into a channel nobody received and the agent hung forever; receipt listener added (mirroring confirm-response) with a mock-LLM end-to-end test verified via persisted events
- **Decision card rendering collapse** — the global `input{width:100%}` hit the radio, filling the whole row and crushing the label into an 11px vertical sliver with invisible text and 170px row height; radios are exempted back to `width:auto` inline layout; dead rule blocks that didn't match the real DOM were removed
- **Decision card lingering after timeout/abort, locking focus** — after the main side released the resolver on the 10-minute timeout or an abort, the renderer card stayed on screen holding focus (trapFocus) and further submits did nothing; a new `ask-dismiss` channel closes the card in sync, opening a new card auto-releases the old one, matched precisely by `activeAskId` to avoid closing the wrong card

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.1.0...v4.2.0
