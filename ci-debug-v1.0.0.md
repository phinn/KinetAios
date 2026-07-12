# CI 调试记录(v1.0.0 首发)

> 2026-07-12,v1.0.0 首发 Windows + macOS 双平台构建。CI 一路挂了 4 次,前 3 次根因都猜错,第 4 次才看 API 数据定位到真问题。本文档复盘全过程,留作日后参考。

## 时间线

| # | run_id | 失败步骤 | 当时以为的原因 | 实际原因 |
|---|---|---|---|---|
| 1 | 29183113803 | `npm run dist` | `.npmrc` 强制 npmmirror,GH Actions 拉不动 | **错**。install 步骤过了 |
| 2 | 29184033157 | `npm run dist` | electron-builder 需要 `--publish never`(本地暴露的) | **错**。本地暴露 ≠ CI 真因 |
| 3 | 29184371937 | `npm run dist` | 同上(加了诊断但没等结果) | **错**。dist 实际全成功 |
| 4 | 29184457352 | `Attach to Release` | —— | **对**。GH_TOKEN 缺 `contents: write` |

## 实际的修复(按 commit)

### `fbc76c0` — CI 删 `.npmrc`(伪修复)

`.npmrc` 里写了 `electron_mirror=https://npmmirror.com/...`,本地国内网络用来加速 electron 二进制下载。GH Actions 美国机房连官方源更快,所以 workflow 加了:

```yaml
- run: node -e "require('fs').rmSync('.npmrc',{force:true})"
```

用 `node` 而非 `rm -f`,跨 Windows/macOS 通用。

**实际效果**:这一步本身没错,但没解决 CI 失败。`npm install` 在 CI 上本来就能过。

### `d5f40d7` — electron-builder 加 `--publish never`(半对)

electron-builder 检测到 `CI=true` 时会自动尝试 publish 到 GH Release。`scripts/pack.js` 原来:

```js
const ebArgs = arg === 'dir' ? ['--win', '--dir'] : [`--${arg}`];
```

改成:

```js
// --publish never: electron-builder 检测到 CI=true 时会试图自动发 GH Release,
// 没 GH_TOKEN 就会 fail。我们用 softprops/action-gh-release 单独贴 Release。
const ebArgs = arg === 'dir' ? ['--win', '--dir'] : [`--${arg}`, '--publish', 'never'];
```

**实际效果**:本地复现时确实暴露这问题(报 "GitHub Personal Access Token is not set")。但 CI 上没观察到这个错误 —— 可能 CI 上 publish 检测的条件不同(本地是因为有 draft release?),或者就是被后面 `Attach to Release` 的错误掩盖了。无论如何,`--publish never` 是正确的(Release 由 softprops 单独贴),保留。

### `c23f649` — dist 失败时上传日志 artifact(诊断)

为了不再猜,加了:

```yaml
- shell: bash
  run: |
    set -o pipefail
    ${{ matrix.run_dist }} 2>&1 | tee dist.log

- name: Upload dist log on failure
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: dist-log-${{ runner.os }}
    path: dist.log
```

**实际效果**:第 4 次 run 时 dist 步骤过了、没触发这个上传。但这个诊断机制保留 —— 以后 dist 真挂时,直接下载日志看,不用再看 step 内层(那需要 admin 权限或点网页)。

### `a97d044` — 加 `permissions: contents: write`(真修复)

```yaml
permissions:
  contents: write
```

`softprops/action-gh-release@v2` 创建 Release 需要 `GITHUB_TOKEN` 有 `contents: write` 权限。GH Actions 现在默认 token 只读,workflow 级 `permissions:` 字段把它在本 workflow 内提升。

**实际效果**:run 4 dist 都成功,artifacts 都生成(Windows 81MB .exe + macOS 98MB .dmg),但 step 9 `Attach to Release` 失败。加这个权限后,run 5 全绿,Release 自动创建。

## 关键诊断方法

不要看 GH 网页 step 结论猜内层错误。用公开 API(匿名即可):

```bash
# 1. 哪一步挂了(看 conclusion)
curl -s https://api.github.com/repos/{owner}/{repo}/actions/runs/{run_id}/jobs

# 2. 产物是否生成(判断 dist 阶段是否过)
curl -s https://api.github.com/repos/{owner}/{repo}/actions/runs/{run_id}/artifacts
```

- job 数据里每个 step 有 `conclusion`,直接看哪个 step 是 `failure`
- artifact 数据里如果有产物 = dist 阶段过了,失败在后处理
- 公开 repo 的 step 内层日志 API 要 admin 权限(`Must have admin rights`),匿名拿不到 —— 所以 dist 自带 `tee + upload log on failure` 才有价值

## 本地 vs CI 差异

调试时本地复现 ≠ CI 同一原因。本地干扰多:

- electron cache 损坏(本地 `~/Library/Caches/electron/` 历史下载残留 → 解压不全 → `ENOENT rename Electron → KinetAios`)。`rm -rf ~/Library/Caches/electron` 清掉
- 本机有 codesign 证书 → electron-builder 自动签 → 时间戳服务不通就挂。`CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过
- 国内网络 → 镜像配置(`.npmrc`、pack.js 的 npmmirror)对本地必要,对 CI 是负担

CI 上这些都没有,所以本地复现看到的报错很容易带偏诊断。

## 最终的 workflow

`.github/workflows/release.yml` 关键字段:

```yaml
on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: write  # ← Release 创建需要

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            run_dist: npm run dist
            artifact_glob: release/KinetAios*Setup*.exe
          - os: macos-latest
            run_dist: npm run dist:mac
            artifact_glob: release/KinetAios-*.dmg
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: node -e "require('fs').rmSync('.npmrc',{force:true})"
      - run: npm install --no-audit --no-fund
      - shell: bash
        run: |
          set -o pipefail
          ${{ matrix.run_dist }} 2>&1 | tee dist.log
      - name: Upload dist log on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: dist-log-${{ runner.os }}
          path: dist.log
      - uses: actions/upload-artifact@v4
        with:
          name: KinetAios-${{ runner.os }}-${{ github.ref_name }}
          path: ${{ matrix.artifact_glob }}
          if-no-files-found: warn
      - name: Attach to Release
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          files: ${{ matrix.artifact_glob }}
          generate_release_notes: true
          fail_on_unmatched_files: false
```

`scripts/pack.js` 关键改动:

```js
const useMirror = !process.env.CI;
// CI=true 跳过 npmmirror 镜像(GH Actions 机房连官方源更快)
const env = useMirror ? { ...process.env, ELECTRON_MIRROR: ..., ELECTRON_BUILDER_BINARIES_MIRROR: ... } : { ...process.env };

// CI=true 时 electron-builder 自动 publish 到 GH Release(没 GH_TOKEN 就挂)
// Release 改由 softprops/action-gh-release 单独贴
const ebArgs = arg === 'dir' ? ['--win', '--dir'] : [`--${arg}`, '--publish', 'never'];
```

## 教训

1. **CI 失败时先看 step conclusion**(curl GH API),不要看网页 "Process completed with exit code 1" 就开始猜
2. **看 artifacts 是否生成**,可以二分定位是 build 阶段失败还是后处理失败
3. **本地复现 ≠ CI 同因**,本地有太多干扰变量(缓存、证书、网络)。先看 CI 真错再说
4. **拿不到日志就加诊断**,不要凭推测改代码然后让用户多等一轮 CI(~2 分钟一轮)
5. **`--publish never` + `permissions: contents: write`** 是 electron-builder + GH Release 组合的标准配置,默认缺一不可
