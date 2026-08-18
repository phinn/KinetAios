// 扫描 Claude Code / Codex 的 skills + commands + agents(含已装 plugin 的内容)。
// 每项是 frontmatter(name/description)+ body 的 .md。slash 菜单列出,Direct 引擎注入 body。
// ponytail: 不真正起 subagent(那要独立 AgentLoop + 独立上下文);agent 的 body 当指令注入,和 skill/command 同处理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillInfo, SkillType } from '../shared/types';
import { pluginSlashCommands, loadPluginCommandBody } from './plugins';

type Skill = SkillInfo & { body: string; dir: string };

// ── Skill 分类推断 ──
// 根据 name + description 关键词匹配,自动给 skill 打分类标签。
// 分类用于 slash 菜单的标签栏筛选(输入 / 后显示分类标签)。
const CATEGORY_RULES: { category: string; keywords: RegExp }[] = [
  { category: 'marketing', keywords: /营销|推广|文案|广告|branding|marketing|copywriting|social|竞品|competitor|ASO|落地页|landing|promo/i },
  { category: 'design',    keywords: /设计|ui|ux|visual|海报|poster|动画|animation|brandkit/i },
  { category: 'dev',       keywords: /代码|开发|build|deploy|deploy|debug|fix|sync|clone|scaffold|boilerplate|html|css|swift|ios|android|frontend|backend/i },
  { category: 'review',    keywords: /review|审查|code-review|qa|audit|审查|检查/i },
  { category: 'docs',      keywords: /文档|document|report|report|pdf|ppt|md|markdown|notes/i },
  { category: 'ops',       keywords: /部署|deploy|ci|cd|release|ship|publish|fastlane|test|benchmark/i },
  { category: 'media',     keywords: /视频|video|audio|image|图片|录音|transcription|语音|voice|ocr|视频/i },
];

/** 推断 skill 分类。匹配 name + description;无匹配返回 'other'。 */
function inferCategory(name: string, description: string): string {
  const text = `${name} ${description}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.test(text)) return rule.category;
  }
  return 'other';
}

/** 分类中文标签(slash 菜单标签栏显示)。 */
export const CATEGORY_LABELS: Record<string, string> = {
  marketing: '营销',
  design: '设计',
  dev: '开发',
  review: '审查',
  docs: '文档',
  ops: '运维',
  media: '媒体',
  other: '其它',
};

type ScanRoot = {
  dir: string;
  source: 'claude' | 'codex' | 'kinetaios';
  type: SkillType;
  mode: 'file' | 'skill-dir'; // file=目录下 *.md(name=文件名);skill-dir=<name>/SKILL.md
};

// 用户级根:Claude Code 的 skills/commands/agents + Codex 的 skills。
function roots(): ScanRoot[] {
  const home = os.homedir();
  return [
    // KinetAios 原生目录,先扫 → 同名先到先得时优先于 ~/.claude / ~/.codex。
    // / Native dir scanned first — wins name conflicts over claude/codex.
    { dir: path.join(home, '.kinetaios', 'skills'), source: 'kinetaios', type: 'skill', mode: 'skill-dir' },
    { dir: path.join(home, '.kinetaios', 'commands'), source: 'kinetaios', type: 'command', mode: 'file' },
    { dir: path.join(home, '.kinetaios', 'agents'), source: 'kinetaios', type: 'agent', mode: 'file' },
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
  let installed: Record<string, unknown>;
  try {
    installed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return []; // 没装 plugin / 文件缺失
  }
  const out: ScanRoot[] = [];
  const plugins = installed.plugins as Record<string, Array<{ installPath?: string }>> | undefined;
  for (const entries of Object.values(plugins ?? {})) {
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
  const add = (name: string, description: string, source: 'claude' | 'codex' | 'kinetaios', type: SkillType, body: string, dir: string): void => {
    const key = (name || '').toLowerCase();
    if (!key || map.has(key)) return; // 同名先到先得:用户级 > plugin
    map.set(key, { name, description, source, type, body, dir, category: inferCategory(name, description) });
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
  // v2: 合并插件贡献的 slash 命令(pluginSlashCommands 每次调 loadPlugins, 有缓存)。
  const pluginCmds = safePluginSlashCommands().map((s) => ({
    ...s,
    category: s.category ?? inferCategory(s.name, s.description),
  }));
  const builtin: SkillInfo[] = [...ensure().values()].map(
    ({ body: _body, dir: _dir, ...info }) => info,
  );
  return [...builtin, ...pluginCmds].sort((a, b) => a.name.localeCompare(b.name));
}

// 安全包装: 插件加载失败不应影响 skills 列表。
function safePluginSlashCommands(): SkillInfo[] {
  try {
    return pluginSlashCommands();
  } catch {
    return [];
  }
}

// 返回 body 用于注入;没有该 name 则 null(→ 不是 skill/command/agent 调用)。
// 开头带上 skill 的绝对目录 —— skill 内的 scripts / 资源用绝对路径引用,否则模型按相对 cwd 找
// (glob/where 递归)会找不到甚至超时。
export function loadSkillBody(name: string): string | null {
  const s = ensure().get(name.toLowerCase());
  if (s) {
    return `# 此 Skill 的目录(脚本 / 资源请用绝对路径引用, 例如执行其下的 scripts/xxx):\n${s.dir}\n\n${s.body}`;
  }
  // v2: 再查插件贡献的 slash 命令。
  const pluginCmd = safeLoadPluginCommandBody(name);
  if (pluginCmd) {
    return `# 此 Skill 的目录(脚本 / 资源请用绝对路径引用):\n${pluginCmd.dir}\n\n${pluginCmd.body}`;
  }
  return null;
}

// 安全包装: 插件加载失败不应影响 skill body 查找。
function safeLoadPluginCommandBody(name: string): { body: string; dir: string } | null {
  try {
    return loadPluginCommandBody(name);
  } catch {
    return null;
  }
}
