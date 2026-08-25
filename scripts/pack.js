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
// CI macOS 构建通过 MAC_ARCH 环境变量指定架构(x64 或 arm64),
// 每个 CI job 只打一个架构,避免 electron-builder #10031 bug。
// 本地不设 MAC_ARCH 时默认打双架构(本地 macOS 上 npm install 已编出正确架构)。
const { spawnSync } = require('node:child_process');

const arg = process.argv[2] || 'win';
const useMirror = !process.env.CI;
const env = useMirror
  ? {
      ...process.env,
      ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
      ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    }
  : { ...process.env };

// brand.json 的 productName/icon 同样应用到打包产物(exe 文件名/快捷方式、内嵌图标)。
// 不透传的话,exe 图标永远是 package.json 里写死的 src/resources/icon.ico。
// / Apply brand.json productName/icon to build artifacts (exe name, embedded icon).
const fs = require('node:fs');
const path = require('node:path');
const brandCfg = [];
try {
  const brand = JSON.parse(fs.readFileSync('brand.json', 'utf8'));
  if (brand.productName) brandCfg.push(`--config.productName=${brand.productName}`);
  if (brand.icon) {
    const p = ['build', 'src/resources'].map((d) => path.join(d, brand.icon)).find((f) => fs.existsSync(f));
    if (p) {
      // win 收 ico/png(electron-builder 会转),mac 只收 png
      if (p.endsWith('.png')) brandCfg.push(`--config.mac.icon=${p}`);
      brandCfg.push(`--config.win.icon=${p}`);
    } else console.warn(`[pack] brand.icon=${brand.icon} 在 build/ 和 src/resources/ 都找不到,沿用默认图标`);
  }
  if (brandCfg.length) console.log(`[pack] brand 覆盖 electron-builder: ${brandCfg.join(' ')}`);
} catch { /* brand.json 缺失/损坏 → 用 package.json 默认 */ }

let ebArgs;
if (arg === 'dir') {
  ebArgs = ['--win', '--dir'];
} else if (arg === 'mac') {
  const arch = process.env.MAC_ARCH; // CI 里 'x64' 或 'arm64';本地 undefined = 双架构
  if (arch) {
    ebArgs = ['--mac', `--${arch}`, '--publish', 'never'];
  } else {
    ebArgs = ['--mac', '--x64', '--arm64', '--publish', 'never'];
  }
} else {
  ebArgs = [`--${arg}`, '--publish', 'never'];
}

console.log(`[pack] build → electron-builder ${ebArgs.join(' ')}(${useMirror ? 'npmmirror 镜像' : '官方源'})`);
ebArgs = [...ebArgs, ...brandCfg];

const r1 = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true });
if (r1.status !== 0) {
  console.error('[pack] build 失败,中止');
  process.exit(r1.status ?? 1);
}

// macOS CI:打包前显式为目标架构 rebuild better-sqlite3。
// arm64 runner 上交叉编译 x64 native module —— @electron/rebuild 支持 --arch 跨架构编译。
if (arg === 'mac' && process.env.MAC_ARCH && process.platform === 'darwin') {
  const arch = process.env.MAC_ARCH;
  console.log(`[pack] rebuild better-sqlite3 for ${arch}...`);
  const rb = spawnSync('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3', '--arch', arch], {
    stdio: 'inherit', shell: true,
  });
  if (rb.status !== 0) {
    console.error(`[pack] ${arch} rebuild 失败`);
    process.exit(rb.status ?? 1);
  }
}

const r2 = spawnSync('npx', ['electron-builder', ...ebArgs], { stdio: 'inherit', env, shell: true });
process.exit(r2.status ?? 1);
