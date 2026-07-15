# Product Hunt Forum Post — Revised (Community-Focused)

**Topic:** Self-Promotion

**Title:**
I built a desktop app to run Claude Code, Codex & a custom engine side-by-side — here's what I learned about multi-agent memory

---

**Body:**

Hey PH community 👋

I'm a solo developer, and over the past few months I've been obsessed with one question:

> **What happens when you stop treating AI engines as walled gardens and start treating them as interchangeable tools in one workflow?**

Like a lot of you, I use Claude Code for architecture decisions, Codex for fast implementation, and GLM for cost-effective day-to-day tasks. But every time I switched between them, I lost context. I'd re-explain my project structure to Claude that I'd already explained to Codex an hour ago. It felt like having three brilliant interns with zero memory of each other.

So I built **KinetAios** — an open-source desktop app that runs all three engines from one window, with a shared memory layer that persists across engines.

### The core insight: memory should be engine-agnostic

This was the hardest engineering problem, and I think it's worth discussing because I see very few tools addressing it.

Most AI clients tie memory to a single provider's session. Claude remembers what Claude talked about. Codex remembers what Codex talked about. But what you actually want is a **user profile** — "this person works in TypeScript, prefers vanilla over frameworks, uses Electron, values security" — that follows *you*, not the engine.

My approach:
- After each conversation turn, a background extraction pass pulls durable facts (tech stack, preferences, project structure) into a local SQLite store
- FTS5 full-text search indexes everything for instant recall
- On the next session — regardless of engine — relevant facts get injected as context
- The user can view, edit, or delete any memory entry

It's not vector embeddings or fancy RAG. Just structured extraction + keyword search + user transparency. And honestly? It works surprisingly well. The simplicity surprised me.

### The unexpected part: gamification actually helped

Here's something I didn't expect. I built a "Town View" where each project is a little pixel-art house on an isometric map, and each conversation is a villager living inside. You see real-time status — who's working, who's idle, who errored.

I originally built it because I thought it was fun. But it genuinely changed how I manage parallel agent tasks. The visual map gives you spatial awareness of "oh, that agent is still grinding on the refactor while this one just finished the tests" in a way that a flat tab list doesn't.

**Has anyone else found that visual/spatial metaphors improved your dev workflow?** I'm curious whether this is just me.

### What's open for discussion

A few things I'm still figuring out, and I'd love the community's input:

1. **Memory boundaries** — How aggressive should auto-extraction be? I currently extract after every turn, but sometimes it captures noise (e.g., "user mentioned a bug in CSS"). Where do you draw the line between "useful context" and "clutter"?

2. **Multi-machine agents** — I added MCP protocol support so my laptop can dispatch tasks to my desktop. It works, but orchestrating agents across machines feels like early days. Is anyone else doing distributed AI agent workflows? What patterns work for you?

3. **Cost control** — I built budget cutoffs that hard-stop agents mid-loop. Controversial? Should agents have "unlimited" runway or should guardrails be the default?

If you're curious, the project is open source (GPL v3): **github.com/phinn/KinetAios**

But honestly, I'm more interested in the discussion than the download numbers. How are you all handling multi-engine workflows? Are you sticking with one provider, or mixing? What's missing from your current setup?

Would love to hear from fellow builders 🙏
