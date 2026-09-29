**发布日期:** 2026-09-29(自 v3.9.3 起 1 commit)

### ⚡ 性能

- **turn 内工具结果折叠**(11e626d)—— 根治长跑 ReAct 循环的 O(N²) token 重发。单 turn 数百次 LLM 调用时,每条工具结果都会被后续每次调用完整重发:N 次调用 = O(N²) 输入增长。实测 499 次调用烧 99.8M input tokens($6.99/次),撞 5h 限流;同模式另一会话 361 次调用 51M($3.57)。对标 Claude Code microcompact:每次 streamComplete 前 foldOldToolResults() 生成"折叠视图"喂给 API —— 上下文估超 150K 才触发(小 turn 零感知);旧工具结果(保留最近 10 条)替换为摘要行「[已折叠 tool 目标] 头 80 字… + 重新调用同一工具即可取回」;assistant(tool_calls) 批次参数同步砍成 '{}'(edit_file 的 new_string 动辄几 KB),id 保留 → 与折叠后 tool 结果配对不破,openai/anthropic 协议仍合法;有文本内容的 assistant / _transient 结果 / 截屏类空 content 不折叠。⚠️ 只改视图不动原数组:directHistory / traj 存证 / compaction spill 全不受影响;turn 结束后 interStepCompact 30K 预算照旧。wrapUp 收尾调用同样走折叠视图。验证:13 项断言全过(原数组不可变/配对完整/阈值门/摘要行可读/edit_file 大参数砍除)+ typecheck。效果预估:同规模 turn 99.8M → ~35M,不再撞限流

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.9.3...v3.9.4

---

**English**

### ⚡ Performance

- **Intra-turn tool-result folding** (11e626d) — kills the O(N²) token resending of long-running ReAct loops. When a single turn makes hundreds of LLM calls, every tool result gets resent in full by every subsequent call: N calls = O(N²) input growth. Measured: 499 calls burned 99.8M input tokens ($6.99 for one call) and hit the 5-hour rate limit; another session with the same pattern made 361 calls at 51M ($3.57). Modeled on Claude Code's microcompact: before every streamComplete, foldOldToolResults() builds a "folded view" fed to the API — triggers only when estimated context exceeds 150K (small turns are untouched); old tool results (keeping the most recent 10) collapse to summary lines like "[folded tool target] first 80 chars… re-run the same tool to retrieve"; assistant(tool_calls) batch arguments are cut to '{}' in the same pass (edit_file's new_string is often several KB) while ids are kept, so pairing with folded tool results survives and the openai/anthropic protocol stays valid; assistants with visible text, _transient results, and screenshot-style empty content are never folded. ⚠️ Only the view changes — the original array is untouched: directHistory / traj evidence / compaction spill are all unaffected; the post-turn interStepCompact 30K budget works as before. The wrapUp finishing call uses the folded view too. Verified by 13 assertions (original array immutability / pairing integrity / threshold gate / readable summary lines / large-argument elimination) plus typecheck. Projected effect: a same-scale turn drops from 99.8M to ~35M tokens and no longer trips the rate limit

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.9.3...v3.9.4
