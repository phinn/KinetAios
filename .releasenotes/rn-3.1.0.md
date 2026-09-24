**发布日期：** 2026-08-17(自 v3.0.0 起 6 commits)

### 🔌 插件引擎贡献点(Plugin SDK v3)
- **manifest.engine 声明式引擎贡献点** — 插件可直接贡献新引擎;抽取 CliEngineAdapter,ClaudeCode/Codex 退化为 config 驱动;git-agent 示例插件 dogfood
- plain 协议 stderr 分流 + resume 子命令模式;engine spec 校验 + 错误透出设置页;设置 UI 输入框(schema + 占位符插值)
- 四语言文案 + 插件四操作后热重建引擎表;EngineKind 开放 plugin:<name> 前缀

### 🎨 Windows 图标
- 用 icon-e1-K 重生成 7 尺寸多帧 icon.ico — 修任务栏/EXE 图标仍是旧版

---

**English**

- **Declarative plugin engine contribution points (Plugin SDK v3)**: plugins can ship new engines via manifest.engine; CliEngineAdapter extracted (ClaudeCode/Codex become config-driven); git-agent example plugin dogfoods it
- plain protocol stderr split + resume subcommand mode; engine spec validation with errors surfaced in settings; settings UI inputs (schema + placeholder interpolation); hot engine-table rebuild after plugin ops; `plugin:<name>` engine kinds
- Windows icon regenerated as multi-size icon.ico from icon-e1-K (taskbar/EXE finally updated)

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.0.0...v3.1.0
