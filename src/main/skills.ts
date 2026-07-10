// 扫描 Claude Code / Codex 的 skills + commands + agents(含已装 plugin 的内容)。
// 每项是 frontmatter(name/description)+ body 的 .md。slash 菜单列出,Direct 引擎注入 body。
// ponytail: 不真正起 subagent(那要独立 AgentLoop + 独立上下文);agent 的 body 当指令注入,和 skill/command 同处理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillInfo, SkillType } from '../shared/types';

type Skill = SkillInfo & { body: string; dir: string };

type ScanRoot = {
  dir: string;
  source: 'claude' | 'codex';
  type: SkillType;
  mode: 'file' | 'skill-dir'; // file=目录下 *.md(name=文件名);skill-dir=<name>/SKILL.md
};

// 用户级根:Claude Code 的 skills/commands/agents + Codex 的 skills。
function roots(): ScanRoot[] {
  const home = os.homedir();
  return [
    { dir: path.join(home, '.claude', 'skills'), source: 'claude', type: 'skill', mode: 'skill-dir' },
    { dir: path.join(home, '.claude', 'commands'), source: 'claude', type: 'command', mode: 'file' },
    { dir: path.join(home, '.claude', 'agents'), source: 'claude', type: 'agent', mode: 'file' },
    { dir: path.join(home, '.codex', 'skills'), source: 'codex', type: 'skill', mode: 'skill-dir' },
    // Codex 的内置 skills 在 .system 子目录。
    { dir: path.join(home, '.codex', 'skills', '.system'), source: 'codex', type: 'skill', mode: 'skill-dir' },
  ];
}

// 已装 plugin(installed_plugins.json 的 installPath)下的 commands/agents/skills 目录。
function pluginRoots(): ScanRoot[] {
  const file = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  let installed: any;
  try {
    installed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return []; // 没装 plugin / 文件缺失
  }
  const out: ScanRoot[] = [];
  for (const entries of Object.values(installed?.plugins ?? {}) as any[][]) {
    const p = entries?.[0]?.installPath;
    if (typeof p !== 'string') continue;
    out.push({ dir: path.join(p, 'commands'), source: 'claude', type: 'command', mode: 'file' });
    out.push({ dir: path.join(p, 'agents'), source: 'claude', type: 'agent', mode: 'file' });
    out.push({ dir: path.join(p, 'skills'), source: 'claude', type: 'skill', mode: 'skill-dir' });
  }
  return out;
}

// 解析 frontmatter 的 name + description;body = 闭合 --- 后的全部。
function parseSkill(content: string, fallbackName: string): { name: string; description: string; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { name: fallbackName, description: '', body: content };
  const fm = m[1];
  const body = m[2];
  const line = (key: string): string | undefined => fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1];
  const clean = (s?: string): string => (s ? s.trim().replace(/^["']|["']$/g, '') : '');
  return { name: clean(line('name')) || fallbackName, description: clean(line('description')), body };
}

let cache: Map<string, Skill> | null = null;

function scan(): Map<string, Skill> {
  const map = new Map<string, Skill>();
  const add = (name: string, description: string, source: 'claude' | 'codex', type: SkillType, body: string, dir: string): void => {
    const key = (name || '').toLowerCase();
    if (!key || map.has(key)) return; // 同名先到先得:用户级 > plugin
    map.set(key, { name, description, source, type, body, dir });
  };
  for (const { dir, source, type, mode } of [...roots(), ...pluginRoots()]) {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在 → 跳过
    }
    if (mode === 'file') {
      for (const ent of ents) {
        if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
        try {
          const parsed = parseSkill(fs.readFileSync(path.join(dir, ent.name), 'utf8'), ent.name.replace(/\.md$/, ''));
          add(parsed.name, parsed.description, source, type, parsed.body, dir);
        } catch {
          /* 跳过读不了的 */
        }
      }
    } else {
      for (const ent of ents) {
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
        const skillDir = path.join(dir, ent.name);
        try {
          const parsed = parseSkill(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), ent.name);
          add(parsed.name, parsed.description, source, type, parsed.body, skillDir);
        } catch {
          /* 非 skill 目录(无 SKILL.md)→ 跳过 */
        }
      }
    }
  }
  return map;
}

function ensure(): Map<string, Skill> {
  if (!cache) cache = scan();
  return cache;
}

export function listSkills(): SkillInfo[] {
  return [...ensure().values()]
    .map(({ body: _body, ...info }) => info)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// 返回 body 用于注入;没有该 name 则 null(→ 不是 skill/command/agent 调用)。
// 开头带上 skill 的绝对目录 —— skill 内的 scripts / 资源用绝对路径引用,否则模型按相对 cwd 找
// (glob/where 递归)会找不到甚至超时。
export function loadSkillBody(name: string): string | null {
  const s = ensure().get(name.toLowerCase());
  if (!s) return null;
  return `# 此 Skill 的目录(脚本 / 资源请用绝对路径引用,例如执行其下的 scripts/xxx):\n${s.dir}\n\n${s.body}`;
}
