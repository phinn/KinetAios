> 🌐 Language: **English** | [中文](Direct-Engine.zh-CN.md)

# Direct Engine

The built-in ReAct loop. `src/main/AgentLoop.ts` is the core, paired with `src/main/glm.ts` (provider) and `src/main/tools.ts` (tools).

## Core loop

`runAgentLoop(opts)` (`AgentLoop.ts:23`):

```
messages = [system, ...memMsg?, ...history, userInput]
loop:
  1. provider.streamComplete(messages, tools)
  2. push assistant response
  3. no tool_calls → done, return
  4. run tools (runToolBatch), push tool results
  5. go to 1
```

**Default `maxTurns = ∞`** (`AgentLoop.ts:26`). A non-converging model (keeps calling tools) keeps consuming tokens until the user hits stop. Used to be 50; changed to ∞ so complex tasks aren't cut off mid-flight.

## System prompt assembly

`DirectEngine.run` (`engines.ts:91`) builds `systemPrompt`:

```
baseSystemPrompt
  + skillSection (skill body the user invoked via /)
  + loadProjectRules (AGENTS.md / CLAUDE.md)
  + rulesBlock (KINET.md, app-maintained)
  + contextBlock (KINET-CONTEXT.md)
```

**Note: memoryBlock is NOT in systemPrompt**. As of v1.0 it goes through `history[0]` instead (see below).

## memoryBlock via history[0] (important)

The long-term memory block is injected as a user message at the head of history, marked with `_memory: true`. Reasoning:

- Anthropic's `cache_control` is set on the whole system. When memory is in system, every memory change busts the entire base+rules+context system cache.
- Splitting it out keeps system stable across turns, so the cache hits; memory only invalidates when memory itself changes (a small amount of tokens anyway).

Code:
- `AgentLoop.ts:36-39` — `memMsg` only exists in the current turn's `messages`
- `dropTransient` (`AgentLoop.ts:98`) — filters system + `_memory` on return; **does not write back to `directHistory`** (otherwise it'd pile up across turns and go stale)
- `trimHistoryToTokenBudget` (`AgentLoop.ts:131`) — `_memory` messages are always preserved, never trimmed
- `compactHistory` (`AgentLoop.ts:158`) — `_memory` is excluded from head summarization
- `glm.ts` OpenAI provider strips `_memory` before serialization (so the marker doesn't hit the API); Anthropic provider merges consecutive user messages (satisfies strict alternation)

See [[Long-Term-Memory]].

## Tool call execution

`runToolBatch` (`AgentLoop.ts:197`):

- **Consecutive read-only tools run in parallel** (read_file / grep / glob / web_fetch / recall_memory / git_diff / dispatch_agent) — `Promise.all`
- **Write tools run serially** (shell / write_file / edit_file) — prevents races
- Results backfill in original `toolCalls` order (`tool_call_id` matching)
- On abort, a "[stopped]" placeholder fills in to keep pairs valid (OpenAI and Anthropic both reject orphan tool messages)
- UI gets the full original; model gets a truncated version (see below)

## Long tool result truncation

`truncateForModel` (`AgentLoop.ts:250`):

- Head and tail: 3000 chars each
- Middle replaced with `…[omitted N chars; full result visible in UI step details]…`
- Threshold: 8192 chars

Why: a 4MB file / multi-MB shell output / full web_fetch page, if not truncated, goes literally into the next turn's input tokens and explodes. The model basically needs head + tail (path/error/summary). If full text is needed, the model can issue a follow-up with `read_file` at an offset.

## Token estimation and calibration

`tokenCoef` (`AgentLoop.ts:113`): initial 0.6 (empirical for mixed CN/EN).

Each turn, the real API `prompt_tokens` is used to reverse-derive the token/char ratio, with a 0.5/0.5 moving average (`calibrateTokens`). **Auto-adapts to the actual model** (GLM/Claude/OpenAI tokenizers differ and aren't public — adding ~1MB of tiktoken dependency isn't worth it).

`estMsgChars`: `content.length + JSON.stringify(tool_calls).length`. Previously missed tool_calls → large tool results caused over-estimation of headroom.

## Context-too-long fallback

When the API reports context-too-long (`AgentLoop.ts:44`):

```
isContextTooLong(e) → halve budget (15K) trim history → retry this turn once
```

`isContextTooLong` is best-effort: matches `context length|too long|maximum context|上下文|exceed|prompt is too` + HTTP 413. **Retries only once** (ponytail: no recursive fallback, sufficient).

## Intra-turn tool-result folding (foldOldToolResults)

Added in v3.9.4 (AgentLoop.ts), modeled on Claude Code's microcompact. Before every `streamComplete` the loop builds a **folded view** and sends that to the API instead of the raw array:

- Trigger gate: estimated context > 150K tokens (small turns are untouched)
- Old tool results (all but the most recent 10) collapse to summary lines: `[folded web_fetch https://…] first-80-chars… + re-run the same tool to retrieve`
- The paired `assistant(tool_calls)` batch arguments are cut to `'{}'` in the same pass (edit_file's `new_string` is often several KB); **ids are kept**, so assistant↔tool pairing survives and the openai/anthropic protocol stays valid
- Never folded: assistants with visible text content, `_transient` results, screenshot-style empty content

Why it matters: without folding, a turn that makes N LLM calls resends every earlier tool result N times → O(N²) input growth. Measured incident: 499 calls in one turn burned 99.8M input tokens ($6.99 for a single call) and tripped the 5-hour rate limit.

**Only the view changes.** The original `messages` array is never mutated — directHistory persistence, traj evidence, and compaction spill all see the full text. The end-of-turn `compactHistory` 30K budget works as before, on the unfolded originals. The wrapUp finishing call also uses the folded view.

## Compaction (compactHistory)

`compactHistory` (`AgentLoop.ts:158`):

- Runs at end of turn when over 30K tokens
- Tail keeps complete recent turns (`trimHistoryToTokenBudget`)
- Head is summarized by an LLM into a "[early conversation summary]" user message
- Summary prompt preserves: task goal, key decisions, settled conclusions, important file paths/commands/tech stack
- Failure → falls back to pure tail trim (no functionality lost)

`ponytail:`: ① summarized every turn end on demand, no summary cache (the same head may get summarized repeatedly); ② head only takes `slice(0, 12_000)` chars (very long histories get partial head summary).

## Sub-agent (dispatch_agent)

The `dispatch_agent` tool (`tools.ts`) dispatches a sub-task:

- Reuses `runAgentLoop` with its own history
- Read-only tools only (`readOnlyTools()`)
- maxTurns capped at 8
- Events forwarded: only cost (it costs money) + tool (prefixed for UI), tokens swallowed to prevent flooding
- Return value = sub-agent's assistant text output

The main agent does not see the sub-agent's intermediate steps — only the final text. This isolates context and keeps the main conversation clean.

## Provider dual protocol

`src/main/glm.ts`:

- **OpenAICompatibleProvider** — `/chat/completions` + Bearer, automatic prefix cache (GLM Zhipu / DeepSeek / Qwen / OpenAI endpoints all auto-cache)
- **AnthropicProvider** — `/v1/messages` + x-api-key + anthropic-version, explicit `cache_control` breakpoints (on system + on the last tool, covering the entire tools array)

Both providers normalize the response into the same `Completion`:

```ts
{ content: string; toolCalls: ToolCall[]; rawAssistant: ChatMsg; tokensIn: number; tokensOut: number }
```

`rawAssistant` is OpenAI-format regardless of the source protocol → AgentLoop history is protocol-agnostic.

## Retry strategy

`fetchUntil200` (`glm.ts:62`):

- Retryable status codes: `429 / 500 / 502 / 503 / 529`
- Exponential backoff: 1s / 2s / 4s, ±25% jitter
- Max 3 attempts
- **SSE streams can't retry once started** (would duplicate tokens), so retry only covers "connect → get 200 response"

## Cost calculation

`priceUSD(model, tokensIn, tokensOut)` (`glm.ts:96`):

- GLM family uses GLM price (`0.00000007 / token` in)
- Others use OpenAI default (`0.000003 / token` in)
- ⚙ → Pricing can override (next to API key)

Anthropic cache token billing: `cache_read_input_tokens` charged at input rate (actually ~10%, over-estimate but better than under); `cache_creation_input_tokens` at input rate (actually ~125%).

## Trajectory snapshot (traj)

`snapshotTraj` (`AgentLoop.ts:654`) folds the final messages into `TrajRecord[]` each turn and emits a `traj` event; the renderer's context inspector renders it per turn (expand/copy). Kinds: `system` (prompt), `context` (memory injection, `_memory` marker), `compacted` (head summary), `tool` (tool role / assistant with tool_calls), `message`, `user`.

Tiered quotas — the inspector's unique value is what only it can show:

| Kind | Limit | Why |
|---|---|---|
| system / context / compacted | 16K | Only visible here; short-truncating them defeats the purpose |
| tool / user / message | 2K | Full text lives in step cards / bubbles |

Per-turn total budget 256K (overflow degrades a record to a placeholder, keeping index alignment). Turn snapshots are concatenated across runs with the earliest system/context + latest turns preserved (types.ts). `emitConversation` / `get-conversations` add traj weight to the estimate so the 600K IPC gate still fires.

## Key source files

- `src/main/AgentLoop.ts` — ReAct loop + trim + compact
- `src/main/engines.ts:91` — `DirectEngine.run`
- `src/main/glm.ts` — provider + streaming
- `src/main/tools.ts` — the 10 tools

See [[Tools-and-MCP]], [[Long-Term-Memory]].
