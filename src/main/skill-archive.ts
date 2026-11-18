// skill-archive — 蒸馏技能的淘汰动作:移进 .archive/,永不删除。
// Retirement for distilled skills: move into .archive/, never delete.
//
// 为什么需要它:蒸馏在持续产出(50 个,每天还在涨),但没有淘汰 —— 空胎(正文 59B)、
// 重复技能(asc-* 9 个)、来源被否的技能全都留在目录里和好技能抢可见性预算。
// 淘汰必须有依据,依据来自两份账本:skill_origin(出处)+ turn_feedback(成败)+
// skill_usage(是否被用过)。
//
// 三条判据(全部便宜,主线程可跑):
//   ① 空胎:正文 < 200B 且存活 ≥1 天 —— 蒸馏截断/占位垃圾,自证无效
//   ② 来源被否:来源 turn 被用户返工/报错/中止,且此后 0 次加载,存活 ≥7 天
//   ③ 长期未用:有溯源记录、存活 ≥14 天、0 次加载
// 只有 distilled/ 下的目录会被动 —— 手写技能永远不进这个流程。
//
// 归档 = 同卷 rename 到 distilled/.archive/<slug>__<时间戳>/ + 追加一行 JSON 索引。
// 恢复 = 原样搬回。文件一个字节都不删。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { distilledDir } from './skill-distill';
import { demotedSkillOrigins, listSkillOrigins, skillUsage } from './store';

export const ARCHIVE_DIRNAME = '.archive';
const ARCHIVE_INDEX = '_index.jsonl';

/** 正文低于此字节数视为空胎(正常蒸馏产物 1-4KB)。 */
export const MIN_BODY_BYTES = 200;
/** 空胎也要给一天的观察期:刚落盘的才可能被写坏,别在写入当秒就搬走。 */
const MIN_AGE_DAYS_SHORT = 1;
/** 来源被否的技能:给一周时间证明自己(万一过程错了但打法对)。 */
const MIN_AGE_DAYS_REJECTED = 7;
/** 从未被加载:两周。 */
const MIN_AGE_DAYS_UNUSED = 14;

export function archiveRoot(): string {
  return path.join(distilledDir(), ARCHIVE_DIRNAME);
}

export interface ArchiveCandidate {
  slug: string;
  name: string;
  reasons: string[];
  bodyBytes: number;
  ageDays: number;
  loads: number;
}

export interface ArchiveEntry {
  id: string; // .archive 下的目录名
  slug: string;
  name: string;
  reasons: string[];
  at: number;
  turnId?: string;
}

type DistilledSkill = { slug: string; dir: string; file: string; name: string; bodyBytes: number; ageDays: number };

function parseFrontmatterName(md: string, fallback: string): string {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const n = fm?.[1].match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
  return n || fallback;
}

/** frontmatter 之后的字节数 —— 归档判据要的是"正文有多长",不是文件有多大。 */
function bodyBytes(md: string): number {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return Buffer.byteLength(m ? md.slice(m[0].length) : md, 'utf8');
}

/** 列出 distilled/ 下的技能目录(跳过 .archive 与隐藏目录)。 */
function listDistilledSkills(): DistilledSkill[] {
  const root = distilledDir();
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DistilledSkill[] = [];
  for (const ent of ents) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const dir = path.join(root, ent.name);
    const file = path.join(dir, 'SKILL.md');
    try {
      const st = fs.statSync(file);
      const md = fs.readFileSync(file, 'utf8');
      out.push({
        slug: ent.name,
        dir,
        file,
        name: parseFrontmatterName(md, ent.name),
        bodyBytes: bodyBytes(md),
        ageDays: Math.floor((Date.now() - st.mtimeMs) / 86400_000),
      });
    } catch {
      /* 没有 SKILL.md / 读不了 → 不是技能目录 */
    }
  }
  return out;
}

/** 算出该淘汰谁。纯判定,不动文件。 */
export function findArchiveCandidates(): ArchiveCandidate[] {
  const origins = new Map(listSkillOrigins().map((o) => [o.slug, o]));
  const rejected = demotedSkillOrigins();
  const usage = skillUsage();
  const out: ArchiveCandidate[] = [];
  for (const s of listDistilledSkills()) {
    const origin = origins.get(s.slug);
    // 计数按 frontmatter name 记(load_skill 收的是名字,不是目录名)。
    const loads = usage.get((origin?.name ?? s.name).toLowerCase())?.loads ?? 0;
    const reasons: string[] = [];
    if (s.bodyBytes < MIN_BODY_BYTES && s.ageDays >= MIN_AGE_DAYS_SHORT) {
      reasons.push(`正文仅 ${s.bodyBytes}B(空胎)`);
    }
    if (origin && rejected.has(s.slug) && loads === 0 && s.ageDays >= MIN_AGE_DAYS_REJECTED) {
      reasons.push(`来源轮次被否决(${(rejected.get(s.slug) ?? []).join('/') || '未记录'}),且从未被加载`);
    }
    if (origin && loads === 0 && s.ageDays >= MIN_AGE_DAYS_UNUSED) {
      reasons.push(`存 ${s.ageDays} 天 0 次加载`);
    }
    if (reasons.length > 0) {
      out.push({ slug: s.slug, name: origin?.name ?? s.name, reasons, bodyBytes: s.bodyBytes, ageDays: s.ageDays, loads });
    }
  }
  return out;
}

/** 归档一个技能目录:rename 进 .archive/,索引追加一行。不删任何文件。 */
export function archiveSkill(
  slug: string,
  reasons: string[],
  meta: { name?: string; turnId?: string } = {},
): { ok: true; id: string; dest: string } | { ok: false; error: string } {
  // slug 会拼进路径:拒绝任何分隔符/上跳,只允许目录名安全字符。
  if (!/^[A-Za-z0-9._\u4e00-\u9fa5-]+$/.test(slug) || slug.startsWith('.')) {
    return { ok: false, error: `非法 slug:${slug}` };
  }
  const src = path.join(distilledDir(), slug);
  if (!fs.existsSync(src)) return { ok: false, error: `目录不存在:${src}` };
  const root = archiveRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let id = `${slug}__${stamp}`;
    let dest = path.join(root, id);
    for (let i = 1; fs.existsSync(dest); i++) {
      id = `${slug}__${stamp}-${i}`;
      dest = path.join(root, id);
    }
    fs.renameSync(src, dest);
    const entry: ArchiveEntry = { id, slug, name: meta.name ?? slug, reasons, at: Date.now(), turnId: meta.turnId };
    fs.appendFileSync(path.join(root, ARCHIVE_INDEX), `${JSON.stringify(entry)}\n`, 'utf8');
    // 目录被搬走会 bump distilled 的 mtime(哨兵能探到),但索引/同名场景下显式失效更稳。
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (require('./skills') as typeof import('./skills')).invalidateSkills();
    } catch { /* 缓存失效只是时效优化 */ }
    return { ok: true, id, dest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 读归档索引(最后写入的在前)。索引损坏的行跳过,不影响其余。 */
export function listArchived(): ArchiveEntry[] {
  const file = path.join(archiveRoot(), ARCHIVE_INDEX);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: ArchiveEntry[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as ArchiveEntry;
      if (e && typeof e.id === 'string') out.push(e);
    } catch { /* 跳过坏行 */ }
  }
  return out.reverse();
}

/** 从归档搬回 distilled/。按 id 或 slug(取最近一条)匹配;目标已存在则拒绝,绝不覆盖。 */
export function restoreArchived(idOrSlug: string): { ok: true; dest: string } | { ok: false; error: string } {
  const entries = listArchived();
  const hit = entries.find((e) => e.id === idOrSlug) ?? entries.find((e) => e.slug === idOrSlug);
  if (!hit) return { ok: false, error: `归档里没有:${idOrSlug}` };
  const src = path.join(archiveRoot(), hit.id);
  const dest = path.join(distilledDir(), hit.slug);
  if (!fs.existsSync(src)) return { ok: false, error: `归档目录已不存在:${src}` };
  if (fs.existsSync(dest)) return { ok: false, error: `目标已存在,拒绝覆盖:${dest}` };
  try {
    fs.renameSync(src, dest);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (require('./skills') as typeof import('./skills')).invalidateSkills();
    } catch { /* noop */ }
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 扫一遍并归档全部候选。返回本次归档清单(空 = 没有该淘汰的)。 */
export function sweepSkillArchive(): { candidates: ArchiveCandidate[]; archived: ArchiveEntry[] } {
  const candidates = findArchiveCandidates();
  const archived: ArchiveEntry[] = [];
  for (const c of candidates) {
    const r = archiveSkill(c.slug, c.reasons, { name: c.name });
    if (r.ok) archived.push({ id: r.id, slug: c.slug, name: c.name, reasons: c.reasons, at: Date.now() });
  }
  return { candidates, archived };
}
