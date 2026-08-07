#!/usr/bin/env node
// 打包脚本:本地默认走 npmmirror 镜像(避免国内拉 GitHub 超时);
// CI(GH Actions 等)环境变量 CI=true 时改走默认源(GH 机房连官方源更快)。
// 然后 build + electron-builder。
//
// 用法:
//   npm run dist        → Windows 安装包(NSIS .exe)
//   npm run pack        → Windows 免安装(unpacked,双击 .exe 就跑)
//   npm run dist:mac    → macOS(dmg,双架构 x64 + arm64)
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
// macOS: 显式 --x64 --arm64,在同一 runner 上打双架构 DMG。
let ebArgs;
if (arg === 'dir') {
  ebArgs = ['--win', '--dir'];
} else if (arg === 'mac') {
  ebArgs = ['--mac', '--x64', '--arm64', '--publish', 'never'];
} else {
  ebArgs = [`--${arg}`, '--publish', 'never'];
}

console.log(`[pack] build → electron-builder ${ebArgs.join(' ')}(${useMirror ? 'npmmirror 镜像' : '官方源'})`);

const r1 = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true });
if (r1.status !== 0) {
  console.error('[pack] build 失败,中止');
  process.exit(r1.status ?? 1);
}

// macOS 双架构打包:在 arm64 runner 上打 x64 包时,需要先为 x64 rebuild better-sqlite3。
// electron-builder 内部虽然会 rebuild,但实测在 arm64 上交叉编译 x64 native module 有时不可靠。
// 这里显式调用 @electron/rebuild --arch x64 确保编出正确架构。
if (arg === 'mac' && process.platform === 'darwin') {
  console.log('[pack] rebuild better-sqlite3 for x64 (cross-compile on arm64)...');
  const rx64 = spawnSync('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3', '--arch', 'x64'], {
    stdio: 'inherit', shell: true,
  });
  if (rx64.status !== 0) {
    console.warn('[pack] x64 rebuild 失败,继续打包(electron-builder 可能自行处理)');
  }
  // 再 rebuild 回 arm64(确保当前平台 native module 也是对的)
  console.log('[pack] rebuild better-sqlite3 for arm64...');
  const rArm = spawnSync('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3', '--arch', 'arm64'], {
    stdio: 'inherit', shell: true,
  });
  if (rArm.status !== 0) {
    console.warn('[pack] arm64 rebuild 失败,继续打包');
  }
}

const r2 = spawnSync('npx', ['electron-builder', ...ebArgs], { stdio: 'inherit', env, shell: true });
process.exit(r2.status ?? 1);
