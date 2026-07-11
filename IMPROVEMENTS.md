# KinetAiosWin 改进清单

> 来自 Claude Code session 分析 + token 优化评审 + 内存架构梳理 + 打包踩坑,作为后续版本改进参考。
> 已完成项标 ✅,未完成标 ⬜。

---

## 一、Claude Code session 分析得出的工程规范类

来源:扒了本机 ~790 个 Claude Code session(491M),找出反复出现的问题模式。

| # | 问题 | 改进方向 | 状态 |
|---|------|----------|------|
| 1 | `cd X && cmd` 在 Bash 工具里滥用 | Hook 拦截:看到 `cd X && cmd` 就提示改成 `cwd` 参数或绝对路径 | ⬜ |
| 2 | Edit 前没 Read,导致 old_string 不匹配 | Hook 强制:Edit/Write 前必须先 Read 同一文件(session 内追踪) | ⬜ |
| 3 | 长事实性陈述未查 WebSearch 就断言 | 在 system prompt 里强制:具体数字/版本/API 名前必须 WebSearch 验证 | ⬜ |
| 4 | AskUserQuestion 选项歧义/缺关键分支 | 加规则:选项必须互斥、覆盖主路径、首项是推荐 | ⬜ |
| 5 | iOS xcodebuild 全量编译浪费时间 | 加增量构建规则:同会话内连续 build 只编译变动 target | ⬜ |
| 6 | 长会话(>200K context)不主动拆分 | 超 threshold 时主动提示"建议 /clear 或开新会话" | ⬜ |
| 7 | Halo 项目用户偏好未固化 | 把已确认的偏好(配色/组件库/交互模式)写入 memory | ⬜ |

---

## 二、Token 优化类(主要面向 GLM/MiniMax,不考虑 OpenAI/Anthropic 高价模型)

| # | 问题 | 改进方向 | 状态 |
|---|------|----------|------|
| 8 | 长工具结果(如 npm install 输出 50K 字符)整段回填进下一轮 prompt | `truncateForModel()` 头尾 3K + 中间省略,模型上下文只看 8K | ✅ |
| 9 | `compactHistory` 已通但从未被调用 | engines.ts:147 `conv.directHistory = await compactHistory(...)` 已接通 | ✅(原本误判为死代码,实查已通) |
| 10 | GLM/MiniMax 不支持 Anthropic `cache_control`,但代码里还有 cache 分支 | 保留代码(防御性),Provider 自检探测能力,不支持就跳过 cache_control 添加 | ✅(Provider 自动按 base URL 判断是否打 cache) |
| 11 | 每轮 `extractMemories` 都跑一次 LLM,小会话也付费 | 设阈值:单轮 user input < 100 字符或全短指令跳过 extract | ⬜ |
| 12 | FTS 检索无 cwd 隔离,跨项目搜索混在一起 | `recall_memory` 加可选 cwd 过滤,schema 加 `cwd` 列并索引 | ⬜ |
| 13 | 无 memory 过期/遗忘机制,长期使用后噪声多 | 加 `last_accessed_at`,定期 GC 30 天未命中的 memory | ⬜ |
| 14 | 无 memory 人工策展 UI(误提取无法删) | 设置页加 memory 列表 + 删除/编辑 | ⬜ |
| 15 | `history` FTS 表未按 conversation 索引,跨会话搜索性能随规模下降 | 加 `conversation_id` unindexed 列,先按 conv 缩窄再 FTS | ⬜ |

---

## 三、内存架构(Product Hunt 用户提问触发)

用户问:"How does the long-term memory actually work under the hood with SQLite, and does it get shared across the different agent types or stay siloed per session?"

当前实现:

```
两套独立机制:

1. history 表(FTS5 虚拟表)
   - 写:每轮 appendMessage 后 append 到 FTS
   - 读:recall_memory 工具(Direct 引擎独有)→ MATCH 全文搜索
   - 跨会话:✅ 全局共享(无 conv/cwd 过滤)
   - 跨引擎:❌(Claude Code/Codex 不暴露 recall_memory)

2. memories 表(普通表)
   - 写:每轮 async extractMemories → LLM 提取「关于用户」的持久事实
   - 读:memoryBlock(conv) → 注入下一轮 system prompt
   - 跨会话:✅
   - 跨引擎:✅(三引擎都注入 system prompt)
```

待补短板(同 token 类的 11-15):

- 跨引擎不齐:history / recall_memory 只 Direct 能用,Claude Code/Codex 引擎靠 `--append-system-prompt` 拿不到 FTS 检索能力
- 无 curation:误提取堆积无法清
- 无隔离:多项目混搜
- 无遗忘:噪声只增不减

---

## 四、打包/分发类

| # | 问题 | 改进方向 | 状态 |
|---|------|----------|------|
| 16 | mac 上 electron-builder 不能跨平台编译 Windows 原生模块(`better_sqlite3.node` 是 mac 二进制),装到一半报错 | 必须在 Windows 机器或 GitHub Actions `windows-latest` runner 上 build | ⬜(已确认根因,等 Windows CI) |
| 17 | `asar: true` 后 better-sqlite3 必须解包,否则 require 找不到 .node | `asarUnpack: ["**/better-sqlite3/**", "**/*.node"]` 已加 | ✅ |
| 18 | 安装包拷贝到其他 Windows 报"文件或目录损坏" | 部分是 mac 打包产物 Windows 解析路径异常,部分是用户拷贝损坏;根因仍是 16 | ⬜ |
| 19 | `dist/`、`release/` 都 gitignore,Windows 测试机拿不到构建产物 | 提供 GitHub Actions workflow 在 PR 时构建 + artifact 下载 | ⬜ |

---

## 五、UI/UX 类(本轮已修)

| # | 问题 | 改进方向 | 状态 |
|---|------|----------|------|
| 20 | Windows 上设置按钮被挤隐藏 | `.sb-actions .ghost { padding: 6px 7px; }` 收窄按钮 | ✅ |
| 21 | Windows 原生菜单栏出现且丑 | `Menu.setApplicationMenu(null)` 干掉 | ✅ |
| 22 | Windows 滚动条很丑 | 全局 `::-webkit-scrollbar` 自定义 | ✅ |
| 23 | 工具执行时聊天框无动静,不知道是否在干活 | statusNote 改为独立 `.streaming-status` sibling 元素,不被 answer 覆盖 | ✅ |
| 24 | 设置页内容堆积无分组 | 拆 4 个 section(接口/行为/价格/界面) | ✅ |
| 25 | 无主题切换(只有暗色) | 加 light 主题 + `data-theme` + 实时预览 | ✅ |
| 26 | Git 历史每条点开渲染混乱(commit message 里的 `-` 被当 diff 删除行) | `colorGitDiff` 分离 metadata 和 diff body | ✅ |
| 27 | Files 文件树无选中态 | `selectedRow` + `.selected` CSS class,单击选中 | ✅ |
| 28 | Files 编辑器加载慢(用户双击后 UI 静止) | `loadEditor` 立即切 tab + 显示"加载中…"占位,IPC 完再回填 | ✅ |

---

## 六、长期/架构层(P1,要排进路线图)

| # | 问题 | 改进方向 |
|---|------|----------|
| 29 | 无图片输入(多模态) | 消息格式加 image_url,Provider 改 chat/completions 体 |
| 30 | 无 Agent 可调用的 Git 工具 | 加 `git_diff`/`git_log`/`git_commit` 内置工具(UI 层已有 Git tab) |
| 31 | 无代码库语义检索 | 接 MCP codegraph 服务 |
| 32 | 无编辑检查点/回滚 | edit_file/write_file 前存备份,新加 rollback 工具 |
| 33 | MCP 仅 stdio transport | 加 SSE/HTTP transport + 项目级 `.mcp.json` |
| 34 | `window-all-closed` 直接 quit,托盘形同虚设 | 改为隐藏窗口,托盘菜单"显示/退出" |
| 35 | 无测试框架 | 至少给 `applyEvent()`、`compactHistory`、`shellSafeMemory` 加单测 |

---

## 七、安全/合规类

| # | 问题 | 改进方向 | 状态 |
|---|------|----------|------|
| 36 | API key 已用 safeStorage 加密 | mac Keychain / Windows DPAPI 都覆盖 | ✅(分析报告误判过) |
| 37 | 记忆注入未做 LLM prompt injection 防护 | extracted memory 进 prompt 前应 escape(已做 `shellSafeMemory`,但只防 shell 注入) | ⬜ |

---

## 优先级建议

**P0(立即做)**:#16/#19(Windows CI),#30(Git 工具),#29(多模态)
**P1(本月做)**:#1-#7(Hook 规范化),#11-#14(记忆系统强化),#28(diff 预览)
**P2(季度做)**:#31(codegraph 接入),#32(检查点),#34(托盘行为),#35(测试)
