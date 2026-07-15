# Product Hunt Launch Copy — KinetAios

---

## Tagline (60 chars max)

**Run Claude Code, Codex & your own AI — one desktop, no account**

Alternative: **Three AI agents in one local-first desktop dashboard**

---

## Description (260 chars max)

KinetAios is a local-first AI agent dashboard that runs Claude Code, Codex, and a built-in ReAct engine from one window — with shared long-term memory, MCP multi-machine collaboration, a gamified Town view, and zero cloud dependency. Your API key is the only auth.

---

## Topics (pick 3)

- `Artificial Intelligence`
- `Developer Tools`
- `Productivity`

---

## Comment / "Maker Comment" (post right after launch)

Hey Product Hunt! 👋

I'm a solo developer, and I built KinetAios because I was tired of juggling three terminal windows for three different AI coding agents — and losing all context every time I switched between them.

**What it does:** KinetAios is a desktop app (Electron + TypeScript) that puts Claude Code, Codex, and a built-in ReAct engine behind one window. You get:

🏠 **Town View** — Your projects as little pixel-art houses on an isometric map. Each conversation is a villager. Watch your agents "work" in real time. Click any villager to chat inline.

🧠 **Persistent Memory** — Automatically extracts durable facts about you from conversations and injects them into future sessions. Powered by SQLite + FTS5 full-text search. No more repeating "I use TypeScript, my project is Electron-based…" every single time.

⚔️ **Arena** — Race the same prompt across all three engines simultaneously. Compare outputs side-by-side, diff them, or let an AI judge pick the winner.

🌐 **MCP Bridge** — Connect multiple machines via MCP protocol. Your laptop can dispatch computing tasks to your desktop or a remote server. Remote nodes appear as floating cloud houses in Town View.

💰 **Cost Tracking** — Per-session, daily, and monthly cost dashboards across all engines. Budget cutoffs that actually stop runaway agents.

**No account. No relay server. No telemetry.** Your LLM API key is the only authentication. All data lives in local SQLite.

It's open-source (GPL v3) and runs on Windows + macOS.

I'd love your feedback — what would make this your daily driver? 🙏

---

## Tweet Thread (for launch day promotion)

**Tweet 1:**
Meet KinetAios — a local-first desktop app that runs Claude Code, Codex, AND a built-in AI engine from ONE window.

No accounts. No cloud. Just your API key.

And your projects show up as a pixel-art village. 🧵👇

[#1]

**Tweet 2:**
🏠 Town View: each project is a house, each conversation is a villager.

Watch agents work in real time. Click to chat inline. Remote machines float as cloud houses.

It's Tamagotchi for AI agents. 🍄

[#2]

**Tweet 3:**
🧠 Long-term memory that actually works.

Auto-extracts facts about you from every conversation. Injects them into future sessions. Powered by SQLite + FTS5.

Switch from Claude to Codex to GLM — your memory follows you. No re-explaining context. Ever.

[#3]

**Tweet 4:**
⚔️ Arena mode: one prompt, three engines, side-by-side.

Watch Claude, Codex, and GLM race in real time. Diff their outputs. Let an AI judge pick the winner.

Stop guessing which model is best — see it.

[#4]

**Tweet 5:**
🌐 MCP Bridge: connect multiple machines over MCP protocol.

Your laptop dispatches tasks to your desktop. Remote nodes appear as cloud houses in Town. Full ReAct loop runs on the callee.

Distributed AI agent orchestration, no Kubernetes required.

[#5]

**Tweet 6:**
Built with:
• Electron + TypeScript
• better-sqlite3 + FTS5
• Zero frontend frameworks (vanilla TS)
• 4 themes × 4 languages

Open source (GPL v3). Windows + macOS.

👉 github.com/phinn/KinetAios

We're live on Product Hunt today — come say hi! 🚀

[#6]

---

## Reddit r/devops / r/programming Title

**KinetAios: I built a desktop dashboard that runs Claude Code, Codex, and a custom AI engine side-by-side — with persistent memory and a gamified Town view. No account, fully local.**

---

## Hacker News Title

**Show HN: KinetAios – Local-first desktop dashboard for Claude Code, Codex, and a built-in ReAct engine**

---

## Key Differentiators (for quick reference in comments)

1. **Three engines, one window** — Switch per-conversation without losing session state. No other tool does this.
2. **Cross-engine memory** — One user profile, all engines. Extracted automatically, editable, searchable.
3. **Town View** — Gamified isometric map. Projects = houses, conversations = villagers. Not a gimmick — it's a genuine productivity interface.
4. **MCP Bridge** — Multi-machine agent orchestration via standard MCP protocol. No proprietary server.
5. **Arena** — Empirical engine comparison with diff and AI judging.
6. **Local-first, zero account** — All data in SQLite. Your API key is the only credential.
7. **File snapshots + rollback** — Every write tool auto-snapshots. One-click revert before AI broke your code.
8. **Pipeline** — Chain engines: Claude designs → Codex implements → GLM reviews.
9. **9 built-in tools** — shell, read/write/edit_file, grep, glob, git_diff, web_fetch, recall_memory, dispatch_agent.
10. **Cost tracking + budget cutoffs** — Prevent runaway agents from burning your wallet.
