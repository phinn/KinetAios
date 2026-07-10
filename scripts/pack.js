#!/usr/bin/env node
// 打包脚本:设国内镜像(Electron + electron-builder 二进制都走 npmmirror,避免 GitHub 下载超时)
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
const env = {
  ...process.env,
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};
const ebArgs = arg === 'dir' ? ['--win', '--dir'] : [`--${arg}`];

console.log(`[pack] build → electron-builder ${ebArgs.join(' ')}(走 npmmirror 镜像)`);

const r1 = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true });
if (r1.status !== 0) {
  console.error('[pack] build 失败,中止');
  process.exit(r1.status ?? 1);
}

const r2 = spawnSync('npx', ['electron-builder', ...ebArgs], { stdio: 'inherit', env, shell: true });
process.exit(r2.status ?? 1);
