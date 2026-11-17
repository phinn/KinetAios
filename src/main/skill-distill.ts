// skill-distill — 技能自沉淀(P0-2):成功完成的 turn 蒸馏成可复用 skill。
// Distill skill from completed turns (P0-2): usage time = capability growth.
//
// 设计:
// - LLM 自动判定可蒸馏性(阈值可配 distillAutoEnabled,默认开;llmJudge 可注入便于测试)
// - 产出写到 ~/.kinetaios/skills/distilled/<slug>/SKILL.md(frontmatter name/description + body)
// - skills.ts 已扫描该目录树,蒸馏出的 skill 自动进 slash 菜单、Direct 引擎自动注入 body
// - 与「教训」的区别:教训是碎片铁律;skill 是完整可复用打法(prompt+步骤+坑位清单)

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** 蒸馏结果 */
export interface DistillResult {
  distilled: boolean;
  /** 写盘的 skill 名(frontmatter name);未蒸馏时为空 */
  name: string;
  path: string;
  reason?: string;
}

/** LLM 判定+生成接口(TaskManager 注入真实 provider;测试注入 fake) */
export interface DistillLLM {
  complete(system: string, user: string, signal: AbortSignal): Promise<string>;
}

export function distilledDir(): string {
  return path.join(os.homedir(), '.kinetaios', 'skills', 'distilled');
}

const JUDGE_SYSTEM =
  '你是 agent 技能鉴定器。判断一次完成的任务是否值得沉淀为可复用技能。\n' +
  '值得蒸馏的标准(全部满足):①任务非平凡(多步、有决策点或踩坑)②打法可迁移(下次同类任务能直接复用)③不是一次性数据分析。\n' +
  '只输出 JSON,不要多余文字:{"distill": true/false, "reason": "一句话"}';

const WRITE_SYSTEM =
  '你把一次任务过程蒸馏成一份可复用技能文档(Markdown)。\n' +
  '输出格式(严格遵守,不要代码围栏包裹整体):\n' +
  '---\nname: <短名,kebab-case>\ndescription: <一句话:什么场景用什么打法,含触发词>\n---\n' +
  '# <技能名>\n## 适用场景\n## 步骤\n## 坑位清单(本次踩过的坑与规避)\n## 验证方式\n' +
  '要求:短句、动词开头、只写可执行内容;坑位清单必须来自实际过程;总长 ≤ 80 行。';

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || `skill-${Date.now()}`;
}

function parseJsonLoose(text: string): { distill?: boolean; reason?: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    return JSON.parse(m[0]) as { distill?: boolean; reason?: string };
  } catch {
    return {};
  }
}

/** 从 frontmatter 提取 name/description(skills.ts 同款口径,保持一致) */
export function parseSkillMeta(body: string): { name: string; description: string } {
  const fm = body.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { name: '', description: '' };
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const description = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
  return { name, description };
}

/**
 * 蒸馏一次完成的 turn。
 * @param userMessage 用户原始指令
 * @param assistantAnswer 最终回答(含产出摘要)
 * @param toolDigest 工具调用摘要(工具名+一句话参数/结果;由调用方从事件流折叠,防 prompt 膨胀)
 */
export async function distillSkill(opts: {
  userMessage: string;
  assistantAnswer: string;
  toolDigest: string;
  llm: DistillLLM;
  signal: AbortSignal;
}): Promise<DistillResult> {
  const { userMessage, assistantAnswer, toolDigest, llm, signal } = opts;
  const judgeInput =
    `用户任务:${userMessage.slice(0, 2000)}\n\n` +
    `完成方式摘要(工具调用):${toolDigest.slice(0, 2500) || '(纯回答,无工具)'}\n\n` +
    `最终回答节选:${assistantAnswer.slice(0, 1500)}`;
  let verdict: { distill?: boolean; reason?: string };
  try {
    verdict = parseJsonLoose(await llm.complete(JUDGE_SYSTEM, judgeInput, signal));
  } catch (e) {
    return { distilled: false, name: '', path: '', reason: `judge 失败: ${(e as Error).message}` };
  }
  if (!verdict.distill) {
    return { distilled: false, name: '', path: '', reason: verdict.reason ?? '任务平凡,不值得沉淀' };
  }

  const writeInput =
    `# 原始任务\n${userMessage.slice(0, 4000)}\n\n# 工具调用过程\n${toolDigest.slice(0, 6000) || '(无)'}\n\n# 最终产出\n${assistantAnswer.slice(0, 3000)}`;
  let doc: string;
  try {
    doc = (await llm.complete(WRITE_SYSTEM, writeInput, signal)).trim();
  } catch (e) {
    return { distilled: false, name: '', path: '', reason: `生成失败: ${(e as Error).message}` };
  }
  const meta = parseSkillMeta(doc);
  if (!meta.name || !meta.description) {
    return { distilled: false, name: '', path: '', reason: '产出缺少 frontmatter,放弃写入' };
  }

  const dir = distilledDir();
  const skillDir = path.join(dir, slugify(meta.name));
  fs.mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(file, doc.endsWith('\n') ? doc : `${doc}\n`, 'utf8');
  return { distilled: true, name: meta.name, path: file };
}
