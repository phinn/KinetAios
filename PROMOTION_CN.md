# KinetAios 推广计划 (2026-07-13)

> 针对刚发布的新项目，零基础快速获得关注的实战策略

---

## 🎯 第一周行动清单（立即执行）

### 1. 完成 GitHub 项目基础设置
- [ ] 添加项目描述（不能只是"KinetAios"）
- [ ] 添加主题标签 (Topics)：`ai-agent`, `electron`, `typescript`, `local-first`, `mcp`
- [ ] 启用 GitHub Discussions（社区讨论）
- [ ] 创建 GitHub Release v1.0.0（即使还在测试阶段）

### 2. 撰写推广文案
使用这个模板发布到多个平台（下见各社区具体文案）

**核心卖点（30 秒版本）**：
```
KinetAios：本地优先的 AI Agent 仪表板

✨ 关键特性：
- 跨平台：Windows 11 + macOS
- 多引擎：Direct (ReAct循环) / Claude Code / Codex 任意切换
- 本地化：SQLite 历史 + 长期记忆，完全离线运行
- 强大工具：Shell、文件、Git、搜索、MCP 集成
- 4 语言：English、简体中文、繁體中文、日本語

🔐 隐私第一 - 数据永不上云
📦 开源 GPL-3.0 - 完全透明

https://github.com/phinn/KinetAios
```

### 3. 创建首个发布公告
```bash
git tag -a v1.0.0 -m "Initial release: Multi-engine AI agent dashboard"
git push origin v1.0.0
```

然后在 GitHub 创建 Release，粘贴 CHANGELOG.md 内容

---

## 🌐 推广渠道（按优先级）

### 📍 T1：最高优先级（必做）

#### 1. **Product Hunt**（最大杠杆）
- **时机**：周二-周四 美国东部时间上午 10-11 点
- **链接**：https://www.producthunt.com
- **文案**：
```
🚀 KinetAios – Run AI Agents Locally on Your Machine

Cross-platform (Windows 11 + macOS) desktop app for running multiple AI sessions concurrently.
No cloud, no data sharing – everything stays on your computer.

✨ Features:
• Multi-engine support (Direct ReAct, Claude Code, Codex)
• 10+ built-in tools (shell, git, file ops, web fetch)
• MCP integration for extending capabilities
• Long-term memory with SQLite
• 4 languages (English, 中文, 繁體中文, 日本語)

🔗 GitHub: https://github.com/phinn/KinetAios
```

#### 2. **HackerNews**
- **时机**：周二-周四 10-14 点 (精确时间：10:30 或 13:30)
- **链接**：https://news.ycombinator.com/submit
- **标题**：
```
KinetAios – Local-first AI agent dashboard (Electron + TypeScript)
```
- **内容**：
```
We built a cross-platform desktop app to run AI agents locally without any cloud vendor lock-in.

Multi-engine support (Direct ReAct loop, Claude Code, Codex), 10+ tools, MCP integration, 
and SQLite-backed persistent memory. Completely open source (GPL-3.0).

Binaries for Windows 11 and macOS available. This is the Electron/TypeScript version; 
there's also a native SwiftUI version for macOS.

Looking for feedback on architecture and use cases!

GitHub: https://github.com/phinn/KinetAios
```

#### 3. **GitHub Trending**
- **无法直接提交** - 但通过以下方式自动进入 Trending：
  - 高星数增长（来自上面两个渠道的流量会推送）
  - 代码质量高（完整文档、测试、CI/CD）
  - 活跃开发（频繁提交与发布）

---

### 📍 T2：Reddit 社区（高曝光）

#### 1. **r/ChatGPT**
- **标题**：`I built a local-first AI dashboard where you can run multiple agents offline`
- **内容**：展示截图、强调**隐私** 和 **多引擎** 特性

#### 2. **r/LocalLLMs**
- **标题**：`KinetAios – Open source AI agent dashboard for Windows/macOS (no cloud required)`
- **重点**：本地运行、MCP 集成、支持多个 LLM provider

#### 3. **r/typescript**
- **标题**：`Built a desktop AI agent dashboard with vanilla TS + Electron (no frontend framework)`
- **重点**：技术栈、性能、开发经验分享

#### 4. **r/Electron**
- **标题**：`Electron + TypeScript desktop app: AI agent runtime with SQLite persistence`
- **重点**：跨平台、native module 集成、打包经验

---

### 📍 T3：中文社区（获得中文用户）

#### 1. **V2EX** (https://www.v2ex.com)
- **标题**：`[分享] KinetAios - 本地 AI Agent 仪表盘，Windows + macOS 跨平台`
- **节点**：#分享 或 #程序员
- **关键词**：本地、隐私、开源、AI、跨平台

#### 2. **少数派** (https://sspai.com)
- **投稿**：编写使用体验文章
- **标题示例**：`我用本地 AI Agent 写代码，完全不用上传文件到云`

#### 3. **牛客网** (https://www.nowcoder.com)
- **分类**：开源项目推荐
- **适合**：校招/实习生了解开源项目

#### 4. **GitHub 中文社区讨论区**
- **发帖**：在相关 issue/discussion 中提及（不要硬广）

---

### 📍 T4：长期内容营销

#### 1. **技术博客** (Dev.to, Medium, HashNode)
- **文章 1**：`How I Built a Local-First AI Agent Dashboard`
  - 架构决策、Electron 踩坑、SQLite 性能优化
  
- **文章 2**：`Multi-Engine AI Architecture: Direct vs Claude Code vs Codex`
  - 三种引擎对比、适用场景
  
- **文章 3**：`Building TypeScript/Electron Apps Without Frontend Frameworks`
  - 性能收益、代码组织、招聘 DevRel

#### 2. **YouTube / 小红书**
- 30 秒演示视频：多引擎切换、快速面板唤起
- 3 分钟教程：如何快速开始使用

#### 3. **推特/X**
- 发起话题：`#LocalFirst` `#AIAgent` `#Electron`
- 引用数据：`Built with 0 npm packages in the UI layer`

---

## 📊 衡量成功的指标

| 指标 | 目标 | 时间 |
|------|------|------|
| GitHub Stars | 100+ | 1 周内 |
| GitHub Stars | 500+ | 1 月内 |
| Forks | 20+ | 1 月内 |
| Issues | 10+ | 1 月内 |
| Discussion posts | 20+ | 1 月内 |
| 外部链接 | Product Hunt / HN 进前 100 | 1 周内 |

---

## 🎬 具体执行步骤

### **Day 1 (今天)**
- [ ] 确认所有 README、CHANGELOG、CONTRIBUTING 已完成
- [ ] 创建 GitHub Release v1.0.0
- [ ] 启用 Discussions、Projects
- [ ] 添加 Topics

### **Day 2**
- [ ] Product Hunt 投稿（务必在工作时间）
- [ ] HackerNews 投稿（精确时间）
- [ ] 推特宣布发布

### **Day 3-4**
- [ ] Reddit 四大社区逐个发帖
- [ ] 中文社区发帖（V2EX、少数派）
- [ ] 回复评论、回答问题

### **Day 5-7**
- [ ] 根据反馈改进文档
- [ ] 修复反馈的 bug
- [ ] 发布 v1.0.1 补丁版本
- [ ] 撰写第一篇技术博客

### **Week 2+**
- [ ] 每周持续发布技术内容
- [ ] 响应用户反馈和 issue
- [ ] 定期发布 YouTube 短视频
- [ ] 建立社区讨论热点

---

## 💡 提高获赞的技巧

### ✅ 做这些
- ✅ 展示实际用处（截图、GIF、视频演示）
- ✅ 坦白说明局限性（e.g. "Window close quits app, but we're working on tray mode"）
- ✅ 邀请反馈（"What features would you like to see?"）
- ✅ 跟进评论（首 24 小时要回复每条高赞评论）
- ✅ 强调独特性（"No backend required, runs 100% locally"）

### ❌ 不要做
- ❌ 过度吹嘘或夸大功能
- ❌ 多个社区复制粘贴同样的文案
- ❌ 发布后就不管（失去热度）
- ❌ 和其他项目对比贬低（反感）
- ❌ 频繁自我推销（被视为垃圾广告）

---

## 📧 媒体/博主联系（可选）

如果想加速传播：
- **IndieHackers** Newsletter 编辑
- **Dev.to** 编辑推荐
- **ProductHunt 社区版主** (Ship 计划)
- **relevant YouTube 频道**（AI dev tools）

---

## 💰 资源成本

- **钱**：0（都是免费平台）
- **时间**：初期 2-3 天密集工作 + 每周 2-3 小时维护
- **技能**：基本文案/社区运营经验

---

## 🎯 3 个月目标

| 阶段 | 目标 | 行动 |
|------|------|------|
| **第 1 月** | 500 stars | 大力推广 + 快速响应反馈 |
| **第 2 月** | 1000+ stars | 发布 v1.1（新功能）+ 技术文章 |
| **第 3 月** | 2000+ stars | IDE 插件预告 + 使用案例分享 |

---

**最重要的是**：第一周一定要推！错过这个黄金期，后续很难补救。

祝你推广成功 🚀
