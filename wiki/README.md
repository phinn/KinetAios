# Wiki Sources

KinetAios GitHub wiki 的 markdown 源。和代码一起 PR review,定期同步到 `https://github.com/phinn/KinetAios/wiki`。

## 页面清单

| 文件 | 内容 |
|---|---|
| `Home.md` | wiki 首页 / 功能矩阵 / 入口 |
| `Getting-Started.md` | 第一次启动 → 第一条任务 |
| `Architecture.md` | 三层结构 / shared/types.ts / KinetAPI 契约 |
| `Engines.md` | 三引擎对比 + 何时用哪个 |
| `Direct-Engine.md` | ReAct loop / memory 注入 / context 管理 |
| `Tools-and-MCP.md` | 10 个内置工具 + MCP 集成 |
| `Long-Term-Memory.md` | 抽取 / 注入 / 🧠 面板 / 导入导出 |
| `Skills.md` | skill / command / agent 扫描与 `/` 调用 |
| `Files-and-Preview.md` | 文件窗口 + webview + 编辑器 |
| `Git-Integration.md` | changes / history / 文件 diff / commit show |
| `Rules-and-Context.md` | AGENTS / CLAUDE / KINET / KINET-CONTEXT |
| `Workbench.md` | 项目卡片总览 |
| `Settings.md` | 五大 setting 区 |
| `Global-Hotkey.md` | 全局热键 + 快速面板 + 托盘 |
| `i18n.md` | 四语言切换 |
| `Development.md` | typecheck / build / pack / dist / CI |
| `Wiki-Sync.md` | 怎么把这些推到 GitHub wiki |

## 推到 GitHub wiki

详见 `Wiki-Sync.md`。短版:

```sh
# 一次性:浏览器去 /phinn/KinetAios/wiki 创建首页,初始化 wiki 仓库
git clone https://github.com/phinn/KinetAios.wiki.git /tmp/kinet-wiki
cp wiki/*.md /tmp/kinet-wiki/   # 不含本 README.md
cd /tmp/kinet-wiki && git add . && git commit -m "sync wiki" && git push
```

## 编辑

- 主 repo 的 `wiki/` 是真理源;GitHub wiki 是 mirror
- 内部跳转用 `[[Page-Name]]`(`Page-Name` 对应文件名去 `.md`)
- 代码引用格式 `src/path/file.ts:line`
- 中文为主;代码标识符 / CLI flag / 文件名保留英文
