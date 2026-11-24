// 技能目录按项目加权(2026-11-24)
// 背景:会话 b580efbe(KinetBrief)2026-11-23 一整天 700+ 次工具调用只 load_skill 了 1 次,
// 还是在用户骂「skill 都有的,也不看看」之后 16 秒。原因是 203 个自有技能把 5800 字预算吃干,
// 简介被降到 0 字,而注入语写的是"按**描述**匹配" —— 描述不存在,这句话无法执行。
// 修法:手写技能永远带简介;蒸馏技能里「本项目蒸馏出来的」和「用过的」带简介,其余只列名。
// 本测试钉死:同一条蒸馏技能,在它的来源项目里带简介,在别的项目里只列名。
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-catalog-'));
process.env.HOME = tmpHome;

import { invalidateSkills, skillCatalogText } from '../../src/main/skills';
import * as store from '../../src/main/store';

const KS = path.join(tmpHome, '.kinetaios', 'skills');
const SHOT_DESC = '模拟器真截图做多语首图,禁 HTML mock';
// 目录里简介被截到 22 字,断言用前缀
const SHOT_HEAD = SHOT_DESC.slice(0, 10);

function writeSkill(slug: string, name: string, description: string): void {
  const dir = path.join(KS, 'distilled', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# body\n`, 'utf8');
}

const PROJECT = '/Users/phinn/.openclaw-autoclaw/agents/km/workspace/Products/KinetBrief';
const OTHER = '/Users/phinn/Documents/kinet/AiosPulse';

function seed(): void {
  store.initStore();
  writeSkill('probe-shot', 'probe-shot', SHOT_DESC);
  writeSkill('probe-other', 'probe-other', '别的事的探针技能');
  invalidateSkills();
  store.saveConversation({
    id: 'conv-catalog-probe',
    engine: 'direct',
    model: '',
    cwd: PROJECT,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    customTitle: null,
    directHistory: [],
    engineSessionId: null,
    turns: [],
    turnsLoaded: false,
    status: 'ready',
    statusNote: null,
    cost: 0,
    tokens: 0,
    tokensIn: 0,
    tokensOut: 0,
  } as never);
  store.recordSkillOrigin({ slug: 'probe-shot', name: 'probe-shot', convId: 'conv-catalog-probe', turnId: 't1' });
}

// 取出该技能在目录里那一行,返回简介长度(0 = 只列名)
function descLen(text: string, name: string): number {
  const line = new RegExp(`^- ${name}(?: — (.*))?$`, 'm').exec(text);
  assert.ok(line, `目录里应有 ${name}:${text.slice(0, 200)}`);
  return (line![1] ?? '').length;
}

test('来源项目内:蒸馏技能拿满 22 字简介', () => {
  seed();
  const text = skillCatalogText(PROJECT)!;
  const n = descLen(text, 'probe-shot');
  assert.ok(n >= 20, `本项目蒸馏的技能应拿满简介(否则模型只能看见裸名字 probe-shot),实际 ${n} 字`);
  assert.ok(text.includes(SHOT_HEAD), '简介应是这条技能自己的描述');
});

test('别的项目:同一条技能降级为薄简介或裸名(不占 22 字档)', () => {
  seed();
  const text = skillCatalogText(OTHER)!;
  const n = descLen(text, 'probe-shot');
  assert.ok(n < 20, `非本项目不该占 22 字简介档,实际 ${n} 字`);
});

test('子目录也算本项目(在仓库子目录里干活同样加权)', () => {
  seed();
  const text = skillCatalogText(path.join(PROJECT, 'scripts'))!;
  assert.ok(descLen(text, 'probe-shot') >= 20, '子目录应继承父项目的加权');
});

test('前缀相似但不是同一个项目 → 不加权', () => {
  seed();
  const text = skillCatalogText(`${PROJECT}2`)!;
  assert.ok(descLen(text, 'probe-shot') < 20, '/…/KinetBrief2 不是 /…/KinetBrief');
});

run();
