> 🌐 Language: **English** | [中文](Long-Term-Memory.zh-CN.md)

# Long-Term Memory

KinetAios auto-extracts "durable facts about the user" from each turn, stores them in SQLite, and injects them into the next turn's prompt. **Cross-engine, cross-session.**

## Flow

```
turn N completes
  ↓
extractMemories(): calls LLM once, extracts durable facts from this turn
  ↓
inserts into the memories table (SQLite)
  ↓
turn N+1 starts
  ↓
memoryBlock(): recall-based injection (embedding cosine → FTS5 → recent-N)
  ↓
Direct: as the history[0] user message (_memory marker)
Claude Code: --append-system-prompt
Codex: prepended to the prompt
```

Runs in the background; does not block user input.

## Extraction (`extractMemories`)

Around `src/main/TaskManager.ts:282`. Triggered on each `done` event:

- Take this turn's user prompt + assistant answer
- Call LLM with a small standalone prompt (does NOT enter directHistory)
- The prompt guides the model: only extract "durable facts about the user" — preferences, skills, long-term goals, fixed constraints. **Not one-off task details** ("write me a demo this time" doesn't count).
- Each returned fact is inserted separately into the `memories` table

**Uses the current session's model** (same engine, same model). GLM extracts via GLM, Claude via Claude.

## Storage (SQLite)

`src/main/store.ts`:

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  conversation_id TEXT,           -- the session that extracted this; NULL = global
  created_at INTEGER NOT NULL
);
```

Each memory carries its source session (for "current channel" filtering).

## Injection (`memoryBlock`)

`src/main/TaskManager.ts:443`:

Since v1.9.0, memoryBlock uses **recall-based injection** instead of full-set injection:

```
memoryBlock(conv)
  → build query from last 1-3 user messages (≤500 chars)
  → recallForInjection(query):
      1. embedding cosine (score > 0.25, top-15, ≥3 hits) → touchMemoryUsed
      2. FTS5 LIKE over memories table (≥2 hits)
      3. recent-N fallback (newest 15)
  → shellSafeMemory filter → inject as "## About the user" block
```

**Why recall instead of full-set**: with hundreds/thousands of memories, injecting all of them wastes tokens and dilutes relevance. The recall pipeline selects the 15 most semantically relevant memories for the current conversation — ~500 tokens instead of ~2000.

## Direct engine special handling (v1.0 refactor)

memoryBlock is **not concatenated into systemPrompt** — it goes in as the history[0] user message (marked `_memory: true`). Reasoning:

- Anthropic's `cache_control` is set on the entire system
- When memory is in system, every memory change (a new fact extracted) busts the entire base+rules+context system cache
- Splitting it out keeps system stable across turns, so the cache hits
- Memory invalidation only affects that one small message

trim / compact always preserve `_memory` messages; on return, `dropTransient` filters them out and **does not write back to `directHistory`** (re-injected fresh next turn, prevents stale accumulation).

See [[Direct-Engine]].

## 🧠 panel

Sidebar **🧠** button → long-term memory panel:

| Action | Effect |
|---|---|
| Scope toggle: Current channel / All | Filter by source conversation_id |
| Inline edit | Edit content directly, save to DB |
| Delete | Remove a single entry, with confirmation |

A main-window modal, not full-screen.

## Import / export

⚙ → Long-term memory:

- **Export JSON** — writes to a user-chosen path. Structure: `{ version: 1, exportedAt: number, memories: Memory[] }`
- **Import JSON** — accepts the above structure **or** a plain `string[]`. **Dedupes by content**, skips existing. Returns `{ imported: N, skipped: N }`.

Good for: machine migration, backup, sharing memories across providers.

## recall_memory tool vs long-term memory

Don't confuse them:

| | `recall_memory` tool | Long-term memory |
|---|---|---|
| Source | `history` table (FTS5-indexed conversation text) + `memories` table (embedding cosine) | `memories` table (recall-based injection) |
| Trigger | Model invokes explicitly | Auto-injected every turn (top-15 by relevance) |
| Use case | "How did we solve X last time?" | "Who is this user, what do they like" |
| Volume | Every conversation | Only durable facts |

`recall_memory` details: [[Tools-and-MCP]].

## Known limitations

- **Extracts every turn**: one extra LLM call per turn (doubles cost, though small)
- **What gets extracted depends on the model**: occasionally captures one-off details ("user asked about X") → use the 🧠 panel to delete manually
- **Embedding coverage**: embeddings only cover the `memories` table (facts); the `history` table (conversation text) still uses FTS5 keyword search for `recall_memory`. Full semantic recall over history is a roadmap item.
- **No cross-language unification**: Chinese extracts Chinese, English extracts English, no translation

Roadmap in `IMPROVEMENTS.md`.
