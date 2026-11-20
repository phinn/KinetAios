**发布日期:** 2026-11-20(自 v4.2.4 起 7 commits)

# v4.2.5 — 工具参数闸 / 长任务超时可声明 / MCP cwd 授权边界 / 事件分页提速

## 新功能
- **shell 可声明超时(上限 900s)** — 此前 1027 次超时、28.5 小时纯等待:去重后是 921 条**不同**命令(`find ~` / `grep -r` 全盘 / `xcrun simctl log show` 本来就超过 120s),而模型没有任何办法说明这一点。现在 shell 支持 `timeout` 参数,超时提示第 1 条直接给出建议值(耗时×3,夹在 120-900),不再把固定时长睡满
- **MCP server 每次调用的 cwd 授权边界** — `run_agent` 新增可选 `cwd`,运维方用 `KINET_MCP_CWD` 声明授权根(多路径);包含性校验在派发**之前**执行,越界直接拒绝且**零执行**(不发 prompt、不调工具);未声明授权根时边界默认取 home 目录
- **工具参数闸(guardToolArgs)** — 按 schema.required 校验必填参数,缺参时回"缺哪个字段 + 该字段说明 + 本次传了什么",而不是甩一条 Node 栈给模型;顺带归一化 `cmd→command` / `file_path→path` / `href→url`。127 个工具的 schema 已校验自洽

## 性能与存储
- **事件面板分页:417ms → 16ms** — 补库后最大会话 68,490 条事件 / 39.7MB,「整会话事件搬进内存再处理」的写法已撑不住。改为 `loadEventsTail(800)` + `loadEventsBefore` 游标翻页,顶部「加载更早」并补偿 scrollTop 保证视口不跳;超 3000 条的会话有 78 个(20 个过万)
- **Token 明细浮层按轮查** — 为看 3~5 行 cost 而搬整个会话过 IPC 的写法,改为新增 IPC `conv-turn-events` → `loadTurnEvents(convId, turnId)`,SQL 直接按 turn_id 过滤;实测最大轮(3165 条事件)22ms
- **启动去 N+1:450ms → 227ms** — `loadConversations` 原对 394 个会话逐个 `SELECT json_extract(...)` 读整行 ~150KB JSON 再解析。改为 conversations 加 `first_prompt` 冗余列(截前 500 字符),`saveTurn` / `importTurnsLine` 同事务写入(仅首轮)
- **无洞不重建:19.8s → 13.4s** — `loadTurns` 原无条件全量拉事件 + 逐条 JSON.parse + fold,结果再被 merged 原样丢弃。改用 `COUNT(DISTINCT turn_id)` 快判「有没有洞」(走 idx_events_conv,~1ms),缓存已覆盖且无空轮直接返回
- **web_fetch 进程内 LRU 缓存** — 1366 次抓取里 202 次重复取同一 URL(平均 14.5s)。加 LRU(TTL 10 分钟 / 40 条 / 6MB),只缓存 2xx,命中时明示内容有多旧;实测 example.com:11522ms → 10ms
- **死源主机级熔断** — reddit_hot 70/70 全超时、market_search 47/49 超时(约 40 分钟纯烧),实测这两个域名在本网络结构性不可达。连续 2 次失败 → 10 分钟快速失败,失败文案直接指向 web_search / hn_search;实测第 3 次调用 8005ms → 0ms

## 修复
- **工具失败判定补漏:97 次「以为改好了」** — 近 10 天 22,545 次工具调用实测:`edit_file` 的「未找到要替换的片段」216 次(占该工具 9.6%)全被记成 outcome=ok,其中 97 次 agent 以为改好了就往下走,用户看到「已修改」而磁盘上一字节没动。`toolOutcomeOf` 补 10 条工具自报失败前缀识别 + 新超时文案识别;shell/wecom/feishu 发文件类的「文件不存在/为空/超 50MB/不支持类型」同理
- **卡顿误报止血** — 12:50-13:09 连报 15 次「heartbeat silent 5-6s」,全部落在每分钟第 36-37 秒。采样反证不是卡死(main 2154/2248、renderer 1930/2202 个样本停在 mach_msg 空闲):根因是窗口被完全遮挡时 Chromium 把 renderer 定时器节流到 1 次/分钟,`isVisible()` 盖不住遮挡;而每次误报要跑两个 3s 高频采样 —— 诊断工具自己在制造卡顿。现在心跳带 `document.visibilityState`,main 侧 hidden 跳过判定,一次 episode 只采一次样
- **screenshot_window 截窗先看后选** — 近 7 天 79 次调用 39 次失败(49%),几乎全是在它看不见的命名空间里猜名字(`_v3_sheet_duoh.png` / `简报` / `verify4`)。`title` 改可选,省略时只回吐「标题(宿主应用)」清单、不截图;候选清单标注宿主应用(「Devices」(Device Hub)),标题/词元都未命中时按归一化 owner 名 + 中英别名兜底,同一应用多窗口仍报错列出、不替用户猜
- **browser_eval 导航竞态重试** — 9614 次调用 363 错,其中 65 次 `Inspected target navigated or closed`(页面在 eval 前恰好导航 → 旧 target 作废)。这类错误重取 target 即成功,重试一次;超时类错误明确不重试(否则 15s 翻倍成 30s)
- **video_gen 鉴权失败专门文案** — 6/6 全部止步于 login fail,不是没配 key 而是配了不可用的值。加 trim + 形态预检 + 鉴权失败专门提示,点明「重复调用不会成功,只有重配 key 能解」
- **事件保留改成显式声明** — `turn/meta`(逐次 LLM 调用的 cost/token 明细,UI Token 明细浮层的唯一数据源)与 `turn/status`(路由决策/引擎相位轨迹,复盘"为什么走这条路"的唯一依据)钉为**永久保留**。新增 `RETAINED_EVENT_TYPES` 声明式清单(17 类),prune 前先从待删清单剔除,即使以后有人把唯一副本误塞进冗余清单也删不掉;新增事件类型默认保留(白名单式 `type IN (...)`)。附 `scripts/restore-pruned-events.mjs`(默认只读预演),可按原 seq 净补回 489,714 行 / 314MB
- **应用运行检测改用 lsof** — 残留的 `npm run dev` 终端会被误判成 app 还在跑;按进程名会漏检 dev 模式的 Electron,改为按是否持有 history.db 判断
- **窗口名 ≠ 应用名兜底** — 1358 次调用 242 次失败(17.8%),11-19 那轮修完仍 24%。真实案例:想截「预览」标题其实是 `_v3_sheet_duoh.png`;写「Simulator」在 Xcode 26 里归在「Device Hub」应用下、标题是「Devices」

---

**English**

## New Features
- **Declarable shell timeout (up to 900s)** — 1,027 timeouts and 28.5 hours of pure waiting: after de-duplication these were 921 *different* commands (`find ~`, recursive `grep -r` over the whole disk, `xcrun simctl log show`) that legitimately exceed 120s, and the model had no way to say so. `shell` now accepts a `timeout` argument, and the timeout notice suggests a concrete value on its first line (elapsed × 3, clamped to 120–900) instead of burning the full fixed duration
- **Per-call cwd grant boundary for the MCP server** — `run_agent` gains an optional `cwd`; the operator declares allowed roots via `KINET_MCP_CWD` (multi-path). Containment is enforced *before* dispatch, so an out-of-root `cwd` is refused with **zero execution** (no prompt, no tool calls). With no roots declared, the boundary defaults to the home directory
- **Tool argument gate (`guardToolArgs`)** — required arguments are validated against the schema, and a missing field now returns "which field is missing + what it means + what you actually passed" instead of a raw Node stack trace. Aliases are normalized on the way in (`cmd→command`, `file_path→path`, `href→url`). All 127 tool schemas are now verified self-consistent

## Performance & Storage
- **Events panel paging: 417ms → 16ms** — after the library restore the largest session holds 68,490 events / 39.7MB, and the old "pull the whole session into memory and process it there" approach no longer holds. Now `loadEventsTail(800)` plus a `loadEventsBefore` cursor, with "load earlier" at the top and scrollTop compensation so the viewport does not jump; 78 sessions exceed 3,000 events (20 exceed 10,000)
- **Token breakdown fetched per turn** — the old path moved an entire session across IPC to display 3–5 rows of cost; a new `conv-turn-events` IPC calls `loadTurnEvents(convId, turnId)` and filters by `turn_id` in SQL. Measured 22ms on the heaviest turn (3,165 events)
- **Startup N+1 removed: 450ms → 227ms** — `loadConversations` ran `SELECT json_extract(...)` per conversation across 394 sessions, reading and parsing a ~150KB JSON row each time. `conversations` now carries a redundant `first_prompt` column (truncated to 500 chars), written in the same transaction by `saveTurn` / `importTurnsLine` (first turn only)
- **No-gap fast path: 19.8s → 13.4s** — `loadTurns` unconditionally pulled every event, parsed each one and folded it, only for the result to be discarded by `merged`. It now uses `COUNT(DISTINCT turn_id)` (~1ms via idx_events_conv) to decide whether there is a hole; if the cache already covers the turns and none are empty, it returns directly
- **In-process LRU cache for web_fetch** — 202 of 1,366 fetches re-fetched the same URL (14.5s average). An LRU (10-minute TTL / 40 entries / 6MB) caches 2xx responses only and states the age of a cached hit. Measured example.com: 11522ms → 10ms
- **Host-level circuit breaker for dead sources** — reddit_hot timed out 70/70 and market_search 47/49 (about 40 minutes burned); both domains are structurally unreachable on this network. After 2 consecutive failures the host fails fast for 10 minutes and the error points at `web_search` / `hn_search` instead. Measured third call: 8005ms → 0ms

## Fixed
- **Tool failure detection gaps: 97 "I thought it worked"** — measured across 22,545 tool calls in the last 10 days: "fragment to replace not found" from `edit_file` happened 216 times (9.6% of that tool) and *all* were recorded as `outcome=ok`; 97 of those had the agent move on believing the edit landed, while the user saw "modified" and the file was byte-identical. `toolOutcomeOf` now recognizes 10 tool-reported failure prefixes plus the new timeout wording; the "file missing / empty / over 50MB / unsupported type" class in the file-sending tools is covered the same way
- **False hang reports stopped** — 15 "heartbeat silent 5-6s" reports fired between 12:50 and 13:09, all landing on second 36–37 of each minute. Sampling disproves a real hang (2,154/2,248 main and 1,930/2,202 renderer samples parked in idle `mach_msg`): when a window is fully occluded Chromium throttles renderer timers to once a minute, and `isVisible()` cannot see occlusion — while each false report ran two 3-second high-frequency samples, so the diagnostic tool was creating the lag. The heartbeat now carries `document.visibilityState`, the main side skips the check while hidden, and a single episode is sampled once
- **screenshot_window: look before you shoot** — 39 of 79 calls failed over 7 days (49%), almost all from guessing names in a namespace the tool cannot see (`_v3_sheet_duoh.png`, `简报`, `verify4`). `title` is now optional: omit it and the tool returns just the list of capturable windows, with no screenshot. Candidates carry their owning app (`「Devices」(Device Hub)`), and when neither title nor tokens match, it falls back to the normalized owner name plus Chinese/English aliases. Multiple windows of the same app still error with the list rather than guessing
- **browser_eval navigation race retried** — 363 errors in 9,614 calls, 65 of them `Inspected target navigated or closed` (the page navigated just before the eval, invalidating the old target). These are retried once with a fresh target; timeout-class errors explicitly do not retry (that would turn 15s into 30s)
- **video_gen auth-failure guidance** — all 6 calls stopped at "login fail": the key was configured but unusable. Now the key is trimmed, its shape is pre-checked, and auth failures get dedicated wording stating that repeating the call cannot help — only reconfiguring the key can
- **Event retention becomes an explicit declaration** — `turn/meta` (per-call LLM cost/token detail, the only data source for the UI's Token breakdown) and `turn/status` (routing decisions and engine phase traces, the only evidence for "why did it go this way") are pinned as **kept forever**. A declarative `RETAINED_EVENT_TYPES` list (17 types) is subtracted from the prune set before anything is deleted, so a unique copy can never be swept away even if someone later files it under the redundant list; new event types default to being kept (whitelist-style `type IN (...)`). `scripts/restore-pruned-events.mjs` is included (read-only dry run by default) and can restore 489,714 rows / 314MB by their original `seq`
- **App-running detection uses lsof** — a leftover `npm run dev` terminal was mistaken for the app still running; matching by process name misses dev-mode Electron, so detection now asks whether the process holds `history.db`
- **Window name ≠ app name fallback** — 242 of 1,358 calls failed (17.8%), still 24% after the previous fix. Real cases: the intended "Preview" window was actually titled `_v3_sheet_duoh.png`; "Simulator" in Xcode 26 belongs to the "Device Hub" app and its window is titled "Devices"

---

Part of the Kinet family — 22 apps, all live: https://phinn.github.io/kinetapp/index.html
Kinet 家族成员 —— 22 个应用,全部在架: https://phinn.github.io/kinetapp/index.html

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.2.4...v4.2.5
