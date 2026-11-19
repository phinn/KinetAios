// 蒸馏溯源 + 淘汰归档(2026-11-18)
// 背景:技能自沉淀在持续产出(50 个,每天还在涨),但"这些技能从哪一轮长出来的"没人记,
// 于是来源轮次被用户否决时也没法把它降级 —— 好坏同权。另一半是只生不死:空胎(正文 8B)、
// 长期 0 加载的技能全留在目录里跟好技能抢可见性预算。
//
// 本文件钉死四件事:
//   ① skill_origin 记账 + 「来源 turn 被否」能算出来
//   ② 被否来源 → 技能降级(排尾部 / 不进目录文本 / 加载带警示),但不删除
//   ③ 归档判据:空胎 / 来源被否且从未被加载 / 存 14 天 0 加载;好技能不误伤
//   ④ 归档是移动不是删除,索引可查、可原样恢复
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 技能路径在运行期读 os.homedir() → 换临时 HOME,别碰用户真实技能目录。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-origin-'));
process.env.HOME = tmpHome;

import * as store from '../../src/main/store';
import { listSkills, loadSkillBody, invalidateSkills, skillCatalogText } from '../../src/main/skills';
import { distillSkill } from '../../src/main/skill-distill';
import {
  findArchiveCandidates,
  sweepSkillArchive,
  archiveSkill,
  listArchived,
  restoreArchived,
  archiveRoot,
} from '../../src/main/skill-archive';

store.initStore();

const KS = path.join(tmpHome, '.kinetaios', 'skills');
const DIST = path.join(KS, 'distilled');
const DAY = 86400_000;

function writeSkill(slug: string, name: string, body: string, ageDays = 0): string {
  const dir = path.join(DIST, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} 的说明\n---\n${body}\n`, 'utf8');
  if (ageDays > 0) {
    const t = new Date(Date.now() - ageDays * DAY);
    // 目录时间也要造:存活期锚"首次见到"(目录 birthtime/mtime + 文件 mtime 取早),
    // 只动文件的话,无溯源的技能会被判断成刚出生。
    fs.utimesSync(file, t, t);
    fs.utimesSync(dir, t, t);
  }
  return file;
}

test('skill_origin:来源 turn 被否 → 进降级集合;已肯定的不进', () => {
  store.recordSkillOrigin({ slug: 'bad-skill', name: 'bad-skill', turnId: 'turn-neg', convId: 'c1' });
  store.recordSkillOrigin({ slug: 'good-one', name: 'good-one', turnId: 'turn-ok', convId: 'c1' });
  store.recordTurnFeedback('turn-neg', -1, ['correction']);
  store.recordTurnFeedback('turn-ok', 1, ['liked']);
  const d = store.demotedSkillOrigins();
  assert.ok(d.has('bad-skill'), '被否来源应进降级集合');
  assert.deepEqual(d.get('bad-skill'), ['correction'], '降级要带上否定原因,加载时给模型看');
  assert.ok(!d.has('good-one'), '被肯定的来源不能被降级');
});

test('skill_origin:同一 slug 重新蒸馏 → 覆盖来源,不产生重复行', () => {
  store.recordSkillOrigin({ slug: 'bad-skill', name: 'bad-skill', turnId: 'turn-ok', convId: 'c1' });
  const rows = store.listSkillOrigins().filter((o) => o.slug === 'bad-skill');
  assert.equal(rows.length, 1, 'slug 是主键,重蒸只更新来源');
  assert.equal(rows[0].turnId, 'turn-ok');
  // 复位成被否的,后面的降级用例依赖它(这本身也验证了"覆盖"生效)
  store.recordSkillOrigin({ slug: 'bad-skill', name: 'bad-skill', turnId: 'turn-neg', convId: 'c1' });
});

test('distillSkill 返回 slug(落盘目录名),调用方才能记溯源', async () => {
  const llm = {
    complete: async (sys: string): Promise<string> =>
      sys.includes('鉴定')
        ? '{"distill":true,"reason":"可复用"}'
        : '---\nname: Probe Skill\ndescription: 探针技能\n---\n# 正文\n## 步骤\n1. 先做 A\n2. 再做 B',
  };
  const r = await distillSkill({
    userMessage: '把 A 改成 B',
    assistantAnswer: 'x'.repeat(300),
    toolDigest: '- shell: ls → ok',
    llm,
    signal: new AbortController().signal,
  });
  assert.equal(r.distilled, true);
  assert.equal(r.slug, 'probe-skill', 'slug 应是 slugify 后的目录名');
  assert.ok(fs.existsSync(path.join(DIST, 'probe-skill', 'SKILL.md')));
});

test('来源被否的技能降级:排尾部 / 不进目录文本 / 加载头部带警示', () => {
  store.recordSkillOrigin({ slug: 'probe-skill', name: 'Probe Skill', turnId: 'turn-neg', convId: 'c1' });
  writeSkill('probe-clean', 'Probe Clean', '# 步骤\n1. 干净技能');
  invalidateSkills();
  const all = listSkills();
  const bad = all.find((s) => s.name === 'Probe Skill');
  assert.ok(bad, '降级不等于隐藏:列表里仍在');
  assert.equal(bad!.demoted, true);
  assert.deepEqual(bad!.demotedTags, ['correction']);
  assert.ok(all[all.length - 1].demoted === true, '降级技能应排到列表尾部');
  const clean = all.find((s) => s.name === 'Probe Clean');
  assert.ok(!clean!.demoted, '没有溯源记录(手写/旧产物)不该被降级');

  const cat = skillCatalogText()!;
  assert.ok(!cat.includes('Probe Skill'), '降级技能不占目录文本预算');
  assert.ok(cat.includes('Probe Clean'), '正常技能照旧可见');
  assert.ok(/已降级/.test(cat), '目录要说明"有几个被降级",而不是无声消失');

  const body = loadSkillBody('Probe Skill');
  assert.ok(body!.startsWith('# ⚠ 此技能已降级'), `加载时应先看到警示:${body!.slice(0, 30)}`);
  assert.ok(body!.includes('1. 先做 A'), '警示之后正文仍然给全(可用,只是不可信)');
  const cleanBody = loadSkillBody('Probe Clean');
  assert.ok(!cleanBody!.includes('⚠'), '正常技能不能带警示');
});

test('归档判据:空胎 / 长期未用进入候选,健康技能不误伤', () => {
  writeSkill('junk-empty', 'junk-empty', 'body v2', 2); // 正文 8B,存 2 天
  writeSkill('junk-old', 'junk-old', `# 步骤\n${'1. 有效步骤 '.repeat(40)}`, 20); // 正文够长但 20 天 0 加载
  store.recordSkillOrigin({ slug: 'junk-old', name: 'junk-old', turnId: 'turn-ok', convId: 'c1' });
  writeSkill('fresh-good', 'fresh-good', `# 步骤\n${'1. 有效步骤 '.repeat(40)}`, 20);
  store.recordSkillOrigin({ slug: 'fresh-good', name: 'fresh-good', turnId: 'turn-ok', convId: 'c1' });
  store.recordSkillUse('fresh-good'); // 被用过 → 不是死技能
  invalidateSkills();

  const slugs = findArchiveCandidates().map((c) => c.slug).sort();
  assert.deepEqual(slugs, ['junk-empty', 'junk-old'], `候选应为空胎 + 长期未用:${slugs.join(',')}`);
  const empty = findArchiveCandidates().find((c) => c.slug === 'junk-empty')!;
  assert.ok(empty.reasons.some((r) => r.includes('空胎')), '空胎原因要说清');
  const old = findArchiveCandidates().find((c) => c.slug === 'junk-old')!;
  assert.equal(old.loads, 0);
  assert.ok(old.reasons.some((r) => r.includes('0 次加载')));
});

test('归档是移动不是删除:文件搬到 .archive/,索引可查,可原样恢复', () => {
  const before = fs.readFileSync(path.join(DIST, 'junk-empty', 'SKILL.md'), 'utf8');
  const { archived } = sweepSkillArchive();
  assert.equal(archived.length, 2, `应归档 2 个:${archived.map((a) => a.slug).join(',')}`);
  assert.ok(!fs.existsSync(path.join(DIST, 'junk-empty')), '原目录应已移走');
  assert.ok(fs.existsSync(path.join(DIST, 'fresh-good')), '健康技能必须原地不动');
  const back = path.join(archiveRoot(), archived.find((a) => a.slug === 'junk-empty')!.id);
  assert.ok(fs.existsSync(back), '归档目录要真实存在(不是删除)');
  assert.equal(fs.readFileSync(path.join(back, 'SKILL.md'), 'utf8'), before, '内容一字不改');

  const idx = listArchived();
  assert.equal(idx.length, 2);
  assert.ok(idx.every((e) => e.reasons.length > 0), '索引要记归档原因');
  assert.ok(idx.some((e) => e.slug === 'junk-empty' && /空胎/.test(e.reasons.join(' '))));

  // 归档后扫描不到(否则归档等于没做)
  invalidateSkills();
  assert.ok(!listSkills().some((s) => s.name === 'junk-empty'));

  const r = restoreArchived('junk-empty');
  assert.ok(r.ok, `恢复应成功:${r.ok ? '' : r.error}`);
  assert.ok(fs.existsSync(path.join(DIST, 'junk-empty', 'SKILL.md')), '恢复后回到 distilled');
  invalidateSkills();
  assert.ok(listSkills().some((s) => s.name === 'junk-empty'), '恢复后重新可见');
});

test('归档拒绝越界 slug 与覆盖已有目录', () => {
  const bad = archiveSkill('../etc', ['x']);
  assert.equal(bad.ok, false, '路径穿越必须拒绝');
  // junk-old 已归档;再拿一个"目标已存在"的场景验证 restore 不覆盖
  const again = restoreArchived('junk-empty');
  assert.equal(again.ok, false, '目标已存在时恢复必须拒绝而不是覆盖');
});

test('外部覆盖写不能重置观察期:存活锚"首次见到"而非文件 mtime', () => {
  // 实机现象(2026-11-19):两个空胎的 SKILL.md 被外部工具同秒覆盖写,内容一字未改,
  // 文件 mtime 变新 → 按 mtime 算存活的话观察期每次都被重置,空胎永远进不了归档。
  const file = writeSkill('junk-rewritten', 'junk-rewritten', 'body v2', 2);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8'), 'utf8'); // 覆盖写,mtime 变成现在
  const c = findArchiveCandidates().find((x) => x.slug === 'junk-rewritten');
  assert.ok(c, '目录已存在 2 天,覆盖写不该让它变回"刚出生"');
  assert.ok(c!.ageDays >= 2, `存活应仍按目录时间算,实际 ${c!.ageDays} 天`);
  assert.ok(c!.reasons.some((r) => r.includes('空胎')));
});

test('skill_usage:重复加载累加,名字大小写归一', () => {
  // 淘汰判据只看"被加载过没有",但累加写错会让"用过"变成"没用过"。
  const before = store.skillUsage().get('fresh-good')?.loads ?? 0;
  store.recordSkillUse('Fresh-Good');
  const after = store.skillUsage().get('fresh-good')!;
  assert.equal(after.loads, before + 1, 'upsert 必须是 +1 而不是覆盖成 1');
  assert.ok(after.lastLoadAt > 0);
});

run();
