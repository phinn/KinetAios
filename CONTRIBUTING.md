# Contributing to KinetAios

Thanks for your interest! KinetAios is a solo-maintained, local-first AI agent dashboard — every contribution matters.

[English](CONTRIBUTING.md) · 中文见下

---

## Ways to contribute

1. **Bug reports** — use the Bug Report issue template. Include OS (Win11/macOS), app version, engine (Direct / Claude Code / Codex / DeepSeek Harness), and console output if available.
2. **Feature ideas** — use the Feature Request template. Check [existing discussions](https://github.com/phinn/KinetAios/discussions) first to avoid duplicates.
3. **Good First Issues** — issues labeled `good first issue` are scoped to 1-4 hours and marked with the file to touch. Comment "I'd like to work on this" before starting.
4. **Docs / i18n** — typo fixes, README translations, and wiki improvements are always welcome (English + 简体中文 are both first-class).

## Dev setup

```bash
npm install        # needs Node 18+, native build toolchain (better-sqlite3)
npm run build
npm run typecheck  # primary verification — there is no test framework
npm start
```

Read [KinetAios.md](KinetAios.md) first — it documents the architecture (two processes, three engines, one shared `applyEvent`) and conventions (bilingual comments, `// ponytail:` markers for known MVP ceilings).

## Conventions

- Comments are **bilingual (中文 + English)** to match the codebase.
- One logical change per PR. Platform-specific code paths (shell/PATH/hotkey/tray) must be verified on the target OS — a Windows binary must be built on Windows, macOS likewise.
- `npm run typecheck` must pass. Verification = typecheck + manually driving the affected flow.

## PR process

| Time | What happens |
|---|---|
| 0-24h | First response (thanks + initial feedback) |
| 24-48h | Code review |
| 48-72h | Merge or change request |

---

# 贡献指南(中文)

感谢关注 KinetAios。这是一个个人维护的 local-first AI agent 仪表盘,每一份贡献都很重要。

## 参与方式

1. **Bug 报告** — 用 Bug Report 模板,写清系统(Win11/macOS)、版本、引擎(Direct / Claude Code / Codex / DeepSeek Harness)、控制台输出。
2. **功能想法** — 用 Feature Request 模板,先搜 [Discussions](https://github.com/phinn/KinetAios/discussions) 避免重复。
3. **Good First Issues** — 带 `good first issue` 标签的 issue 都是 1-4 小时工作量,标注了要改的文件。开工前先评论认领。
4. **文档/翻译** — 错别字、README 翻译、wiki 改进随时欢迎(英文+简体中文双语文档)。

## 本地开发

```bash
npm install        # Node 18+,需要原生编译工具链(better-sqlite3)
npm run build
npm run typecheck  # 主要验证手段 —— 本仓库没有测试框架
npm start
```

动手前先读 [KinetAios.md](KinetAios.md):双进程架构、三引擎统一事件流(`applyEvent`)、双语文注释、`// ponytail:` 标记的已知 MVP 边界。

## 约定

- 注释双语,与现有代码一致。
- 一个 PR 只做一件事。平台相关代码(shell/PATH/热键/托盘)必须在目标系统上验证过。
- `npm run typecheck` 必须通过;验证 = typecheck + 手动走一遍受影响的流程。

## PR 响应节奏

| 时间 | 动作 |
|---|---|
| 0-24h | 首次回复 |
| 24-48h | Code review |
| 48-72h | 合并或提出修改 |
