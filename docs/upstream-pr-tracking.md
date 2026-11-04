# KinetAios 上游 PR 追踪表

> 更新: 2026-11-04 | 仓库: phinn/KinetAios (v4.0.3)
> 用途: 所有上游收录 PR 的状态快照。每次跟进前先跑一遍状态刷新(脚本见 /tmp/build_table.py 模式),不要凭记忆。

## 状态总览

| 仓库 | PR | 状态 | 合并 | 备注 |
|---|---|---|---|---|
| serhii-londar/open-source-mac-os-apps (42k⭐) | [#1386](https://github.com/serhii-londar/open-source-mac-os-apps/pull/1386) | Add KinetAios | ✅ MERGED 2026-10-19 | **主引流源**,已验证带来 referrer 流量 |
| juejin-cn/juejin-usage | [#201](https://github.com/juejin-cn/juejin-usage/pull/201) | KinetAios 用量采集 | ✅ MERGED 2026-10-08 | 国内渠道 |
| 1c7/chinese-independent-developer | [#1736](https://github.com/1c7/chinese-independent-developer/issues/1736) | 收录申请:3 个 macOS App | ✅ **已进主版面 2026-11-03**(1c7 两小时即合);同日留言补齐其余 16 个 App([comment-6606924972](https://github.com/1c7/chinese-independent-developer/issues/1736#issuecomment-6606924972)),等 1c7 合入 README |
| **mcp.so**(目录站) | [servers/kinetaios](https://mcp.so/servers/kinetaios) | 收录页 | ✅ LIVE(免 PR 自动收录) | 2026-11-02 确认;AI & Agents 分类,README 特性已展示。**缺口:Tools 列表+config 块**(站方声明按 README `## Tools` 标题自动抓取)→ 11-02 双语 README 已补,等重抓 |
| e2b-dev/awesome-ai-agents | [#1397](https://github.com/e2b-dev/awesome-ai-agents/pull/1397) | Add kinetaios | ⏳ open, clean | CLA 已签;⚠️ 11-03 复核**维护队列已死**(近 30 天 merged=0),停止回查评论,只做静默状态监测 |
| punkpeye/awesome-mcp-servers (60k⭐) | [#14667](https://github.com/punkpeye/awesome-mcp-servers/pull/14667) | Developer Tools 区 | ⏳ open, clean | Glama A 级徽章+rebase 全齐,维护者 nudge 已回复,10-28 跟进评论后无新消息,只等合并 |
| kyrolabs/awesome-agents | ~~#781~~ → ~~#902~~ | Conversational / General Agents | ❌ #902 被 botbocks 于 2026-10-29 关闭 | **bot 风暴确认**:10-29~10-31 连关 15+ PR(#900-#921 全军覆没,含早期 #586),30 天内该仓 **0 merge**。判定=仓库进入无人维护+bot 大清洗状态,**不再投**;等待期观察是否复活 |
| Homebrew/homebrew-cask | [#297869](https://github.com/Homebrew/homebrew-cask/pull/297869) | Cask: add kinetaios | ❌ closed(等重开) | bot 因"模板缺失"关闭(实为 AI 检测误伤);已补全官方模板+留言申请重开;**cask 本身三次修正全绿** |
| microsoft/winget-pkgs | [#463867](https://github.com/microsoft/winget-pkgs/pull/463867) | KinetAios.KinetAios 4.0.3 | ⏳ open, clean | **已进 moderator 人工审批队列**(10-28 policy bot 留言"requires a moderator to approve")。CLA 已签,验证流程走完,只等人 |
| jamesmurdza/awesome-ai-devtools | [#1404](https://github.com/jamesmurdza/awesome-ai-devtools/pull/1404) | Desktop & Mobile Applications 区 | ⏳ open, clean | 前身 #1096 被 devtools-repo-bot 以模板缺失关闭(描述缺 `## Description`+4 项 checklist 未勾,且 body 用错别仓模板口径);**bot 关闭的 PR 作者无法 reopen**(issues/GraphQL 双端点 422,与 Homebrew 同款)。改按本仓模板重写 body(fork 分支 add-kinetaios 复用)重开 **#1404**,开后 4 分钟 bot 静默+mergeable clean=模板校验通过。本仓只收**开发者工具**,general-purpose agent 是红线,body 已显式澄清"not a general-purpose assistant" |

## 已关未合并(不再跟进)

| 仓库 | PR | 结局 | 教训 |
|---|---|---|---|
| getagentseal/codeburn | [#1540](https://github.com/getagentseal/codeburn/pull/1540) | closed 2026-09-24, 未合并 | 此前误记为 merged;小仓库维护者不活跃 |
| WangRongsheng/awesome-LLM-resources | [#232](https://github.com/WangRongsheng/awesome-LLM-resources/pull/232) | closed 2026-09-28, 未合并 | 同上 |
| kyrolabs/awesome-agents | [#781](https://github.com/kyrolabs/awesome-agents/pull/781) | botbocks 批量清理 | 已由 #902 替代 |
| jamesmurdza/awesome-ai-devtools | [#1096](https://github.com/jamesmurdza/awesome-ai-devtools/pull/1096) | closed 2026-10-28(bot 模板校验),未合并 | body 用了别仓模板口径(缺 `## Description`/未勾 checklist);bot 关闭的 PR 作者不可 reopen(422),重写 body 开 #1404 替代 |

## 已实测的关键事实(2026-10-28)

- **Homebrew cask 质量全绿**: `brew style` 无 offense;`brew audit --new --online` 唯一报错 = notability 门槛(75 stars, 我们 8⭐) → **短期内别再投 homebrew-cask 官方库**,等 stars ≥75 再试,或投第三方 tap
- **cask 哈希即官方 release digest**: arm `175e014b…`, intel `3d790e39…` 直接来自 GH API digest 字段,无需重算
- **NSIS ProductCode 推导**: `uuidv5(appId, 50e065bc-3134-11e6-9bab-38c9862bdaf3)`;`com.kinet.kinetaios` → `f65d9359-0830-527e-8b7c-f7153f15e828`(electron-builder NsisTarget.js L147)
- **electron-builder NSIS 合并二进制 → winget Architecture: neutral**(arm64/intel 分写会被验证 bot 拒)
- **winget 静默安装**: NSIS = `/S`(大写S);assistant 模式下 Custom: /currentuser
- **exe SHA256**: `5A67D968D29F1473878E8C58195D5F012C3A678A511CD97F6DF153B9C3C03627`(与 GH release digest 一致)
- **GitHub PR reopen API**: 已关闭 PR 不可 reopen(422), kyrolabs 那条是重开新 PR;但 Homebrew bot 用 issues API 也不行 —— 只能留言请维护者
- **网络坑**: brew 拉 portable-ruby 走 ghcr.io 被墙(~100B/s), shell 里显式 `export https_proxy=http://127.0.0.1:10808` 走系统代理即通

## 下一步动作

1. **README Tools/config 段**(11-02 已推):等 mcp.so 重抓 README,回查 https://mcp.so/servers/kinetaios 是否出现工具列表与 config;若 2 周未抓,发邮件/表单催更(站内无 PR 机制)
2. **winget #463867**: 已在人工审批队列,不动;若 2-3 周无人批,礼貌 at moderator 询问(11-18 后仍无动静即执行;已建每周一 9:00 cron 自动巡查)
3. **e2b #1397**: ⚠️ 11-03 复核**队列已死**——近 30 天 merged=0(此前"维护者每日合并"判断过时),10-28 后也无新评论。停止回查评论(刷了只会显示被无视),改为每半月静默 API 查 merged 状态,有动静再行动
4. **punkpeye #14667**: 仓库极活跃(30 天 merged 547 个,11-02 刚合 #18312)但本 PR 10-28 后无回复无 review——大概率人工排期长而非被遗忘,11-11 左右(距上次跟进 2 周)留**最后一条**简短跟进评论;若再无回复则不再跟,PR 挂着不吃亏(Glama 徽章要求已全满足)
5. **Homebrew**: 若无人重开 → 放弃本轮,stars ≥75 后用现成 cask(`docs/tmp` 已存最终版)再投(当前 12⭐,按近期增速尚远)
6. stars 过 75/100 后:重投 homebrew-cask(附 notability 改善说明)
