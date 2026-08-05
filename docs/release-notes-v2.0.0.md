# KinetAios v2.0.0 Release Notes

**从 v1.6.0 到 v2.0.0 — 133 commits, 架构级升级。**

---

## 🔥 核心新特性

### DirectV2 引擎 — Plan · Execute · Verify · Judge 四层架构

全新引擎,对标 Claude Code 的多步任务执行能力:

- **Planner**:接收用户指令,生成结构化执行计划(JSON steps)
- **Executor**:逐步执行,每步走独立 ReAct loop,支持 auto-verify 和 replan
- **Verifier**:执行结果验证,防止"假完成"
- **Judge**:JSON 结构化评判,决定是否通过 / 重试 / 重新规划
- **Crash Recovery**:断点续执行 — 每步完成后持久化 checkpoint,崩溃/重启后自动恢复
- **上下文预算可配置**:`modelWindow` + `budgetRatio` 让用户按模型调整上下文窗口
- **三级压缩 fallback**:全预算 → 砍半 → 1/4,结构化摘要(任务目标/关键决策/已改文件/执行命令)

### Agent Teams — 多 Agent 团队协作

- `spawn_team` 创建多成员团队,每个 member 独立 history + 持久化
- `team_broadcast` 广播指令,所有 member 并行处理
- `team_send` 单独追问某个 member
- 实时可视化 Team 面板 — member 卡片状态实时更新
- 完整 i18n(14 key × 4 语言)

### 记忆系统全面升级 — 三层架构

1. **Memory Blocks(结构化常驻记忆)**
   - `user_profile` / `project_context` / `active_goals` 三个核心块
   - 每轮注入上下文,`memory_replace` / `memory_append` API

2. **长期记忆(自动提取 + 检索注入)**
   - 每轮对话自动提取"关于用户的事实"
   - **Importance Scoring**:记忆按重要性打分,影响检索排序
   - **三级去重**:精确 + Jaccard 模糊 + Embedding 语义去重
   - **Embedding 语义检索**:recall_memory 走 cosine 相似度召回
   - **知识图谱三元组**:记忆支持三元组提取 + 图谱检索重排
   - **时间衰减**:旧记忆自动降权,可手动批量清理
   - memoryBlock 从全量注入改为**检索注入**(只注入相关的)

3. **Episodic Memory(会话摘要)**
   - 每次会话结束自动生成摘要
   - 下次对话可看到"最近做了什么"

### 替身画像系统(Persona)

- 分析历史对话 + 长期记忆,自动生成用户风格画像
- 画像注入三引擎 systemPrompt — 让 AI 模仿用户做事风格
- 独立面板,支持手动清空/激活切换

### 实时语音对话(豆包实时语音大模型)

- WebSocket 全双工实时语音 — 说话即响应
- ASR 文本 → Agent 执行 → 结果语音播报
- 语音对话注入当前项目上下文
- 分栏 UI — 点击后 main 区域一分为二
- 四语言 i18n(zh / en / zh-TW / ja)
- 设置页新增实时语音助手配置区

### dispatch_agent scope 参数

- `none`(默认):子 agent 完全独立
- `last_n_turns`:取 parent 最近 N 轮对话
- `summary_only`:LLM 全文摘要注入
- `full_history`:全量 history(超长自动 compact)

### remember_fact / recall_fact — 会话级 KV 锚点

- 多步任务的关键产出跨轮持久化(文件路径列表、关键决策、临时文件名)
- 不依赖对话 history(会被 trim/compact 砍掉)

---

## 🎨 UI / UX 改进

### 液态玻璃主题全面深化
- Sidebar / chat-head / input / composer 工具栏全面液态玻璃化
- `.ch-env` 胶囊适配各主题材质,消除死灰背景
- cwd 输入框 hover 展开 / blur 收窄交互

### 聊天头部视觉重设计
- 标题行 / 配置行 / tab 分层清晰,消除碎片感
- 流式期间上下抖动修复

### Git 面板增强
- 分支旁显示**本地/远程同步状态徽章**(↑ahead / ↓behind / synced)
- Git diff 视觉精致化(行号 / 背景色 / hunk header / 圆角)
- 图标统一为 Lucide 风格 inline SVG

### 设置界面精致化
- API Key 输入框加👁眼睛切换显示/隐藏
- 消灭 inline style 毛胚感
- 设置面板 tab / engine 下拉全部 4 语言化

### 频道管理
- 侧栏频道显示时间 + **按最近活动排序**
- 「只看运行中」筛选按钮 — 快速定位工作中的频道
- 长对话渲染分批 + 流式增量更新,消除切频道空白

---

## 🌍 国际化

- **全面 4 语言**(简中 / 英文 / 繁中 / 日语)
- 设置面板、替身面板、Team 面板、语音配置、同步徽章 — 所有硬编码中文全部替换为 `tr()` i18n
- 同步徽章文案四语言统一缩短

---

## 🛠️ 重要 Bug 修复

### 引擎核心
- **V1 AgentLoop reactive trim 第二级缺 `continue`**:上下文超长时任务直接崩溃退出(致命)
- **V1 第一级 trim 预算从 15K 降到 7.5K**:比原版更激进,提前触发崩溃路径
- **DirectV2**:Planner API 错误静默吞掉 / 长期记忆在步骤执行时丢失 / Judge JSON 解析 / autoVerify 跨会话泄漏 / maxTurns 截断被静默当作步骤完成 / replan 断裂 / 退化模式缺写工具
- **dispatch_agent**:子任务缺少独立超时,API/CLI hang 时永久卡住
- **更新时间**:updatedAt 在所有事件路径都持久化到数据库

### 语音模块
- WebSocket binaryType='arraybuffer' 导致消息解析失败
- InvalidSpeaker 错误 — 音色 ID 不存在
- 1006 连接被拒 — 重写 VoiceChat 二进制协议
- Agent 回复不再自动语音朗读(仅显示文字)

### 记忆模块
- 去重算法从 Jaccard 换为 textSimilarity(规范化 + 包含检测 + Jaccard)
- 无 embedding 接口时也能正常工作
- 旧 DB 表缺失崩溃修复
- 去重/衰减按钮反馈不可见修复

---

## 🔌 插件生态

- **arduino-dev**:Arduino/ESP32 硬件开发(编译 / 烧录 / 串口监控 / 库管理)
- **serial-comm**:串口/设备通信调试
- **platformio**:PlatformIO 项目管理
- **hardware-tier1 + tier2**:7 个硬件插件,25 个工具,11 个 slash 命令
- **MiniMax H3 文生视频**:text-to-video 工具集成

---

## 📊 数据

| 维度 | 数值 |
|------|------|
| Commits | 133 |
| 新特性 | 30+ |
| Bug 修复 | 40+ |
| 支持语言 | 4(zh / en / zh-TW / ja) |
| 引擎数量 | 4(Direct / DirectV2 / Claude Code / Codex) |

---

**Upgrade from v1.6.0**: 直接覆盖安装,SQLite schema 自动迁移,无需手动操作。
