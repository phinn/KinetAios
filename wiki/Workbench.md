> 🌐 Language: **English** | [中文](Workbench.zh-CN.md)

# Workbench (project card overview)

Sidebar **📂** button → Workbench view.

## What it is

A "project card" overview grouped by cwd. Each cwd = one card. Each card shows:

- **cwd path** (top)
- **Recent activity** (titles + timestamps of the last few turns)
- **Cumulative cost** (USD)
- **Cumulative tokens** (in/out)

Click a card → switch to that cwd's most recent session (creates one if none).

## Actions

| Button | Effect |
|---|---|
| Card body (click) | Switch to that cwd's latest session |
| "Context" button | Edit that cwd's `KINET-CONTEXT.md` (see [[Rules-and-Context]]) |
| "New session" button | Start a new session in that cwd |

## Data source

`api.getConversations()` pulls all sessions → groups by `conv.cwd` → one group per cwd → computes the cwd's total cost/tokens/recent activity.

There's no "project" entity persisted; everything derives from sessions. Starting a session with a new cwd → Workbench automatically gains a card.

## Usage

- **Multi-project parallel**: see each project's cumulative cost in Workbench, spot which hasn't been touched recently
- **Quick project switch**: no need to dig through the sidebar for the session, just click the card
- **Project-level context**: click "Context" to write `KINET-CONTEXT.md`, injected into every session under that cwd

## Difference from the sidebar

| | Sidebar session list | Workbench |
|---|---|---|
| Unit | Single session | cwd (may contain multiple sessions) |
| Default sort | Time descending | cwd alphabetical |
| Actions | Switch / delete / rename session | Switch cwd + edit context |
| View | Flat / grouped by project (`sb-mode-toggle`) | Always by cwd |

The sidebar's "group by project" mode (`▤` button) is a lightweight Workbench — shows grouping inside the sidebar only.

## Key source files

- `src/renderer/app.ts` — Workbench view rendering (grep `workbench`)
- `src/main/main.ts` — `read-context` / `write-context` IPC (read/write `KINET-CONTEXT.md`)
