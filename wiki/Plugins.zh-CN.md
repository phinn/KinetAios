> 🌐 语言:**中文** | [English](Plugins.md)

# 插件引擎(SDK v3)

从 SDK v3 起,**任意外部 CLI agent 都能注册为 KinetAios 引擎** —— 零 JS 代码,`plugin.json` 里一个声明式 `engine` 字段即可。插件的 CLI 会以 `plugin:<name>` 出现在引擎下拉里,流式 token、工具事件、会话续接、成本追踪 —— 内置 CLI 引擎(Claude Code / Codex)有的它都有。

本页面向**使用**插件引擎的用户。插件开发全流程(工具 / slash 命令 / 面板)见仓库根目录的 [`KinetAiosPlugin.md`](../KinetAiosPlugin.md)。

## 快速上手

1. 把插件目录放到 `<userData>/plugins/<name>/`(设置 → 插件 页显示确切路径)。
2. 插件的 `plugin.json` 声明 `engine` 块(见下)。
3. 设置 → 行为 里开启 "启用 CLI 引擎"(插件引擎与内置 CLI 引擎共用此开关)。
4. 会话头部引擎下拉里选 `plugin:<name>`,显示名为 spec 的 `label`。

安装 / 卸载 / 启用 / 禁用后引擎表**热重建**,无需重启 app。正在运行的会话持有旧引擎引用跑完,不受影响。

## `engine` spec

```jsonc
{
  "name": "my-agent",
  "version": "1.0.0",
  "engine": {
    "bin": "my-agent",                    // CLI 名,从 PATH + 常见安装目录解析
    "protocol": "plain",                  // ndjson | jsonl-claude | jsonl-codex | plain(默认)
    "args": ["--no-color"],               // argv 前缀,prompt 之前
    "cwdFlags": ["-C", "{cwd}"],          // {cwd} 占位符 = 会话工作目录
    "inject": "prompt",                   // prompt(默认)| system
    "resume": { "idField": "session_id", "resumeFlag": "--resume", "mode": "flag" },
    "label": "My Agent"                   // 下拉 / NEXUS 显示名
  }
}
```

### 协议预设

| protocol | 行格式 | 适用 |
|---|---|---|
| `ndjson` | 每行一个 JSON 对象:`{"type":"token","text":..}`、`{"type":"tool",...}`、`{"type":"cost",...}`、`{"type":"done"}`、`{"type":"error","message":..}` | 自己写的 CLI |
| `jsonl-claude` | 兼容 `claude -p --output-format stream-json` | claude 协议的 agent |
| `jsonl-codex` | 兼容 `codex exec --json` | codex 协议的 agent |
| `plain` | 整段 stdout 当答案文本 | 普通 CLI(git、ripgrep 包装等) |

### 会话续接

- `resume.idField` 声明携带 session id 的事件字段(来自 `sessionStarted` 事件)。引擎发出后,KinetAios 把 id 存进 `conv.engineSessionId`,下一轮自动追加续接参数。
- `mode: "flag"`(默认)→ `--resume <id>`;`mode: "subcommand"` → `resumeFlag` 按空格切开后前置,如 `"session resume"` → `my-agent session resume <id> <prompt>`(codex 式子命令)。

### 上下文注入

- `inject: "prompt"`(默认,codex 式):persona + 项目规则 + 记忆用 `---` 分隔后拼在 prompt 前。
- `inject: "system"`:注入块走 `systemFlag`(默认 `--append-system-prompt`)作为独立 argv 对 —— claude 式。

## 行为要点

- **Windows `.cmd` 垫片**走 `shell: true`(与 claude/codex 相同);真正的 `.exe`/unix 二进制直接 spawn。中止时杀整棵进程树(`taskkill /T /F`)。
- **plain 协议**:stderr 从答案流中**剥离**;CLI 非零退出时,最后 8 行 stderr 拼进错误信息。退出码 0 且无终态事件 = 完成。
- **非法 spec**(protocol 拼错、bin 缺失、resume 残缺)—— 引擎不注册;设置页插件卡片显示红色徽章,悬停看具体原因。
- **重名冲突**:两个插件贡献同名引擎,后者覆盖(与工具摊平同语义)。
- 贡献引擎的插件,manifest 的 `engines` 字段被忽略(引擎本身即入口)。

## 内置示例

仓库 `plugins/examples/git-agent/` 把裸 `git` 包装成引擎(`plain` 协议,`-C {cwd}` 工作目录)。它是全链路的参考实现:manifest → 引擎注册表 → 下拉 → plain 协议 token 流。

## 相关

- [[Engines]] —— 内置引擎与共享的 CliEngineAdapter 骨架
- [`KinetAiosPlugin.md`](../KinetAiosPlugin.md) —— 插件开发完整 SOP(分类、工具、slash 命令、面板)
