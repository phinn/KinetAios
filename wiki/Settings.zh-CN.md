> 🌐 Language: [English](Settings) | **中文**

# Settings

主窗口右上角 **⚙** 进。五大区。

## API

| 字段 | 说明 |
|---|---|
| Provider 协议 | `OpenAI 兼容` / `Anthropic` 二选一。决定请求走 `/chat/completions` 还是 `/v1/messages` |
| Base URL | 端点根。预设按钮:GLM 智谱 / DeepSeek / OpenAI / Anthropic 一键填 |
| Model | 默认模型。例 `glm-4.6` / `claude-sonnet-4-6` / `gpt-4o`。每会话可独立改 |
| API Key | safeStorage 加密存(macOS Keychain / Windows DPAPI)。明文不进 settings.json |
| **测试连接** | 发一个最小请求验证。**保存前必测** |

`AppSettings.apiKey` 通过 `safeStorage.encryptString` 加密后存 `userData/settings.json` 的 `apiKeyEnc` 字段。

## 行为

| 字段 | 说明 |
|---|---|
| Shell 审批 | `always`(默认,每次弹确认)/ `never`(自动放行,慎用) |
| 沙箱(Claude Code / Codex) | `readOnly` / `workspaceWrite` / `fullAccess`。映射到 `--permission-mode`(CC)/ `-s`(Codex) |
| 计划模式 | 开了 → 引擎只读不写(CC 走 `plan` mode,Codex 走 `read-only`) |
| 启用 CLI 引擎 | 默认关。开了才会扫 PATH 找 `claude` / `codex`,把对应引擎选项加到下拉 |

## 价格

| 字段 | 说明 |
|---|---|
| 输入价格(per 1M token) | 美元。覆盖默认(GLM `0.07`,其他 `3`) |
| 输出价格(per 1M token) | 同上 |

`priceUSD(model, tokensIn, tokensOut)`(`glm.ts:96`)优先用这里的设置;为 0 时回退到内置默认。

## 界面

| 字段 | 说明 |
|---|---|
| 语言 | English / 简体中文 / 繁體中文 / 日本語。**实时切换**(不用重启) |
| 主题 | dark(默认)/ light。**实时预览**(切走再切回不丢) |

i18n 实现详见 [[i18n]]。

## 长期记忆

| 按钮 | 说明 |
|---|---|
| 导出 JSON | 写到用户选的路径。`{ version: 1, exportedAt: number, memories: Memory[] }` |
| 导入 JSON | 接受上面结构 **或** 纯 `string[]`。按 content 去重。返回 `{ imported: N, skipped: N }` |

适合换机器迁移、备份、不同 provider 共享。详见 [[Long-Term-Memory]]。

## 每会话独立 vs 全局

| 全局(setting) | 每会话(conv) |
|---|---|
| Provider 协议 | 引擎(Direct/CC/Codex) |
| Base URL | 模型 |
| API Key | cwd |
| 价格 | |
| 审批 / 沙箱 | |
| 语言 / 主题 | |

每会话模型的可编辑下拉在聊天头部第二行,接 OpenAI 兼容 + Anthropic 双协议。

## 加密存储的安全权衡

`CLAUDE.md` 明确写了:

> API key is stored **plaintext** in `userData/settings.json` (known MVP constraint — swap for Windows Credential Manager before real distribution).

实际上 v1.0 后已经走 safeStorage 加密。但 CLAUDE.md 还留着这条说明(还没更新)。实际安全性:macOS Keychain / Windows DPAPI 保护,从 settings.json 直接读到的只是加密 blob。

## 关键源文件

- `src/main/settings.ts` —— `getSettings` / `saveSettings` / `snapshot` / 加密读写
- `src/shared/types.ts:30` —— `AppSettings` 类型
- `src/renderer/settings.ts`(嵌入 app.ts) —— settings view 渲染
