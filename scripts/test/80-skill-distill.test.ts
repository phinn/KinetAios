// 技能自沉淀(skill-distill)测试 — judge/write 解析 + 落盘 + 幂等命名。
// Covers: loose JSON parse of judge verdict, frontmatter validation, slug collision, write-to-dir.
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import {
  distilledDir,
  parseSkillMeta,
  distillSkill,
  type DistillLLM,
} from '../../src/main/skill-distill';

const okSignal = new AbortController().signal;

function fakeLLM(responses: Record<string, string>): DistillLLM {
  return {
    async complete(system, _user, _signal) {
      for (const k of Object.keys(responses)) {
        if (system.includes(k)) return responses[k];
      }
      throw new Error(`no canned reply for system: ${system.slice(0, 30)}`);
    },
  };
}

test('parseSkillMeta:标准 frontmatter', () => {
  const m = parseSkillMeta('---\nname:打包ESP32\ndescription: 打包固件时配镜像加速\n---\n# 正文');
  assert.equal(m.name, '打包ESP32');
  assert.equal(m.description, '打包固件时配镜像加速');
});

test('parseSkillMeta:缺 frontmatter → 空名(拒写)', () => {
  const m = parseSkillMeta('# 没有 frontmatter 的文档');
  assert.equal(m.name, '');
});

test('distillSkill:judge 说否 → 不产出文件', async () => {
  const llm = fakeLLM({
    技能鉴定器: '{"distill": false, "reason": "一次性数据分析"}',
    技能文档: '---\nname: x\ndescription: y\n---\nbody',
  });
  const r = await distillSkill({ userMessage: '分析这份数据', assistantAnswer: 'done', toolDigest: '', llm, signal: okSignal });
  assert.equal(r.distilled, false);
  assert.equal(r.reason, '一次性数据分析');
});

test('distillSkill:judge 通过 → 落盘 SKILL.md 且 meta 完整', async () => {
  const doc = [
    '---',
    'name: mac dmg 打包',
    'description: Electron macOS dmg 打包,镜像加速+跳公证。触发词:打包/dmg/dist',
    '---',
    '# mac dmg 打包',
    '## 步骤',
    '- 设 ELECTRON_MIRROR',
  ].join('\n');
  const llm = fakeLLM({ 技能鉴定器: '{"distill": true}', 技能文档: doc });
  const r = await distillSkill({
    userMessage: '帮我打一个 dmg 安装包',
    assistantAnswer: '产物已生成',
    toolDigest: 'shell(npm run dist) → 成功;hdiutil attach → 验收通过',
    llm,
    signal: okSignal,
  });
  assert.equal(r.distilled, true);
  assert.ok(r.path.includes('SKILL.md'));
  const written = (await import('node:fs')).readFileSync(r.path, 'utf8');
  assert.ok(written.includes('ELECTRON_MIRROR'));
  const meta = parseSkillMeta(written);
  assert.equal(meta.name, 'mac dmg 打包');
});

test('distillSkill:同名重复蒸馏 → 覆盖同目录,不爆盘', async () => {
  const doc = '---\nname:打包ESP32\ndescription: 打包固件\n---\nbody v2';
  const llm = fakeLLM({ 技能鉴定器: '{"distill": true}', 技能文档: doc });
  for (let i = 0; i < 2; i++) {
    const r = await distillSkill({ userMessage: '打包固件', assistantAnswer: 'ok', toolDigest: 'shell', llm, signal: okSignal });
    assert.equal(r.distilled, true);
  }
  const entries = fs.readdirSync(distilledDir()).filter((f) => f.includes('ESP32') || f.includes('esp32'));
  assert.equal(entries.length, 1, `同名 skill 应同目录覆盖,实际: ${entries.join(',')}`);
});

test('distillSkill:产出缺 frontmatter → 放弃写入不留半成品', async () => {
  const llm = fakeLLM({ 技能鉴定器: '{"distill": true}', 技能文档: '没有 frontmatter 的纯文本' });
  const r = await distillSkill({ userMessage: 'x', assistantAnswer: 'y', toolDigest: '', llm, signal: okSignal });
  assert.equal(r.distilled, false);
  assert.ok(r.reason!.includes('frontmatter'));
});

run();
