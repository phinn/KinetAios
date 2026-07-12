#!/usr/bin/env node
// 打包脚本:本地默认走 npmmirror 镜像(避免国内拉 GitHub 超时);
// CI(GH Actions 等)环境变量 CI=true 时改走默认源(GH 机房连官方源更快)。
// 然后 build + electron-builder。
//
// 用法:
//   npm run dist        → Windows 安装包(NSIS .exe)
//   npm run pack        → Windows 免安装(unpacked,双击 .exe 就跑)
//   npm run dist:mac    → macOS(dmg)
//
// 镜像只对下载生效,缓存到 %LOCALAPPDATA%\electron\Cache 等,下过的不重下。
const { spawnSync } = require('node:child_process');

const arg = process.argv[2] || 'win';
const useMirror = !process.env.CI; // CI=true 时(GH Actions 等会自动设)不走镜像
const env = useMirror
  ? {
      ...process.env,
      ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
      ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    }
  : { ...process.env };
// --publish never: electron-builder 检测到 CI=true 时会试图自动发 GH Release,
// 没 GH_TOKEN 就会 fail。我们用 softprops/action-gh-release 单独贴 Release。
const ebArgs = arg === 'dir' ? ['--win', '--dir'] : [`--${arg}`, '--publish', 'never'];

console.log(`[pack] build → electron-builder ${ebArgs.join(' ')}(${useMirror ? 'npmmirror 镜像' : '官方源'})`);

const r1 = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true });
if (r1.status !== 0) {
  console.error('[pack] build 失败,中止');
  process.exit(r1.status ?? 1);
}

const r2 = spawnSync('npx', ['electron-builder', ...ebArgs], { stdio: 'inherit', env, shell: true });
process.exit(r2.status ?? 1);
