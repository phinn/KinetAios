# Release Notes

## v1.4.0 — 协作增强 & 可视化全面升级

**发布日期：** 2026-07-16

v1.3.0 后 37 次提交。两个方向：**协作与可视化**（区域截图、记忆图谱大屏、Visual Inspector、Arena 仪表盘、跨会话引用）和**插件生态**（插件系统 V2 多贡献点架构）。

---

### 📷 区域截图（新）

截图不再只能截全屏——拖拽框选屏幕任意区域，裁剪后以图片附件发送给 AI。

- **拖拽选区裁剪** — 点击截图按钮 → 全屏遮罩 → 拖拽框选 → 自动裁剪
- **Base64 内嵌** — 截图以 vision content part 形式注入 prompt，AI 直接"看到"图片
- **CSP 放行** — `img-src` 允许 `data:` / `blob:`，截图缩略图正常显示

---

### 🧠 记忆图谱大屏（重做）

独立窗口的力导向图谱，让 AI 的长期记忆从黑盒变透明。

- **力导向可视化** — 三元组（主体-关系-客体）渲染为可拖拽、缩放、平移的图谱
- **搜索 + 度数过滤** — 输入关键词定位实体，滑块过滤低关联节点
- **记忆溯源** — 点击节点查看每条记忆来自哪个引擎、哪次对话、原始问题
- **冲突检测** — 右侧面板自动标红同一主体的矛盾记忆
- **手动删除** — 在详情面板直接删除过时 / 错误的三元组

---

### 🎯 Visual Inspector — 圈选改代码（新）

在文件面板预览网页时，直接在页面上拖拽圈选 DOM 元素，收集 outerHTML / computedStyle / DOM 路径，然后描述修改意图 → AI 自动改代码。所见即所言。

- **元素框选** — webview 中拖拽选择元素，高亮选中区域
- **上下文组装** — 文件路径 + 源码片段 + 元素信息 + 修改意图，自动拼成完整 prompt
- **Renderer 层实现** — overlay 完全在 renderer 层，绕开 IPC 延迟

---

### ⚔️ Arena 深度仪表盘（增强）

三引擎并跑从"能看回答"升级为"深度对比"。

- **三栏并排实时流** — Direct / Claude Code / Codex 同一 prompt 并排输出
- **Diff 逐行对比** — 选两个引擎的输出做 word-level diff，高亮差异行
- **AI 裁判** — 第三个引擎自动对另两个的回答评分

---

### 🔗 跨会话引用 + 会话分支 + 任务图（新）

像 Git 一样管理 AI 对话。

- **`@conv:xxx` 引用** — 在输入框引用另一个会话的最后一轮回答作为上下文
- **会话分支** — 从任意一轮创建分支（类似 `git branch`），走不同方向不丢上下文
- **任务图 DAG** — 自动构建所有会话间的分支 / 引用关系图

---

### 🔌 插件系统 V2（重做）

从 V1 的单一工具注册升级为多贡献点架构。

- **四种贡献点** — 工具（Tools）/ Slash 命令 / System Prompt 注入 / Hooks
- **分类卡片** — 设置页展示插件名称、版本、作者、分类、图标、权限声明
- **拖放安装** — 将插件目录拖入即可安装，一键卸载
- **plugin.json 清单** — 标准化插件描述格式
- **内置示例** — 18 工具的办公套件插件（CSV / Excel / PDF / OCR / Outlook / Office COM）

---

### 🔍 上下文检查器（新）

查看 / 编辑每个会话实际发给 LLM 的完整消息列表。

- **Token 进度条** — 当前上下文用量 vs 模型上限，>60% 黄色 / >80% 红色预警
- **JSON 消息列表** — 展示完整 directHistory（role / content / tool_calls）
- **内联编辑** — 直接修改消息内容，保存后下一轮使用新上下文
- **侧栏入口** — 每个会话项可直接打开检查器

---

### 🔎 全局对话搜索（新）

`Ctrl+Shift+F` 呼出搜索浮层，跨所有历史会话搜关键词（标题 + prompt 内容），点击直接跳转。

---

### 🔒 安全修复

- **SSRF 防护加固** — timing-attack 恒定时间比较、SSE 端点不接受 URL 传 token
- **子进程监听器泄漏** — abort 监听器在子进程关闭时未移除
- **sandbox check** — `write_file` / `edit_file` 未传 `isWrite=true`
- **持久化字段补全** — conversations 表新增 `branch_info` / `pipeline_id`

---

### 🐛 其他修复

- 侧栏频道文字水平居中（flex-direction 继承问题）
- 截图后输入框消失 / overlay 遮挡输入框
- DevTools 快捷键在清空菜单后失效
- 上下文检查器 CSS 变量名错误（`--bg-elevated` → `--bg-elev`）
- 上下文检查器 i18n 键缺失
- 品牌名全局统一为 KinetAios / Claude Code / Codex

---

**完整 changelog：** https://github.com/phinn/KinetAios/commits/main

---

## v1.3.0 — Town View & 安全加固

**发布日期：** 2026-07-15

v1.2.0 后 24 次提交。两个方向：**Town View 小镇可视化**（等距像素风 Agent 地图 + 远程节点可视化）和**安全加固**（SSRF / shell-open / 正则注入 / argument injection 两轮审查修复）。

---

### 🏘️ Town View — 等距像素风 Agent 小镇（新）

把项目和 Agent 可视化为一个等距像素风小镇——每个项目是一栋房子，每个会话是一个村民，远程节点是云端房子。

- **等距像素地图** — 项目渲染为等距网格上的小房子，村民作为精致 SVG 角色住在里面
- **实时 Agent 状态** — 每个村民头顶显示状态徽章：空闲 / 工作中 / 完成 / 出错，一眼掌握全局
- **地图内聊天** — 点击村民直接在地图上打开迷你聊天面板，发任务、停 Agent、跳转完整对话
- **远程节点可视化** — 已连接的远程 MCP 节点显示为云端房子，在线/离线状态实时同步
- **新建项目 / 新建任务** — 新建项目 = 选目录盖房子；新建任务 = 在已有房子里生成新村民
- **跨引擎** — 村民可用任意引擎（Kaios / Claude Code / Codex），引擎徽章标识
- **四语言 i18n** — Town UI 全部本地化：English / 简体中文 / 繁體中文 / 日本語
- **主题联动** — Town 背景跟随当前主题切换，回归克制配色（去掉花哨皮肤系统）

---

### 🔒 安全加固（两轮审查）

- **SSRF 防护** — `web_fetch` 禁止访问内网地址（127.0.0.1 / 10.x / 172.16-31.x / 192.168.x / IPv6 ULA）
- **shell-open 防护** — 阻止 `shell:` / `file:` 协议的外部链接打开（防 RCE）
- **正则注入防护** — `grep` 工具的正则参数转义，防 ReDoS
- **argument injection 防护** — CLI spawn 参数严格校验，防注入
- **类型修复** — TypeScript 类型安全加固
- **剪贴板修复** — contextIsolation 下剪贴板复制不工作 → 改用 IPC 通道

---

### 🎨 UX 改善

- **关闭按钮行为设置** — 关闭窗口时：退出 / 最小化到托盘 / 最小化（默认最小化）
- **Town 面板居中弹出** — 毛玻璃背景遮罩，居中显示，高度自适应
- **对比页面** — 新增 KinetAios vs Claude Code vs Codex 三方对比页（15 项改进迭代）
- **功能说明 HTML** — 完整功能说明页面
- **Product Hunt 发布文案** — 英文版营销文案

---

**完整 changelog：** https://github.com/phinn/KinetAios/commits/main

---

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
- Landing / index 页面可视化大幅升级
- README 英文版第一屏改造（badges / 对比表 / 下载链接）
- GitHub wiki 全套 17 页（英文为主 + 中文镜像）

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
