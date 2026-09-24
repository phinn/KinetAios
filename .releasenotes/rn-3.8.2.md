**发布日期：** 2026-09-22(自 v3.8.1 起 6 commits)

### ✨ 功能

- **侧栏频道速览 tooltip**(9ba9ed5)—— hover 频道条目 350ms 弹出会话全景:当前步骤/待办进度/token 消耗/最近输出,harness 风格;fixed 定位挂 body 不遮列表(197bed8),不喜欢可一键关闭(3557f1d),默认关(7d6b37e)

### 🐛 修复

- **feishu/wecom_send_file 会话来源门控**(0901541)—— 飞书/企微通道只对来源会话开放:修前本地频道会话也能调,曾把 release 笔记误推到企微群
- **embedding 链路断供 P0**(7d30a5e)—— 智谱 anthropic 端点(`/api/anthropic`)不含 `/v4` 子串被守卫误杀 → 8/5 起全库记忆 0 向量,语义召回静默退化为子串匹配;修复后端点自动改写 `/api/paas/v4`,附存量回填脚本(18627/18627 全量回填)
- **记忆治理三处**(7d30a5e)—— rule 类记忆补过滤(不再被语义去重误删/被 decay 清掉);纠错 strike 归因收紧到"纠正话术本身"(跨轮错位不再误杀);deleteConversation 级联清理 conv_facts 锚点

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.8.1...v3.8.2
