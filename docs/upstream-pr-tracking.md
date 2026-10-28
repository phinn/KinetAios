# KinetAios 上游 PR 追踪表

> 更新: 2026-10-28 | 仓库: phinn/KinetAios (v4.0.3)
> 用途: 所有上游收录 PR 的状态快照。每次跟进前先跑一遍状态刷新(脚本见 /tmp/build_table.py 模式),不要凭记忆。

## 状态总览

| 仓库 | PR | 状态 | 合并 | 备注 |
|---|---|---|---|---|
| serhii-londar/open-source-mac-os-apps (42k⭐) | [#1386](https://github.com/serhii-londar/open-source-mac-os-apps/pull/1386) | Add KinetAios | ✅ MERGED 2026-10-19 | **主引流源**,已验证带来 referrer 流量 |
| juejin-cn/juejin-usage | [#201](https://github.com/juejin-cn/juejin-usage/pull/201) | KinetAios 用量采集 | ✅ MERGED 2026-10-08 | 国内渠道 |
| e2b-dev/awesome-ai-agents | [#1397](https://github.com/e2b-dev/awesome-ai-agents/pull/1397) | Add kinetaios | ⏳ open, clean | CLA 已签;维护者审核慢(数周),定期回查 |
| punkpeye/awesome-mcp-servers (60k⭐) | [#14667](https://github.com/punkpeye/awesome-mcp-servers/pull/14667) | Developer Tools 区 | ⏳ open | Glama 目录已收录(条件满足),2026-10-28 已发跟进评论 |
| kyrolabs/awesome-agents | [#902](https://github.com/kyrolabs/awesome-agents/pull/902) | Conversational / General Agents | ⏳ open | 旧 #781 被 botbocks 批量清理关闭(该仓库近期一半 PR 同遭遇,非针对);GitHub 不允许 reopen,已基于最新上游重开;**警惕再次被 bot 清理** |
| Homebrew/homebrew-cask | [#297869](https://github.com/Homebrew/homebrew-cask/pull/297869) | Cask: add kinetaios | ❌ closed(等重开) | bot 因"模板缺失"关闭(实为 AI 检测误伤);已补全官方模板+留言申请重开;**cask 本身三次修正全绿** |
| microsoft/winget-pkgs | [#463867](https://github.com/microsoft/winget-pkgs/pull/463867) | KinetAios.KinetAios 4.0.3 | ⏳ open, 验证中 | CLA 已签;首轮验证败于 NSIS 静默参数,已修(neutral + ProductCode f65d9359…+ /S),等 bot 重跑 |

## 已关未合并(不再跟进)

| 仓库 | PR | 结局 | 教训 |
|---|---|---|---|
| getagentseal/codeburn | [#1540](https://github.com/getagentseal/codeburn/pull/1540) | closed 2026-09-24, 未合并 | 此前误记为 merged;小仓库维护者不活跃 |
| WangRongsheng/awesome-LLM-resources | [#232](https://github.com/WangRongsheng/awesome-LLM-resources/pull/232) | closed 2026-09-28, 未合并 | 同上 |
| kyrolabs/awesome-agents | [#781](https://github.com/kyrolabs/awesome-agents/pull/781) | botbocks 批量清理 | 已由 #902 替代 |

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

1. **winget**: 等 winget 验证 bot 重跑(通常 30-60 分钟出结果);若静默装仍失败,本地实测 `KinetAios.Setup.4.0.3.exe /S /currentuser`
2. **Homebrew**: 若 3-5 天无人重开 → 关闭,stars ≥75 后用现成 cask(`docs/tmp` 已存最终版)再投
3. **kyrolabs #902**: 每周查一次是否又被 bot 清理
4. **e2b #1397 / punkpeye #14667**: 维护者节奏慢,每 2 周回查
5. stars 过 75/100 后:重投 homebrew-cask(附 notability 改善说明)
