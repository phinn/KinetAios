> 🌐 Language: **English** | [中文](Development.zh-CN.md)

# Development & Packaging

## Commands

```sh
npm install          # installs + rebuilds better-sqlite3 for Electron
npm run typecheck    # typechecks both halves, no emit — primary verification
npm run build        # tsc (main) + esbuild (renderer) + copy static assets
npm start            # electron .  (requires a prior build)
npm run dev          # build + start
npm run pack         # build + electron-builder --win --dir → release/win-unpacked/
npm run dist         # build + electron-builder --win → release/KinetAios Setup <ver>.exe
```

`dist/`, `release/`, `node_modules/` are all gitignored.

## No test framework

CLAUDE.md is explicit:

> Verification = `npm run typecheck` + launching the app (`npm start`) and driving the affected flow. Don't invent test scripts.

## Platform caveat (important)

The real build target is **Windows 11** (cmd.exe shell, `.cmd` shims, Windows paths).

- On macOS you can: `npm install` / `npm run typecheck` / `npm start` (Electron is cross-platform; core logic smokes fine)
- On macOS you **cannot**: build/verify a Windows binary or NSIS installer (electron-builder + the native module rebuild need a Windows toolchain)

Windows-only behavior (shell / PATH / hotkey) must be verified on Windows.

## typecheck details

```sh
npm run typecheck
# = tsc -p tsconfig.main.json --noEmit && tsc -p tsconfig.renderer.json
```

Two independent halves:
- main process + shared (standard Node TypeScript)
- renderer (typechecked before esbuild bundles)

`shared/types.ts` is the pure-types + pure-functions module both halves import, so a change here is validated by both.

## build details

```sh
npm run build
# = tsc -p tsconfig.main.json                           # main → dist/main/*.js
# + esbuild src/renderer/app.ts quick.ts dashboard.ts files.ts \
#           --bundle --format=iife --outdir=dist/renderer
# + copy src/renderer/ (non-.ts) → dist/renderer/        # html / css / images
# + copy brand.json → dist/brand.json
```

`dist/` is the runtime root; `package.json` `main` points to `dist/main/main.js`. **No build = `npm start` fails.**

## pack vs dist

| Command | Output | Use |
|---|---|---|
| `npm run pack` | `release/win-unpacked/KinetAios.exe` (whole dir) | Local trial install, sanity-check electron-builder output |
| `npm run dist` | `release/KinetAios Setup <ver>.exe` (NSIS installer) | Real distribution, single-file installer |

`scripts/pack.js` adds `--publish never` to electron-builder (prevents accidental CI publish).

## CI (GitHub Actions)

`.github/workflows/release.yml`:

- matrix: `windows-latest` + `macos-latest`
- steps: setup-node 18 → npm install → npm run build → npm run dist (each platform's default target)
- artifact: upload setup.exe / .dmg
- publish to Release (softprops/action-gh-release@v2, **needs `permissions: contents: write`**)

CI failure postmortem: see `ci-debug-v1.0.0.md`.

## Native module (better-sqlite3)

`package.json` postinstall runs `electron-builder install-app-deps`, rebuilding better-sqlite3 against Electron's ABI.

At pack time `electron-builder` rebuilds again; `asar: false` avoids loading native modules from inside an asar.

## Brand config

`brand.json` (repo root):

```json
{ "productName": "KinetAios", ... }
```

Read at startup by `src/main/brand.ts`. `${getBrand().productName}` is substituted into `baseSystemPrompt` and used throughout the UI. Renaming the product = edit this one file.

## Adding main↔renderer capabilities

See [[Architecture]] "KinetAPI: three-layer contract" — three synchronized edits:

1. Add method signature to `KinetAPI` in `src/shared/types.ts`
2. Add `ipcRenderer.invoke` / `on` in `src/preload/preload.ts`
3. Add `ipcMain.handle` / `on` in `src/main/main.ts`

typecheck passes = all three line up.

## Adding Direct tools

See [[Tools-and-MCP]] "When to extend tools" — one edit:

1. Add `Tool` implementation in `src/main/tools.ts`
2. Register it in `allTools()` / `readOnlyTools()`

The ReAct loop picks it up automatically. typecheck and ship.

## Adding UI languages / i18n keys

See [[i18n]] "Adding a new language / Adding a new key".

## Known constraints (from CLAUDE.md)

- **Close window = quit**: no background persistence; hotkey works only while the app runs
- **API key is encrypted** but CLAUDE.md is stale on this (was plaintext earlier, now safeStorage)
- **Code indexing / semantic search / image multimodal / IDE plugins** are on the `IMPROVEMENTS.md` roadmap, not done
- **Mac→Windows cross-platform native-module build is unreliable** — Windows installer must be produced on a Windows machine or `windows-latest` CI

## Commit conventions

Commit directly to `main`, no branches (current project stage). `git log` is mixed but leans Chinese:

```
refactor(direct): memory 从 systemPrompt 移到 history[0]
fix: 切换 HTML 文件时 webview 不刷新
feat: 长期记忆面板(🧠)
```

Type prefixes: `feat` / `fix` / `refactor` / `style` / `docs` / `chore` / `perf`.
