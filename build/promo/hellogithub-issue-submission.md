# HelloGitHub 自荐 issue 文案(2026-09-19 制作)

> 提交入口(须人工填表单,模板 submit-cn.yaml):
> https://github.com/521xueweihan/HelloGitHub/issues/new?template=submit-cn.yaml
> 已查无重复:hellogithub.com 搜索 0 结果 + 仓内 issue 搜索 0 结果。

## 逐字段填法

- **Title**(标题,自带前缀后填):`[开源推荐] KinetAios:跨平台本地优先的多引擎 AI Agent 仪表盘`
- **项目地址**:`https://github.com/phinn/KinetAios`
- **类别**(下拉,单选):`TypeScript`
  (下拉无 Electron 项;仓库主体是 TypeScript,选它;备选 `人工智能`)
- **项目标题**(≤50 字符):`跨平台多引擎 AI Agent 仪表盘,本地优先,Windows/macOS 双端`
- **项目描述**(32-256 字符):

```
本地优先的 AI Agent 桌面仪表盘,Electron + TypeScript 编写,Windows 和 macOS 双端原生支持。多个 AI 引擎(内置 ReAct、Claude Code、Codex)在同一界面并发开会话,流式输出答案,可调用 shell、文件、网页抓取等 40+ 内置工具,支持 MCP 协议接入外部工具生态,长期记忆基于 SQLite + FTS5 全文检索,数据完全留在本地。
```

- **亮点**:

```
- **多引擎同屏**:内置 ReAct 规划引擎 + Claude Code + Codex 三类引擎随时切换,会话历史统一管理,跨引擎上下文自动清理,不用在多个 CLI 之间来回跳。
- **40+ 内置工具开箱即用**:shell(带高危命令确认门)、文件读写、网页抓取(SSRF 防护)、浏览器自动化、记忆检索,还有 MQTT/Modbus/BLE 等硬件调试工具,嵌入式开发者也能用。
- **MCP 双向**:既能当 MCP 客户端接外部 server,也能开 host 模式把内置工具暴露给其它 AI 应用,token 鉴权 + 爆破限速。
- **长期记忆**:每轮对话自动提取"关于用户的事实",SQLite + FTS5 全文检索,下次会话自动注入,local-first 不出本机。
- **对初学者友好**:README 提供 30 秒 TL;DR,中文文档 62 页 wiki(30 篇中文),ReAct 循环、SSE 流式解析、事件溯源式状态折叠(applyEvent)都是可直接读的工程实现。
```

- **示例代码**(可选,可跳过;若填):

```
```bash
# 源码运行(Node 18+)
git clone https://github.com/phinn/KinetAios
cd KinetAios
npm install
npm run build
npm start
```
```

- **截图**:建议拖上传 README 首屏截图(仓库 README 里有 dashboard 截图,可右键另存后拖进 issue)。

## 注意
- 描述必须原创(已原创,非复制 README)✅
- 若收录,issue 内会收到通知,账号进贡献人列表。
