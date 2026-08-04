# Agent Teams

> Multi-agent team collaboration — dispatch a team of named sub-agents that each have independent history, run in parallel, and report back.

## Overview

Agent Teams let the LLM (or the user manually) spin up a group of specialized sub-agents within a conversation. Each member has:

- **Independent history** — persisted to SQLite (`team_members.history`), carried across multi-round team interactions
- **Read-only tools** — `read_file`, `grep`, `glob`, `web_fetch`, `web_search`, `recall_memory`, `recall_fact` (same as `dispatch_agent`)
- **Real-time visualization** — token stream, tool calls, status changes, and final answer all show live in the Team tab

Teams are scoped per-conversation: each team lives under `conv:<convId>:team:<timestamp>` and is isolated from other sessions.

## Architecture

```
┌──────────────────────────────────────────────┐
│ Main Conversation (Direct / DirectV2 engine) │
│                                               │
│  LLM calls spawn_team → creates team_members  │
│  LLM calls team_broadcast → ──────────────┐   │
│  LLM calls team_send → ─────────────────┐ │   │
│                                          ▼ ▼   │
│  ┌──────────────────────────────────────────┐ │
│  │ teams.ts: runMember / runMembersParallel │ │
│  │  · Each member: AgentLoop + readOnlyTools│ │
│  │  · 3-min timeout per member              │ │
│  │  · Broadcast: Promise.allSettled (并行)  │ │
│  │  · TeamEvent → emitTeamEvent → renderer  │ │
│  └──────────────────────────────────────────┘ │
│                                               │
│  Results returned as text to main LLM loop   │
└──────────────────────────────────────────────┘
                    │ IPC
                    ▼
┌──────────────────────────────────────────────┐
│ Renderer: Team Tab                            │
│  · Member cards with live status dots        │
│  · Token streaming preview                   │
│  · Manual send/broadcast/create/delete       │
└──────────────────────────────────────────────┘
```

## LLM-Driven Usage (Tools)

The LLM autonomously manages teams through four built-in tools:

| Tool | Purpose |
|------|---------|
| `spawn_team` | Create a team with N named members |
| `team_broadcast` | Send one message to all members (runs in parallel) |
| `team_send` | Send a message to one specific member |
| `team_close` | Delete team and all member data |

### Example Flow

```
User: "审查这个项目的架构,从数据库、API、前端三个角度"

LLM:
  1. spawn_team({ members: [
       { name: "db-reviewer", role: "数据库架构评审" },
       { name: "api-reviewer", role: "API 设计评审" },
       { name: "fe-reviewer", role: "前端架构评审" }
     ] })
     → team_id: "conv:abc:team:xyz"

  2. team_broadcast({ team_id, message: "审查项目架构,各自从自己的角度分析" })
     → [all 3 members run in parallel]
     → ### db-reviewer (数据库架构评审)
       分析了 store.ts 的 schema...
     → ### api-reviewer (API 设计评审)
       分析了 IPC handler 结构...
     → ### fe-reviewer (前端架构评审)
       分析了 app.ts 的渲染逻辑...

  3. team_send({ team_id, member_name: "db-reviewer", message: "深入看下 FTS5 索引设计" })
     → 单 member 追问,带上之前的 history

  4. team_close({ team_id })
```

## Manual Usage (Team Tab)

The Team tab (👥) in the dashboard provides full manual control:

- **Create Team** — Click "新建", enter members as `name1:role1, name2:role2`
- **Send to Member** — Click 💬 on a member card to send a direct message
- **Broadcast** — Click 📢 to send a message to all members simultaneously
- **Delete Team** — Click 🗑 to remove a team and all its data
- **Refresh** — Click the refresh icon to reload team state from DB

### Real-Time Visualization

When members are running (whether triggered by LLM or manually):

- 🔵 Blue dot = running
- 🟢 Green dot = done
- 🔴 Red dot = failed
- ⚪ Gray dot = idle

Member cards show a live preview of the token stream and tool calls as they happen.

## Parallel Execution

`team_broadcast` runs all members concurrently using `Promise.allSettled`. Each member gets:

- An independent `AbortController` with a 3-minute timeout
- Its own `AgentLoop` instance with read-only tools
- Separate cost tracking (aggregated and reported as a single `cost` event)

`team_send` runs a single member — no parallelism needed.

## Data Model

```sql
CREATE TABLE team_members(
  team_id TEXT,          -- "conv:<convId>:team:<ts>"
  member_id TEXT,        -- = member name (unique within team)
  name TEXT,
  role TEXT,
  history TEXT,          -- JSON: ChatMsg[] serialized member history
  last_message TEXT,     -- most recent message sent to this member
  last_result TEXT,      -- most recent answer
  status TEXT,           -- 'idle' | 'running' | 'done' | 'failed'
  created_at REAL,
  updated_at REAL,
  PRIMARY KEY(team_id, member_id)
);
```

## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `team-list` | renderer → main | List all teams for a conversation |
| `team-create` | renderer → main | Create a new team |
| `team-delete` | renderer → main | Delete a team |
| `team-list-members` | renderer → main | List members of a team |
| `team-send-member` | renderer → main | Send message to one member |
| `team-broadcast` | renderer → main | Broadcast to all members |
| `team-event` | main → renderer | Real-time `TeamEvent` stream |

## Limitations (MVP)

- **Read-only tools only** — members cannot write files or run shell commands (by design, for safety)
- **No inter-member communication** — members can't message each other directly; use `recall_fact` for shared data
- **Per-conversation isolation** — teams don't persist across different conversations
- **Max 8 members per team** — prevents token explosion
- **3-minute timeout per member** — prevents hung API calls from blocking indefinitely
