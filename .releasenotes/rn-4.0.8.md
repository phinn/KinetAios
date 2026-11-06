**发布日期:** 2026-11-06(自 v4.0.7 起 19 commits)

# v4.0.8 — Composer 视觉收敛 / Provider 预设 / 启动动画贡献点 / 安全加固

## 新功能

- **阿里百炼 Token Plan 预设** — 新增阿里百炼(DashScope)Anthropic 兼容端点引擎预设；协议切换时 Base URL 自动联动(智谱 Coding Plan ↔ 阿里 Token Plan 双向映射，含测试覆盖)；模型配置档编辑弹窗补 Provider 预设下拉
- **Provider 经济学分流** — 按所用 Provider 在 systemPrompt 注入对应的用量纪律段：阿里 Credits 按量计费提醒 / 智谱 Coding Plan 5h 窗口额度策略(缓存优先、探查合批、断链禁令)
- **启动动画插件贡献点** — splash 支持插件以 panel 式声明接管开场动画，主题配色跟随；12 秒崩溃回退兜底，主窗 `show:false + ready-to-show` 交棒不再白闪
- **Composer 视觉收敛** — 输入区多层框线收敛为单卡片(六主题对齐)；工具钮/发送钮/模式 pill 全面平权化去框线，hover 才浮现材质，对齐参考级"干净整洁"界面

## 修复

- **插件面板桥静默失效(P1)** — sandbox iframe 未插入 DOM 前 `contentWindow` 恒为 null，桥收编永不执行，插件全部 `hostCall`(getTheme/promoList/导入)被静默丢弃；修复为先 `appendChild`(同步创建 browsing context)再收编，`load` 事件幂等兜底
- **插件桥防伪造加固** — 按 iframe `contentWindow` 身份白名单(WeakSet)校验，不再信任 `source` 字符串前缀(任意 iframe 自称 `plugin:x` 即可调敏感 API 的漏洞封死)
- **大仓库 glob/grep 假性无匹配** — `walkFiles` 改目录优先 BFS，深层文件不再因遍历顺序被漏掉
- **打断管线** — 流式响应停止时正确传播 abort，不再"停了还在计费"

## 内部改进

- Direct 引擎 systemPrompt 注入探查合批指令(只读探查同轮并行发多个 tool_calls)，降低窗口消耗
- 文档修正：插件数 21→26(按 plugin.json 实际清点)

---

**English**

## New

- **Alibaba Bailian Token Plan preset** — new engine preset for Alibaba Bailian (DashScope) Anthropic-compatible endpoint; Base URL auto-syncs on protocol switch (Zhipu Coding Plan ↔ Alibaba Token Plan, both directions, with tests); provider preset dropdown added to the profile editor modal
- **Provider economics injection** — usage-discipline paragraphs injected into systemPrompt per provider: Alibaba Credits pay-as-you-go reminders / Zhipu Coding Plan 5-hour window quota strategy (cache-first, batched exploration, no abandoned chains)
- **Splash animation plugin contribution point** — plugins can take over the startup animation via panel-style declaration; follows theme colors; 12s crash fallback; main window hands over via `show:false + ready-to-show`, no more white flash
- **Composer visual consolidation** — input area reduced to a single card across all six themes; tool buttons / send button / mode pills flattened to borderless-by-default with hover-revealed surfaces, matching a clean reference-grade UI

## Fixed

- **Plugin panel bridge silently dead (P1)** — a sandboxed iframe has `contentWindow === null` until inserted into the DOM, so bridge enrollment never ran and every plugin `hostCall` (getTheme/promoList/import) was dropped silently; fixed by `appendChild` first (synchronously creates the browsing context), then enrolling, with an idempotent `load`-event fallback
- **Plugin bridge anti-spoofing hardening** — enrollment is validated against a `contentWindow` identity whitelist (WeakSet) instead of trusting the `source` string prefix (closing the hole where any iframe could self-identify as `plugin:x` to call sensitive APIs)
- **False "no matches" on large repos** — `walkFiles` now walks directories first (BFS) so deep files are no longer skipped by traversal order
- **Interrupt pipeline** — abort now propagates correctly when stopping a streamed response; no more "stopped but still billing"

## Internal

- Direct engine systemPrompt now includes batched-exploration instructions (parallel read-only tool calls in one turn) to reduce window consumption
- Docs: plugin count corrected 21→26 (actual plugin.json inventory)

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.0.7...v4.0.8
