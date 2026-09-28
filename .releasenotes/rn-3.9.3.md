**发布日期:** 2026-09-29(自 v3.9.2 起 5 commits)

### ✨ 功能

- **轨迹透视分级配额 + 检查器批量展开/复制**(f9c5698)—— 快照按记录类型分级截断:system/context/compacted 16K(只有轨迹面板能看到它们,短截=透视失真),tool/user/message 维持 2K(全文在步骤卡里已有),单 turn 总预算 256K;超预算按序保头。上下文检查器支持逐 turn 展开/复制轨迹;emitConversation/get-conversations 估重补 traj 权重,600K IPC 闸门不失灵

### 🐛 修复

- **多任务并发界面卡顿**(5200b38)—— 三处随任务数放大的风暴:①工作台全量 innerHTML 重建高频触发 → scheduleWorkbench 250ms 节流 + scrollTop 恢复;②estContextTokens 每秒对 directHistory 全量 stringify → ctxEstCache(引用+长度不变即复用);③nexus refreshNexusNode 的 rAF 节流每帧全量重建 → 500ms 尾随节流 + offsetParent 可见性守卫。模式:rAF 是错误的节流器(不减频只对齐帧),要用时间窗节流 + 可见性守卫 + 滚动恢复
- **Goal 监工接力链被清空**(c4be299)—— 初始化时序竞态:markClean() 用 readSettingsForm() 覆写脏检测基线,而 readSettingsForm 读 goalChainCache,缓存在 markClean 之后才回填 → 读到空 [] 毒化快照 → 每次冷启动后首次开设置,链显示为空,保存即清盘。修复:回填挪到 markClean 之前(与其它缓存同时序);链增删是 button onclick 不冒泡 input/change,补 updateSaveDot 防改完不保存静默丢
- **Windows CRLF/BOM 写入三连坑根修**(e248965)—— edit_file 读入后检测换行风格,old_string/new_string 归一化后再匹配(含 replace_all);decodeBuffer 剥 \ufeff BOM;atomicWrite 保 BOM。此前 CRLF 文件遇 \n 的 old_string 必然匹配失败
- **仓库换行策略**(c1b395c)—— 加 .gitattributes:仓库 LF,Windows 脚本 CRLF,杜绝 CRLF 事故复发

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.9.2...v3.9.3
