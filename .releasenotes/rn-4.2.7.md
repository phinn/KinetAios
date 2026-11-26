**发布日期:** 2026-11-26(自 v4.2.6 起 15 commits)

# v4.2.7 — 编辑自验证内环 / 工具级遥测 / 子任务模型路由

## 新功能
- **工具级遥测** — `tool/call` 事件新增 `outcome`（ok/error）、`errorKind`（timeout / bad_args / edit_mismatch / not_found / io / permission / unsupported / exit_code 等 10 类）与 `errorSummary`。此前只能看轮级失败率，现在可直接按「工具 × 错误类型」聚合，定位返工热点；设置页新增「使用统计」面板，另有 `usage_stats` 工具可让 agent 自己查
- **编辑精度升级** — `edit_file` 精确匹配失败后，自动做行级空白归一化模糊匹配（忽略缩进差异）并按其实际缩进重排 `new_string`；归一化后命中多处且未开 `replace_all` 时拒绝执行并列出候选行号（宁可不改，不改错位置）；完全失配时返回最接近的 3 个片段（行号 + 相似度 + 原文）
- **编辑后自验证内环** — `write_file` / `edit_file` 成功后自动跑诊断（TS/JS 走 tsc 或 eslint、Python 走 pyright / py_compile、Go 走 gopls check / go vet），结果直接回灌给模型；首次只报被改文件的错误，之后只报「本次新增」，大仓库不会被历史错误淹没。同文件内容未变时跳过重复检查
- **自动测试闸** — 改完代码自动跑受影响的测试（同目录同名测试、或直接 import 该模块的测试），失败走基线 diff 只报新增失败；支持 vitest / jest / mocha / pytest / go test，自研脚本可用 `KINET_TEST_CMD`（支持 `{files}` 占位符）
- **视觉验收内环** — 新增 `verify_visual`：支持读图 / 按窗口标题截现场窗口 / 截当前屏幕，视觉模型按验收标准判定并返回问题清单与修复建议；UI 文件改动后若本地页面已打开，还会自动跑一次验收（90s 节流，绝不拉起浏览器）
- **检索升级（零 embedding）** — `repo_map` 新增跨文件调用图与「符号→引用」反查（`repo_map(symbol="…")` 返回定义点与全部引用点）；grep 结果按相关性重排（大小写精确 > 词边界 > 源码目录 > 测试/文档，生成文件降权）
- **子任务模型路由** — plan / exec / summarize / vision 四类能力可分别指定模型，支持 `profile名/模型名` 跨 provider；设置页新增配置项，环境变量 `KINET_MODEL_PLAN/EXEC/SUMMARIZE/VISION` 可临时覆盖，每次决策都带可读的来源说明
- **快照 diff 预览** — 快照面板新增「预览改动」，零依赖 unified diff 对比当前文件与快照原文，确认后再决定是否还原
- **记忆睡眠期固化** — 空闲时自动去重、降权、把稳定事实晋升到常驻记忆块
- **分布式执行与技能依赖** — `remote_agent` 可把任务派发到远端节点执行并回传；技能 `requires` 声明会在加载时检查并给出装配引导

## 修复
- **自动视觉验收用错模型** — 之前按全局默认模型解析，全局模型不支持读图时自动验收会静默失效；现在使用会话绑定的模型，并优先走 vision 路由，节流按会话隔离
- **窗口截图/浏览器调用失败信息太笼统** — 窗口匹配失败时按相似度列出候选窗口名，缩略图全空直接提示屏幕录制权限；`browser_eval` 区分页面已关闭 / 超时 / 页面 JS 错误，并给出下一步动作
- **使用统计文案硬编码中文** — 统计面板与 `usage_stats` 输出改为跟随界面语言（中/英/繁/日）
- **`read_file` 批量读取** — 新增 `paths` 参数，一次最多读 8 个文件，减少往返

## 工程
- **修复 Python 3.12+ 下 native 模块编译失败** — `node-gyp` 固定到 10.x（旧版 gyp 依赖已被移除的 `distutils`），`better-sqlite3` 在 Python 3.14 上可正常重建
- **macOS 公证失败兜底** — 公证凭据失效时自动跳过公证重试一次，保证 dmg 仍有产出
- 新增 20+ 测试文件，覆盖遥测分类、视觉判定、编辑模糊匹配、诊断解析、测试选择、模型路由、diff、统计格式化

---

**English**

## New Features
- **Tool-level telemetry** — `tool/call` events now carry `outcome` (ok/error), `errorKind` (10 classes: timeout / bad_args / edit_mismatch / not_found / io / permission / unsupported / exit_code and more) and `errorSummary`. Previously only per-turn failure rates were visible; you can now aggregate by tool × error type and pinpoint rework hot spots. Settings gains a Usage Statistics panel, and a `usage_stats` tool lets the agent query it directly
- **Sharper edits** — when `edit_file`'s exact match fails, it now falls back to a line-level whitespace-normalized fuzzy match (ignoring indentation differences) and re-indents `new_string` to the file's actual indentation. If the normalized match hits multiple places without `replace_all`, the edit is refused with the candidate line numbers listed (better to not edit than to edit the wrong place). On a complete miss it returns the 3 closest snippets with line numbers, similarity score and source text
- **Self-verifying loop after edits** — after a successful `write_file` / `edit_file`, diagnostics run automatically (tsc or eslint for TS/JS, pyright / py_compile for Python, gopls check / go vet for Go) and the results feed straight back to the model. The first pass reports errors only in the touched files; later passes report only newly introduced ones, so a large repo is not drowned in legacy noise. Unchanged file content skips the repeat check
- **Automatic test gate** — changed code triggers the affected tests (a same-directory, same-name test file, or any test that imports the module). Failures go through a baseline diff that reports only new breakage. Supports vitest / jest / mocha / pytest / go test, and custom harnesses via `KINET_TEST_CMD` (with a `{files}` placeholder)
- **Visual acceptance loop** — new `verify_visual`: read an image, capture a window by title, or grab the current screen; a vision model judges against your acceptance criteria and returns an issue list with fix suggestions. After UI file changes, if a local page is already open it runs one automatic check (90s throttle, never launches a browser)
- **Better retrieval, zero embeddings** — `repo_map` gains a cross-file call graph and a symbol → references reverse lookup (`repo_map(symbol="…")` returns the definition plus every reference site); grep results are re-ranked by relevance (exact case > word boundary > source dirs > tests/docs, generated files down-weighted)
- **Per-capability model routing** — plan / exec / summarize / vision can each target a different model, using `profile/model` across providers. Configurable in Settings, with `KINET_MODEL_PLAN/EXEC/SUMMARIZE/VISION` env overrides, and every decision carries a readable explanation of where it came from
- **Snapshot diff preview** — the snapshot panel gains a Preview Changes view with a zero-dependency unified diff between the current file and the snapshot, so you can inspect before deciding to restore
- **Memory consolidation during idle** — when idle, memories are deduplicated, down-weighted, and stable facts promoted into the resident memory block
- **Distributed execution and skill dependencies** — `remote_agent` can dispatch a task to a remote node and return the result; a skill's `requires` declaration is checked at load time with assembly guidance when it is missing

## Fixed
- **Auto visual acceptance used the wrong model** — it resolved the global default, so when that model could not read images the automatic check silently did nothing. It now uses the session-bound model, prefers the vision route, and throttles per session
- **Vague failures from window capture / browser calls** — a window match failure now lists similar window titles by similarity, and an all-empty thumbnail set points at the screen-recording permission. `browser_eval` distinguishes page-closed / timeout / page JS errors and states the next action
- **Hardcoded Chinese in usage statistics** — the stats panel and `usage_stats` output now follow the UI language (ZH/EN/ZH-TW/JA)
- **`read_file` batch reads** — new `paths` parameter reads up to 8 files in one call, cutting round trips

## Engineering
- **Fixed native module builds under Python 3.12+** — `node-gyp` is pinned to 10.x (older gyp depends on the removed `distutils`), so `better-sqlite3` rebuilds cleanly on Python 3.14
- **macOS notarization fallback** — when notarization credentials fail, the build retries once with notarization skipped so a signed dmg is still produced
- Added 20+ test files covering telemetry classification, visual judging, edit fuzzy matching, diagnostics parsing, test selection, model routing, diff, and stats formatting

---

Part of the Kinet family — 22 apps, all live: https://phinn.github.io/kinetapp/index.html
Kinet 家族成员 —— 22 个应用,全部在架: https://phinn.github.io/kinetapp/index.html

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.2.6...v4.2.7

