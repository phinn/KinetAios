// 构建 CLI 产物到 release/cli/。产物 = cli.js(bundle,Node 16 目标)+ 需要的运行时资产。
// 运行:esbuild --bundle --alias:electron=src/cli/shims/electron.ts --platform=node --format=cjs
// better-sqlite3 / quickjs 等 native 模块保持 external,由 release/cli/node_modules 提供。
//
// better-sqlite3 原生二进制按目标 ABI 单独下载:
//   NODE_ABI=93 (Node 16, Windows Server 2012 R2) ← 默认,产物目标
//   NODE_ABI=127 (Node 22, 本机冒烟测试用)      ← --abi 127
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, createWriteStream, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'release', 'cli');

// --abi 93(默认)| --abi 127(本机 Node 22 冒烟)
const abiIdx = process.argv.indexOf('--abi');
const ABI = abiIdx >= 0 ? process.argv[abiIdx + 1] : '93';
// ABI 93 的预编译只到 better-sqlite3 v8.7.0;127 用 v11.1.0(与项目 devDeps 同版)
const BSQL_VERSION = ABI === '93' ? '8.7.0' : '11.1.0';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'src/cli/cli.ts')],
  bundle: true,
  outfile: join(out, 'cli.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node16',
  alias: { electron: join(root, 'src/cli/shims/electron.ts') },
  external: ['better-sqlite3', 'quickjs-wasm', 'quickjs-wasi', 'ws', 'fsevents'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// package.json(声明 external 依赖,方便目标机 npm i 或直接带 node_modules)
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify({ name: 'kinetaios-cli', version: '1.0.0', private: true, bin: { kinet: 'cli.js' }, dependencies: { 'better-sqlite3': '^9.6.0', ws: '^8.17.0' } }, null, 2)
);

// ── 拷贝 node_modules 子树(js 部分通用,native 二进制随后替换) ──
const nm = join(root, 'node_modules');
const toCopy = ['better-sqlite3', 'ws'];
if (existsSync(join(nm, 'quickjs-wasi'))) toCopy.push('quickjs-wasi');
if (existsSync(join(nm, 'quickjs-wasm'))) toCopy.push('quickjs-wasm');
if (existsSync(join(nm, 'quickjs-wasmfile-asyncify'))) toCopy.push('quickjs-wasmfile-asyncify');
if (existsSync(join(nm, 'quickjs-wasmfile-core'))) toCopy.push('quickjs-wasmfile-core');
for (const dep of toCopy) {
  cpSync(join(nm, dep), join(out, 'node_modules', dep), { recursive: true });
}
// better-sqlite3 的运行时 loader 依赖
if (existsSync(join(nm, 'bindings'))) cpSync(join(nm, 'bindings'), join(out, 'node_modules/bindings'), { recursive: true });
if (existsSync(join(nm, 'file-uri-to-path'))) cpSync(join(nm, 'file-uri-to-path'), join(out, 'node_modules/file-uri-to-path'), { recursive: true });

// ── 下载目标 ABI 的 better-sqlite3 预编译并替换 .node ──
// Node fetch 在此网络环境不可达(系统代理),改用 PowerShell Invoke-WebRequest;已下载过则用缓存。
const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${BSQL_VERSION}/better-sqlite3-v${BSQL_VERSION}-node-v${ABI}-win32-x64.tar.gz`;
const tgz = join(out, 'bsql.tar.gz');
if (existsSync(tgz)) {
  console.log(`使用缓存 ${tgz}`);
} else {
  console.log(`下载 ${url}`);
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    `[Net.ServicePointManager]::SecurityProtocol='Tls12';Invoke-WebRequest '${url}' -OutFile '${tgz}'`],
    { stdio: 'inherit' });
  if (ps.status !== 0) throw new Error('下载预编译失败(PowerShell): ' + url);
}
// tar 解压(Windows 10+ 自带 bsdtar;Server 2012 打包机若无 tar,可换 7z)
const r = spawnSync('tar', ['-xzf', tgz, '-C', out], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('tar 解压失败');
// 包内结构: build/Release/better_sqlite3.node
cpSync(join(out, 'build', 'Release', 'better_sqlite3.node'),
       join(out, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'));
rmSync(join(out, 'build'), { recursive: true, force: true });
unlinkSync(tgz);

// skills/ 与 plugins/(Direct 引擎的工具/skill 注入依赖目录,若存在则带上)
for (const dir of ['skills', 'plugins']) {
  const src = join(root, dir);
  if (existsSync(src)) cpSync(src, join(out, dir), { recursive: true });
}

// 使用说明
writeFileSync(
  join(out, 'README.txt'),
  `KinetAios CLI
运行需要 Node.js 16+(Windows Server 2012 R2 用 Node 16)。

用法:
  node cli.js                交互模式(REPL)
  node cli.js "问题"          单次问答
  node cli.js --cwd X:\\path  指定工作目录

数据目录(与桌面版共享):
  %APPDATA%\\KinetAios\\settings.json  ← API key 在这里填
  %APPDATA%\\KinetAios\\history.db     ← 对话/记忆库

注意: 桌面版加密存的 API key 在 CLI 里读不出来(safeStorage 属于 Electron),
首次使用请在 settings.json 的 "apiKey" 填明文 key。
`
);

console.log(`CLI 产物完成(ABI v${ABI}):`, out);
