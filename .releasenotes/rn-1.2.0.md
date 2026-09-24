**发布日期：** 2026-07-15(自 v1.1.0 起 13 commits)

### 🌐 多机协作 MCP Bridge(新)
- **本机 MCP Server** — 默认端口 18109,Bearer token 鉴权
- **远程 SSE Client** — 自动发现/连接远程节点,工具名带 `[MCP:remote/节点名]` 标识
- **`run_agent` 远程调度** — 远程只暴露一个工具,在被调端启动完整 ReAct 循环,5 分钟超时;断线自动重连
- **远程 Agent 状态条** — 本机被远程调用时右下角金色脉动提示
- 设置页分 tab(模型/行为/高级/多机协作)+ iOS 风格开关 + MCP token 一键生成

### 其他
- **maxTurns 改为设置项**(默认 50,0=无限);全量 UI emoji 换内联 SVG;新增 Serene 暖灰+玫瑰金主题

---

**English**

- **MCP Bridge for multi-machine collaboration**: local MCP server (port 18109, Bearer auth), remote SSE client with auto-reconnect, and a single sandboxed `run_agent` remote tool (5-min timeout). Remote invocations show a pulsing status bar locally.
- Settings page reorganized into tabs with iOS-style switches and one-click MCP token generation
- `maxTurns` now a setting (default 50, 0 = unlimited); all UI emoji replaced with inline SVG; new Serene theme

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v1.1.0...v1.2.0
