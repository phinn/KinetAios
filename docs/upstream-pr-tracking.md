# KinetAios 上游 PR 追踪表

> 更新: 2026-11-04 全量盘点 | 仓库: phinn/KinetAios (v4.0.6)
> 盘点口径: GitHub search `author:phinn type:pr` = **30 个 PR**(11-04 扫描)。此前档案只记了 14 个,漏 1 个 MERGED(yzfly #586)和 9 个沉默 open。**每季度全量扫一次,日常只盯「下一步动作」**。刷新脚本已入库: `docs/scripts/pr_all.py`(search API 翻页)+ `docs/scripts/diag14.py`(mergeable_state+仓吞吐),token 走 git credential(osxkeychain)

## ✅ 已合并(3 PR + 2 非 PR 收录) + 11-04 新投 issue(2)

| 仓库 | PR | 合并日 | 备注 |
|---|---|---|---|
| serhii-londar/open-source-mac-os-apps (42k⭐) | [#1386](https://github.com/serhii-londar/open-source-mac-os-apps/pull/1386) | 2026-10-19 | **主引流源**,已验证 referrer 流量 |
| juejin-cn/juejin-usage | [#201](https://github.com/juejin-cn/juejin-usage/pull/201) | 2026-10-08 | 国内渠道,用量采集接入 |
| yzfly/Awesome-MCP-ZH | [#586](https://github.com/yzfly/Awesome-MCP-ZH/pull/586) | 2026-09-18 | MCP 客户端中文列表。⚠️ 11-04 盘点才补录,当时漏记 |
| 1c7/chinese-independent-developer | [issue #1736](https://github.com/1c7/chinese-independent-developer/issues/1736) | 2026-11-03 | 非 PR(issue 收录制):3 App 两小时进主版面,同日[留言补录 16 App](https://github.com/1c7/chinese-independent-developer/issues/1736#issuecomment-6606924972)。11-04 核验:1c7 仍在高频合入(每日批次),16 App **在队列等站长**,issue 制不催 |
| **mcp.so**(目录站) | [servers/kinetaios](https://mcp.so/servers/kinetaios) | LIVE | 非 PR 自动收录,2026-11-02 确认。缺口:Tools 列表+config 块,README `## Tools` 已补(11-02),等重抓 |
| **521xueweihan/HelloGitHub** (186k⭐) | [issue #4242](https://github.com/521xueweihan/HelloGitHub/issues/4242) | 2026-11-04 | 🆕 开源自荐(按 submit-cn.yaml 字段:标题/描述/亮点/示例代码)。月刊只收开源项目,收录后进贡献人列表。周期≈月,下次盘点 12-初 |
| **ruanyf/weekly** (科技爱好者周刊) | [issue #13062](https://github.com/ruanyf/weekly/issues/13062) | 2026-11-04 | 🆕 开源自荐(社区口吻:网址/痛点/特点/我是作者)。周刊每期 5-10 条从 issue 池挑,无时限,被选中有邮件通知 |

## ⏳ Open — 高活跃仓(值得投入跟进)

| 仓库 | PR | 投递 | 状态 | 备注 |
|---|---|---|---|---|
| jaywcjlove/awesome-mac (4.2k⭐) | [#4217](https://github.com/jaywcjlove/awesome-mac/pull/4217) | 2026-11-04 | open, **ahead 4 / behind 0** | 30d 193 merge 高吞吐。前身 [#2915](https://github.com/jaywcjlove/awesome-mac/pull/2915) 47 天未维护 DIRTY,11-04 用 Contents API 从上游 master 重放 4 行(EN/zh/ja/ko AI 区,Jan 后字母序)开新 PR。**当前最值得盯的一个** |
| microsoft/winget-pkgs | [#463867](https://github.com/microsoft/winget-pkgs/pull/463867) | 2026-10-28 | open, moderator 队列 | ❗11-04 核验:两条硬阻塞——①**CLA 未签**(bot 10-28 通知,需用户到 [CLA 系统](https://opensource.microsoft.com/cla/) 人工签,6 条评论无签署确认)②shellExecute 动态安装验证报错(label Validation-Completed 在,以 moderator 实批为准)。CLA 签完前纯排队 |
| punkpeye/awesome-mcp-servers | [#14667](https://github.com/punkpeye/awesome-mcp-servers/pull/14667) | 2026-09-18 | open, 沉默 | 30d 547 merge 极活跃但本 PR 无 review——人工排期长非遗忘。**11-11(距上次跟进 2 周)留最后一条跟进**,再无回复则放弃跟进(挂着不吃亏) |
| punkpeye/awesome-mcp-clients | [#321](https://github.com/punkpeye/awesome-mcp-clients/pull/321) | 2026-09-17 | open, 沉默 | 同维护者(#14667 同款 547/30d)。跟随 #14667 策略,不单独刷 |
| jamesmurdza/awesome-ai-devtools | [#1404](https://github.com/jamesmurdza/awesome-ai-devtools/pull/1404) | 2026-11-04 | open, clean | 模板校验 bot 已放行(开后 4 分钟静默)。前身 #1096 bot 模板关闭(缺 `## Description`+checklist,且 body 用错别仓模板)。**教训:投稿前先读目标仓 `.github/PULL_REQUEST_TEMPLATE.md`,别复用其它仓的 body 口径** |

## ⏳ Open — 沉默仓(低/零吞吐,静默监测不主动刷)

| 仓库 | PR | 投递 | 备注 |
|---|---|---|---|
| steven2358/awesome-generative-ai | [#1400](https://github.com/steven2358/awesome-generative-ai/pull/1400) | 2026-09-19 | 30d ~2 merge 低速;0 评论。季度盘点 |
| 0PandaDEV/awesome-windows | [#299](https://github.com/0PandaDEV/awesome-windows/pull/299) | 2026-09-17 | unstable(上游自身 CI),30d 仅 1 merge。季度盘点 |
| deepseek-ai/awesome-deepseek-integration | [#739](https://github.com/deepseek-ai/awesome-deepseek-integration/pull/739) | 2026-09-18 | 官方仓五语条目+docs 页,0 回复。季度盘点 |
| deepseek-ai/awesome-deepseek-agent | [#414](https://github.com/deepseek-ai/awesome-deepseek-agent/pull/414) | 2026-09-03 | 最老的 open,0 回复。季度盘点 |
| e2b-dev/awesome-ai-agents | [#1397](https://github.com/e2b-dev/awesome-ai-agents/pull/1397) | 2026-08-14 | ⚠️ 11-03 复核**队列已死**(30d merged=0),停止评论回查,只静默 API 查 merged |
| ai-boost/awesome-harness-engineering | [#270](https://github.com/ai-boost/awesome-harness-engineering/pull/270) | 2026-09-18 | 0 回复。季度盘点 |
| jiji262/awesome-deepseek-harness | [#19](https://github.com/jiji262/awesome-deepseek-harness/pull/19) | 2026-09-18 | 0 回复。季度盘点 |
| reorx/awesome-chatgpt-api | [#203](https://github.com/reorx/awesome-chatgpt-api/pull/203) | 2026-09-17 | 0 回复。季度盘点 |
| AMD-DEV-CONTEST/Radeon-hackathon-2026-07 | [#79](https://github.com/AMD-DEV-CONTEST/Radeon-hackathon-2026-07/pull/79) | 2026-08-04 | 赛事投稿仓,活动结束自然沉,不追 |

## 🔒 Closed 未合并(11 个,含被替代前身)

| 仓库 | PR | 关闭原因 |
|---|---|---|
| Homebrew/homebrew-cask | [#297869](https://github.com/Homebrew/homebrew-cask/pull/297869) | audit 全绿但差 stars 门槛(需 ≥75,现 12)。stars 够后重投(cask 已丢,重投时按当时 release digest 重写) |
| kyrolabs/awesome-agents | [#902](https://github.com/kyrolabs/awesome-agents/pull/902) / [#781](https://github.com/kyrolabs/awesome-agents/pull/781) | #781 被 botbocks 批量清理;#902 10-28 关(bot 维护),**放弃此仓不再投** |
| Shubhamsaboo/awesome-llm-apps | [#1174](https://github.com/Shubhamsaboo/awesome-llm-apps/pull/1174) | 外部关闭,未合并 |
| WangRongsheng/awesome-LLM-resources | [#232](https://github.com/WangRongsheng/awesome-LLM-resources/pull/232) | 外部关闭,未合并 |
| getagentseal/codeburn | [#1538](https://github.com/getagentseal/codeburn/pull/1538) / [#1540](https://github.com/getagentseal/codeburn/pull/1540) | 外部关闭(provider 接入类 PR) |
| jamesmurdza/awesome-ai-devtools | [#1093](https://github.com/jamesmurdza/awesome-ai-devtools/pull/1093) / [#1096](https://github.com/jamesmurdza/awesome-ai-devtools/pull/1096) | bot 模板校验关闭 → 重开为 #1404。**平台规则:bot(写权限者)关闭的 PR 作者无法 API reopen**(REST/GraphQL 双 422),唯一出路=改 body 开新 PR |
| jaywcjlove/awesome-mac | [#2915](https://github.com/jaywcjlove/awesome-mac/pull/2915) | DIRTY(47 天上游漂移,四语 README 全冲突)→ API rebase 开 #4217 |

## 自家仓 PR(2026-11-04 清零)

| 仓库 | PR | 结局 |
|---|---|---|
| phinn/kinetbrief | [#1](https://github.com/phinn/kinetbrief/pull/1) | ✅ MERGED 11-04(App Store link) |
| phinn/kinettask | [#1](https://github.com/phinn/kinettask/pull/1) | ✅ MERGED 11-04(App Store link) |
| phinn/KinetAios | [#14](https://github.com/phinn/KinetAios/pull/14) | 🔒 closed(superseded):README 漂移 dirty;意图(MAS 徽章+Install 首选)已按现价 $12.99/¥68 直落 main `cc82e5e`,关单留言说明 |

## 下一步动作

0. **11-04 19 App 引流新渠道(用户指令:为 20 个在线 App 引流)**:
   - ✅ CID 续录 16 App 已在队列(勿催,1c7 每日批次合入)
   - ✅ HelloGitHub #4242 / ruanyf #13062 已投
   - ⏸→✅ **macnative.io 已投 3 App(11-04,用户注册账号后执行)**:KinetAios #9414 / KinetMagicDisk #9415 / KinetMinutes #9416 全进 review queue(`/profile/apps/<id>/upgrade` 页=已受理信号)。要点:①表单图标/截图是**即时上传**(onChange→POST /api/assets→assets.macnative.io),无 UI 回显,别被 "Drop or click" 迷惑;②React 受控 file input 用 DataTransfer+原生 dispatch 可靠注入;③提交后 URL 跳 listing id 即成功;④Clasp 是别人 App(seller Kihyuk Hong)已剔除;⑤官网 URL 用 dofollow 吃 SEO。第二批候选:DriftDesk #6817377455 / KinetRain #6814033986(等首批过审再投,ambience 类有 thin 风险别烧账号首印象)。素材缓存 /tmp/mn_assets+(icon/shots 已上传走 API,本地仅留档)
   - 排除(已查证):awesome-electron(暂停收录)、awesome-testflight-link(只收 TF 公链,无 TF 不资格)、垂直品类榜(无活跃池)
   - ✅ **免费渠道实测盘点(11-04 下午)**:付费墙陷阱——TAAFT 免费通道已死(纯付费 Launch)、Toolify $99、aitools.fyi 跳付费 tally、DevHunt 提交指向 listingbott 付费、uneed.best CF 硬拦 IP。**可用免费渠道定论**:
     - ✅ **meta.appinn.net 发现频道(中文区最高价值)**:phinn 账号有登录态(TL0),KinetAios 自荐帖已按官方模板(topic/77583)提交(标题【开发者自荐】KinetAios – …7 引擎/30+ 工具/21 插件;付费标价 $12.99/¥68),正文走 ProseMirror 合成 ClipboardEvent paste(⚠️ execCommand insertText 在 Discourse PM 上产生幻影状态,paste 事件才走事务)。**新号首帖进 staff 审核队列**,9-23 的 KinetTask 帖(#92332)至今 6 周匿名不可见=同样悬审,别重复投。发帖自动同步 Twitter@Appinn/Telegram@AppinnFX/Fediverse。模板铁律:付费软件必须标价格、标题不带网址、先写「发现理由」
     - ✅ **MacUpdate**(老牌 Mac 目录):提交入口 /content/submit(需注册账号,免费)
     - ✅ **少数派 Matrix**(sspai.com/matrix):免费投稿,有 Mac 工具文先例,长文评测向
     - ✅ **Peerlist Launchpad**:免费 launch(需账号),PH 平替中最活跃
     - 🚫 **V2EX(11-04 用户明确:不要搞了)**:无邀请码,账号 shenjunjie0202 未激活,**永久放弃此渠道,勿再提**
     - ⚠️ **linux.do**:邀请码制(GitHub 5 年+账号可申请)
     - 排除:SaaSHub/alternativeto/slant(CF 挡自动化,用户手动)、devhunt.org(开源 only)
1. **awesome-mac #4217**(11-04 开):等合并;1 周无动静礼貌跟进一次。此仓吞吐高,大概率快
2. **awesome-ai-devtools #1404**(11-04 开):bot 校验已过,纯等人工
3. **winget #463867**: 阻塞=CLA 未签(用户手动签)+moderator 审;11-18 后仍无人批 → at moderator(已有每周一 9:00 cron 巡查)
3a. **CID(1c7)16 App 批次**: 站长 11-03 已合 MagicDisk/FlashFind/DriftDesk 进主版面,其余 16 个清单 phinn 已评论跟进,**勿催**,等批次合入;下次盘点直接 grep README 核对
4. **punkpeye #14667**: 11-11 左右留最后一条简短跟进;无回复即停止跟进。#321 跟随不单独刷
5. **沉默仓 9 个**(e2b/deepseek×2/ai-boost/jiji262/reorx/steven2358/0PandaDEV/AMD):**季度静默盘点**(下次 2027-02 跑 `/tmp/pr_all.py`),不逐个刷评论
6. **Homebrew**: stars ≥75 重投(现 12)
7. **mcp.so**: 11-16 前后回查 Tools/config 是否被抓到;2 周未抓 → 联系站方
8. **季度全量盘点**: `author:phinn type:pr` 搜索,核对本表无遗漏(11-04 发现漏 yzfly #586 MERGED + 9 个沉默 open,就是没做全量盘点的代价)
