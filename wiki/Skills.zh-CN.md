> 🌐 Language: [English](Skills) | **中文**

# Skills / Commands / Agents

Direct 引擎支持「可调用的 skill / command / agent」。从本机的 Claude Code / Codex 安装扫到,通过 `/` 菜单或 ⚡ 按钮调用。

## 来源

`src/main/skills.ts` 扫:

| 路径 | 来源 | 类型 |
|---|---|---|
| `~/.claude/skills/*` | Claude Code 的 user skills | skill |
| `~/.claude/commands/*` | Claude Code 的 user commands | command |
| `~/.claude/agents/*` | Claude Code 的 user agents | agent |
| Claude Code plugins | 已安装 plugin 的内容(`~/.claude/plugins/*`) | 各种 |
| `~/.codex/skills/*` | Codex skills | skill |

每个 skill 是一个目录,带 `SKILL.md`(frontmatter:`name` / `description`)。

## 调用方式

### `/` 菜单(输入框)

主窗口底部输入框第一个字符打 `/` → 弹出 slash 菜单,列出所有可用 skill / command / agent。键盘上下选 + Enter 选中,或鼠标点。

选中后:
- skill 的 body(`SKILL.md` 内容)会在下一轮注入到 systemPrompt 的 `skillSection`
- 输入框自动填好 `/skill-name`,用户继续输参数 + Enter

### ⚡ 按钮

主窗口底部 **⚡ Skill** 按钮 → 弹同一个菜单,鼠标用户的入口。

## 注入

`EngineRunOpts.skillBlock?: string` —— Direct only。

`engines.ts:131`:

```ts
const skillSection = skillBlock ? `\n\n# 当前 Skill 指令(用户通过 / 调用,请遵循)\n${skillBlock}` : '';
```

拼到 `systemPrompt`(在 baseSystemPrompt 后、规则前)。

**只 Direct 引擎支持**。Claude Code / Codex 的 skill 各自走 CLI 自家的 `/` 机制(不在这里注入)。

## 触发时机

skill 的 body 只在用户**这一轮**调用 `/skill-name` 时注入。下一轮不持续(除非又调一次)。

## 列表

`api.listSkills()` → `SkillInfo[]`:

```ts
{
  name: string;        // 调用名(用于 /name)
  description: string; // SKILL.md frontmatter 的 description
  source: 'claude' | 'codex';
  type: 'skill' | 'command' | 'agent';
}
```

主窗口 ⚡ 按钮点开就是这个列表(只读,不能在 app 里编辑)。

## 加新 skill

在 Claude Code 或 Codex 的标准位置加目录:

```
~/.claude/skills/my-skill/
  SKILL.md    # frontmatter: name, description; body: 指令
```

重启 KinetAios → 扫到 → `/my-skill` 可用。

## 关键源文件

- `src/main/skills.ts` —— 扫描逻辑
- `src/shared/types.ts:51` —— `SkillInfo` / `SkillType`
- `src/renderer/app.ts` —— slash menu + ⚡ 按钮渲染
- `src/main/main.ts` —— `list-skills` IPC
