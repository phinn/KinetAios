// i18n — four-language string table + t(). Pure TS (no Node/DOM APIs) so both
// main (CJS) and renderer (bundled) can import it, matching the shared/ convention.
//
// 范围:只覆盖用户可见 UI 字符串。给模型看的(system prompt / tool description /
// memory prompt / tool run() 返回值)一律保持中文,不进这个表。
// 插值:用 {name} 占位,t(lang, key, { name }) 替换。

export type Lang = 'en' | 'zh-CN' | 'zh-TW' | 'ja';

// 语言下拉用(选项文案本身不翻译,各语言用母语显示自己的名字)。
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'zh-CN', label: '简体中文' },
  { id: 'zh-TW', label: '繁體中文' },
  { id: 'ja', label: '日本語' },
];

type Dict = Record<string, string>;

// 简体中文是源(=现有文案),其它语言以此为基准翻译。
const ZH_CN: Dict = {
  'common.cancel': '取消',
  'common.ok': '确定',
  'common.send': '发送',
  'common.stop': '停止',

  'sidebar.newSession': '新建会话',
  'sidebar.settings': '设置',
  'sidebar.empty': '还没有会话 — 点 ＋ 新建',

  'head.clear': '清空当前会话',
  'head.delete': '删除会话',
  'head.clearBtn': '清空',
  'head.deleteBtn': '删除',
  'head.engine': '引擎',
  'head.cwdTitle': '工作目录(回车应用或点 📁 选)',
  'head.cwdPh': '工作目录',
  'head.pickDir': '选择目录',
  'head.newConv': '新会话',

  'composer.placeholder': '给 {product} 下达任务…  (Enter 发送,Shift+Enter 换行;可拖入文件)',

  'attach.title': '添加文件(可多选 / 可拖入)',
  'attach.lbl': '附件',
  'attach.dirAlert': '暂不支持文件夹,请拖单个文件(可多选),或用 📎 选择。',
  'attach.missingAlert': '这些 @文件 没读到(不存在 / 非文本 / 不在工作目录内):\n{list}',

  'model.title': '模型(Direct 引擎,每会话独立;回车应用)',
  'model.ph': '模型',

  'skill.title': '选择 Skill(Direct)',
  'skill.lbl': 'Skill',
  'skill.noMatch': '无匹配 skill',
  'quick.placeholder': '⌘/Ctrl+Alt+Space 唤出。输入任务,Enter 发送…',
  'quick.hint': '答案流式显示在下方;完整对话在主窗口。',
  'dash.title': '仪表盘',
  'dash.open': '打开仪表盘',
  'dash.sessions': '会话',
  'dash.running': '运行中',
  'dash.tokens': 'Token',
  'dash.cost': '费用',
  'dash.byEngine': '按引擎',
  'dash.col.name': '会话',
  'dash.col.engine': '引擎',
  'dash.col.model': '模型',
  'dash.col.status': '状态',
  'dash.col.activity': '当前动作',
  'dash.col.tokens': 'Token',
  'dash.col.cost': '费用',
  'dash.col.last': '最后活动',
  'dash.status.ready': '就绪',
  'dash.status.running': '运行中',
  'dash.empty': '还没有会话',
  'dash.noActivity': '空闲',

  'mcp.title': 'MCP 服务与工具',
  'mcp.lbl': 'MCP',
  'mcp.noTools': '(无工具)',
  'mcp.empty': '未连接 MCP 服务。<br>在 ~/.claude.json / ~/.codex/config.toml 配置后,启动时自动接入。',

  'modal.title': '要执行 shell 命令?',
  'modal.noask': '不再询问(之后自动放行所有 shell 命令)',
  'modal.ok': '执行',

  'prompt.rename': '改名',
  'prompt.nameTitle': '会话名(留空用首条消息)',
  'prompt.deleteFallback': '此会话',
  'prompt.deleteConfirm': '删除「{name}」?不可恢复。',

  'empty.noConv': '选择一个会话,或点 ＋ 新建',
  'empty.noTurns': '输入任务开始',

  'conv.rename': '改名',
  'conv.delete': '删除',

  'engine.switchConfirm': '切换引擎会清空当前上下文(Direct 对话历史 / Claude·Codex 的会话续接)。继续?',

  'settings.back': '← 返回对话',
  'settings.title': '设置',
  'settings.sub': 'Direct 引擎走 OpenAI 兼容或 Anthropic 协议的端点。',
  'settings.lang': '语言',
  'settings.preset': 'Provider 预设',
  'settings.modelId': '模型 ID',
  'settings.protocol': '协议',
  'settings.proto.openai': 'OpenAI 兼容',
  'settings.approval': 'shell 执行确认',
  'settings.approval.always': '每次确认',
  'settings.approval.never': '从不(自动放行)',
  'settings.sandbox': 'Claude Code / Codex 沙盒',
  'settings.sandbox.readOnly': '只读(规划)',
  'settings.sandbox.workspaceWrite': '工作区写入',
  'settings.sandbox.fullAccess': '完全访问',
  'settings.plan': '计划模式(只规划不执行)',
  'settings.cli': '启用 Claude Code / Codex 引擎(需本地装好 CLI,默认关)',
  'settings.price': '价格(USD / 1M tokens)·0=内置默认',
  'settings.save': '保存',
  'settings.test': '测试连接',
  'settings.saved': '已保存',
  'settings.testing': '测试中…',

  'preset.glm': 'GLM 智谱',
  'preset.qwen': '阿里通义 (DashScope)',
  'preset.custom': '自定义',
  'preset.deepseek': 'DeepSeek',

  // ---- main 层用户可见消息 ----
  'tray.show': '显示主窗口',
  'tray.quick': 'Quick 面板',
  'tray.quit': '退出',
  'readfile.outOfPath': '路径必须在工作目录内',
  'testConn.ok': '连接成功',

  'tmgr.cancelled': '已取消',
  'tmgr.stopped': '已停止',
  'tmgr.badCwd': '工作目录不存在或不是目录: {cwd}',
  'tmgr.engineDisabled': '未启用该引擎 — 在设置里打开「启用 Claude Code / Codex」。',
  'tmgr.unknownEngine': '未知引擎: {engine}',
  'tmgr.skillLoaded': '已加载 skill: {name}',

  'eng.claudeNotFound': '找不到 claude CLI。装 Claude Code(npm i -g @anthropic-ai/claude-code)或把它加进 PATH。',
  'eng.codexNotFound': '找不到 codex CLI。装 OpenAI Codex 或加进 PATH。',
  'eng.requesting': '请求中…',
  'eng.claudeError': 'claude 执行出错',
  'eng.claudeNoResult': 'claude 未返回结果(被中断 / 超时 / 或 flags 不被当前版本支持)',
  'eng.codexFailed': 'codex 轮失败',
  'eng.codexMsg': 'codex: {msg}',
  'eng.codexNoResult': 'codex 未返回结果(status={code}){tail}',
  'eng.apiRetry': '模型 {error}(HTTP {status}),重试 {attempt}/{max}…',

  'al.ctxTooLong': '上下文过长,已压缩历史并重试。',
  'al.maxTurns': '达到最大轮数({max}),停止 — 任务太复杂,可拆分后继续。',
  'al.noKey': '未设置 API Key — 打开设置填入 key。',
  'al.httpErr': 'HTTP {code}{detail} — 检查 API key / 模型 id / 网络。',
  'al.err': '出错: {msg}',
};

const EN: Dict = {
  'common.cancel': 'Cancel',
  'common.ok': 'OK',
  'common.send': 'Send',
  'common.stop': 'Stop',

  'sidebar.newSession': 'New session',
  'sidebar.settings': 'Settings',
  'sidebar.empty': 'No sessions yet — click + to create one',

  'head.clear': 'Clear current session',
  'head.delete': 'Delete session',
  'head.clearBtn': 'Clear',
  'head.deleteBtn': 'Delete',
  'head.engine': 'Engine',
  'head.cwdTitle': 'Working directory (Enter to apply, or 📁 to pick)',
  'head.cwdPh': 'Working directory',
  'head.pickDir': 'Pick directory',
  'head.newConv': 'New session',

  'composer.placeholder': 'Give {product} a task…  (Enter to send, Shift+Enter for newline; files can be dropped)',

  'attach.title': 'Add files (multi-select / drop)',
  'attach.lbl': 'Files',
  'attach.dirAlert': "Folders aren't supported — drop individual files (multi-ok), or use 📎.",
  'attach.missingAlert': "These @files couldn't be read (missing / non-text / outside cwd):\n{list}",

  'model.title': 'Model (Direct engine, per-session; Enter to apply)',
  'model.ph': 'Model',

  'skill.title': 'Pick a skill (Direct)',
  'skill.lbl': 'Skill',
  'skill.noMatch': 'No matching skill',
  'quick.placeholder': '⌘/Ctrl+Alt+Space to summon. Type a task, Enter to send…',
  'quick.hint': 'Answers stream below; the full conversation lives in the main window.',
  'dash.title': 'Dashboard',
  'dash.open': 'Open dashboard',
  'dash.sessions': 'Sessions',
  'dash.running': 'Running',
  'dash.tokens': 'Tokens',
  'dash.cost': 'Cost',
  'dash.byEngine': 'By engine',
  'dash.col.name': 'Session',
  'dash.col.engine': 'Engine',
  'dash.col.model': 'Model',
  'dash.col.status': 'Status',
  'dash.col.activity': 'Activity',
  'dash.col.tokens': 'Tokens',
  'dash.col.cost': 'Cost',
  'dash.col.last': 'Last active',
  'dash.status.ready': 'Ready',
  'dash.status.running': 'Running',
  'dash.empty': 'No sessions yet',
  'dash.noActivity': 'Idle',

  'mcp.title': 'MCP services & tools',
  'mcp.lbl': 'MCP',
  'mcp.noTools': '(no tools)',
  'mcp.empty': 'No MCP services connected.<br>Configure in ~/.claude.json / ~/.codex/config.toml — auto-loaded at startup.',

  'modal.title': 'Run this shell command?',
  'modal.noask': "Don't ask again (auto-approve all shell commands)",
  'modal.ok': 'Run',

  'prompt.rename': 'Rename',
  'prompt.nameTitle': 'Session name (blank = use first message)',
  'prompt.deleteFallback': 'this session',
  'prompt.deleteConfirm': 'Delete "{name}"? This cannot be undone.',

  'empty.noConv': 'Pick a session, or click + to create',
  'empty.noTurns': 'Type a task to start',

  'conv.rename': 'Rename',
  'conv.delete': 'Delete',

  'engine.switchConfirm': 'Switching engines clears the current context (Direct history / Claude·Codex session resume). Continue?',

  'settings.back': '← Back to chat',
  'settings.title': 'Settings',
  'settings.sub': 'The Direct engine talks to any OpenAI-compatible or Anthropic endpoint.',
  'settings.lang': 'Language',
  'settings.preset': 'Provider preset',
  'settings.modelId': 'Model ID',
  'settings.protocol': 'Protocol',
  'settings.proto.openai': 'OpenAI-compatible',
  'settings.approval': 'Shell approval',
  'settings.approval.always': 'Ask every time',
  'settings.approval.never': 'Never (auto-approve)',
  'settings.sandbox': 'Claude Code / Codex sandbox',
  'settings.sandbox.readOnly': 'Read-only (plan)',
  'settings.sandbox.workspaceWrite': 'Workspace write',
  'settings.sandbox.fullAccess': 'Full access',
  'settings.plan': 'Plan mode (plan only, no execution)',
  'settings.cli': 'Enable Claude Code / Codex engines (requires local CLI, off by default)',
  'settings.price': 'Price (USD / 1M tokens) · 0 = built-in default',
  'settings.save': 'Save',
  'settings.test': 'Test connection',
  'settings.saved': 'Saved',
  'settings.testing': 'Testing…',

  'preset.glm': 'GLM (Zhipu)',
  'preset.qwen': 'Alibaba Qwen (DashScope)',
  'preset.custom': 'Custom',
  'preset.deepseek': 'DeepSeek',

  'tray.show': 'Show main window',
  'tray.quick': 'Quick panel',
  'tray.quit': 'Quit',
  'readfile.outOfPath': 'Path must be inside the working directory',
  'testConn.ok': 'Connection OK',

  'tmgr.cancelled': 'Cancelled',
  'tmgr.stopped': 'Stopped',
  'tmgr.badCwd': "Working directory doesn't exist or isn't a directory: {cwd}",
  'tmgr.engineDisabled': 'Engine not enabled — turn on "Enable Claude Code / Codex" in settings.',
  'tmgr.unknownEngine': 'Unknown engine: {engine}',
  'tmgr.skillLoaded': 'Loaded skill: {name}',

  'eng.claudeNotFound': 'claude CLI not found. Install Claude Code (npm i -g @anthropic-ai/claude-code) or add it to PATH.',
  'eng.codexNotFound': 'codex CLI not found. Install OpenAI Codex or add it to PATH.',
  'eng.requesting': 'Requesting…',
  'eng.claudeError': 'claude execution error',
  'eng.claudeNoResult': 'claude returned no result (interrupted / timed out / or unsupported flags)',
  'eng.codexFailed': 'codex turn failed',
  'eng.codexMsg': 'codex: {msg}',
  'eng.codexNoResult': 'codex returned no result (status={code}){tail}',
  'eng.apiRetry': 'Model {error} (HTTP {status}), retry {attempt}/{max}…',

  'al.ctxTooLong': 'Context too long — compacted history and retrying.',
  'al.maxTurns': 'Max turns ({max}) reached — task too complex, split and continue.',
  'al.noKey': 'No API key set — open settings to add one.',
  'al.httpErr': 'HTTP {code}{detail} — check API key / model id / network.',
  'al.err': 'Error: {msg}',
};

const ZH_TW: Dict = {
  'common.cancel': '取消',
  'common.ok': '確定',
  'common.send': '傳送',
  'common.stop': '停止',

  'sidebar.newSession': '新建工作階段',
  'sidebar.settings': '設定',
  'sidebar.empty': '還沒有工作階段 — 點 ＋ 新建',

  'head.clear': '清空當前工作階段',
  'head.delete': '刪除工作階段',
  'head.clearBtn': '清空',
  'head.deleteBtn': '刪除',
  'head.engine': '引擎',
  'head.cwdTitle': '工作目錄(Enter 套用或點 📁 選)',
  'head.cwdPh': '工作目錄',
  'head.pickDir': '選擇目錄',
  'head.newConv': '新工作階段',

  'composer.placeholder': '給 {product} 下達任務…  (Enter 傳送,Shift+Enter 換行;可拖入檔案)',

  'attach.title': '新增檔案(可多選 / 可拖入)',
  'attach.lbl': '附件',
  'attach.dirAlert': '暫不支援資料夾,請拖單個檔案(可多選),或用 📎 選擇。',
  'attach.missingAlert': '這些 @檔案 沒讀到(不存在 / 非文字 / 不在工作目錄內):\n{list}',

  'model.title': '模型(Direct 引擎,每工作階段獨立;Enter 套用)',
  'model.ph': '模型',

  'skill.title': '選擇 Skill(Direct)',
  'skill.lbl': 'Skill',
  'skill.noMatch': '無匹配 skill',
  'quick.placeholder': '⌘/Ctrl+Alt+Space 喚出。輸入任務,Enter 傳送…',
  'quick.hint': '答案串流顯示在下方;完整對話在主視窗。',
  'dash.title': '儀表板',
  'dash.open': '開啟儀表板',
  'dash.sessions': '工作階段',
  'dash.running': '執行中',
  'dash.tokens': 'Token',
  'dash.cost': '費用',
  'dash.byEngine': '依引擎',
  'dash.col.name': '工作階段',
  'dash.col.engine': '引擎',
  'dash.col.model': '模型',
  'dash.col.status': '狀態',
  'dash.col.activity': '目前動作',
  'dash.col.tokens': 'Token',
  'dash.col.cost': '費用',
  'dash.col.last': '最後活動',
  'dash.status.ready': '就緒',
  'dash.status.running': '執行中',
  'dash.empty': '還沒有工作階段',
  'dash.noActivity': '閒置',

  'mcp.title': 'MCP 服務與工具',
  'mcp.lbl': 'MCP',
  'mcp.noTools': '(無工具)',
  'mcp.empty': '未連接 MCP 服務。<br>在 ~/.claude.json / ~/.codex/config.toml 設定後,啟動時自動接入。',

  'modal.title': '要執行 shell 命令?',
  'modal.noask': '不再詢問(之後自動放行所有 shell 命令)',
  'modal.ok': '執行',

  'prompt.rename': '改名',
  'prompt.nameTitle': '工作階段名(留空用首條訊息)',
  'prompt.deleteFallback': '此工作階段',
  'prompt.deleteConfirm': '刪除「{name}」?無法復原。',

  'empty.noConv': '選擇一個工作階段,或點 ＋ 新建',
  'empty.noTurns': '輸入任務開始',

  'conv.rename': '改名',
  'conv.delete': '刪除',

  'engine.switchConfirm': '切換引擎會清空當前情境(Direct 對話歷史 / Claude·Codex 的工作階段續接)。繼續?',

  'settings.back': '← 返回對話',
  'settings.title': '設定',
  'settings.sub': 'Direct 引擎走 OpenAI 相容或 Anthropic 協定的端點。',
  'settings.lang': '語言',
  'settings.preset': 'Provider 預設',
  'settings.modelId': '模型 ID',
  'settings.protocol': '協定',
  'settings.proto.openai': 'OpenAI 相容',
  'settings.approval': 'shell 執行確認',
  'settings.approval.always': '每次確認',
  'settings.approval.never': '從不(自動放行)',
  'settings.sandbox': 'Claude Code / Codex 沙盒',
  'settings.sandbox.readOnly': '唯讀(規劃)',
  'settings.sandbox.workspaceWrite': '工作區寫入',
  'settings.sandbox.fullAccess': '完全存取',
  'settings.plan': '計畫模式(只規劃不執行)',
  'settings.cli': '啟用 Claude Code / Codex 引擎(需本地裝好 CLI,預設關)',
  'settings.price': '價格(USD / 1M tokens)·0=內建預設',
  'settings.save': '儲存',
  'settings.test': '測試連線',
  'settings.saved': '已儲存',
  'settings.testing': '測試中…',

  'preset.glm': 'GLM 智譜',
  'preset.qwen': '阿里通義 (DashScope)',
  'preset.custom': '自訂',
  'preset.deepseek': 'DeepSeek',

  'tray.show': '顯示主視窗',
  'tray.quick': 'Quick 面板',
  'tray.quit': '結束',
  'readfile.outOfPath': '路徑必須在工作目錄內',
  'testConn.ok': '連線成功',

  'tmgr.cancelled': '已取消',
  'tmgr.stopped': '已停止',
  'tmgr.badCwd': '工作目錄不存在或不是目錄: {cwd}',
  'tmgr.engineDisabled': '未啟用該引擎 — 在設定裡打開「啟用 Claude Code / Codex」。',
  'tmgr.unknownEngine': '未知引擎: {engine}',
  'tmgr.skillLoaded': '已載入 skill: {name}',

  'eng.claudeNotFound': '找不到 claude CLI。裝 Claude Code(npm i -g @anthropic-ai/claude-code)或把它加進 PATH。',
  'eng.codexNotFound': '找不到 codex CLI。裝 OpenAI Codex 或加進 PATH。',
  'eng.requesting': '請求中…',
  'eng.claudeError': 'claude 執行出錯',
  'eng.claudeNoResult': 'claude 未回傳結果(被中斷 / 超時 / 或 flags 不被當前版本支援)',
  'eng.codexFailed': 'codex 輪失敗',
  'eng.codexMsg': 'codex: {msg}',
  'eng.codexNoResult': 'codex 未回傳結果(status={code}){tail}',
  'eng.apiRetry': '模型 {error}(HTTP {status}),重試 {attempt}/{max}…',

  'al.ctxTooLong': '上下文過長,已壓縮歷史並重試。',
  'al.maxTurns': '達到最大輪數({max}),停止 — 任務太複雜,可拆分後繼續。',
  'al.noKey': '未設定 API Key — 打開設定填入 key。',
  'al.httpErr': 'HTTP {code}{detail} — 檢查 API key / 模型 id / 網路。',
  'al.err': '出錯: {msg}',
};

const JA: Dict = {
  'common.cancel': 'キャンセル',
  'common.ok': 'OK',
  'common.send': '送信',
  'common.stop': '停止',

  'sidebar.newSession': '新規セッション',
  'sidebar.settings': '設定',
  'sidebar.empty': 'セッションがありません — ＋ で新規作成',

  'head.clear': '現在のセッションをクリア',
  'head.delete': 'セッションを削除',
  'head.clearBtn': 'クリア',
  'head.deleteBtn': '削除',
  'head.engine': 'エンジン',
  'head.cwdTitle': '作業ディレクトリ(Enter で適用、📁 で選択)',
  'head.cwdPh': '作業ディレクトリ',
  'head.pickDir': 'ディレクトリを選択',
  'head.newConv': '新規セッション',

  'composer.placeholder': '{product} にタスクを…  (Enter で送信、Shift+Enter で改行、ファイルもドロップ可)',

  'attach.title': 'ファイルを追加(複数可 / ドロップ可)',
  'attach.lbl': '添付',
  'attach.dirAlert': 'フォルダは未対応です — 個別ファイルをドロップ(複数可)するか 📎 で選択してください。',
  'attach.missingAlert': '以下の @ファイル が読めませんでした(不在 / 非テキスト / 作業ディレクトリ外):\n{list}',

  'model.title': 'モデル(Direct エンジン、セッション単位、Enter で適用)',
  'model.ph': 'モデル',

  'skill.title': 'Skill を選択(Direct)',
  'skill.lbl': 'Skill',
  'skill.noMatch': '一致する skill なし',
  'quick.placeholder': '⌘/Ctrl+Alt+Space で呼び出し。タスクを入力、Enter で送信…',
  'quick.hint': '回答は下記にストリーミング表示。完全な会話はメインウィンドウにあります。',
  'dash.title': 'ダッシュボード',
  'dash.open': 'ダッシュボードを開く',
  'dash.sessions': 'セッション',
  'dash.running': '実行中',
  'dash.tokens': 'Token',
  'dash.cost': 'コスト',
  'dash.byEngine': 'エンジン別',
  'dash.col.name': 'セッション',
  'dash.col.engine': 'エンジン',
  'dash.col.model': 'モデル',
  'dash.col.status': 'ステータス',
  'dash.col.activity': '現在の動作',
  'dash.col.tokens': 'Token',
  'dash.col.cost': 'コスト',
  'dash.col.last': '最終アクティビティ',
  'dash.status.ready': '準備完了',
  'dash.status.running': '実行中',
  'dash.empty': 'セッションがまだありません',
  'dash.noActivity': 'アイドル',

  'mcp.title': 'MCP サービスとツール',
  'mcp.lbl': 'MCP',
  'mcp.noTools': '(ツールなし)',
  'mcp.empty': 'MCP サービス未接続。<br>~/.claude.json / ~/.codex/config.toml で設定すると起動時に自動接続します。',

  'modal.title': 'この shell コマンドを実行しますか?',
  'modal.noask': '次回から確認しない(以降の shell コマンドを自動許可)',
  'modal.ok': '実行',

  'prompt.rename': '名前変更',
  'prompt.nameTitle': 'セッション名(空欄なら最初のメッセージを使用)',
  'prompt.deleteFallback': 'このセッション',
  'prompt.deleteConfirm': '「{name}」を削除します?元に戻せません。',

  'empty.noConv': 'セッションを選ぶか、＋ で新規作成',
  'empty.noTurns': 'タスクを入力して開始',

  'conv.rename': '名前変更',
  'conv.delete': '削除',

  'engine.switchConfirm': 'エンジン切り替えで現在のコンテキストがクリアされます(Direct 履歴 / Claude·Codex のセッション再開)。続けますか?',

  'settings.back': '← チャットへ戻る',
  'settings.title': '設定',
  'settings.sub': 'Direct エンジンは OpenAI 互換または Anthropic のエンドポイントに接続します。',
  'settings.lang': '言語',
  'settings.preset': 'Provider プリセット',
  'settings.modelId': 'モデル ID',
  'settings.protocol': 'プロトコル',
  'settings.proto.openai': 'OpenAI 互換',
  'settings.approval': 'shell 実行確認',
  'settings.approval.always': '毎回確認',
  'settings.approval.never': 'なし(自動許可)',
  'settings.sandbox': 'Claude Code / Codex サンドボックス',
  'settings.sandbox.readOnly': '読み取り専用(計画)',
  'settings.sandbox.workspaceWrite': 'ワークスペース書き込み',
  'settings.sandbox.fullAccess': 'フルアクセス',
  'settings.plan': '計画モード(計画のみで実行しない)',
  'settings.cli': 'Claude Code / Codex エンジンを有効化(ローカル CLI 必要、デフォルトオフ)',
  'settings.price': '価格(USD / 1M tokens)・0=内蔵デフォルト',
  'settings.save': '保存',
  'settings.test': '接続テスト',
  'settings.saved': '保存しました',
  'settings.testing': 'テスト中…',

  'preset.glm': 'GLM (Zhipu)',
  'preset.qwen': 'Alibaba Qwen (DashScope)',
  'preset.custom': 'カスタム',
  'preset.deepseek': 'DeepSeek',

  'tray.show': 'メインウィンドウを表示',
  'tray.quick': 'Quick パネル',
  'tray.quit': '終了',
  'readfile.outOfPath': 'パスは作業ディレクトリ内である必要があります',
  'testConn.ok': '接続成功',

  'tmgr.cancelled': 'キャンセルしました',
  'tmgr.stopped': '停止しました',
  'tmgr.badCwd': '作業ディレクトリが存在しないかディレクトリではありません: {cwd}',
  'tmgr.engineDisabled': 'エンジンが無効です — 設定で「Claude Code / Codex を有効化」をオンにしてください。',
  'tmgr.unknownEngine': '不明なエンジン: {engine}',
  'tmgr.skillLoaded': 'skill を読み込みました: {name}',

  'eng.claudeNotFound': 'claude CLI が見つかりません。Claude Code をインストール(npm i -g @anthropic-ai/claude-code)するか PATH に追加してください。',
  'eng.codexNotFound': 'codex CLI が見つかりません。OpenAI Codex をインストールするか PATH に追加してください。',
  'eng.requesting': 'リクエスト中…',
  'eng.claudeError': 'claude 実行エラー',
  'eng.claudeNoResult': 'claude が結果を返しませんでした(中断 / タイムアウト / または未サポートの flags)',
  'eng.codexFailed': 'codex ターン失敗',
  'eng.codexMsg': 'codex: {msg}',
  'eng.codexNoResult': 'codex が結果を返しませんでした(status={code}){tail}',
  'eng.apiRetry': 'モデル {error}(HTTP {status})、リトライ {attempt}/{max}…',

  'al.ctxTooLong': 'コンテキストが長すぎます — 履歴を圧縮して再試行します。',
  'al.maxTurns': '最大ターン数({max})に達しました — タスクが複雑すぎます、分割して続けてください。',
  'al.noKey': 'API キー未設定 — 設定を開いてキーを入力してください。',
  'al.httpErr': 'HTTP {code}{detail} — API キー / モデル id / ネットワークを確認してください。',
  'al.err': 'エラー: {msg}',
};

export const STRINGS: Record<Lang, Dict> = {
  en: EN,
  'zh-CN': ZH_CN,
  'zh-TW': ZH_TW,
  ja: JA,
};

// 翻译查找。缺 key 时回退到 zh-CN(源),再缺就返回 key 本身(开发期可见漏译)。
export function t(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const dict = STRINGS[lang] ?? ZH_CN;
  let s = dict[key] ?? ZH_CN[key] ?? key;
  if (params) {
    for (const k of Object.keys(params)) {
      s = s.split('{' + k + '}').join(String(params[k]));
    }
  }
  return s;
}
