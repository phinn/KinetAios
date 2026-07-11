// 产品品牌配置:启动时读 dist/brand.json(由 build 从根 brand.json 拷贝)。
// 所有「KinetAios」字样的显示处都从这里取,改 brand.json 的 productName 即可全局改名。
// homeDir 同时暴露给 renderer(用于侧栏分组:cwd === homedir → 显示「未分类」)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Brand = { productName: string; homeDir: string };

const DEFAULT: Brand = { productName: 'KinetAios', homeDir: os.homedir() };
let cache: Brand | null = null;

export function getBrand(): Brand {
  if (cache) return cache;
  let b: Brand = { ...DEFAULT };
  try {
    // __dirname = dist/main → ../brand.json = dist/brand.json
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'brand.json'), 'utf8')) as Partial<Brand>;
    if (raw.productName) b = { ...b, productName: raw.productName };
  } catch {
    /* 文件缺失/损坏 → 用默认 */
  }
  cache = b;
  return cache;
}
