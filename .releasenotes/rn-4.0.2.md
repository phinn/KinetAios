**发布日期:** 2026-10-23(自 v4.0.1 起 19 commits)

> 4.0.2 是「稳定性 + 长任务治理」版本:根治 goal 循环期的界面卡死与按钮无响应(goal ✕ 硬通道、persist 写节流、traj O(1) 拼接、增量渲染),补齐记忆 Git 仓库同步(memory as code)、web-companion 手机端回执、renderer console 黑匣子,以及 V5 Ralph Loop 全链路。定位:让 agent 长时间自己跑的时候,人随时看得见、管得住。

### ⚡ 界面卡死根治(四处连环 perf/fix)

- **traj 快照拼接 O(n)→O(1)**:applyEvent 每轮 LLM 调用全量拼接 traj 再截断,O(n) 累积把 renderer 心跳堵到停摆 30s+ —— 改为增量维护,心跳恢复。
- **persist 写节流**:主进程被同步 SQLite 写堵死导致 goal 取消按钮无响应 → 写操作节流合并。
- **广播节流 + 循环期增量渲染 + 侧栏降频 + 失焦降载**:goal 全速跑时 UI 不再整体重渲染。
- **冻结检测器降噪**:心跳被系统节流不是卡死,忽略隐藏/遮挡窗口,取证日志不再被误报污染。

### 🎯 goal 监工可管得住(三连修)

- **goal ✕ 走硬通道 `clearGoal`**:loop 全速跑时点 ✕ 没反应 → 清除 = cancel 整循环(含撤标记、清修正队列)。
- **saveConversation VALUES 占位符 21→20**:goal 清除按钮静默失效的根因(SQL 参数数不匹配被吞)。
- **方向修正立即落可见 ack turn**:插话修正后立刻看到「已收到」,不再像没反应。
- **失败/取消态重启后保留**:重启不再丢失败提示和 ⏵ 继续按钮。

### 🧠 记忆 Git 仓库同步(memory as code)

- 长期记忆导出为文本视图(`lessons.md` / `facts.ndjson` / `blocks.json`)同步到 git 仓库,**gitee / github 均可**,双机互同步。
- **隐私分级**:L0 lessons 明文、L1 facts/blocks、L2 对话原文永不出本地。
- **双向幂等**:push 前 pull,远端新条目并回本地(UPSERT / 去重 / LWW);凭证复用系统 git credential。设置 → 长期记忆 → Git 同步。

### 📱 web-companion 手机端增强

- 手机端发送即回执(发出立刻有反馈);支持在项目内新建会话;页面激活即刷新,不再看旧状态。

### 🧬 V5 Ralph Loop 全链路接通

- 任务级自迭代基因型拓扑(#3 P0):ralph 循环 + 验收(accept)+ 结算(settle)全链路,Universe 可选持久化。
- 附 Phylum 种群进化 Agent 引擎提案文档(docs)。

### 🔍 其它

- **renderer console 黑匣子**:Uncaught/Error 自动落盘 `renderer-console.log`,界面异常有据可查。
- **security-audit 内置 skill**:Cloudflare 安全审计方法论随 app 分发。
- **复制空内容明示**:复制空串不再假成功(此前 Electron `writeText('')` 静默成功但剪贴板为空),toast「没有可复制的内容」;复制成功也补反馈。
- **记忆块目标压制条款**:全局 active_goals 不再把会话带跑到别的项目。

---

**English**

**Release date:** 2026-10-23 (19 commits since v4.0.1)

> 4.0.2 is the "stability + long-task governance" release: it kills the UI freezes and dead buttons during goal loops (hard-channel goal ✕, throttled persistence, O(1) traj stitching, incremental rendering), adds memory Git-repo sync (memory as code), web-companion mobile receipts, a renderer console black box, and the full V5 Ralph Loop. Theme: while the agent runs for hours on its own, you can always see it and always stop it.

### ⚡ UI freeze — root-caused and fixed (four linked perf/fix commits)

- **Traj snapshot stitching O(n)→O(1)**: applyEvent re-stitched the full traj on every LLM call; the O(n) accumulation stalled the renderer heartbeat 30s+ — now incrementally maintained.
- **Throttled persistence**: the main process was blocked by synchronous SQLite writes (goal cancel button unresponsive) → writes are now throttled and merged.
- **Broadcast throttling + incremental rendering during loops + sidebar down-sampling + blur back-off**: no more full re-renders while a goal loop runs at full speed.
- **Freeze-detector denoising**: a throttled heartbeat is not a freeze; hidden/occluded windows are ignored, so forensic logs stay clean.

### 🎯 The goal supervisor is actually stoppable (three fixes)

- **Goal ✕ goes through a hard channel `clearGoal`**: clicking ✕ did nothing while the loop ran at full speed → clear now cancels the whole loop (including markers and the steering queue).
- **saveConversation VALUES placeholders 21→20**: the root cause of the silently dead goal-clear button (SQL arg mismatch swallowed).
- **Steering corrections get an immediate visible ack turn**: inserting a correction shows "received" right away.
- **Failed/cancelled states survive restart**: no more losing the failure banner and the ⏵ resume button.

### 🧠 Memory Git-repo sync (memory as code)

- Long-term memories export as text views (`lessons.md` / `facts.ndjson` / `blocks.json`) synced to a git repo — **gitee and GitHub both work** — for two-machine sync.
- **Privacy tiers**: L0 lessons in plaintext, L1 facts/blocks, L2 conversation history never leaves the machine.
- **Bidirectional & idempotent**: pull before push; remote entries merge back (UPSERT / dedupe / LWW); credentials reuse the system git credential. Settings → Long-term memory → Git sync.

### 📱 web-companion mobile enhancements

- Immediate send receipts from the phone; create sessions inside a project; the page refreshes on activation instead of showing stale state.

### 🧬 V5 Ralph Loop — full pipeline connected

- Task-level self-iterating genotype topology (#3 P0): the ralph loop plus acceptance and settle stages, with optional Universe persistence.
- Includes the Phylum population-evolution agent engine proposal doc (docs/).

### 🔍 Other

- **Renderer console black box**: Uncaught/Error are written to `renderer-console.log` automatically — UI anomalies leave evidence.
- **Built-in security-audit skill**: Cloudflare's security-audit methodology ships with the app.
- **Empty-copy is now explicit**: copying an empty string no longer fakes success (Electron `writeText('')` silently "succeeds" but the clipboard stays empty) — a toast says "Nothing to copy"; successful copies also toast.
- **Memory-block goal suppression**: global active_goals no longer drag a session into a different project.

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.0.1...v4.0.2
