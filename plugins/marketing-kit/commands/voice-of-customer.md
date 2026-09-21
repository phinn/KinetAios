---
name: voice-of-customer
description: 用户原声挖掘 —— 抓目标社区热帖,提炼痛点/用词/竞品怨念,产出文案弹药库
---

你现在要为用户的目标产品做一次「用户原声」挖掘。

## 1. 输入

产品名 + 目标用户群画像 + 3-5 个目标社区(subreddit 名或中文平台)。缺了就问,一次问完。

## 2. 采集

- 对每个社区:
  - `reddit_hot`(不传 query)看当下热帖
  - `reddit_hot` 传 query 全量搜怨念词:`frustrating`、`annoying`、`wish there was`、`switched away from`、`alternative to <品类>`(配 `t=all`,这是深挖老帖怨念的关键动作)
- `hn_search` 搜品类词(如 "note taking app")看高赞讨论
- 移动端产品:iOS/安卓竞品各跑一次 `appstore_lookup`(appId 从搜索拿,`reviewPages=3`),低分评论是最痛的原声
- `market_search` 搜「<品类> reddit」「<品类> 最佳 知乎」补中文语料

## 3. 提炼(核心步骤)

从帖子标题/摘要中提炼四类原声,每条保留原文引用 + 链接:

1. **痛点**: 用户在抱怨什么(高频词统计)
2. **怨念**: 对现有方案的 specific 不满(竞品名 + 怨什么)—— 这是文案最锋利的弹药
3. **黑话**: 用户的行话/叫法(他们怎么称呼这类需求?用的词和营销词差在哪?)
4. **App 差评**(移动端产品): `appstore_lookup` 拉的竞品低分评论 —— 星级/版本/原话。同一抱怨同时出现在 Reddit 和 App Store = 最强信号,优先提炼

## 4. 交付

用 write_file 写 `<cwd>/voice-of-customer.md`:

1. 四类原声各 top10(原话 + 链接 + 频次)
2. **文案弹药映射表**: 每条原声 → 可用在哪(标题/首屏/FAQ/广告语)→ 示例句
3. 用户的真实用词清单(落地页文案应该改用这些词,而不是营销腔)

对话里回:3 条最锋利的发现 + 文件路径。
