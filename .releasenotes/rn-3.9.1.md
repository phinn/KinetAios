**发布日期：** 2026-09-24(自 v3.9.0 起 9 commits)

### ✨ 功能

- **Steer 打断闭环:CLI 引擎软打断**(2220efe)—— claude/codex 跑长任务时 ⌘Enter 不再干等:kill 进程(SIGTERM→2.5s→SIGKILL,win 走 taskkill /T /F)+ `--resume` 原会话续跑,打断文本在续段头部注入;三引擎全覆盖;首轮未建 session 时自动降级排队
- **工作台项目看板**(5b1fa4d)—— 按 cwd 分组的项目卡,新增最近活动频道列表(updatedAt 排序、引擎色点、飞书/企微来源标识);running 卡绿色呼吸点+accent 边框;status 事件驱动 300ms 节流刷新;i18n 四语

### 🐛 修复

- **CLI 软打断三处硬伤**(2bf52b2)—— steer 只写缓冲不触发 abort → kill 无触发路径,打断要等 CLI 自然跑完才生效,失去打断意义(补 kill 通道);续段重布防看门狗前不复位 idleFired → 续段挂死无人管;kill hook 生命周期泄漏(cancel/收尾/删除会话四点收口)
- **终态竞态吞打断文本**(e6af1fb)—— pullSteer 原语义"取走即清除",竞态窗口内文本被丢;移到 sawTerminal 判定后;V3 引擎 steer 缺口同步收口
- **goal 接力链静默停机**(11da72b)—— 链空/链尽时不再无声结束,显式告警;链每轮现读(运行中改链即时生效)
- **拿掉 stall 熔断**(ff41907)—— 连续 8 轮相同工具调用即停的熔断误伤几百步的合理任务(如逐行审计、全量重构);死循环防护回归 maxTurns 兜底 + 内容级 stall 检测(后续)

### 🎨 UI

- **全局图标 SVG 化**(9a3a95e)—— 新增 SVGI 语义图标库(与 ICON 同风格描边圆角、stroke=currentColor),看板/任务清单/事件流/远程 banner/job pill/git sync/模板卡全站 emoji 与 ✓✗⇅ 等伪字符清零;颜色语义交 CSS 变量;配套 12 处 CSS 对齐。发往模型的 prompt 文本 emoji 保留(非 UI)
- **引擎配色收口**(ce8a83b)—— 三处色值互不一致的引擎色(dashboard/nexus/styles)收口到 engine-colors.ts 单一来源
- **cron 工具化**(e87da31)—— 新增 cron_list/cron_manage 工具,agent 可直接管理定时任务,不再只靠 UI 面板

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.9.0...v3.9.1
