> 🌐 Language: [English](Git-Integration) | **中文**

# Git 集成

主窗口「Git」tab。分两列:左 changes(working tree),右 history(默认)/ diff(点文件或 commit 后)。

## 布局

```
┌────────────────────────────────────────────────────────────┐
│ .git-head                                                  │
│ 🌿 <branch> · N 更改          [⟳ 刷新]                    │
├──────────────────────┬─────────────────────────────────────┤
│                      │                                     │
│ .git-changes         │ .git-side                           │
│ 更改(working tree) │ ├─ 默认:历史(commit log)         │
│                      │ └─ 点文件/commit:diff(带 ← 返回)│
│ M  修改  src/x.ts    │                                     │
│ A  新增  README.md   │  abc123  2026-07-12  fix: ...  me   │
│ ?? 未跟  foo.txt     │  def456  2026-07-11  feat: ...  me   │
│                      │                                     │
└──────────────────────┴─────────────────────────────────────┘
```

## 数据来源

`api.gitSnapshot(cwd)`(`src/shared/types.ts:160`)返回 `GitSnapshot`:

```ts
{
  ok: boolean;
  branch?: string;          // 当前分支名
  changes?: GitChange[];    // git status --short 解析
  log?: GitCommit[];        // git log --pretty=format:...
  error?: string;
}
```

`GitChange`:`{ path, code, staged }`(`code` 是单字符 `M/A/D/R/?/!`…)。

main 进程直接 spawn `git` 命令(走 `tools.ts` 的 spawn 逻辑,但不在 Direct 工具链里 —— 这给 renderer tab 用)。

## 左列:changes

`git status --short` 解析。每行一个文件:

- **code**(单字符 + 颜色):M(修改)/ A(新增)/ D(删除)/ R(重命名)/ ??(未跟踪)/ !(忽略)等
- **label**(i18n):「修改 / 新增 / 删除 / 重命名 / 未跟」
- **path**:相对 cwd 的路径

**点击行** → `showGitDiff({ file: path })` → 右列切到 diff 视图。

## 右列:history(默认)

`git log -20 --pretty=format:"%h|%cd|%s|%an"`。每条:

- **hash** 前 7 位(等宽字体)
- **date**(`%cd`,short format)
- **subject**(`%s`,commit message 首行)
- **author**(`%an`)

**点击行** → `showGitDiff({ hash })` → 右列切到 commit show。

## 右列:diff 视图

两种渲染方式:

### 文件 diff(左右对比)

`renderSideBySide`(`src/renderer/app.ts:456`)—— 把 unified diff 解析成对齐的「左旧 / 右新」行。

- 同一 hunk 内连续的 `-` 与 `+` 按行配对(逐对对齐)
- 多出来的用空行垫
- 不做 token 级 diff(够直观,ponytail:同段字级 diff 算法可后续加)

视觉:左侧删除行红、右侧新增行绿、共同行灰。

### commit show(unified)

`colorGitDiff`(`src/renderer/app.ts:426`)—— git show 的统一格式按行着色。

- 从首个 `diff --git` 行开始才算 diff body(commit message 里的 `- list 项` 不该被误判为删除行)
- meta(commit metadata + message)单独显示
- `+` 绿、`-` 红、`@@` hunk header 蓝、`+++`/`---` 文件名蓝

### 返回 history

diff 视图顶部有 **← 历史** 按钮,点回 history 列表。

## 点文件 / 点 commit 后的状态机

`gitState`(`src/renderer/app.ts:36`):

```ts
{
  snapshot?: GitSnapshot;                       // 最近一次抓的快照
  view: { kind: 'history' }                     // 默认
      | { kind: 'diff'; title: string; contentHTML: string };
  lastCwd: string;                              // 上次抓的 cwd(切了重抓)
}
```

- 切 cwd / 手动刷新 → 重置 view 到 history + 重抓 snapshot
- 点文件 / commit → view 切到 diff,占位先渲染「…」+ 异步加载真实 diff

## 刷新

`.git-head` 右侧 **⟳** 按钮 → 重抓 snapshot。

切会话(不同 cwd)→ 自动重抓。tab 切走再切回 → 用已有 snapshot(不重抓)。

## 限制

- **只读**:这里不能 stage / commit / push。要操作 git → 用聊天框让 agent 调 `shell` 工具,或开 Files 窗口走系统 git GUI
- **不支持 submodule / worktree 视图**:只看当前仓库根
- **commit log 固定 20 条**:不看完整 history(改 main 进程 `git log -20` 改数字)
- **diff 不支持二进制**:图片改、音频改等只显示「Binary files differ」

## 关键源文件

- `src/renderer/app.ts:329` —— `refreshGit`
- `src/renderer/app.ts:345` —— `renderGit`(列渲染 + 事件绑定)
- `src/renderer/app.ts:405` —— `showGitDiff`
- `src/renderer/app.ts:426` —— `colorGitDiff`(commit show)
- `src/renderer/app.ts:456` —— `renderSideBySide`(文件 diff)
- `src/main/main.ts` —— `git-snapshot` / `git-diff` IPC handler
- `src/renderer/index.html`(内联)—— `#chat-git-pane`
