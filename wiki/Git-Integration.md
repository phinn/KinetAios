> 🌐 Language: **English** | [中文](Git-Integration.zh-CN.md)

# Git Integration

Main window "Git" tab. Two columns: left changes (working tree), right history (default) / diff (after clicking a file or commit).

## Layout

```
┌────────────────────────────────────────────────────────────┐
│ .git-head                                                  │
│ 🌿 <branch> · N changes        [⟳ refresh]                 │
├──────────────────────┬─────────────────────────────────────┤
│                      │                                     │
│ .git-changes         │ .git-side                           │
│ Changes (working     │ ├─ Default: History (commit log)    │
│ tree)                │ └─ Click file/commit: diff (with ←) │
│                      │                                     │
│ M  modified src/x.ts │  abc123  2026-07-12  fix: ...   me  │
│ A  added   README.md │  def456  2026-07-11  feat: ...   me  │
│ ?? untracked foo.txt │                                     │
│                      │                                     │
└──────────────────────┴─────────────────────────────────────┘
```

## Data source

`api.gitSnapshot(cwd)` (`src/shared/types.ts:160`) returns `GitSnapshot`:

```ts
{
  ok: boolean;
  branch?: string;          // current branch name
  changes?: GitChange[];    // parsed from `git status --short`
  log?: GitCommit[];        // from `git log --pretty=format:...`
  error?: string;
}
```

`GitChange`: `{ path, code, staged }` (`code` is a single char `M/A/D/R/?/!`…).

The main process spawns `git` directly (using `tools.ts`'s spawn logic but outside the Direct tool chain — this is for the renderer tab).

## Left column: changes

Parsed from `git status --short`. One row per file:

- **code** (single char + color): M (modified) / A (added) / D (deleted) / R (renamed) / ?? (untracked) / ! (ignored), etc.
- **label** (i18n): "Modified / Added / Deleted / Renamed / Untracked"
- **path**: relative to cwd

**Click a row** → `showGitDiff({ file: path })` → right column switches to diff view.

## Right column: history (default)

From `git log -20 --pretty=format:"%h|%cd|%s|%an"`. Each entry:

- **hash** first 7 chars (monospace)
- **date** (`%cd`, short format)
- **subject** (`%s`, commit message first line)
- **author** (`%an`)

**Click a row** → `showGitDiff({ hash })` → right column switches to commit show.

## Right column: diff view

Two render modes:

### File diff (side-by-side)

`renderSideBySide` (`src/renderer/app.ts:456`) — parses unified diff into aligned "left old / right new" rows.

- Consecutive `-` and `+` lines in the same hunk are paired (aligned pair by pair)
- Overflow padded with blank rows
- No token-level diff (visually sufficient; ponytail: word-level diff can be added later)

Visual: left deleted lines red, right added lines green, common lines grey.

### Commit show (unified)

`colorGitDiff` (`src/renderer/app.ts:426`) — colorizes git show's unified format line by line.

- The diff body only starts at the first `diff --git` line (so a `- list item` in the commit message isn't mistaken for a deleted line)
- Meta (commit metadata + message) displayed separately
- `+` green, `-` red, `@@` hunk header blue, `+++`/`---` filename blue

### Back to history

The diff view has a **← History** button at the top to return to the history list.

## State machine after clicking file / commit

`gitState` (`src/renderer/app.ts:36`):

```ts
{
  snapshot?: GitSnapshot;                       // last fetched snapshot
  view: { kind: 'history' }                     // default
      | { kind: 'diff'; title: string; contentHTML: string };
  lastCwd: string;                              // last cwd fetched (refetch on change)
}
```

- Switch cwd / manual refresh → reset view to history + refetch snapshot
- Click file / commit → view switches to diff, a "…" placeholder renders first, then async-loads the real diff

## Refresh

The **⟳** button on the right of `.git-head` → refetches snapshot.

Switching sessions (different cwd) → auto-refetch. Tab switching away and back → uses the existing snapshot (no refetch).

## Limitations

- **Read-only**: you can't stage / commit / push here. To operate on git → ask the agent to use the `shell` tool in chat, or open the Files window to use system git GUI
- **No submodule / worktree view**: only the current repo root
- **commit log is capped at 20**: edit the main process `git log -20` number to see more
- **Diff doesn't support binaries**: image changes, audio changes, etc. just show "Binary files differ"

## Key source files

- `src/renderer/app.ts:329` — `refreshGit`
- `src/renderer/app.ts:345` — `renderGit` (column rendering + event binding)
- `src/renderer/app.ts:405` — `showGitDiff`
- `src/renderer/app.ts:426` — `colorGitDiff` (commit show)
- `src/renderer/app.ts:456` — `renderSideBySide` (file diff)
- `src/main/main.ts` — `git-snapshot` / `git-diff` IPC handlers
- `src/renderer/index.html` (inline) — `#chat-git-pane`
