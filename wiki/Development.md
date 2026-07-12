# 开发与打包

## 命令

```sh
npm install          # 装 + 重建 better-sqlite3 给 Electron
npm run typecheck    # 两半 typecheck,不 emit —— 主要验证步骤
npm run build        # tsc(main)+ esbuild(renderer)+ 复制静态资源
npm start            # electron .(需先 build)
npm run dev          # build + start
npm run pack         # build + electron-builder --win --dir → release/win-unpacked/
npm run dist         # build + electron-builder --win → release/KinetAios Setup <ver>.exe
```

`dist/` / `release/` / `node_modules/` 都 gitignore。

## 没有测试框架

CLAUDE.md 明确:

> 验证 = `npm run typecheck` + 启动 app(`npm start`)跑受影响流程。不要发明测试脚本。

## 平台限制(重要)

真实构建目标是 **Windows 11**(cmd.exe shell,`.cmd` shims,Windows 路径)。

- macOS 上能:`npm install` / `npm run typecheck` / `npm start`(Electron 跨平台,核心逻辑能 smoke)
- macOS 上**不能**:构建/验证 Windows 二进制或 NSIS installer(electron-builder + 原生模块重建要 Windows 工具链)

Windows-only 行为(shell / PATH / 热键)必须在 Windows 上验。

## typecheck 详解

```sh
npm run typecheck
# = tsc -p tsconfig.main.json --noEmit && tsc -p tsconfig.renderer.json
```

两半独立 typecheck:
- main 进程 + shared(typescript Node 标准)
- renderer(esbuild bundle 之前先 typecheck)

shared/types.ts 是两半都 import 的纯类型 + 纯函数模块,所以这里改一处两边都验。

## build 详解

```sh
npm run build
# = tsc -p tsconfig.main.json                           # main → dist/main/*.js
# + esbuild src/renderer/app.ts quick.ts dashboard.ts files.ts \
#           --bundle --format=iife --outdir=dist/renderer
# + 复制 src/renderer/(非 .ts)到 dist/renderer/        # html / css / 图片等
# + copy brand.json → dist/brand.json
```

`dist/` 是运行时根,`package.json` 的 `main` 指向 `dist/main/main.js`。**没 build 就 `npm start` 不工作**。

## pack vs dist

| 命令 | 产物 | 用途 |
|---|---|---|
| `npm run pack` | `release/win-unpacked/KinetAios.exe`(整个目录) | 本地试装,看 electron-builder 打出来能不能跑 |
| `npm run dist` | `release/KinetAios Setup <ver>.exe`(NSIS installer) | 真分发,单文件安装 |

`scripts/pack.js` 给 electron-builder 加 `--publish never`(防 CI 自动 publish)。

## CI(GitHub Actions)

`.github/workflows/release.yml`:

- matrix:`windows-latest` + `macos-latest`
- 步骤:setup-node 18 → npm install → npm run build → npm run dist(各平台默认 target)
- artifact:上传 setup.exe / .dmg
- 发布到 Release(softprops/action-gh-release@v2,**需要 `permissions: contents: write`**)

CI 失败排查见 `ci-debug-v1.0.0.md`(v1.0 调试 postmortem)。

## 原生模块(better-sqlite3)

`package.json` 的 postinstall 跑 `electron-builder install-app-deps`,重建 better-sqlite3 给 Electron 的 ABI 用。

打包时 `electron-builder` 自动重建;`asar: false` 避免 native module 从 asar 里加载报错。

## brand 配置

`brand.json`(根目录):

```json
{ "productName": "KinetAios", ... }
```

`src/main/brand.ts` 启动时读。`baseSystemPrompt` 里 `${getBrand().productName}` 自动用,UI 各处也是。改名只需要改这一个文件。

## 加 main↔renderer 能力

参考 [[Architecture]] 的「KinetAPI:三层契约」——三处同步改:

1. `src/shared/types.ts` 的 `KinetAPI` 加方法签名
2. `src/preload/preload.ts` 加 `ipcRenderer.invoke` / `on`
3. `src/main/main.ts` 加 `ipcMain.handle` / `on`

typecheck 通过 = 三处对得上。

## 加 Direct 工具

参考 [[Tools-and-MCP]] 的「何时扩展工具」——一处改:

1. `src/main/tools.ts` 加 `Tool` 实现
2. 加进 `allTools()` / `readOnlyTools()`

ReAct loop 自动发现。typecheck 通过即可。

## 加 UI 语言 / i18n key

参考 [[i18n]] 的「加新语言 / 加新 key」。

## 已知约束(CLAUDE.md 列的)

- **关窗即退**:无后台驻留;热键只在 app 运行时生效
- **API key 加密**但 CLAUDE.md 文档没更新(之前是明文,现已 safeStorage)
- **代码索引 / 语义检索 / 图片多模态 / IDE 插件**在 `IMPROVEMENTS.md` roadmap,未做
- **Mac→Windows 跨平台构建原生模块不可靠** —— Windows installer 必须在 Windows 机器或 `windows-latest` CI 上打

## 提交规范

直接提交到 main,不开分支(项目当前阶段)。看 `git log` 是中英混合但偏中文:

```
refactor(direct): memory 从 systemPrompt 移到 history[0]
fix: 切换 HTML 文件时 webview 不刷新
feat: 长期记忆面板(🧠)
```

类型前缀:`feat` / `fix` / `refactor` / `style` / `docs` / `chore` / `perf`。
