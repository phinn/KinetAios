# 规则与背景

KinetAios 把 4 种「指导材料」自动注入到 agent 的 prompt。**约定大于配置**——文件在 cwd 根,自动被读;不需要在 setting 里勾选。

## 4 种文件

| 文件 | 来源 | 谁读 | 注入位置 |
|---|---|---|---|
| `AGENTS.md` | cwd 根 | Direct 引擎自动读 | systemPrompt 拼接 |
| `CLAUDE.md` | cwd 根 | Direct 引擎自动读(作为 AGENTS.md 的 fallback) | systemPrompt 拼接 |
| `KINET.md` | cwd 根,app UI「规则」tab 维护 | 三套引擎都注入 | Direct:systemPrompt;Claude:`--append-system-prompt`;Codex:prompt 头 |
| `KINET-CONTEXT.md` | cwd 根,Workbench 卡片「背景」按钮维护 | 三套引擎都注入 | 同 KINET.md |

## AGENTS.md / CLAUDE.md(项目规则,外部工具约定)

`src/main/engines.ts:54`:

```ts
function loadProjectRules(cwd: string): string {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      const body = fs.readFileSync(path.join(cwd, name), 'utf8');
      if (body.trim()) return `\n\n# 项目规则(${name})\n${body.slice(0, 8000)}`;
    } catch { /* 不存在 → 试下一个 */ }
  }
  return '';
}
```

- **Direct 独享**(只有 DirectEngine 调 `loadProjectRules`)
- 优先级 `AGENTS.md` > `CLAUDE.md`(都有则只读前者)
- 截断 8000 字符
- 适合:**团队/工具约定的硬规则**(代码风格、commit 格式、安全限制)

Claude Code / Codex 不需要这里读,因为它们各自的 CLI 已经会读(走 Claude Code 的 `CLAUDE.md` 自动加载 / Codex 的 `AGENTS.md` 自动加载)。

## KINET.md(项目规则,app 维护)

`src/main/engines.ts:68`:

```ts
export function loadRulesBlock(cwd: string): string {
  const body = fs.readFileSync(path.join(cwd, 'KINET.md'), 'utf8');
  return body.trim() ? `\n\n# 项目规则(KINET.md)\n${body.slice(0, 8000)}` : '';
}
```

- **三套引擎都注入**
- 在 `TaskManager.runTurn` 里加载,通过 `EngineRunOpts.rulesBlock` 传给引擎
- Direct 跟在 `loadProjectRules` 后面;Claude 走 `--append-system-prompt`;Codex 拼到 prompt 头
- 截断 8000

**和 AGENTS.md/CLAUDE.md 区分**:后者是外部工具约定(直接读文件就能用,不依赖 KinetAios);前者是本 app 的「规则 tab」写的,要主动注入到 CC/Codex。

### 编辑:主窗口「规则」tab

主窗口 → 「规则」tab:

- 左上:标题「项目规则(KINET.md)」
- 中间:`<textarea>` 编辑内容
- 右上:**⟳ 重新加载**(从磁盘读,覆盖 textarea) / **保存**(写回磁盘)
- 底部状态栏:当前 cwd / 已保存 / 未保存 / 错误

切 cwd → 自动读新 cwd 的 `KINET.md`(空就显示空 textarea)。

## KINET-CONTEXT.md(项目背景知识)

`src/main/engines.ts:80`:

```ts
export function loadContextBlock(cwd: string): string {
  const body = fs.readFileSync(path.join(cwd, 'KINET-CONTEXT.md'), 'utf8');
  return body.trim() ? `\n\n# 项目背景(KINET-CONTEXT.md)\n${body.slice(0, 12000)}` : '';
}
```

- **三套引擎都注入**
- 截断 **12000**(比 KINET.md 多 —— 背景知识一般更长)
- 通过 `EngineRunOpts.contextBlock` 传

**和 KINET.md 区分**:
- `KINET.md` = 「必须遵守的规则」(代码风格、不能做的事、安全限制)
- `KINET-CONTEXT.md` = 「关于这个项目的事实」(架构、技术栈、关键文件、约定来源)

### 编辑:Workbench 卡片「背景」按钮

侧边栏 📂 → Workbench → 找到 cwd 对应的卡片 → 「背景」按钮 → 弹 modal:

- 标题:项目背景(KINET-CONTEXT.md)
- 显示当前 cwd
- `<textarea>` 编辑
- 保存 / 取消

## 注入顺序(Direct)

`engines.ts:139`(`DirectEngine.run`)拼 systemPrompt:

```
baseSystemPrompt              ← KinetAios 内置 system(写文件规则、cwd 提示等)
  + skillSection              ← 用户用 /<name> 调用的 skill body
  + loadProjectRules          ← AGENTS.md / CLAUDE.md(截断 8000)
  + rulesBlock                ← KINET.md(截断 8000)
  + contextBlock              ← KINET-CONTEXT.md(截断 12000)
```

memoryBlock **不在这里**(从 v1.0 起走 history[0],见 [[Long-Term-Memory]])。

## 注入顺序(Claude Code / Codex)

不读 AGENTS.md/CLAUDE.md(它们各自 CLI 自己读)。

`engines.ts` 的 CC/Codex.run:

```
append = (rulesBlock ?? '')    ← KINET.md
       + (contextBlock ?? '')  ← KINET-CONTEXT.md
       + memoryBlock;          ← 长期记忆
```

- CC:`--append-system-prompt <append>`
- Codex:append + 当前 prompt 拼接(`codex` 没 `--append-system-prompt` flag)

## 推荐怎么用

| 你想表达 | 写哪里 |
|---|---|
| 团队所有人都该遵守的代码风格、commit 规则 | `AGENTS.md`(团队 repo 入库) |
| 个人对该项目的硬性约束(不许 push main、必须 typecheck 过) | `KINET.md`(本地,不入库或入库都行) |
| 这个项目的架构、技术栈、关键文件 | `KINET-CONTEXT.md` |
| 用户长期偏好(我爱简洁回复、Go 后端) | 长期记忆(🧠 自动抽,或手动改) |

## 例子

### KINET.md 例子

```markdown
- 提交前必须 `npm run typecheck`
- 不许 push main,开分支
- 回复用中文
- 写文件用 write_file 工具,不要 shell heredoc
```

### KINET-CONTEXT.md 例子

```markdown
# 项目结构
- src/main/* —— 主进程(Node 全访问)
- src/renderer/* —— 渲染进程(无 Node)
- src/shared/types.ts —— 单一真理源

# 技术栈
- Electron + TypeScript
- better-sqlite3 + FTS5
- vanilla TS + HTML/CSS,无前端框架

# 关键约定
- KinetAPI 是三层契约,加方法要同步改 3 处
- 三引擎统一发 AgentEvent
```

## 关键源文件

- `src/main/engines.ts:54` —— `loadProjectRules`(AGENTS/CLAUDE)
- `src/main/engines.ts:68` —— `loadRulesBlock`(KINET.md)
- `src/main/engines.ts:80` —— `loadContextBlock`(KINET-CONTEXT.md)
- `src/renderer/app.ts` —— 「规则」tab 逻辑
- `src/main/main.ts` —— `read-rules` / `write-rules` / `read-context` / `write-context` IPC
