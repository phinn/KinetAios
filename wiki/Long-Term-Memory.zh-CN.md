> 🌐 Language: [English](Long-Term-Memory) | **中文**

# 长期记忆

KinetAios 自动从每轮对话抽取「关于用户的持久事实」,存进 SQLite,下一轮注入到 prompt。**跨引擎、跨会话**。

## 流程

```
turn N 完成
  ↓
extractMemories():调一次 LLM,从本轮对话抽「持久事实」
  ↓
存进 memories 表(SQLite)
  ↓
turn N+1 开始
  ↓
memoryBlock() 把所有 memories 拼成一段
  ↓
Direct:作为 history[0] 的 user 消息(_memory 标记)
Claude Code:--append-system-prompt
Codex:拼到 prompt 头
```

后台异步跑,不阻塞用户继续输入。

## 抽取(`extractMemories`)

`src/main/TaskManager.ts:282` 附近。每个 done 事件触发:

- 取本轮 user prompt + assistant answer
- 调 LLM(`extractMemories` 自己一个独立的小 prompt,不进 directHistory)
- prompt 引导模型:只抽「**关于用户的持久事实**」—— 喜好、技能、长期目标、固定约束。**不抽一次性任务细节**(「这次帮我写个 demo」不算)。
- 返回的每条 fact 单独 INSERT 进 `memories` 表

**用的是当前会话的模型**(同 engine、同 model)。所以 GLM 抽 GLM 的、Claude 抽 Claude 的。

## 存储(SQLite)

`src/main/store.ts`:

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  conversation_id TEXT,           -- 抽出这条记忆的会话;NULL = 全局
  created_at INTEGER NOT NULL
);
```

每条记忆有源会话(供「当前频道」过滤)。

## 注入(`memoryBlock`)

`src/main/TaskManager.ts:267`:

```ts
const mems = store.loadMemories().map(m => shellSafeMemory(m.content));
return '\n\n## 关于用户(长期记忆,回答时参考)\n' + mems.map(m => `- ${m}`).join('\n');
```

**所有记忆都注入**(每轮都全量,不分对话主题)。reasoning:跨主题的用户事实(「用户是 Go 后端」、「用户偏好简洁回复」)对每个任务都有用。

## Direct 引擎的特殊处理(v1.0 重构)

memoryBlock **不拼进 systemPrompt**,而是作为 history[0] 的 user 消息(带 `_memory: true` 标记)。理由:

- Anthropic 的 `cache_control` 标在整个 system 上
- memory 拼进 system 时,记忆每变一次(抽取新 fact)就打穿整个 base+rules+context 系统缓存
- 拆出来后,system 跨轮稳定,缓存命中
- 记忆失效只影响那条小消息(本就少量 token)

trim / compact 时永远保留 `_memory` 消息;return 时 `dropTransient` 过滤掉、**不写回 `directHistory`**(下一轮重新注入,防陈旧堆叠)。

详见 [[Direct-Engine]]。

## 🧠 面板

侧边栏 **🧠** 按钮 → 长期记忆面板:

| 操作 | 效果 |
|---|---|
| scope 切换:当前频道 / 全部 | 按源 conversation_id 过滤 |
| 行内编辑 | 直接改 content,save 进 DB |
| 删除 | 单条删,确认弹窗 |

主窗口 modal,不全屏。

## 导入 / 导出

⚙ → 长期记忆:

- **导出 JSON** —— 写到用户选的路径。结构:`{ version: 1, exportedAt: number, memories: Memory[] }`
- **导入 JSON** —— 接受上面结构 **或** 纯 `string[]`。**按 content 去重**,已存在的跳过。返回 `{ imported: N, skipped: N }`。

适合:换机器迁移、备份、不同 provider 共享同一份记忆。

## recall_memory 工具 vs 长期记忆

不要混淆:

| | `recall_memory` 工具 | 长期记忆 |
|---|---|---|
| 来源 | `history` 表(FTS5 索引的对话原文) | `memories` 表(抽取出的 fact) |
| 触发 | 模型主动调 | 每轮自动注入 |
| 用途 | 「我们之前怎么解决 X 的?」 | 「这个用户是谁、喜欢什么」 |
| 数据量 | 所有对话 | 只挑持久事实 |

`recall_memory` 详见 [[Tools-and-MCP]]。

## 已知限制

- **每轮都抽**:每个 turn 多一次 LLM 调用(成本翻倍,虽然小)
- **抽什么靠模型判断**:偶尔会抽出一次性细节(「用户问过 X」)→ 用 🧠 面板手动删
- **全量注入**:记忆多到几百条时 prompt 会膨胀(目前没自动筛选/裁剪)
- **跨语言不统一**:中文抽中文、英文抽英文,不翻译

后续 roadmap 见 `IMPROVEMENTS.md`。
