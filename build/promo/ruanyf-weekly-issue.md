#ruanyf/weekly 投稿 issue(2026-09-19)
# 发到 https://github.com/ruanyf/weekly/issues 新建 issue,标题用下面这行
# (ruanyf/weekly 无禁 AI 代投条款,但 issue 用第一人称"我",AI 代发即欺骗,必须用户本人提交)

标题:
【开源自荐】KinetAios:本地优先的多引擎 AI Agent 桌面端,Windows / macOS 双端

正文:

## KinetAios:把多个 AI Agent 引擎装进同一个桌面窗口

我是 KinetAios 的作者。平时同时用 Claude Code、Codex 和自研引擎干活,窗口切来切去、会话历史散落各处,于是做了这个桌面端,把它们装进同一个窗口:

- **四个引擎,按会话切换**:内置 ReAct 引擎(Direct V1/V2/V3,支持 Plan-Execute-Verify-Judge 与 DAG 并行)+ Claude Code + Codex + DeepSeek Harness,同一界面管理,会话历史统一入库。
- **本地优先**:SQLite 存全部会话,自动提取长期记忆(跨引擎共享,重启不丢);无账号、无中转服务器,自己的 API Key 是唯一凭据。
- **40+ 内置工具**:shell(带审批门)、文件读写、网页抓取(带 SSRF 防护)、浏览器自动化,MCP Client/Host 双向支持。
- **技能/插件生态**:自动扫描 Claude Code 的 skills/commands/agents 并直接调用;自带 20 个插件(办公套件、嵌入式 IoT 全家桶、NestJS 脚手架等)。
- **Windows 11 与 macOS 双端一等公民**:平台差异运行时路由,功能对齐。

- 项目:https://github.com/phinn/KinetAios (GPLv3,Electron + TypeScript)
- 下载:https://github.com/phinn/KinetAios/releases (v3.8.0,免安装 NSIS / macOS zip)
- 文档:https://github.com/phinn/KinetAios/wiki(62 页,含中英双语)

<img src="https://raw.githubusercontent.com/phinn/KinetAios/main/documents/hero-v3.8.jpg" width="640" alt="KinetAios 主界面:多项目并行会话,每会话可切换引擎">

界面即真实运行画面:左侧多项目会话树,每个会话可选引擎,右侧对话/文件/Git/规则多 tab,每轮显示 token 成本。

上手:解压启动 → 设置里贴 API Key(内置 GLM/Claude/OpenAI 等预设)→ 发任务。欢迎试用和反馈。
