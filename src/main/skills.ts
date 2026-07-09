// Skill discovery: scans ~/.claude/skills and ~/.codex/skills for SKILL.md files.
// Each skill is a dir with a SKILL.md whose YAML frontmatter holds name + description and whose
// body is the instruction text. The slash menu lists them; the Direct engine injects the body.
// No YAML dep — we only need name + description, so a 2-line frontmatter scan is enough (ponytail).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillInfo } from '../shared/types';

type Skill = SkillInfo & { body: string };

// Roots scanned in order; first one wins on a name clash (so Claude's user skills beat Codex's).
function roots(): Array<{ dir: string; source: 'claude' | 'codex' }> {
  const home = os.homedir();
  return [
    { dir: path.join(home, '.claude', 'skills'), source: 'claude' as const },
    { dir: path.join(home, '.codex', 'skills'), source: 'codex' as const },
    // Codex's built-in skills ship one level deeper, under a hidden .system dir.
    { dir: path.join(home, '.codex', 'skills', '.system'), source: 'codex' as const },
  ];
}

// Parse just name + description out of YAML frontmatter; body = everything after the closing ---.
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
  for (const { dir, source } of roots()) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // dir missing — normal if the CLI isn't installed
    }
    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const file = path.join(dir, ent.name, 'SKILL.md');
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf8'); // follows symlinks (some skills are links)
      } catch {
        continue; // not a skill dir (no SKILL.md)
      }
      const parsed = parseSkill(content, ent.name);
      const key = parsed.name.toLowerCase();
      if (!map.has(key)) map.set(key, { name: parsed.name, description: parsed.description, source, body: parsed.body });
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

// Returns the skill body for injection, or null if no skill by that name (→ not a skill invocation).
export function loadSkillBody(name: string): string | null {
  return ensure().get(name.toLowerCase())?.body ?? null;
}
