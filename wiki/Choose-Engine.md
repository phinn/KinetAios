> 🌐 Language: [English](Choose-Engine) | [中文](Choose-Engine.zh-CN.md)

# Which engine? V1 / V2 / V3 / V4 / V5

KinetAios ships five generations of the built-in Kaios engine, switchable per session. All five run the **same model with the same tools** — what differs is **how they work**. Picking the right one can easily halve the time a task takes.

## 30-second cheat sheet

| Your task | Pick |
|---|---|
| Q&A, translation, writing, reading a file, fixing one file | **V1** |
| Tight cost control, want to see every step | **V1** |
| Multi-file code changes, refactors with verification, multi-step data processing | **V2** |
| Data analysis, reports, cross-table comparisons | **V3** |
| Not sure | **V3** (it grades the task difficulty itself) |
| Long-horizon deep task that must hit hard acceptance criteria | **V4** (Legis) |
| Repeatable task family — past failures should shape future runs | **V5** (Phylum, experimental) |

---

## V1 (Direct) — light and direct

**How it works**: a single-threaded ReAct loop; the model calls tools directly, every step visible in real time. Lightweight context strategy — fastest responses, lowest token cost.

**Good for**:
- Q&A, explanations, translation, copywriting, emails
- Reading a file, inspecting code, small fixes
- Continuous one-question-one-answer conversations
- Precise control over cost and flow

**Not good for**:
- Refactors spanning many files (long conversations drop earlier findings)
- Multi-step data processing (intermediate results live in conversation memory and get truncated)

**Tip**: when using V1 for data analysis, invoke `/data-analysis` to load the analysis discipline — it measurably reduces "mental-math" errors.

---

## V2 — plan first, then execute

**How it works**: complex tasks enter a **planning phase** first (read-only exploration producing a step plan), then execute step by step, each step optionally carrying a verification command (typecheck / tests). Failures auto-retry (≤3 per step, ≤2 replans).

**Good for**:
- Multi-file code changes and refactors
- Dev tasks that must pass tests/lint after the change
- Multi-step data processing, cross-file stats (intermediate results are forced to disk/memory, truncation-proof)
- Tasks where you **want to see the plan before execution starts**

**Not good for**:
- Simple Q&A, single-file tweaks (planning is wasted overhead — slower and pricier)
- Large multi-file parallel work (V2 executes serially, step by step)

**Tip**: V2 auto-degrades to plain mode on trivial tasks — no "nuking mosquitoes" worry. But if you already know the task is simple, V1 is faster.

---

## V3 — adaptive pipeline (recommended default)

**How it works**: a zero-cost rules-based router grades the task and picks one of three paths:

- **fast**: reading files, docs, simple Q&A → single-round direct answer, zero overhead
- **std**: bugfix, feature work, **data analysis** → multi-round tool execution
- **deep**: cross-file refactors, architecture-level changes → auto-planned into a DAG; independent steps **run in parallel**, with built-in verification gates

**Good for**:
- **Data analysis / reports / statistics** — V3 has the analysis discipline built in: schema before conclusions, compute via python/sqlite (never mental math), intermediate results on disk, conclusions must be sourced, key numbers cross-checked. When 「📊 Analysis mode」 shows in the status bar, it's active
- Tasks with unknown complexity (let the router decide)
- Complex refactors (deep's parallelism + verification gates are unique among the five)

**Not good for**:
- Advanced workflows needing precise per-step control (V1 is more transparent)
- Minimum-cost single Q&A at all costs (the fast path is cheap, but V1 is slightly cheaper)

---

## V4 (Legis) — plan as law, assert before settle

**How it works**: shares V3's router (fast/std are identical to V3). The deep path replaces free-form DAG execution with the **Legis pipeline**: the model first *compiles* the requirement into a structured plan — typed nodes (`replay` = pure tool chains with zero LLM, `agent` = sub-ReAct), deterministic acceptance assertions, DAG validation (acyclic, whitelisted tools, writes on agent nodes only) — then a runtime executes it topologically (same-layer reads parallel, writes serial), and every assertion must pass before the plan settles. Assertion failure → minimal failure context goes back to the LLM → patch → resume that node. Checkpoint/resume and JobManager backgrounding are inherited from V3.

**Good for**:
- Long-horizon deep tasks where you want **machine-checkable acceptance**, not the LLM judging itself
- Cost-sensitive deep runs — replay nodes cost zero tokens (the LLM appears once per program, not once per step)

**Not good for**:
- Exploratory work with an unknown finish line (assertions need a definable "done")

---

## V5 (Phylum) — population evolution (experimental)

**How it works**: agents don't learn, they breed. Each prompt normalizes to a task-template id (signature); a living expression is claimed from the gene pool and executed under hard constraints (affinity-pruned tools, maxSteps budget, assertion gates). Execution ends in death settlement — scars from failures are attributed and inherited by the next generation. The gene pool persists per conversation.

**Good for**:
- Repeatable task families where past failures should shape future attempts
- Tasks with deterministic acceptance that benefit from accumulated execution memory

**Not good for**:
- One-off creative tasks (no family to evolve from)
- **Experimental** — expect semantics to shift between versions

---

## Scenario comparison

| Scenario | Pick | Why |
|---|---|---|
| "Look at this error for me" | V1 or V3 | Single-point problem, just be fast |
| "Move this feature from file A to B, run the tests after" | V2 or V3 | Code change with verification needs |
| "Compare these two CSVs and produce a report" | V3 | Analysis discipline + intermediate results on disk |
| "Migrate the whole project from JS to TS" | V3 (deep) → V4 | V3 deep has DAG parallelism; V4 Legis adds compile→runtime→audit gates |
| "Translate this paragraph" | V1 | No tool orchestration needed |
| "Give me a plan first, I'll approve before you act" | V2 | The planning phase is literally "plan first" |
| "This task family keeps failing the same way" | V5 | Phylum inherits scars across generations |

## Caveats

- **Switching engines clears cross-engine context**: Direct generations share `directHistory`, but Claude Code / Codex / plugin engines don't — don't switch mid-task
- All built-in engines share the same model config, MCP tools, and memory system — switching needs no reconfiguration
- When data files (csv/xlsx/db) appear in the task description, V3/V4/V5 enter analysis mode automatically; on V1, pair it with `/data-analysis`
