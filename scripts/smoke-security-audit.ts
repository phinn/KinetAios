/* 冒烟:security-audit 内置 skill 扫描 + 正文加载 + load_skill 工具链。
 * skills.ts 顶层 import { app } from 'electron' — RUN_AS_NODE 下 require('electron') 返回二进制路径
 * 字符串而非模块,app 是 undefined(agent-policy 能跑是因为它 try/catch 兜底,skills.ts 不兜)。
 * 在任何 src import 前劫持 Module._load 注入 mock electron。
 * 跑法: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron <tsx cli.mjs> scripts/smoke-security-audit.ts */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('node:module');
const origLoad: (...a: unknown[]) => unknown = Module._load;
Module._load = function (request: unknown, ...rest: unknown[]) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => '/tmp/kinet-smoke-userdata' } };
  }
  return origLoad.call(this, request, ...rest);
};

// tsx 直译 TS:直接 import 项目内模块(tsx 会同时编译依赖树,require 裸 .ts 反而不行)
import { listSkills, loadSkillBody, readSkillSource } from '../src/main/skills';

// ① 扫描:builtin source 的 security-audit 必须可见
const skills = listSkills();
const sa = skills.find((s) => s.name === 'security-audit');
if (!sa) throw new Error(`security-audit 未被扫描到。内置目录技能: ${skills.filter((s) => s.source === 'builtin').map((s) => s.name).join(', ') || '(无)'}`);
if (sa.source !== 'builtin') throw new Error(`source 应为 builtin,实际 ${sa.source}(同名用户级覆盖?)`);

// ② frontmatter:description 单行非空(铁律:parseFrontmatter 逐行 split(":"),desc 内含英文冒号会截断)
if (!sa.description || sa.description.length < 30) throw new Error(`description 异常: "${sa.description}"`);
if (sa.description.includes('\n')) throw new Error('description 含换行(必须单行)');

// ③ 正文加载:SKILL.md body 非空且包含关键路由段
const body = loadSkillBody('security-audit');
if (body == null || body.length < 1000) throw new Error(`正文加载异常: ${body ? body.length : 'null'} 字符`);
for (const kw of ['RECONNAISSANCE', 'HUNTING', 'VALIDATION-AND-REPORTING', 'Electron', 'findings.json']) {
  if (!body.includes(kw)) throw new Error(`正文缺关键段: ${kw}`);
}

// ④ files/ 引用完整性:SKILL.md 提到的每个 files/*.md 都真实存在
//    (SkillInfo 无 dir 字段,真实路径走 readSkillSource 反查 —— 与 load_skill 工具同一条链)
import fs from 'node:fs';
import path from 'node:path';
const src = readSkillSource('security-audit');
if (!src) throw new Error('readSkillSource 反查失败');
const fileRefs = [...body.matchAll(/files\/([A-Z0-9-]+\.(?:md|json))/g)].map((m) => m[1]);
const missing = fileRefs.filter((f) => !fs.existsSync(path.join(src.dir, 'files', f)));
if (missing.length) throw new Error(`SKILL.md 引用了不存在的文件: ${missing.join(', ')}`);
if (fileRefs.length < 8) throw new Error(`引用文件数过少(${fileRefs.length}),路由表疑似不完整`);

// ⑤ load_skill 工具级链路:catalog 含本 skill(system prompt 轻量目录)
//    (skillCatalogText 非 async、CJS 下无顶层 await,直接同步 import)
import { skillCatalogText } from '../src/main/skills';
const catalog = skillCatalogText();
if (!catalog || !catalog.includes('security-audit')) throw new Error('skillCatalogText 缺 security-audit');

console.log(`✅ security-audit: source=builtin, desc=${sa.description.length}字, body=${body.length}字, files/引用=${fileRefs.length}个全部存在`);
console.log(`   类别: ${sa.category ?? '-'}; 目录: ${src.dir}`);
console.log('smoke done');
