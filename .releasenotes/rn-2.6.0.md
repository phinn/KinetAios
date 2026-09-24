**发布日期：** 2026-08-10(自 v2.5.0 起 47 commits)

### 🌌 NEXUS 空间认知 Agent 界面(Phase 1–4)
- **轨道视图** — 会话按引擎/状态分布同心轨道;缩放/平移;搜索过滤;轨道折叠 + 节点徽标 + 视图持久化
- 视觉全面升级:深空背景 + 毛玻璃 + 多层光晕;token events 实时刷新节点

### 📡 飞书多媒体
- 支持接收图片/文件/语音/视频消息,下载到本地并注入 Agent 上下文

### 🐛 修复
- NEXUS 返回按钮/Escape 无响应;webview 后退按钮(src+loadURL 双重加载+canGoBack 竞态);feishuKey/wecomKey/subAgentModel 持久化(建表迁移全链路);重启后会话丢失;侧栏主题快捷切换菜单

---

**English**

- **NEXUS spatial agent view (Phases 1–4)**: concentric orbit layout by engine/status, zoom & pan, search filter, orbit collapse, node badges, view persistence; deep-space glassmorphism visuals with live token updates
- **Feishu multimedia inbound**: images/files/voice/video downloaded locally and injected into agent context
- Fixes: NEXUS back/Escape unresponsive, webview back button (double-load + canGoBack race), persistence for subAgentModel/wecomKey/feishuKey, sessions lost after restart, quick theme-switch menu

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v2.5.0...v2.6.0
