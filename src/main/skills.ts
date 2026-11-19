// 扫描 Claude Code / Codex 的 skills + commands + agents(含已装 plugin 的内容)。
// 每项是 frontmatter(name/description)+ body 的 .md。slash 菜单列出,Direct 引擎注入 body。
// ponytail: 不真正起 subagent(那要独立 AgentLoop + 独立上下文);agent 的 body 当指令注入,和 skill/command 同处理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import type { SkillInfo, SkillType } from '../shared/types';
import { pluginSlashCommands, loadPluginCommandBody } from './plugins';

type Skill = SkillInfo & { body: string; dir: string; file: string };

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
  source: 'claude' | 'codex' | 'kinetaios' | 'builtin';
  type: SkillType;
  mode: 'file' | 'skill-dir'; // file=目录下 *.md(name=文件名);skill-dir=<name>/SKILL.md
};

// 内置 skill 根:随 app 分发,打包后 electron-builder 经 extraResources 复制到 resources/skills/
// (package.json),dev 模式直接扫源码 skills/ 目录。参照 plugins/ 的分发模式。
// source='builtin' → 技能面板只读(saveSkillSource 已拦截),用户级同名 skill 优先(先到先得)。
// Bundled skills ship with the app: resources/skills/ when packaged, repo skills/ in dev.
function builtinRoot(): ScanRoot | null {
  // RUN_AS_NODE(冒烟脚本/脚本化调用)下 electron 模块缺 app —— 与 agent-policy 同款兜底:
  // 非 packaged 时 __dirname 解析不受影响,只有 isPackaged 读取会炸。优雅降级为 dev 路径。
  // Under RUN_AS_NODE the electron module has no `app`; degrade gracefully to the dev path.
  const packaged = (() => { try { return app.isPackaged; } catch { return false; } })();
  const dir = packaged
    ? path.join(process.resourcesPath, 'skills')
    : path.resolve(__dirname, '..', '..', 'skills');
  return { dir, source: 'builtin', type: 'skill', mode: 'skill-dir' };
}

// 用户级根:Claude Code 的 skills/commands/agents + Codex 的 skills。
function roots(): ScanRoot[] {
  const home = os.homedir();
  return [
    // KinetAios 原生目录,先扫 → 同名先到先得时优先于 ~/.claude / ~/.codex。
    // / Native dir scanned first — wins name conflicts over claude/codex.
    { dir: path.join(home, '.kinetaios', 'skills'), source: 'kinetaios', type: 'skill', mode: 'skill-dir' },
    // 蒸馏产物(P0-2 skill-distill)写在 ~/.kinetaios/skills/distilled/<slug>/SKILL.md,比上面那个根
    // 多一层;而 scan() 只遍历一层的 <name>/SKILL.md,不递归 → distilled/ 自己没有 SKILL.md 就被当
    // "非 skill 目录"吞掉,42 个蒸馏技能全部不可见(2026-11-18 实测:175 个已注册 skill 里 0 命中)。
    // 单独列一个根,排在用户手写 skill 之后:手写同名优先,但优于 ~/.claude / 内置副本。
    // Distilled skills live one level deeper than the scan loop goes — add them as their own root.
    { dir: path.join(home, '.kinetaios', 'skills', 'distilled'), source: 'kinetaios', type: 'skill', mode: 'skill-dir' },
    { dir: path.join(home, '.kinetaios', 'commands'), source: 'kinetaios', type: 'command', mode: 'file' },
    { dir: path.join(home, '.kinetaios', 'agents'), source: 'kinetaios', type: 'agent', mode: 'file' },
    { dir: path.join(home, '.claude', 'skills'), source: 'claude', type: 'skill', mode: 'skill-dir' },
    { dir: path.join(home, '.claude', 'commands'), source: 'claude', type: 'command', mode: 'file' },
    { dir: path.join(home, '.claude', 'agents'), source: 'claude', type: 'agent', mode: 'file' },
    { dir: path.join(home, '.codex', 'skills'), source: 'codex', type: 'skill', mode: 'skill-dir' },
    // Codex 的内置 skills 在 .system 子目录。
    { dir: path.join(home, '.codex', 'skills', '.system'), source: 'codex', type: 'skill', mode: 'skill-dir' },
    // 内置 skill 殿后:同名先到先得 → 用户级/已装配置优先于随 app 分发的只读副本。
    // / Bundled skills last: earlier roots win name conflicts over the read-only shipped copy.
    ...(() => { const b = builtinRoot(); return b ? [b] : []; })(),
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
// 失效哨兵:记录上次扫描时各根目录的 mtime。技能是 agent 用 write_file/shell 动态创建的
// (用户也可能在 Claude Code 里建),进程级"扫一次永不重扫"会导致新建技能要重启 app 才可见
// (2026-09-14 反馈)。fs.watch 在 macOS 对新建目录的事件不可靠且要管理 8+ 个 watcher 生命周期;
// 这里用 mtime 轮询式哨兵:listSkills/loadSkillBody 每次调用时 stat 一次根目录(µs 级),
// mtime 变了才全量重扫。技能目录总量小(几十个),重扫 <10ms,无性能顾虑。
// Invalidation sentinel: stat each root's mtime on access; rescan only when changed.
let sentinels: { dir: string; mtime: number }[] = [];

function rootMtimes(): { dir: string; mtime: number }[] {
  return [...roots(), ...pluginRoots()].map(({ dir }) => {
    try {
      return { dir, mtime: fs.statSync(dir).mtimeMs };
    } catch {
      return { dir, mtime: -1 }; // 目录不存在也算一种状态:新建时会变化
    }
  });
}

function ensure(): Map<string, Skill> {
  const now = rootMtimes();
  const changed = !cache || sentinels.length !== now.length ||
    now.some((s, i) => s.dir !== sentinels[i]?.dir || s.mtime !== sentinels[i]?.mtime);
  if (changed || !cache) {
    cache = scan();
    sentinels = now;
  }
  return cache;
}

/** 强制下次访问时全量重扫。
 *  覆盖写已有 SKILL.md 不会改变父目录 mtime,mtime 哨兵探不到 —— 程序化写入(技能蒸馏)
 *  必须显式失效,否则同一名字的更新内容要重启 app 才可见。
 *  Force a rescan: overwriting an existing SKILL.md does not bump the parent dir mtime. */
export function invalidateSkills(): void {
  cache = null;
  sentinels = [];
}

/** 蒸馏产物根(distilled/<slug>/SKILL.md)。降级与归档都只作用于这棵树。 */
export function distilledRoot(): string {
  return path.join(os.homedir(), '.kinetaios', 'skills', 'distilled');
}

/** 来源 turn 被用户否决过的蒸馏技能:slug → 否定标签。
 *  store 未初始化(纯扫描测试 / 首次启动前)→ 空 Map,扫描照常。
 *  Lazy require:skills.ts 被 skills 面板、load_skill、目录文本三处调用,
 *  静态 import store 会把 better-sqlite3 拖进每个调用点。 */
function demotedSlugs(): Map<string, string[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const s = require('./store') as typeof import('./store');
    return s.demotedSkillOrigins();
  } catch {
    return new Map();
  }
}

function scan(): Map<string, Skill> {
  const map = new Map<string, Skill>();
  const add = (name: string, description: string, source: 'claude' | 'codex' | 'kinetaios' | 'builtin', type: SkillType, body: string, dir: string, file: string): void => {
    const key = (name || '').toLowerCase();
    if (!key || map.has(key)) return; // 同名先到先得:用户级 > plugin
    map.set(key, { name, description, source, type, body, dir, file, category: inferCategory(name, description) });
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
          add(parsed.name, parsed.description, source, type, parsed.body, dir, path.join(dir, ent.name));
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
          add(parsed.name, parsed.description, source, type, parsed.body, skillDir, path.join(skillDir, 'SKILL.md'));
        } catch {
          /* 非 skill 目录(无 SKILL.md)→ 跳过 */
        }
      }
    }
  }
  // 蒸馏溯源降级(2026-11-18):来源轮次被用户否决过(返工/报错/中止)→ 这个技能是从一次
  // 失败的执行里提炼出来的,步骤大概率带着当时的错误假设。处置是「降级」而不是删除:
  // 仍可用(用户显式 /name 或模型指名加载都还能拿到),但排到列表尾部、不进目录文本推荐、
  // 加载时头部带警示。判据全部来自 skill_origin ⋈ turn_feedback,不改磁盘内容。
  // Demote (never delete) skills distilled from a rejected turn.
  const demoted = demotedSlugs();
  if (demoted.size > 0) {
    const root = distilledRoot() + path.sep;
    for (const s of map.values()) {
      if (!s.file.startsWith(root)) continue;
      const tags = demoted.get(path.basename(s.dir));
      if (tags) {
        s.demoted = true;
        s.demotedTags = tags;
      }
    }
  }
  return map;
}

// ── Skill 目录文本(自动加载模式用)──
// 把 name+description 压成轻量索引注入 system prompt;正文仍靠 load_skill 工具按需拉取。
// ⚠️ v3.6.5 重写(2026-09-14):旧格式 `- name — desc80` 下预算只装得下 28/98 个技能,
// 字母序填充 → 尾部技能(如 skill-creator 排 88)永远不可见,模型"不知道它存在"自然不调。
// 新格式降级式:①紧凑 name 列表(可见性保证)②剩余预算内补 description。
// 目录的意义是"让模型知道有什么",名字本身高度语义化(skill-creator/create-skill),
// desc 是锦上添花 —— 可见性优先于描述完整度。
// ⚠️ 2026-11-19 分层重写:技能数 240(自家 73 + ~/.claude 副本 161),纯名列表 4043 字符,
// 3800 预算被名列表吃干 → 简介一条都挤不进,模型看到一串裸名字(打包esp32 这类根本猜不出来)。
// 分成两段,按"信息的边际价值"分配预算:
//   ① 自有技能(手写 + 蒸馏):名字是项目黑话,不给简介等于不可用 → `- name — desc22`
//   ② 外部副本(内置/claude/codex/plugin):名字本身高度语义化(pdf/xlsx/skill-creator),
//      而且名字很短(均值 13 字符)→ 只列名,同样字符数能覆盖 10 倍数量
// 预算 5800:固定前缀走 cache 命中($0.029/M),比省的 token 更稀缺的是模型的注意力,
// 但 5800 已能装下"全部自有带简介 + 几乎全部外部名",再涨只增噪音。
// 截断时先丢 ~/.claude 副本(最外围),tail 说明还有多少,且 load_skill 传未知名会回全量清单。
export function skillCatalogText(): string | null {
  const skills = listSkills();
  if (skills.length === 0) return null;
  const MAX_CHARS = 5800;
  const HEAD = '(按需调用 load_skill 加载正文;自有技能带简介,外部副本仅列名)\n';
  const TAIL_RESERVE = 220;
  // 降级技能(来源轮次被否)不进目录:它们是负资产,占的是别的技能的可见性预算。
  const demotedCount = skills.filter((s) => s.demoted).length;
  const live = skills.filter((s) => !s.demoted);
  const own = live.filter((s) => s.source === 'kinetaios');
  // 外部副本按"离用户核心工作由近到远"排:插件(自己装的)> 内置 > codex > claude(体量最大,先丢)。
  const ext = [
    ...live.filter((s) => s.source === 'plugin'),
    ...live.filter((s) => s.source === 'builtin'),
    ...live.filter((s) => s.source === 'codex'),
    ...live.filter((s) => s.source === 'claude'),
  ];
  const ownBudget = MAX_CHARS - HEAD.length - TAIL_RESERVE;
  const renderOwn = (cap: number): string[] =>
    own.map((s) => {
      const desc = cap > 0 ? (s.description || '').replace(/\s+/g, ' ').trim().slice(0, cap) : '';
      return desc ? `- ${s.name} — ${desc}` : `- ${s.name}`;
    });
  // 简介档位 22 → 12 → 0:自有技能涨上来时,宁可缩简介也要保住名字可见性
  let ownLines: string[] = [];
  for (const cap of [22, 12, 0]) {
    ownLines = renderOwn(cap);
    if (ownLines.join('\n').length <= ownBudget) break;
  }
  // 仍超预算 → 截断名单(极少见:自有技能上百且名字都很长)
  let ownDropped = 0;
  if (ownLines.join('\n').length > ownBudget) {
    const kept: string[] = [];
    let used = 0;
    for (const line of ownLines) {
      if (used + line.length + 1 > ownBudget) {
        ownDropped++;
        continue;
      }
      kept.push(line);
      used += line.length + 1;
    }
    ownLines = kept;
  }
  const ownBlock = ownLines.join('\n');
  // ② 外部:逗号列,吃剩下的预算
  const extBudget = Math.max(0, MAX_CHARS - HEAD.length - ownBlock.length - (own.length ? 12 : 0) - TAIL_RESERVE);
  let nameList = '';
  let dropped = 0;
  for (const s of ext) {
    const piece = nameList ? `, ${s.name}` : s.name;
    if (nameList.length + piece.length > extBudget) {
      dropped++;
      continue;
    }
    nameList += piece;
  }
  const tailParts: string[] = [];
  if (ownDropped > 0) tailParts.push(`…另有 ${ownDropped} 个自有技能未列出(load_skill 传名可取)`);
  if (dropped > 0) tailParts.push(`…另有 ${dropped} 个外部副本未列出(load_skill 传名可取)`);
  if (demotedCount > 0) tailParts.push(`${demotedCount} 个技能因来源轮次被否决已降级,未列入`);
  const tail = tailParts.length > 0 ? `\n(${tailParts.join('; ')})` : '';
  const ownSection = own.length ? `\n自有技能(${own.length}):\n${ownBlock}\n` : '';
  const extSection = ext.length ? `\n外部副本(${ext.length}):\n${nameList}\n` : '';
  return HEAD + ownSection + extSection + tail + '\n';
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
  // 降级技能排尾部:仍在列表里(用户/模型显式点得到),但不占前排。
  return [...builtin, ...pluginCmds].sort(
    (a, b) => Number(!!a.demoted) - Number(!!b.demoted) || a.name.localeCompare(b.name),
  );
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
    const head = `# 此 Skill 的目录(脚本 / 资源请用绝对路径引用, 例如执行其下的 scripts/xxx):\n${s.dir}\n\n`;
    // 降级警示:技能本身还在(可能对),但它出自一次被否决的执行 —— 模型拿到正文时
    // 必须知道这一层不可靠,否则会照抄当时的错误结论。
    const warn = s.demoted
      ? `# ⚠ 此技能已降级\n它蒸馏自一轮被用户否决的执行(${(s.demotedTags ?? []).join('/') || '未记录原因'})。步骤可作参考,结论与"已验证"之类的断言不可直接采信;与当前任务事实冲突时以实际观察为准。\n\n`
      : '';
    return warn + head + s.body;
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

// ── Skill 源文件读写(设置页「技能」面板用)──
// Skill source read/write for the settings Skills panel.

// 按 name 定位扫描缓存里的条目,读出磁盘上的 .md 全文(frontmatter + body)。
// 插件贡献的 command 也能读;读不到返回 null。
// Locate the scanned entry by name and read the full .md (frontmatter + body) from disk.
export function readSkillSource(name: string): { source: SkillInfo['source']; type: SkillType; dir: string; file: string; content: string } | null {
  const s = ensure().get(name.toLowerCase());
  if (s) {
    try {
      return { source: s.source, type: s.type, dir: s.dir, file: s.file, content: fs.readFileSync(s.file, 'utf8') };
    } catch {
      return null;
    }
  }
  // 插件贡献的 slash 命令:plugins.ts 只给 body,拼上 frontmatter 还原成可编辑全文。
  // Plugin-contributed slash command: only body is cached — rebuild full text with frontmatter.
  const cmd = safeLoadPluginCommandBody(name);
  if (!cmd) return null;
  try {
    const info = safePluginSlashCommands().find((c) => c.name.toLowerCase() === name.toLowerCase());
    const fm = info?.description ? `---\nname: ${info.name}\ndescription: ${info.description}\n---\n\n` : '';
    return { source: 'plugin', type: 'command', dir: cmd.dir, file: path.join(cmd.dir, `${name}.md`), content: fm + cmd.body };
  } catch {
    return null;
  }
}

// 保存 skill 源文件。只允许写进用户级根(~/.kinetaios / ~/.claude / ~/.codex 的 skills),
// 插件目录只读(升级会被冲掉,且属第三方资产)。
// 写成功后强制全量重扫(文件内容变更不改变根目录 mtime,mtime 哨兵探不到)。
// Only user-level roots are writable (plugin dirs are read-only third-party assets);
// force a full rescan after save since root mtimes don't change on file edits.
export function saveSkillSource(name: string, content: string): { ok: true; file: string } | { ok: false; error: string } {
  const s = ensure().get(name.toLowerCase());
  if (!s) return { ok: false, error: `skill not found: ${name}` };
  if (s.source === 'plugin' || s.source === 'builtin') {
    return { ok: false, error: 'plugin/builtin skills are read-only' };
  }
  // 安全校验:frontmatter 的 name 若被改,按新名落盘会分裂出重复条目 —— 这里直接校验
  // 内容里的 name 字段(有则必须一致),避免「改了名 → 列表出现两个同名 skill」的脏状态。
  // Guard: an edited frontmatter name would fork a duplicate entry — keep it consistent.
  const fmName = content.match(/^---\n[\s\S]*?^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (fmName && fmName.toLowerCase() !== name.toLowerCase()) {
    return { ok: false, error: `frontmatter name "${fmName}" ≠ skill name "${name}" — 不允许改名` };
  }
  try {
    fs.writeFileSync(s.file, content, 'utf8');
    cache = null; // 强制下次全量重扫
    return { ok: true, file: s.file };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── 技能市场(anthropics/skills 官方库)──
// listMarketSkills: 拉取 GitHub 仓库树 → 每个含 SKILL.md 的目录即一个技能;并发抓 frontmatter 拿描述;
// 结果内存缓存 10 分钟。installMarketSkill: 下载该目录全部文件写入 ~/.kinetaios/skills/<name>/。
// Market: enumerate SKILL.md dirs from the official GitHub repo, fetch frontmatter for
// descriptions (concurrency-limited, 10-min cache); install downloads the whole dir to user root.
const MARKET_REPO = 'anthropics/skills';
const MARKET_BRANCH = 'main';
const MARKET_CACHE_MS = 10 * 60 * 1000;

export interface MarketSkill { name: string; path: string; description: string; installed: boolean }

async function ghFetch(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'KinetAios', 'Accept': 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${url}`);
  return res;
}

// 踩坑(2026-11-09):Electron main 的 fetch 走 Chromium net 栈 + 系统代理,
// api.github.com 可达,但 raw.githubusercontent.com 在部分代理网络下黑洞 20s 超时
// → 拉取层静默丢条目(市场缺技能/空列表的根因)。node 的 undici fetch 不读系统代理,
// 所以「node 直跑正常、Electron 里复现」——排查同类问题先分叉这两个 runtime。
// 解法:blobs API(同 api.github.com 域,base64 编码)优先,raw 直链只作回落。
// / Pitfall: Electron main fetch uses Chromium net stack + system proxy; raw.githubusercontent.com
// may be black-holed while api.github.com is reachable. Prefer same-domain blobs API, raw as fallback.
async function ghFetchText(blobsUrl: string, rawPath?: string): Promise<string> {
  try {
    const res = await ghFetch(blobsUrl);
    const j = JSON.parse(await res.text()) as { encoding?: string; content?: string };
    if (j.encoding === 'base64' && typeof j.content === 'string') {
      return Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8');
    }
    // 某些代理会把 Accept 头改写导致返回纯文本 → 直接当文本用
    if (typeof j.content === 'string') return j.content;
    throw new Error('unexpected blobs payload');
  } catch (e) {
    if (!rawPath) throw e;
    const res2 = await fetch(`https://raw.githubusercontent.com/${rawPath}`, {
      headers: { 'User-Agent': 'KinetAios' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res2.ok) throw e;
    return await res2.text();
  }
}

/** 简单并发池(保序返回)。— Minimal concurrency-limited map. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

/** 解析 SKILL.md frontmatter 的 name/description。— Parse frontmatter name/description. */
function parseMarketFrontmatter(md: string): { name?: string; description?: string } {
  const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  // 踩过:官方库部分技能(如 academy-guide)的 description 用 YAML `>` 折叠块多行书写,
  // 旧单行正则只抓到 ">" → 搜索主字段废了 + UI 描述列显示一个尖括号。
  // / Some skills use YAML folded (`>`) multiline descriptions; parse those too.
  const fold = fm.match(/^description:\s*[>|][+-]?\n((?:[ \t]+.*\n?)+)/m);
  if (fold) {
    const desc = fold[1].split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
    const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
    return { name, description: desc };
  }
  const pick = (key: string): string | undefined =>
    fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '');
  return { name: pick('name'), description: pick('description') };
}

let marketCache: { at: number; items: Array<Omit<MarketSkill, 'installed'>> } | null = null;
// 部分拉取失败提示(单次拉取周期内有效;全量失败走 catch 的 error,不在这里)
let lastMarketPartial: string | null = null;

export async function listMarketSkills(query = ''): Promise<{ items: MarketSkill[]; error?: string }> {
  try {
    if (!marketCache || Date.now() - marketCache.at > MARKET_CACHE_MS) {
      const tree = await (await ghFetch(`https://api.github.com/repos/${MARKET_REPO}/git/trees/${MARKET_BRANCH}?recursive=1`)).json() as {
        tree?: Array<{ path: string; type: string; sha?: string }>;
      };
      // 每个含 SKILL.md 的一级/任意目录 = 一个技能;排除隐藏目录与嵌套 example。
      const skillDirs = (tree.tree ?? [])
        .filter((e) => e.type === 'blob' && e.path.endsWith('/SKILL.md')
          && !e.path.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules'))
        .map((e) => ({ dir: e.path.slice(0, -'/SKILL.md'.length), sha: e.sha ?? '' }));
      let failCount = 0;
      const blobText = (sha: string, dir: string) => ghFetchText(`https://api.github.com/repos/${MARKET_REPO}/git/blobs/${sha}`, `${MARKET_REPO}/${MARKET_BRANCH}/${dir}/SKILL.md`);
      const raws = await pool(skillDirs, 6, async ({ dir, sha }) => {
        try {
          const md = await blobText(sha, dir);
          const fm = parseMarketFrontmatter(md);
          const name = fm.name || dir.split('/').pop()!;
          return { name, path: dir, description: (fm.description ?? '').replace(/\s+/g, ' ').slice(0, 200) } as Omit<MarketSkill, 'installed'>;
        } catch { failCount++; return null; }
      });
      marketCache = { at: Date.now(), items: raws.filter((x): x is Omit<MarketSkill, 'installed'> => !!x) };
      if (failCount > 0) {
        // 部分失败不再静默:错误字段带回 UI 显示(用户能立刻知道列表残缺,而不是当成"就这么多技能")
        lastMarketPartial = `${failCount} 个技能元数据拉取失败(代理网络可达性),列表可能不完整 — ${failCount} skill(s) failed to fetch metadata, list may be incomplete`;
      } else lastMarketPartial = null;
    }
    const q = query.trim().toLowerCase();
    // installed 每次现算(不进缓存):装完立刻反映,不用等缓存过期。
    const installed = new Set(listSkills().map((s) => s.name.toLowerCase()));
    const all = marketCache.items.map((m) => ({ ...m, installed: installed.has(m.name.toLowerCase()) }));
    const items = q
      ? all.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      : all;
    return { items, error: lastMarketPartial ?? undefined };
  } catch (e) {
    return { items: (marketCache?.items ?? []).map((m) => ({ ...m, installed: false })), error: e instanceof Error ? e.message : String(e) };
  }
}

// 安装:下载技能目录下全部文件(GitHub raw),写入用户级根 ~/.kinetaios/skills/<name>/。
// 路径安全:relpath 逐段清洗,拒绝 .. 与绝对路径;写完清缓存触发重扫。
export async function installMarketSkill(dirPath: string): Promise<{ ok: true; file: string; files: number } | { ok: false; error: string }> {
  try {
    const clean = dirPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!clean || clean.includes('..') || clean.split('/').some((seg) => seg.startsWith('.'))) {
      return { ok: false, error: `illegal skill path: ${dirPath}` };
    }
    const name = clean.split('/').pop()!;
    const tree = await (await ghFetch(`https://api.github.com/repos/${MARKET_REPO}/git/trees/${MARKET_BRANCH}?recursive=1`)).json() as {
      tree?: Array<{ path: string; type: string; sha?: string }>;
    };
    const files = (tree.tree ?? []).filter((e) => e.type === 'blob' && (e.path === `${clean}/SKILL.md` || e.path.startsWith(`${clean}/`)));
    if (!files.length) return { ok: false, error: `skill not found in ${MARKET_REPO}: ${clean}` };
    const destRoot = path.join(os.homedir(), '.kinetaios', 'skills', name);
    let written = 0;
    let mainFile = '';
    // 与列表拉取同一坑:raw 域名在代理网络下黑洞。树接口给了每个 blob 的 sha,
    // 安装文件也走 api.github.com blobs API(ghFetchText 含 raw 回落)。
    const shaByPath = new Map((tree.tree ?? []).filter((e) => e.type === 'blob').map((e) => [e.path, e.sha ?? '']));
    for (const f of files) {
      const rel = f.path.slice(clean.length + 1);
      const dest = path.join(destRoot, ...rel.split('/'));
      if (!dest.startsWith(destRoot)) return { ok: false, error: `illegal relpath: ${rel}` };
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // blobs 优先(sha 从树拿);无 sha 时直接 raw(极老文件树无 sha 字段的兜底)
      const body = shaByPath.get(f.path)
        ? await ghFetchText(`https://api.github.com/repos/${MARKET_REPO}/git/blobs/${shaByPath.get(f.path)}`, `${MARKET_REPO}/${MARKET_BRANCH}/${f.path}`)
        : await ghFetchText(`https://raw.githubusercontent.com/${MARKET_REPO}/${MARKET_BRANCH}/${f.path.split('/').map(encodeURIComponent).join('/')}`);
      fs.writeFileSync(dest, body, 'utf8');
      written++;
      if (rel === 'SKILL.md') mainFile = dest;
    }
    cache = null; // 触发全量重扫
    return { ok: true, file: mainFile || destRoot, files: written };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
