// 产品品牌配置:读取顺序 userData/brand.json(外部,优先,改完重启即生效)
// → 内嵌 dist/brand.json(build 时从根 brand.json 拷贝)。
// 所有「KinetAios」字样的显示处都从这里取,改 productName 即可全局改名;
// icon 字段填 build/ 下图标文件名则强制锁定图标(优先级高于 settings.appIcon)。
// homeDir 同时暴露给 renderer(用于侧栏分组:cwd === homedir → 显示「未分类」)。
// / Brand config: userData/brand.json (external, wins) → embedded dist/brand.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

export type Brand = { productName: string; homeDir: string; version: string; icon?: string };

// 版本号从 package.json 读,不硬编码 / Version from package.json, never hardcode.
import pkg from '../../package.json';
const DEFAULT: Brand = { productName: 'KinetAios', homeDir: os.homedir(), version: pkg.version };
let cache: Brand | null = null;

// 外部覆盖文件:打包版也生效,用户可随时改不用重打包。
// ⚠️ 不用 getPath('userData'):它会在首次访问时**创建**目录,而本模块可能在
// main.ts 的 setName('KinetAios') 之前被求值(engines.ts 顶层 baseSystemPrompt),
// 那样就会创建出 ../kinetaios-win(见 main.ts 历史事故注释)。appData 不创建目录。
// 'KinetAios' 必须与 main.ts 的 USERDATA_DIR 一致。
// / External override file. ⚠️ NOT getPath('userData') — that CREATES the dir on
// first access, and this module can be evaluated before main.ts setName() runs,
// which would create ../kinetaios-win. appData never creates; matches USERDATA_DIR.
export function brandOverridePath(): string {
  return path.join(app.getPath('appData'), 'KinetAios', 'brand.json');
}

export function getBrand(): Brand {
  if (cache) return cache;
  let b: Brand = { ...DEFAULT };
  let src = '默认(brand.json 缺失)';
  // 1) 内嵌默认 / embedded defaults(__dirname = dist/main → ../brand.json = dist/brand.json)
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'brand.json'), 'utf8')) as Partial<Brand>;
    if (raw.productName) { b = { ...b, productName: raw.productName }; src = `内嵌 dist/brand.json (${__dirname}/../brand.json)`; }
    if (raw.icon) b = { ...b, icon: raw.icon };
  } catch {
    /* 文件缺失/损坏 → 用默认 */
  }
  // 2) 外部覆盖 / external override(userData/brand.json),最高优先级
  try {
    const raw = JSON.parse(fs.readFileSync(brandOverridePath(), 'utf8')) as Partial<Brand>;
    if (raw.productName) { b = { ...b, productName: raw.productName }; src = `外置覆盖 ${brandOverridePath()} ← 优先级最高,改名请改这个或删掉它`; }
    // icon 允许显式清空:"" → 清掉内嵌值,回落 settings.appIcon
    b = { ...b, ...(raw.icon !== undefined ? { icon: raw.icon || undefined } : {}) };
  } catch {
    /* 无外部文件 → 用内嵌 */
  }
  // 启动打一行来源:排查"改了 brand.json 不生效"类问题(外置文件静默覆盖是惯犯)
  console.log(`[brand] productName=${b.productName} 来源: ${src}`);
  cache = b;
  return b;
}

// 改 brand 后重置缓存(appIcon 等下次调用重新读取)。热更新窗口/Dock 用。
// / Reset cache after brand change so appIcon() etc. re-read.
export function resetBrandCache(): void {
  cache = null;
}
