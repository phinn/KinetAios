# KinetAios 上游 PR 追踪表

> 更新: 2026-11-04 全量盘点 | 仓库: phinn/KinetAios (v4.0.6)
> 盘点口径: GitHub search `author:phinn type:pr` = **30 个 PR**(11-04 扫描)。此前档案只记了 14 个,漏 1 个 MERGED(yzfly #586)和 9 个沉默 open。**每季度全量扫一次,日常只盯「下一步动作」**。刷新脚本已入库: `docs/scripts/pr_all.py`(search API 翻页)+ `docs/scripts/diag14.py`(mergeable_state+仓吞吐),token 走 git credential(osxkeychain)

## ✅ 已合并(3 PR + 2 非 PR 收录) + 11-04 新投 issue(2)

| 仓库 | PR | 合并日 | 备注 |
|---|---|---|---|
| serhii-londar/open-source-mac-os-apps (42k⭐) | [#1386](https://github.com/serhii-londar/open-source-mac-os-apps/pull/1386) | 2026-10-19 | **主引流源**,已验证 referrer 流量 |
| juejin-cn/juejin-usage | [#201](https://github.com/juejin-cn/juejin-usage/pull/201) | 2026-10-08 | 国内渠道,用量采集接入 |
| yzfly/Awesome-MCP-ZH | [#586](https://github.com/yzfly/Awesome-MCP-ZH/pull/586) | 2026-09-18 | MCP 客户端中文列表。⚠️ 11-04 盘点才补录,当时漏记 |
| 1c7/chinese-independent-developer | [issue #1736](https://github.com/1c7/chinese-independent-developer/issues/1736) | 2026-11-03 | 非 PR(issue 收录制):3 App 两小时进主版面,同日[留言补录 16 App](https://github.com/1c7/chinese-independent-developer/issues/1736#issuecomment-6606924972)。11-04 站长合 13 个,补美区链接后**当日批次合入剩 3 个——[19/19 全齐](https://github.com/1c7/chinese-independent-developer/issues/1736#issuecomment-6631384200),已回帖致谢,渠道收官 ✅**(11-04 grep README 核验) |
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
| linsa-io/macos-apps (847⭐) | [#228](https://github.com/linsa-io/macos-apps/pull/228) | 2026-11-04 | open, clean | Dev tools 区 AgentGrid 后字母序。learn-anything 系(格式 `[Name](link) - Desc.`,句号结尾/禁 A/An 开头/勿匿名链接)。30 天活跃,桌面工具向对口 |
| WangRongsheng/awesome-LLM-resources (~9k⭐) | [#291](https://github.com/WangRongsheng/awesome-LLM-resources/pull/291) | 2026-11-04 | open, clean, +1/-0 | 中文区大榜。初投错插 Agent 区(自动续号 54),已用 Contents API 重放分支修正:**代码 Coding 区 #28(DeepSeek Harness 后)**,口径 30+ tools。教训:编号目录仓 fork 后须核对目标区实际行号,别信README 目录锚点 |

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
   - ✅ CID 续录 16 App 批次合入完成(11-04 核验 19/19 全齐,渠道收官,见上表)
   - ✅ HelloGitHub #4242 / ruanyf #13062 已投
   - ⏸→✅ **macnative.io 已投 3 App(11-04,用户注册账号后执行)**:KinetAios #9414 / KinetMagicDisk #9415 / KinetMinutes #9416 全进 review queue(`/profile/apps/<id>/upgrade` 页=已受理信号)。要点:①表单图标/截图是**即时上传**(onChange→POST /api/assets→assets.macnative.io),无 UI 回显,别被 "Drop or click" 迷惑;②React 受控 file input 用 DataTransfer+原生 dispatch 可靠注入;③提交后 URL 跳 listing id 即成功;④Clasp 是别人 App(seller Kihyuk Hong)已剔除;⑤官网 URL 用 dofollow 吃 SEO。第二批候选:DriftDesk #6817377455 / KinetRain #6814033986(等首批过审再投,ambience 类有 thin 风险别烧账号首印象)。素材缓存 /tmp/mn_assets+(icon/shots 已上传走 API,本地仅留档)
   - 🚫→♻️ **macnative 3 App 11-04 深夜全被拒(状态 In review→Rejected,无邮件通知)**。诊断链:upgrade 页文案 "Free listings publish once the badge is live on your site" → 误判挂 badge 死锁;真拒因在 **submission-guidelines 明文红线**:"Browser wrappers: Electron..." 而三个 listing 的 URL/描述关联了开源 Electron 仓——但 MAS 版全是 SwiftUI 原生,Electron 只是 Windows 侧开源(灰区应走 "Tell us what's native" 申辩)。**另外 MagicDisk listing 整段 "AI flashcards from anything" 是幻觉文案**(真实功能=纯磁盘 sunburst 清理,iTunes id6813423397 描述为准),正踩 "Misleading listings" 红线。11-04 已处置:①三个 listing Edit→修正 MagicDisk 描述/正文→Save(已落库);②Aios listing 强化 "100% native SwiftUI, Electron is Windows-only" 声明;③发邮件 hello@macnative.io(Mail ax_script 已送)说明修正+申辩+主动 offer promo codes 给 review@macnative.io。等站长回复;若要求 resubmit 再走表单。教训:**新渠道提交前必须先读 submission guidelines 红线清单,模型生成的营销文案必须逐条对 iTunes 官方描述核真,幻觉功能=主动撞 Misleading 红线**
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
3a. ~~**CID(1c7)16 App 批次**~~ ✅ **收官(11-04)**:19/19 全进主版面(含 3 个美区链接补录),已致谢。后续无需跟进
4. **punkpeye #14667**: 11-11 左右留最后一条简短跟进;无回复即停止跟进。#321 跟随不单独刷
4b. **awesome-mac #4267**(11-05 开,6 App×四语 25 行):Kinet 六件套批量条目,与 #4217 同仓不同 PR,等合并
4c. **pay-once-mac-apps #7-#12**(11-05 开,6 PR 一 App 一 PR):新仓(2★)但明邀投稿,低星低成本试错;若两周无 merge 视为死仓即弃
5. **沉默仓 9 个**(e2b/deepseek×2/ai-boost/jiji262/reorx/steven2358/0PandaDEV/AMD):**季度静默盘点**(下次 2027-02 跑 `/tmp/pr_all.py`),不逐个刷评论
6. **Homebrew**: stars ≥75 重投(现 12)
7. **mcp.so**: 11-16 前后回查 Tools/config 是否被抓到;2 周未抓 → 联系站方
8. **季度全量盘点**: `author:phinn type:pr` 搜索,核对本表无遗漏(11-04 发现漏 yzfly #586 MERGED + 9 个沉默 open,就是没做全量盘点的代价)

### awesome-claude-code #3473(11-05 重投,新)

- 形态:issue 表单推荐([Resource] 模板),非 PR;维护者单人,处理慢
- 历史教训:10-15 同日双投 #2876+#2846,被静默 not_planned 双关 —— 该仓 contributing 明文"一次只推荐一个资源",双开即违规;gh CLI 提交被明令禁止(其 bot 会查,网页表单是唯一正道)
- 11-05 合规重投单条 #3473:描述改为 Claude Code 主角式白描(参照同类收录条目 agent-workbench 仅 10⭐ 也被收,星数非门槛)
- 跟进:给 2-3 周;若再被关,读关闭评论找真因,勿盲目三投

### GitHubDaily #1352 + CCR #1947 + ccr 插件引擎(11-05,新)

- **GitHubDaily #1352**(48.4k⭐中文日报仓):【开源自荐】issue 格式(样例 #1351:项目地址/类别/标题/描述/亮点);README 十个月未更但日更自荐 5+ 条,渠道活跃;org 未挡,API 直投 201
- **CCR Discussions #1947**(38k⭐ Show and tell 板块):同款先例 #1897=AgentManager 收编帖;发帖前先落地 `claude-code-router` 插件引擎(commit d10ba76)让故事真实 —— ccr code -p stream-json 透传+--resume,复用 jsonl-claude 协议,零代码纯 plugin.json 声明
- GraphQL 发 discussion 要点:REST /discussions/categories 是 404,须走 GraphQL discussionCategories;createDiscussion 需 repositoryId+categoryId
- 模式定案:**收编帖=先造集成事实再发帖**,比裸自荐转化高一个量级;同路线可复制到其它 CLI agent 生态(待选:opencode/gemini-cli/agentmanager 本身)

### gemini-cli 生态:jsonl-gemini 协议 + 插件引擎 + #30151(11-05,新)

- **为什么选 gemini-cli 当第二个收编目标**:108.7k⭐(最大生态)、Show and tell 日更活跃(先例 #30101=Friday 托管帖)、`-p` headless+`--output-format stream-json`+`-r <session_id>` 集成面完整、npm 0.67.0 昨日刚发
- **工程落地**(commit 6a961b3):第四协议预设 `jsonl-gemini`,schema 从官方 `packages/core/src/output/types.ts`(v0.67)逐字段核对(init/message delta/tool_use+tool_id/tool_result/result.stats);官方快照事件流驱动 harness ALL PASS;error severity=warning 不当终态;result.stats 折算 cost 事件(usd=0 口径如实)
- **踩坑记录**:①cli-reference 里 `-p` 是带值 flag,但实测放 args 会与 stdin 输入冲突 —— 正解=不放 -p,spawn 的 stdin 是 pipe 时 gemini 自动进 headless 并把 stdin 内容前置为 prompt,argv 位置参数(unix)/stdin(cmd shim)双路都通,spawn 恒 end stdin 不挂死;②GraphQL createDiscussion 的 repositoryId 手查会打错(误抄 category id),先 `repository(){ id }` 单查;③discussion body 存 HTML,markdown 链接须 regex 转 `<a href>`
- 帖:#30151 已发(先造集成事实再发帖,第三次复用收编帖模式)
- opencode(sst, 网页档位)备选:无 Discussions 板块;`opencode run` 无 --output-format,只有 `-s/--session`+`--fork`+`--auto`;集成价值低于 gemini,暂缓

### 2026-11-05 新投(第二轮扫描)
1. **awesome-llm-apps #1286**(143.9k⭐, 11-05 开):KinetAios→Standalone Apps & Tools 段;近 30 closed merged 7,最新 merge 10-21;两周后跟进
2. **slavakurilyak/awesome-ai-agents #931**(issue, 2.9k⭐):投稿机制=issue 模板(维护者转 PR,数据 id 带盐 hash);categories 选 AI Agents/Long-Term Memory/Local Inference/MCP Servers;近 30 closed merged 27,高活性
3. **sindresorhus/awesome-electron**(27.3k⭐):blocked——投稿硬门槛 repo≥100 stars(现 12),达标后投 Closed Source 段(收 Obsidian/Notion);electronjs.org/apps 底层=electron/apps 仓,上游已限制外部 PR,判死勿投
4. 已验证死路(不再试):pluja/awesome-privacy(外部 App 条目多被关)、alexanderop/awesome-local-first(<250⭐ 长期无外部 App merge)、vsouza/awesome-ios(只收组件不收成品 App)、iOS 侧品类列表仓(全 <100⭐)——**结论:iOS App 在 GitHub 列表仓无投放通路,资源全压 macOS/Electron/AI-Agent 侧**

### 2026-11-05 wave-4(不同方向扫描)
1. **ScoopInstaller/Extras #19258**(11-05 开):bucket/kinetaios.json,electron NSIS 双层解压(Expand-7zipArchive→$PLUGINSDIR 内层 7z);Windows 分发线第二通路(winget #463867 并行);近15 merged 10
2. **deepseek-ai/awesome-deepseek-integration**:查重发现 #739 早在 9-18 已投(五语言行+docs/kinetaios/README.md+logo);本轮险情=PUT 覆盖旧分支丢内容,已从旧 head 7623ffcb 捞回 7 文件;**铁律:fork/PUT 前先 search author:phinn 查历史 PR**;官方仓停滞(最后 merge 2-23)低速跟
3. 判死记录:awesome-mcp-clients 6.6k⭐(近20 closed 0 merged)、Awesome-MCP-ZH(已收录 185 行无需再投)、ACC(已有 #3473 在投,一次一条铁律)
4. 挂盯:sindresorhus/awesome-electron(≥100★ 门槛);OpenClaw 394k⭐ 生态仓(awesome-openclaw 系未成形列表,观察)

### 2026-11-06 wave-5(生态帖+判死一批)
1. **musistudio/claude-code-router discussion #1948**(38k⭐, 11-06 发):Show-and-tell,角度=spawn 原生 claude CLI→CCR settings.json 零改动生效;GraphQL createDiscussion(REST 无此通道);讨论区死寂(唯一旧 s&t 帖 0 评论)但 38k 基数占位零成本
2. 判死:EndoTheDev/Awesome-Ollama(29 open 黑洞+批量关不 merge,无 issue 流)、ComposioHQ/awesome-claude-skills 78.8k 及同型 skills 列表(纯 skill 分类无 clients 段不 fit)、hesamsheikh/awesome-openclaw-usecases 31.6k(未验证 OpenClaw 集成,口径纪律:不投未实测的)
3. 人工项:gitee token 过期(401)——GVP/开源指北推荐位需用户续 token 后提表单;中文线补充
4. 查重纪律再次生效:CCR phinn 零历史✓、Ollama phinn 零历史✓(先查后投,deepseek #739 教训)

### 2026-11-07 全量核查(转化+拒因归档)
**转化 2**:mcp.so #4373 已收录(/servers/kinetaios);chinese-independent-developer #1736 已收 19 App 全量进主版面(11-03)
**被拒 2(带出路)**:①awesome-llm-apps #1286——拒因=列表只收 established 外链项目;**维护者明确给出重投门:`advanced_llm_apps/` 下自包含可运行示例驱动 KinetAios**(对口形状=KinetAios MCP server 示例,先进仓 plugins/ 再投,示例仓链接进 README);②scoop Extras #19258——星数墙 ≥100★/50fork;出路=社区 bucket 或自建 phinn/scoop-bucket(`scoop bucket add phinn https://github.com/phinn/scoop-bucket`),建仓时照 Extras manifest 范式(已验证的双层解压写法可复用)
**判死 1**:sindresorhus/awesome-electron——先例 KDE Connect PR #21732 因「100+ stars」被拒,与 Extras 同星数墙;近 8 PR 0 merged;挂盯撤销(100★ 解锁条款作废,判死不等涨星)
**仍 open 值班**:ACC #3473(validation-passed 标签✓,待 maintainer 人审)、CCR #1948(0评论0赞,死寂符合预期)、deepseek #739、#4267 awesome-mac、#90 ai-guide、#13062 ruanyf、#4242 HelloGitHub、pay-once ×6、#915 toolkit、#102/#8 教程库、#179 chatgpt-zh
**当前漏斗**:曝光在飞 15 条;星数墙类(extras/electron/Homebrew)全部转入「bucket 自建/暂缓」而非死等涨星

### 2026-11-08 第二轮扫描(列表仓维度扫竭确认)
**零成本已做**:repo topics 汰换——dashboard/openai 撤下,electron+gemini-cli 换入(topics/electron 聚合页大流量;jsonl-gemini 引擎对口;electron/electron-apps 判死≠topic 页失效)
**核实 3**:
- glama.ai 已自动收录 /mcp/servers/phinn/kinetaios(117k 目录在册,badge SVG 200);⚠️风险记:9月自称 score A,11-08 快照=Not graded quality/B maintenance——punkpeye #14667 merge 时若 badge 校验踩空,重跑 glama 评测即可
- punkpeye/awesome-mcp-servers #14667:6 评论全链路达标(Glama listed+claimed+badge+rebase+10-28 follow-up),纯等 merge,不再 follow(已够频)
- gemini-cli show-and-tell #30151 确认 11-05 已发(1👍0💬 与同批持平),不重投
**判死 4**:mcphub.io(站挂了 DEPLOYMENT_DISABLED)、pulsemcp(Cloudflare 挡自动化,人工)、ECC 299k(纯产品仓无收录位)、shanraisshan/claude-code-best-practice 68k(AGENT COLLECTIONS 只收 subagent 库;STARTUPS 段=官方功能替代对照表非收录位)
**执行级新机会(非 PR,按价值排序)**:①自建 phinn/scoop-bucket(manifest 照 Extras #19258 审过的双层解压范式,`scoop bucket add phinn` 通路解锁,~30min);②advanced_llm_apps/ 自包含示例驱动 KinetAios(#1286 重投门,维护者亲口路条,143.9k⭐生态门票);③ACC #3473 进 validation-passed 人审队列等转化

### 2026-11-08 双执行落地(bucket + #1286 重投)
**① phinn/scoop-bucket 上线** — bucket/kinetaios.json v4.2.0(hash=exe 实算 f0daacb8…,NSIS 内层 app-64.7z 双层解压范式=Extras #19258 审过的写法)+README;Windows 通路解锁:`scoop bucket add phinn https://github.com/phinn/scoop-bucket && scoop install kinetaios`;autoupdate 挂 GitHub Releases。后续发版 checklist 加一条:发 tag 后 `scoop checkup`/手动 checkver 刷 manifest(或让 autoupdate 自己咬)。源文件 documents/scoop-bucket-src/。
**② awesome-llm-apps 重投 PR #1293** — advanced_llm_apps/kinetaios_mcp_agent/(README 51行+kinetaios_agent.py 93行纯 requests MCP client+env+gitignore)+根 README advanced 段插行(Ripple 后);新分支 add-kinetaios-agent 基于当日 main,PR body 明确回指 #1286 拒因;本仓源 documents/advanced_llm_apps_kinetaios/(c7a9bb1)。示例协议口径:POST /mcp、initialize→tools/list→tools/call run_agent、Bearer token、server 10min cap、run_agent{prompt,maxTurns}、SSE/JSON 双 content-type 兼容。
**网络坑(复用)**:github.com 下载域 shell curl 直连 000,须 `-x http://127.0.0.1:10808`(api.github.com 直连正常);大文件 8 段并行 Range 83MB≈2min。
**盯防**:#1293 两周窗口(11-22);bucket star 不追,入口可用性优先。

### 2026-11-09 winget 修复 + 重投 #475205
**旧 PR #463867 已死**(closed 03:32:29,非超时——是我按修复方案删掉 PR 分支上 4.0.3 三件后 diff 清零,被 winget 策略 bot 连带关闭;教训:**修 PR 别动 PR 所在分支的旧文件,新版本该开新分支/新 PR**)
**新 PR #475205 已开**:microsoft/winget-pkgs#475205,head=phinn:master(与上游同步后净增 4.2.0 三件,+74 行),mergeable=True,validation pending(动态装机跑中)。要点:
- 4.0.3→4.2.0,InstallerUrl 指向 v4.2.0 Setup.exe,Sha256=F0DAACB8980B5857C4C4ED5EC240110318FE01D680AE5D395DBCDB2CBE50DC30(实算)
- **摘掉硬编码 ProductCode**(4.0.3 版带 ARP GUID,旧 PR 动态验证失败嫌疑源之一;新版让 ARP 匹配走数据驱动)
- locale 补 ReleaseNotes/ReleaseNotesUrl(指向 v4.2.0 tag)
- PR body+评论均回指 #463867 说明修复差异
**盯防**:validation 结果(动态装机,常 1-3 小时-1 天)+ moderator 审核队列;若再挂,看 bot 评论的具体 fail 原因(这次修的是「install failed」,若出新错型再对症)
**操作坑(复用)**:①winget-pkgs 树对象 API 大 base_tree 玄学 422,别用分步 tree/commit API,用 Contents API 逐文件 PUT 或本地 git;②fork master 先 merge-upstream 再动手,否则删旧文件会把 PR diff 掏空引来自动关闭;③shell 里写 python heredoc 连续翻车两次(括号/引号转义),一律先落盘再执行

### 2026-11-09 awesome-indie-developers 投递 PR #6(海外 CID 对标)
仓:indiedeveloper-org/awesome-indie-developers(3★,2026-10 新建,JSON profile 制收录)。
**22 App 口径**:19 在架(README §Kinet family 权威)+3 在途(KinetAgent/MagicWindow/Dock,ASC 无记录,链接挂 kinetapp 家族页)。
**关键约束(踩坑后实测)**:validate.mjs 规定 `projects` **上限 6 个**(CONTRIBUTING.md 文字说"no fixed limit"是过时文档——代码为准)。22 全塞物理不可能。
**解法**:projects=6 旗舰(Aios/M5Chat/Task/Brief/Soul/Fit),bio 写"22 apps",website=phinn.github.io/kinetapp(全景页承载其余 16+3)。
PR#6:github.com/indiedeveloper-org/awesome-indie-developers/pull/6,本地先跑 node validate.mjs 过校验再投。comment 已留:22 口径+validator 上限说明。
**同坑复发记录**:shell heredoc 写 python 又翻车 2 次(一处是我上一轮刚记的教训没长记性)——**python 一律先 write_file 落盘再 python3 执行,永不写 heredoc**。

### 2026-11-09 winget PR #475205 校验失败定位与修复(ManifestType 错位)
**症状**:PR #475205 带标签 `Manifest-Validation-Error` + `Needs-Author-Feedback`;`mergeable_state=blocked`;commit statuses count=0(Azure 未跑出 status)。
**你给的那条链接**(issuecomment-6731616730)= policy bot 的**空徽章**(无实质内容),真正的诊断在下一条 `github-actions[bot]`(03:45:19),它明确标注 "Experimental automated suggestion - please verify before acting"。
**根因(winget-cli 源码 + 上游实例交叉验证)**:`YamlParser.cpp` 强制「No duplicate locales across manifests」+ 文件名↔ManifestType 强绑定。我们三件 manifest 的 ManifestType 全部错位:
  - `<Id>.yaml` 写了 `ManifestType: defaultLocale`(应 version)
  - `<Id>.locale.en-US.yaml` 写了 `ManifestType: locale` 且 PackageLocale=en-US(应 defaultLocale)→ 与 defaultLocale 重复
  - ⇒ IncompleteMultiFileManifest / DuplicateMultiFileManifestLocale / bot 报的 "Filename mismatch"
**权威基线**:①上游 `microsoft/winget-pkgs` 的 Microsoft.PowerToys / Microsoft.WindowsTerminal 目录结构;②旧 4.0.3 基线(commit 9975fda571e5 的 parent,bdf6b91c4 是删除 4.0.3 的 commit)—— 旧版 `<Id>.yaml` 就是 `ManifestType: version` + `DefaultLocale: en-US`,且旧 PR #463867 于 2026-10-28 已 `Azure-Pipeline-Passed`。**说明是我重写 4.2.0 时把结构改坏了(回归),旧结构本来就是对的**。
**修复**:version/defaultLocale/installer 三件按上游结构重写;version 文件只留 PackageIdentifier/PackageVersion/DefaultLocale;去硬编码 ProductCode(NSIS 用 ARP 匹配);InstallerSha256=F0DAACB8…DC30(实算)。
**本地验证(winget-cli 官方推荐 `winget validate`,但 macOS 无 winget)**:拉 winget-cli `schemas/JSON/manifests/v1.10.0/` 三份 JSON Schema + pip install jsonschema,再复刻跨文件规则 → ALL PASS。
**上传方式**:Contents API 逐文件 PUT(带 sha 更新),**不删任何文件**——删文件会让 PR diff 清零触发 bot 自动关闭(旧 PR 就是这么死的)。
**当前**:3 文件 diff 保持(+/56-0),`Manifest-Validation-Error`+`Needs-Author-Feedback` 标签已自动清除,剩 `Needs-CLA`(CLA check=success,标签滞后)+`Validation-Guide`;Azure 动态装机验证待跑(1-3h)。

### 2026-11-09 winget PR #475205 三轮修复(最终态:1.28.0 + 恢复 ProductCode)
**你给的链接**(issuecomment-6731616730)= policy bot 的**空徽章**,无实质内容;真诊断在下一条 `github-actions[bot]`(03:45:19),且它自标 "Experimental automated suggestion - please verify before acting"。
**三轮根因**:
1. **ManifestType 错位 + locale 重复** → `IncompleteMultiFileManifest` / `DuplicateMultiFileManifestLocale` / bot 报 "Filename mismatch"。正解:`<Id>.yaml`=version、`<Id>.locale.en-US.yaml`=defaultLocale、`<Id>.installer.yaml`=installer。**上轮(我)是回归**——旧 4.0.3 基线本来就是对的(commit 9975fda571e5 的 parent,bdf6b91c4 是删除 4.0.3 的 commit),旧 PR #463867 于 2026-10-28 10:47 已 `Azure-Pipeline-Passed`。
2. **ManifestVersion 1.10.0 过时** → PR template 明确要求 1.28 schema;上游 2026-11-09 当天合并的新包全部 `ManifestVersion: 1.28.0`。已升级三件到 1.28.0。
3. **摘掉 ProductCode 是错误决策** → 已恢复 `f65d9359-0830-527e-8b7c-f7153f15e828`(+ `AppsAndFeaturesEntries`)。来源已闭环:electron-builder `NsisTarget.js` 常量 `ELECTRON_BUILDER_NS_UUID = UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3")`,`UUID.v5(appId='com.kinet.kinetaios', NS)` 本地算出与 4.0.3 已验证值完全一致 → appId 不变则各版本 GUID 相同。
** InstallerSha256 实算**:`F0DAACB8980B5857C4C4ED5EC240110318FE01D680AE5D395DBCDB2CBE50DC30`(走 api.github.com release asset API 下载 87,533,113 字节实算;raw.githubusercontent.com 被代理黑洞)。
**上传方式**:Contents API 逐文件 PUT(带 sha 更新),**不删任何文件**——删文件会让 PR diff 清零触发 bot 自动关闭(旧 PR 就是这么死的)。
**本地验证**:winget-cli v1.28.0 JSON Schema(3 份)+ 复刻跨文件规则 → ALL PASS。脚本沉淀在 `/tmp/wg_v28.py`(临时,规范已写进 `docs/winget-manifest-guide.md`)。
**PR 现状**:3 文件 diff 保持(+/63-0),已发 2 条作者评论说明根因与修复;等 Azure 动态装机验证(1-3h)。
**旧 PR #463867 死因归档**:10-28 09:33 Validation-Shell-Execute 失败 → 10-28 10:01 修 installer → 10-28 10:47 Azure-Pipeline-Passed ✅ → 11-09 03:31 我删 4.0.3 文件 → Unexpected-File → 03:32 PR 被关闭。教训:修 PR 不删文件。
