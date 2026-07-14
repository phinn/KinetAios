# Release Notes

## v1.2.0 — 多机协作 & UX 全面改善

**发布日期：** 2026-07-15

v1.0 后 71 次提交，重点在两个方向：**多机远程协作**（MCP Bridge 成熟可用）和 **UX 体验打磨**（四主题、SVG 图标、自研编辑器、Git Diff 重做）。

---

### 🌐 多机协作 MCP Bridge（核心新特性）

多台安装 KinetAios 的电脑通过 MCP 协议（SSE/HTTP + JSON-RPC 2.0）实现跨机协同计算——A 机的 Agent 可以调度 B 机的完整算力。

- **本机 MCP Server** — 默认端口 18109，Bearer token 鉴权，30s ping 保活
- **远程 SSE Client** — 自动发现/连接远程节点，工具名带 `[MCP:remote/节点名]` 标识注入 Direct 引擎
- **`run_agent` 远程调度** — 远程节点只暴露 `run_agent` 一个工具（不暴露细粒度工具），在被调用端启动完整 ReAct Agent 循环，沙箱跟随本机设置，5 分钟超时保护
- **自动重连** — SSE 连接断开后自动重连恢复，不再一次网络抖动就永久失效
- **远程 Agent 状态条** — 本机被远程调用时右下角即时弹出金色脉动状态条，实时显示「Agent 已启动 / 正在调用工具 / 已完成」
- **设置页** — iOS 风格开关，MCP token 一键生成，远程节点列表可视化管理

---

### 🚀 11 大差异化功能（Phase 1–11）

| 功能 | 说明 |
|---|---|
| **Arena 多引擎并跑** | 同一 prompt 同时发给多个引擎，并排对比输出质量 |
| **文件快照 + 回滚** | Agent 改文件前自动建快照，一键回滚到任意版本 |
| **跨引擎子任务编排** | `dispatch_agent` 派发独立子任务给子 Agent（独立上下文），支持并行探索 |
| **记忆图谱** | 长期记忆以三元组（主体-关系-客体）结构化存储，Canvas 力导向图可视化 |
| **Plugin SDK v1** | 第三方插件接口，自定义工具扩展 |
| **语音输入/输出** | 🎤 语音录制 → API 转写 → 发送；回复可朗读 |
| **定时任务 (Cron)** | 定时触发 Agent 执行周期性任务 |
| **Watch 模式** | 监控文件变化自动触发 Agent |
| **Ollama 本地模型** | 接入本地 Ollama，离线可用 |
| **语义召回 (Embeddings)** | Embedding 接口独立配置（默认 GLM embedding-3），语义近似搜索补充 FTS5 关键词 |
| **知识图谱力导向可视化** | Canvas 力导向图替代纯文本列表，拖拽节点、缩放画布 |

---

### 🎨 UI / UX 全面升级

- **四种主题** — Dark / Light / Serene（暖灰 + 玫瑰金）/ Gold
- **全量 SVG 图标** — 所有 emoji 替换为内联 SVG，视觉统一
- **自研代码编辑器** — 轻量 CodeEditor 替换所有 textarea，支持语法高亮、自动缩进、多语言
- **Git Diff 界面大改** — word-level diff、文件分段、staged/unstaged 分组
- **侧栏头部收纳** — 按钮收纳进 ⋯ 下拉菜单，布局整洁
- **消息复制按钮** — 每条 AI 回复可一键复制
- **四语言 i18n** — en / zh-CN / zh-TW / ja，全面覆盖

---

### ⚙️ 引擎与核心改进

- **引擎改名** — `GLM Direct` → `Kaios`（品牌统一）
- **maxTurns 可配置** — 设置项控制最大循环轮数，默认 50，支持 0=无限
- **Token 估算优化** — 算上 tool_calls，滑动平均自校准系数（初始 0.6）
- **Prompt Cache** — Direct 引擎支持 Anthropic prompt cache 降低成本
- **三级上下文压缩** — trim → LLM 摘要 → 超长兜底
- **文件编码自动检测** — read_file / edit_file / grep 自动识别 UTF-8 / GBK / GB18030 等
- **记忆注入重构** — 从 systemPrompt 移到 history[0]，减少重复注入开销

---

### 🐛 重要修复

- 二进制文件读取崩溃 → 检测 + 跳过
- 截图空白图 → 改用 `getDisplayMedia`
- 中断后连续对话上下文断裂
- cost 重复记录 / 记忆 1970 时间戳 / 孤儿数据
- 命令注入风险加固（`execFile` 替代 `exec`）
- webview HTML 预览显示源码 → CSP `frame-src` 修复
- 淡色主题在独立窗口（Dashboard/Quick/Files）未生效
- 打包用 `asar: true` + native module unpack，修复复制到其他 Windows 报「损坏」

---

### 📦 打包 & CI

- GitHub Actions 自动构建 Windows + macOS 双平台 release
- 版本 1.0.0 → 1.1.0
- Landing / index 页面可视化大幅升级
- README 英文版第一屏改造（badges / 对比表 / 下载链接）
- GitHub wiki 全套 17 页（英文为主 + 中文镜像）

---

**完整 changelog：** https://github.com/phinn/KinetAios/commits/main

---

## v1.0.0 — 首个正式发布

**发布日期：** 2026-07-12

KinetAios 首个正式版本——Windows 11 平台的三引擎 AI Agent 面板。

### 核心特性

- **三引擎架构** — Kaios（内置 ReAct）/ Claude Code / Codex，每会话可切换
- **9 个内置工具** — shell / read_file / write_file / edit_file / grep / glob / web_fetch / recall_memory / git_diff
- **SQLite + FTS5** — 对话历史全文检索 + 长期记忆抽取
- **全局热键** — 快速呼出 Quick Panel
- **MCP 协议** — stdio transport 接入外部 MCP Server
- **成本追踪** — 实时 token 消耗 + 费用统计
- **Files / Git / Rules 内联 Tab** — 不离主窗口管理项目文件
- **Workbench 项目视图** — 按 cwd 分组管理多项目
- **Dashboard 窗口** — Token 消耗 + Agent 实时状态监控
- **长期记忆面板** — 按频道查看 / 行内编辑 / 删除
- **暗 / 淡色主题**
- **四语言 i18n** — en / zh-CN / zh-TW / ja
- **@文件引用** — 拖入文件自动拼进 prompt
- **Plugin + Agent 扫描** — 自动发现 Claude / Codex 插件和 agent 配置
