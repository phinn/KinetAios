**发布日期:** 2026-11-20(自 v4.2.3 起 16 commits)

# v4.2.4 — 启动聚合 605 倍提速 / wait_for 条件等待 / 后台 Job 续跑修复 / 官网换全家族图标墙

## 新功能
- **wait_for 条件等待** — 新增内置工具:等待条件成立再继续(日志出现匹配行 / 端口可连 / 文件写完或消失 / 进程退出 / 探测命令通过),命中立即返回并带回证据,超时也带回"最后看到了什么"以便决策;替代 sleep 盲等,长任务编排不再把固定时长睡满
- **历史反馈回填技能淘汰** — 技能"来源裁决"机制补上数据面:回填 8743 轮历史对话反馈参与技能评分,淘汰不再只依赖"14 天 0 加载"单指标,蒸馏出的技能被后续任务推翻时降级更准

## 性能与存储
- **启动聚合 11.4s → 6ms** — 启动时的全量扫描聚合改为 SQL 聚合查询一次取回;FTS 不再索引工具输出大文本;事件保留期 90→30 天。冷启动直读路径彻底绕开逐行 JS 折叠
- **conv_events 分层保留** — 证据类事件(工具调用/审批/错误)永久保留,冗余 message 体 7 天滚动清理;回放取证与库体积不再互斥

## 修复
- **workflow 后台 Job 重启续跑接通 UI** — app 重启后 paused 状态的 Job 行不再隐形,续跑不再静默失败;v3-deep 重启续跑的假门同类隐患一并连根拔除
- **V5 无限模式步数墙归宿主** — 基因墙 12 / 进度门 24 退出生产路径,长任务不再在固定步数处半路冤死;"移除隐藏步数墙"类故障模式闭环
- **wait_for 参数容错** — until 可按参数形态自动推断,不再因"参数不对"白跑
- **侧边栏「最近常用」条目补删除入口** — 此前 hover 无 X、右键无菜单,点删无反应
- **screenshot_window 短名不再靠猜** — 两字短窗口名唯一命中放行;找不到时直接返回可截窗口标题清单,照清单重试一次即可

## 官网
- **phinn.github.io/KinetAios 整站换新** — 首页换为 Kinet 全家族 23 卡图标墙落地页(真实 App Store 图标 + 价格角标 + 中/繁/英/日四语联动,KinetAios 置顶);隐私政策、企业能力页(中英)同步新口径,sitemap 重写

---

**English**

## New Features
- **wait_for — condition-based waiting** — new built-in tool: wait for a condition instead of blind-sleeping (log line match / port reachable / file written or gone / process exited / probe command passing). Returns immediately with evidence on hit, and on timeout reports what it last saw so the next step can adapt
- **Historical feedback backfill for skill eviction** — the skill "source adjudication" mechanism gains a data layer: 8,743 turns of historical conversation feedback are backfilled into skill scoring, so eviction no longer relies solely on "14 days with zero loads", and downgrading distilled skills (whose conclusions were later overturned) becomes accurate

## Performance & Storage
- **Startup aggregation 11.4s → 6ms** — the full-scan aggregation at startup now runs as a single SQL aggregate query; FTS no longer indexes large tool-output bodies; event retention 90→30 days. The cold-start read path completely bypasses row-by-row JS folding
- **conv_events tiered retention** — evidence-bearing events (tool calls / approvals / errors) are kept forever; redundant message bodies roll off after 7 days. Replay forensics and database size are no longer a trade-off

## Fixed
- **Background workflow jobs re-attach to the UI after restart** — jobs left in the paused state by an app restart no longer turn invisible, and resuming no longer fails silently; the same class of bug in v3-deep's resume gate was hunted down in the same pass
- **V5 unlimited-mode step walls now belong to the host** — the gene wall (12) and progress gate (24) are out of the production path, so long tasks no longer die half-way at a fixed step count; the "hidden step wall" failure class is closed
- **wait_for parameter tolerance** — `until` is now inferred from the other parameters when omitted, instead of the call being wasted on a validation error
- **Sidebar "recently used" entries get a delete affordance** — previously there was no X on hover and no context menu, so deleting them did nothing
- **screenshot_window no longer guesses short titles** — unique two-character title matches are allowed through; on a miss it returns the list of capturable window titles so the retry is exact

## Website
- **phinn.github.io/KinetAios fully redesigned** — the landing page is now a 23-card icon wall of the whole Kinet family (real App Store icons + price badges + four-language switching, KinetAios pinned on top); the privacy policy and enterprise capability pages (EN included) were aligned, and the sitemap rewritten

---

Part of the Kinet family — 22 apps, all live: https://phinn.github.io/kinetapp/index.html
Kinet 家族成员 —— 22 个应用,全部在架: https://phinn.github.io/kinetapp/index.html

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.2.3...v4.2.4
