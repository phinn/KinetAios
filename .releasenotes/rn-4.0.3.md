**发布日期:** 2026-10-24(自 v4.0.2 起 6 commits)

> 4.0.3 是「记忆同步跨设备闭环」版本:会话历史(conversations + turns + 全文索引)全量进 Git 同步,导出/导入全线流式化根治大库崩溃,turns 分片 + gzip 过 gitee 单文件 100MB 配额,同步全程实时进度回显。至此,换一台电脑 clone 同一个仓库,记忆、教训、目标、以及全部对话历史与可检索性一起到位。

### 🔄 会话历史全量同步(跨设备接续会话)

- **同步范围扩到四张表**:原 memories/lessons/blocks 三个派生视图之外,新增 conversations + turns 导出导入;导入后回填 FTS(prompt+answer 双条),`recall_memory` 跨设备可检索。
- **本地为准幂等合并**:按 id 去重,已存在的会话/轮次不覆盖;conv_events 不导(append-only 存证是体积大头,turns 缓存足以重建视图)。
- **对话原文随同步携带**:隐私语义从「原文不出本地」升级为「原文进你自己的私有 Git 仓库」——仓库在你手上,端到端仍无第三方服务。

### 🚄 大库导出根治(两处连环)

- **Invalid string length 根治**:整库 turns `join()` 拼单串撞 V8 ~512MB 字符串上限 → 全量读写改 `iterate()` + 逐行 NDJSON 流式,2GB 库不再崩。
- **turns 分片 + gzip**:单文件 881MB 撞 gitee pre-receive 单文件 100MB 配额(报错误导为「远端有新提交」)→ 64MB 原文/片、gzip 逐片写,真实库 14 片 × 18~22MB;读侧按文件名序 gunzip 合流,旧单文件/旧分片先清后写防残留。

### 📊 同步进度实时回显

- **状态栏实时百分比**:`memorySync onProgress` → IPC `memory-sync-progress` → 设置页状态栏「同步中·导出轮次 63%」,覆盖 clone/pull/导入/导出/commit/push 全阶段;`store.countTurns()` 支撑百分比分母。首推 7381 条(~750MB 原文)约 2 分钟,全程可见,不再是干等。

### 📱 web-companion 手机端

- 手机详情页显示工具执行轨迹:agent 每步调了什么工具、参数是什么,手机上看得见。

### Full Changelog

https://github.com/phinn/KinetAios/compare/v4.0.2...v4.0.3

---

**English**

**Release date:** 2026-10-24 (6 commits since v4.0.2)

> 4.0.3 closes the loop on cross-device memory sync: full conversation history (conversations + turns + full-text index) now rides the Git sync, all bulk reads/writes are streaming to kill large-DB crashes, turns are sharded + gzipped to clear gitee's 100MB-per-file quota, and the whole sync reports live progress. Clone the same repo on another machine and your memories, lessons, goals — plus every conversation and its searchability — are all there.

### 🔄 Full conversation-history sync (resume sessions across devices)

- **Sync scope extended to four tables**: beyond the three derived views (memories/lessons/blocks), conversations + turns are now exported/imported; FTS is backfilled on import (prompt+answer dual rows) so `recall_memory` works across devices.
- **Local-wins idempotent merge**: dedupe by id — existing conversations/turns are never overwritten; conv_events stay local (append-only audit is the bulk; the turns cache suffices to rebuild views).
- **Transcripts now travel with the sync**: privacy semantics upgraded from "transcripts never leave this machine" to "transcripts live in your own private Git repo" — the repo is yours, still zero third-party services.

### 🚄 Large-DB export fixed (two linked repairs)

- **Invalid string length fixed**: joining all turns into one string hit V8's ~512MB string cap → all bulk reads/writes rewritten as `iterate()` + line-by-line NDJSON streaming; 2GB DBs no longer crash.
- **Sharded + gzipped turns**: a single 881MB file hit gitee's per-file 100MB pre-receive quota (error misread as "remote has new commits") → 64MB raw text per shard, gzipped per shard; the real library lands as 14 shards × 18~22MB; reads gunzip shards in filename order; stale single-file/old shards are cleared before writing.

### 📊 Live sync progress

- **Real-time status-line percentage**: `memorySync onProgress` → IPC `memory-sync-progress` → settings status line "Syncing · exporting turns 63%", covering clone/pull/import/export/commit/push; `store.countTurns()` backs the percentage denominator. First push of 7,381 records (~750MB raw) takes ~2 minutes — fully visible instead of a blind wait.

### 📱 web-companion (mobile)

- The mobile detail page now shows the tool-execution trail: which tool the agent called at each step and with what arguments, visible from your phone.

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.0.2...v4.0.3
