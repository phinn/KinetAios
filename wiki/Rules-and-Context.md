> 🌐 Language: **English** | [中文](Rules-and-Context.zh-CN.md)

# Rules & Context

KinetAios auto-injects 4 kinds of "guidance material" into the agent's prompt. **Convention over configuration** — files at the cwd root are auto-read; no setting toggles needed.

## The 4 files

| File | Source | Who reads it | Injection point |
|---|---|---|---|
| `AGENTS.md` | cwd root | Direct engine auto-reads | systemPrompt concatenation |
| `CLAUDE.md` | cwd root | Direct engine auto-reads (fallback for AGENTS.md) | systemPrompt concatenation |
| `KINET.md` | cwd root, maintained via the app's "Rules" tab | All three engines inject | Direct: systemPrompt; Claude: `--append-system-prompt`; Codex: prompt head |
| `KINET-CONTEXT.md` | cwd root, maintained via Workbench card's "Context" button | All three engines inject | Same as KINET.md |

## AGENTS.md / CLAUDE.md (project rules, external-tool convention)

`src/main/engines.ts:54`:

```ts
function loadProjectRules(cwd: string): string {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      const body = fs.readFileSync(path.join(cwd, name), 'utf8');
      if (body.trim()) return `\n\n# Project rules (${name})\n${body.slice(0, 8000)}`;
    } catch { /* not present → try next */ }
  }
  return '';
}
```

- **Direct-only** (only `DirectEngine` calls `loadProjectRules`)
- Priority: `AGENTS.md` > `CLAUDE.md` (if both exist, only the first is read)
- Truncated at 8000 chars
- Good for: **team/tool convention hard rules** (code style, commit format, security limits)

Claude Code / Codex don't need this here because their respective CLIs already auto-load them (Claude Code auto-loads `CLAUDE.md`; Codex auto-loads `AGENTS.md`).

## KINET.md (project rules, app-maintained)

`src/main/engines.ts:68`:

```ts
export function loadRulesBlock(cwd: string): string {
  const body = fs.readFileSync(path.join(cwd, 'KINET.md'), 'utf8');
  return body.trim() ? `\n\n# Project rules (KINET.md)\n${body.slice(0, 8000)}` : '';
}
```

- **All three engines inject this**
- Loaded in `TaskManager.runTurn`, passed to engines via `EngineRunOpts.rulesBlock`
- Direct appends after `loadProjectRules`; Claude passes via `--append-system-prompt`; Codex prepends to the prompt
- Truncated at 8000

**Difference from AGENTS.md/CLAUDE.md**: the latter are external-tool conventions (work without KinetAios); KINET.md is written by this app's "Rules" tab and explicitly injected into CC/Codex.

### Editing: main window "Rules" tab

Main window → "Rules" tab:

- Top-left: title "Project rules (KINET.md)"
- Middle: `<textarea>` for editing
- Top-right: **⟳ Reload** (read from disk, overwrites textarea) / **Save** (writes to disk)
- Bottom status: current cwd / saved / unsaved / error

Switching cwd → reads the new cwd's `KINET.md` (empty if absent).

## KINET-CONTEXT.md (project background knowledge)

`src/main/engines.ts:80`:

```ts
export function loadContextBlock(cwd: string): string {
  const body = fs.readFileSync(path.join(cwd, 'KINET-CONTEXT.md'), 'utf8');
  return body.trim() ? `\n\n# Project context (KINET-CONTEXT.md)\n${body.slice(0, 12000)}` : '';
}
```

- **All three engines inject this**
- Truncated at **12000** (more than KINET.md — context is usually longer)
- Passed via `EngineRunOpts.contextBlock`

**Difference from KINET.md**:
- `KINET.md` = "rules you must follow" (code style, things not to do, security limits)
- `KINET-CONTEXT.md` = "facts about this project" (architecture, tech stack, key files, where conventions come from)

### Editing: Workbench card "Context" button

Sidebar 📂 → Workbench → find the card for the cwd → "Context" button → modal:

- Title: Project context (KINET-CONTEXT.md)
- Shows current cwd
- `<textarea>` for editing
- Save / Cancel

## Injection order (Direct)

`engines.ts:139` (`DirectEngine.run`) builds systemPrompt:

```
baseSystemPrompt              ← KinetAios built-in system (write-file rules, cwd hint, etc.)
  + skillSection              ← body of the /<name> skill the user invoked
  + loadProjectRules          ← AGENTS.md / CLAUDE.md (truncated 8000)
  + rulesBlock                ← KINET.md (truncated 8000)
  + contextBlock              ← KINET-CONTEXT.md (truncated 12000)
```

memoryBlock is **not here** (as of v1.0 it goes through history[0], see [[Long-Term-Memory]]).

## Injection order (Claude Code / Codex)

Don't read AGENTS.md/CLAUDE.md (their CLIs do that themselves).

In `engines.ts`'s CC/Codex.run:

```
append = (rulesBlock ?? '')    ← KINET.md
       + (contextBlock ?? '')  ← KINET-CONTEXT.md
       + memoryBlock;          ← long-term memory
```

- CC: `--append-system-prompt <append>`
- Codex: append + current prompt concatenated (`codex` has no `--append-system-prompt` flag)

## Recommended usage

| What you want to express | Where to write it |
|---|---|
| Code style / commit rules everyone on the team should follow | `AGENTS.md` (committed to team repo) |
| Personal hard constraints for this project (don't push main, must typecheck) | `KINET.md` (local, commit or not) |
| This project's architecture, tech stack, key files | `KINET-CONTEXT.md` |
| User long-term preferences (concise replies, Go backend dev) | Long-term memory (auto-extracted via 🧠, or hand-edit) |

## Examples

### KINET.md example

```markdown
- Must `npm run typecheck` before committing
- Don't push main, open a branch
- Reply in Chinese
- Use the write_file tool to write files, not shell heredoc
```

### KINET-CONTEXT.md example

```markdown
# Project structure
- src/main/* — main process (full Node access)
- src/renderer/* — renderer (no Node)
- src/shared/types.ts — single source of truth

# Tech stack
- Electron + TypeScript
- better-sqlite3 + FTS5
- vanilla TS + HTML/CSS, no frontend framework

# Key conventions
- KinetAPI is a three-layer contract — adding a method requires 3 synced edits
- All three engines emit the same AgentEvent union
```

## Key source files

- `src/main/engines.ts:54` — `loadProjectRules` (AGENTS/CLAUDE)
- `src/main/engines.ts:68` — `loadRulesBlock` (KINET.md)
- `src/main/engines.ts:80` — `loadContextBlock` (KINET-CONTEXT.md)
- `src/renderer/app.ts` — "Rules" tab logic
- `src/main/main.ts` — `read-rules` / `write-rules` / `read-context` / `write-context` IPC
