> 🌐 Language: [English](Getting-Started) | **中文**

# Getting Started

从零到第一个任务跑通。

## 装依赖

需要 **Node.js 18+** + 联网(`better-sqlite3` 原生模块要编译)。

```sh
cd KinetAiosWin
npm install      # postinstall 重建 better-sqlite3 给 Electron 用
npm run build
npm start
```

**CN 网络提示**:`npm install` 拉 Electron 二进制可能超时。`.npmrc` 已经配好 npmmirror;真挂了可以手动跑:

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

详见 [[Development]]。

## 配 API

第一次启动 → 右上角 **⚙** → **API** 区:

| 字段 | 说明 |
|---|---|
| Provider | OpenAI 兼容 / Anthropic 二选一(决定请求协议) |
| Base URL | 默认 GLM 智谱;内置 preset 按钮:GLM / DeepSeek / OpenAI / Anthropic |
| Model | 例 `glm-4.6`,`claude-sonnet-4-6`,`gpt-4o` |
| API Key | 存在 userData 的 `settings.json`,通过 safeStorage 加密(macOS Keychain / Windows DPAPI) |

填完点 **测试连接**。通过 = 能用了。

API key 存储详见 [[Settings]];协议差异详见 [[Engines]]。

## 发第一条任务

主窗口底部输入框:

```
帮我看下当前目录结构,列出所有 .md 文件并告诉我每个的开头一句话
```

回车 = 发送;Shift+Enter = 换行;拖文件到输入框 = 加附件。

模型会:
1. 调 `glob` 找 `.md` 文件
2. 调 `read_file` 读开头
3. 流式回答

每个工具调用在聊天框里折叠显示(`▸ shell`、`▸ read_file`…),点开看完整结果。下面有 token 实时计数。

## 选工作目录(cwd)

会话头部第二行 **工作目录** 输入框:
- 直接输路径 + 回车
- 或点 📁 选目录

agent 的所有 shell / read_file / write_file 都以此为根。换会话时 cwd 跟着切;每个会话独立 cwd。

## 切引擎

会话头部 **引擎** 下拉:
- **Kaios (Direct)** —— 内置 ReAct loop,默认。
- **Claude Code** —— 本机装了 `claude` CLI 才能开。
- **Codex** —— 本机装了 `codex` CLI 才能开。

切换清空跨引擎上下文(三套引擎历史格式不互通)。详见 [[Engines]]。

## 试全局热键

任意应用前台时按 `Ctrl/Cmd+Alt+Space` → 弹出快速面板:
- 输入任务 → Enter → 后台跑一个临时会话
- 完成后通知 + 显示结果

主窗口关掉时快速面板不工作(关窗 = 退应用)。详见 [[Global-Hotkey]]。

## 接下来

- [[Direct-Engine]] —— 看内置引擎怎么思考、怎么调工具
- [[Tools-and-MCP]] —— 10 个内置工具 + MCP 集成
- [[Long-Term-Memory]] —— 跨会话记忆怎么自动抽取
- [[Files-and-Preview]] —— 内置浏览器看 HTML / 起的本地服务
