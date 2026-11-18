// 蒸馏技能可见性回归(2026-11-18 修复)
// 背景:skill-distill 把产物写到 ~/.kinetaios/skills/distilled/<slug>/SKILL.md,
// 比 skills 扫描根多一层;而 scan() 只遍历一层的 <name>/SKILL.md 不递归,
// distilled/ 自己没有 SKILL.md 就被当"非 skill 目录"吞掉 —— 42 个蒸馏技能全部不可见。
// 这里钉死:①能扫到 ②正文能加载 ③同名手写优先 ④目录文本含名且不失控。
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// roots() 运行期读 os.homedir()(POSIX 走 $HOME)→ 换成临时目录,别碰用户真实技能。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-skills-'));
process.env.HOME = tmpHome;

import { listSkills, loadSkillBody, readSkillSource, invalidateSkills, skillCatalogText } from '../../src/main/skills';

const KS = path.join(tmpHome, '.kinetaios', 'skills');

function writeSkill(base: string, slug: string, name: string, description: string, body: string): string {
  const dir = path.join(base, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`, 'utf8');
  return dir;
}

test('distilled/<slug>/SKILL.md 能被扫到(修复前整目录被跳过)', () => {
  writeSkill(path.join(KS, 'distilled'), 'probe-alpha', 'probe-alpha', '蒸馏探针 A', '# 步骤\n1. 先做 A');
  invalidateSkills();
  const hit = listSkills().find((s) => s.name === 'probe-alpha');
  assert.ok(hit, 'distilled 下的 skill 应出现在技能列表里');
  assert.equal(hit!.source, 'kinetaios');
  assert.equal(hit!.description, '蒸馏探针 A');
  const src = readSkillSource('probe-alpha');
  assert.ok(src, '应能读回源文件');
  assert.ok(src!.file.includes(path.join('distilled', 'probe-alpha')), `文件路径应指向 distilled 子目录:${src!.file}`);
});

test('loadSkillBody 能取到蒸馏技能正文,并给出绝对目录', () => {
  const body = loadSkillBody('probe-alpha');
  assert.ok(body, 'load_skill 应能加载蒸馏技能');
  assert.ok(body!.includes('1. 先做 A'), '正文应包含 SKILL.md 内容');
  assert.ok(body!.includes(path.join('distilled', 'probe-alpha')), '正文头部应带 skill 绝对目录');
});

test('同名冲突:用户手写(~/.kinetaios/skills)优先于蒸馏产物', () => {
  writeSkill(KS, 'handwritten-x', 'probe-beta', '手写版', '# 手写正文');
  writeSkill(path.join(KS, 'distilled'), 'distilled-x', 'probe-beta', '蒸馏版', '# 蒸馏正文');
  invalidateSkills();
  const hit = listSkills().find((s) => s.name === 'probe-beta');
  assert.ok(hit);
  assert.equal(hit!.description, '手写版', '先到先得:手写 skill 应压过 distilled 同名');
  const src = readSkillSource('probe-beta');
  assert.ok(src && !src.file.includes('distilled'), `应指向手写目录:${src?.file}`);
});

test('目录文本包含蒸馏技能名,且总长受预算约束', () => {
  // 造一批长名字,把 nameList 顶过预算,验证截断兜底与尾巴计数
  for (let i = 0; i < 60; i++) {
    const long = `zz-bulk-${String(i).padStart(2, '0')}-${'x'.repeat(60)}`;
    writeSkill(path.join(KS, 'distilled'), long, long, '批量占位', '# body');
  }
  invalidateSkills();
  const text = skillCatalogText();
  assert.ok(text, '目录文本不应为空');
  assert.ok(text!.length <= 3900, `目录文本应受预算约束,实际 ${text!.length} 字符`);
  assert.ok(text!.includes('probe-alpha'), '常规技能名应仍可见');
  assert.ok(text!.includes('另有'), '超预算时应带截断尾注(告诉模型还有多少没列)');
});

// 兜底:临时目录清理失败不影响断言结果
process.on('exit', () => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* noop */ }
});

run();
