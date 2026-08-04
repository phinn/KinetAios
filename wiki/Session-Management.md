> 🌐 Language: **English** | [中文](Session-Management.zh-CN.md)

# Session Management

Advanced session operations: **branching**, **export/import for handoff**, **cross-session references**, and the **task graph**.

## Branching

Right-click any turn in a conversation → **Branch from here**. This deep-copies all turns and steps up to that point into a new session, creating a fork.

- The new session inherits the same engine, model, cwd, and `directHistory`.
- The original session is unaffected.
- Useful for exploring alternative approaches without losing the original thread.

```ts
// TaskManager
branchFrom(convId: string, turnId: string): string  // returns new convId
```

## Export / Import (session handoff)

Serialize a full session state for cross-machine handoff (via [[MCP-Server]] or manual JSON).

**Export** produces:

```json
{
  "version": 1,
  "conv": {
    "engine": "direct",
    "model": "glm-4.6",
    "cwd": "/home/user/project",
    "turns": [...],
    "directHistory": [...],
    "engineSessionId": "...",
    "cost": 0.03,
    "tokens": 15000
  },
  "exportedAt": 1234567890
}
```

**Security**: API keys, secrets, and tokens in `directHistory` are auto-redacted to `[REDACTED]` before serialization (regex patterns: `sk-...`, `api_key=...`, etc.).

**Import** validates:
- Message roles must be in the whitelist: `system`, `user`, `assistant`, `tool`.
- Content types checked (string or ContentPart[]).
- Length limits: max 500 messages, max 50K chars per message.
- `engine`, `model`, `cwd` validated as non-empty strings.

## Cross-session references

Sessions can be linked to show dependencies (e.g., "session B was branched from session A"). The **task graph** renders these as a DAG (Directed Acyclic Graph):

- **Nodes**: sessions (labeled by title or first prompt).
- **Edges**: branch relationships, pipeline stage links.
- Interactive: click a node to open that session.

## Task graph

Visualized as a DAG showing all sessions and their relationships:

| Edge type | Meaning |
|---|---|
| Branch | Session was forked from another |
| Pipeline | Session is a stage in a pipeline |
| Reference | Manual cross-session link |

Accessed programmatically via `TaskManager.taskGraph()` → returns `{ nodes: TaskGraphNode[], edges: TaskGraphEdge[] }`.

## Sidebar sorting & activity timestamps

Each session has an `updatedAt` timestamp, automatically updated on:

- **User sends a message**
- **Engine events** arrive (token / tool / done / error)
- **/goal command** execution

The sidebar defaults to sorting by `updatedAt` descending (most recent first). The **🕐** button at the sidebar footer toggles back to creation order.

Each channel shows a relative time on the right:

| Elapsed | Display |
|---|---|
| < 1 min | `just now` |
| < 1 hr | `Nm ago` |
| < 1 day | `Nh ago` |
| 1–2 days | `yesterday` |
| 2–7 days | `Nd ago` |
| 7 days–1 yr | `MM-DD` |
| > 1 yr | `YYYY-MM-DD` |

Hover shows the full date-time.

Old sessions without `updatedAt` fall back to `createdAt`.

## Key source files

- `src/main/TaskManager.ts` — `branchFrom`, `exportSession`, `importSession`, `taskGraph`
- `src/main/mcp-server.ts` — remote `export_session` / `import_session` tools
- `src/shared/types.ts` — `TaskGraphNode`, `TaskGraphEdge`
- `src/main/store.ts` — `branch_info`, `pipeline_id`, `updated_at` columns on `conversations`
