**发布日期:** 2026-11-06(自 v4.0.8 起 17 commits)

# v4.0.9 — MCP 管理面板 / 技能市场 / MiniMax Provider 加固

## 新功能
- **MCP 管理面板** — 设置页新增 MCP tab,与 composer 弹层共用管理逻辑:应用自有 server(`settings.mcpServers`)成为一等公民,面板内增删改;外部扫描(`~/.claude.json` / Claude Desktop / `~/.codex/config.toml`)可整体开关;任一 server 可单独停用——连接保留、仅在工具收集时过滤,重新启用零成本(无需重连);同名自有配置优先于外部扫描发现
- **MCP 重新扫描** — 面板一键重连全部发现型 server,一次 IPC 往返直接返回新快照刷新 UI
- **技能市场** — 技能面板内嵌 anthropics/skills 官方库浏览:拉取仓库索引、按名称/描述搜索、一键安装到 `~/.kinetaios/skills`;主进程出网(渲染层零网络面),安装后技能缓存即时失效,slash 菜单与引擎注入立即生效;并发受限抓取 + 10 分钟内存缓存

## 修复
- **MiniMax 账户级限流退避策略** — `[1302] 您的账户已达到速率限制`(RPM 限流)原先按通用 429 走秒级退避(1s/2s/4s),对分钟级限流窗口无效、三连发全败;现识别后改长退避(2s/8s/30s)并优先尊重 `Retry-After` 响应头,退避耗尽才向上进入 failover 链
- **MiniMax 原生错误壳可读化** — MiniMax 报错装在自有的 `{base_resp:{status_code,status_msg}}` 壳里,原先只能 JSON.stringify 兜底吐整坨;现解析为 `[1301] 内容安全审查未通过` 式可读文案,错误分类(auth/quota/network)随之正确
- **SSE 流内错误帧静默丢失** — MiniMax 在 HTTP 200 下用流内 `base_resp`/`error` 帧报错,原先落进 `catch{continue}` 被静默吞掉,表现为"空回复 + 面目全非的兜底报错";现显式抛 `GLMError` 进入重试/failover 链(自抛错误在 catch 中穿透,JSON 解析噪声照旧吞掉)
- **内容安全 400 自愈回灌** — `[1301]` 内容安全拦截原先直接终止整个 turn,几十轮长任务一次拦截即全盘报废;现识别后回灌一条 `_transient` 系统提示让模型改写措辞续跑(仅自愈 1 次,再命中向上抛走既有错误链,不写回历史)
- **「速率限制」中文措辞进瞬时错误正则** — MiniMax 中文报错不命中英文瞬时正则时被判 `other` 不重试不 failover 直接停机;`TRANSIENT_RE` 补齐中文措辞,全链路(重试/failover)都能吃到
- **CLI shim body 赋值静默失败** — Node 对 getter-only 属性直接赋值不报错,修为 `defineProperty` 强写

## 视觉
- **chat-head 环境胶囊平权化** — 顶部环境条去框线去内高光,与 composer 收敛同一语言;craft 主题拟物语言留给工具钮

## 内部改进
- 探针脚本(ka_head_probe / ka_env_probe / ka_shot)入库,便于回归 UI 量测
- gitignore 排除 OCR 中间产物与 trae 临时包

---

**English**

# v4.0.9 — MCP Manager / Skills Marketplace / MiniMax Provider Hardening

## New
- **MCP manager panel** — new MCP tab in settings, sharing logic with the composer popup: app-owned servers (`settings.mcpServers`) are now first-class citizens (add/edit/remove in the panel); external scanning (`~/.claude.json` / Claude Desktop / `~/.codex/config.toml`) can be toggled off entirely; any server can be disabled individually — the connection stays alive and only tool collection is filtered, so re-enabling is free (no reconnect); app-owned entries win over external discovery on name conflicts
- **MCP rescan** — one click reconnects all discovery-type servers and returns the fresh snapshot in a single IPC round-trip to refresh the UI
- **Skills marketplace** — the skills panel now embeds the official anthropics/skills catalog: fetch the repo index, search by name/description, one-click install into `~/.kinetaios/skills`; all network access lives in the main process (zero network surface in the renderer), and installing invalidates the skill cache immediately so the slash menu and engine injection pick it up right away; concurrency-limited fetching + 10-minute in-memory cache

## Fixed
- **MiniMax account-level rate-limit backoff** — `[1302] 您的账户已达到速率限制` (RPM limit) used to fall into the generic 429 path with second-scale backoff (1s/2s/4s), which is useless against a minute-scale limit window and burned all three retries; now detected and switched to long backoff (2s/8s/30s) honoring the `Retry-After` header first, escalating to the failover chain only after exhaustion
- **MiniMax native error shell made readable** — MiniMax wraps errors in its own `{base_resp:{status_code,status_msg}}` shell, previously falling back to a raw `JSON.stringify` dump; now parsed into readable `[1301] content-safety rejection` style messages, so error classification (auth/quota/network) works correctly
- **In-stream error frames silently dropped** — MiniMax reports errors as in-stream `base_resp`/`error` frames under HTTP 200; they used to vanish into `catch{continue}`, surfacing as an empty reply with a misleading fallback error; now a `GLMError` is thrown explicitly into the retry/failover chain (self-thrown errors pass through the catch; JSON parse noise is still ignored)
- **Content-filter 400 self-heal** — a `[1301]` content-safety rejection used to kill the whole turn, wasting dozens of completed rounds in long tasks; now a `_transient` system nudge is reinjected so the model rephrases and continues (self-heal capped at once; a second hit escalates through the existing error chain, nothing is written back into history)
- **Chinese "rate limit" wording in the transient regex** — MiniMax Chinese error text missed the English-only transient regex and was classified `other` → no retry, no failover, hard stop; `TRANSIENT_RE` now covers the Chinese wording across the whole chain (retry/failover)
- **CLI shim body assignment silently failing** — assigning to a getter-only property throws nothing in Node; fixed with an explicit `defineProperty`

## Visual
- **chat-head env pill flattened** — the top environment strip loses its border and inner glow, same design language as the composer consolidation; craft keeps its skeuomorphic treatment for tool buttons

## Internal
- Probe scripts (ka_head_probe / ka_env_probe / ka_shot) committed for UI regression measurements
- gitignore: OCR intermediates and trae temp packages excluded

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.0.8...v4.0.9
