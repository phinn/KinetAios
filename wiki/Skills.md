> 🌐 Language: **English** | [中文](Skills.zh-CN.md)

# Skills / Commands / Agents

The Direct engine supports invocable skills / commands / agents. Scanned from local Claude Code / Codex installs; invoked via the `/` menu or the ⚡ button.

## Sources

`src/main/skills.ts` scans:

| Path | Source | Type |
|---|---|---|
| `<resources>/skills/*` (packaged) or `skills/*` (dev) | **Built-in** (read-only) | skill |
| `~/.claude/skills/*` | Claude Code user skills | skill |
| `~/.claude/commands/*` | Claude Code user commands | command |
| `~/.claude/agents/*` | Claude Code user agents | agent |
| Claude Code plugins | Installed plugin content (`~/.claude/plugins/*`) | various |
| `~/.codex/skills/*` | Codex skills | skill |
| Installed KinetAios plugins | Plugin-contributed (read-only) | various |

Each skill is a directory with a `SKILL.md` (frontmatter: `name` / `description`).

**Built-in skills** ship with the app (v3.7.3+). The first one, `data-analysis`, ports the V3 analysis discipline: schema before conclusions, compute via tools not mental math, intermediate results on disk, sourced conclusions, cross-checked key figures. Invoke it via `/data-analysis`, or let V3 auto-load it when data files appear in the task.

## Invocation

### `/` menu (input box)

Type `/` as the first character in the main window's input → slash menu pops up listing all available skills / commands / agents. Navigate with arrow keys + Enter, or click.

After selecting:
- The skill's body (`SKILL.md` content) is injected into the systemPrompt's `skillSection` for the next turn
- The input auto-fills `/skill-name`; the user adds arguments + Enter

### ⚡ button

The main window's **⚡ Skill** button → opens the same menu, mouse-friendly entry.

## Injection

`EngineRunOpts.skillBlock?: string` — Direct only.

`engines.ts:131`:

```ts
const skillSection = skillBlock ? `\n\n# Current Skill directive (user invoked via /, please follow)\n${skillBlock}` : '';
```

Concatenated into `systemPrompt` (after baseSystemPrompt, before rules).

**Direct-only**. Claude Code / Codex skills go through their respective CLI's `/` mechanism (not injected here).

## Trigger timing

A skill's body is only injected on the turn the user invokes `/skill-name`. Not persisted to subsequent turns (unless invoked again).

## Skills panel (Settings → Skills, v3.7.2+)

Aggregates every skill/command/agent from all sources (Claude Code / Codex / built-in / plugins) into one searchable panel. User-level skills are **editable in-app** (opens the source file in an editor modal); plugin and built-in skills are read-only. Changes take effect immediately — no restart.

## Adding a new skill

Add a directory in Claude Code's or Codex's standard location:

```
~/.claude/skills/my-skill/
  SKILL.md    # frontmatter: name, description; body: instructions
```

Restart KinetAios → it's scanned → `/my-skill` is available.

## Key source files

- `src/main/skills.ts` — scanning logic
- `src/shared/types.ts:51` — `SkillInfo` / `SkillType`
- `src/renderer/app.ts` — slash menu + ⚡ button rendering
- `src/main/main.ts` — `list-skills` IPC
