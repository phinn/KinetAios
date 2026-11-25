// 技能依赖装配 —— 解析 SKILL.md frontmatter 的 requires,并在使用前检查是否就绪。
//
// 支持的写法(宽松):任意一种都行,方便手写也方便模型蒸馏时生成
//   requires: git, node, env:OPENAI_API_KEY
//   requires: [git, node, "env:OPENAI_API_KEY"]
//   requires:
//     - cmd:git
//     - env:OPENAI_API_KEY
//     - file:scripts/run.sh
//     - skill:other-skill
//
// 检查项:
//   cmd:<bin>(或裸 <bin>)   → PATH 里能找到(不 spawn 子进程,直接扫 PATH,快且无副作用)
//   env:<NAME>              → 环境变量非空
//   file:<path>             → 技能目录(cwd)相对的路径存在
//   skill:<name>            → 另有同名技能(由调用方注入解析器)
//
// 检查失败不阻止技能加载 —— 技能正文里常有"如果没装 X,可以改用 Y"的分支;
// 但必须把缺失项和安装提示放在正文最前面,模型才知道要走降级路径。
import fs from 'node:fs';
import path from 'node:path';

export type ReqKind = 'cmd' | 'env' | 'file' | 'skill';

export type Requirement = {
  raw: string;
  kind: ReqKind;
  target: string;
  hint: string;
};

export type RequirementReport = {
  ok: boolean;
  requirements: Requirement[];
  missing: Requirement[];
  hints: string[];
};

/** 从 frontmatter 文本里取 requires 列表(调用方已剥离 --- 边界)。 */
export function parseRequires(fm: string): string[] {
  if (!fm) return [];
  const bracket = fm.match(/^requires:[ \t]*\[([^\]]*)\][ \t]*$/m);
  if (bracket) return splitList(bracket[1]);
  const inline = fm.match(/^requires:[ \t]*([^\n]+)$/m);
  if (inline && inline[1].trim()) return splitList(inline[1]);
  // YAML block 形式:requires:\n  - a\n  - b
  const block = fm.match(/^requires:[ \t]*\r?\n((?:[ \t]+[^\n]*\r?\n?)+)/m);
  if (!block) return [];
  return splitList(block[1].replace(/^[ \t]*-\s*/gm, ','));
}

function splitList(s: string): string[] {
  return String(s ?? '')
    .split(/[,，\s]+/)
    .map((x) => x.trim().replace(/^["'[]|["'\]]$/g, ''))
    .filter(Boolean);
}

export function parseRequirement(raw: string): Requirement {
  const s = String(raw ?? '').trim();
  const m = /^(cmd|env|file|skill):(.*)$/i.exec(s);
  const kind = (m ? m[1].toLowerCase() : 'cmd') as ReqKind;
  const target = (m ? m[2] : s).trim();
  let hint: string;
  if (kind === 'env') hint = `设置环境变量 ${target}`;
  else if (kind === 'file') hint = `补齐文件 ${target}(相对技能目录)`;
  else if (kind === 'skill') hint = `先安装/启用技能 ${target}`;
  else hint = `安装 ${target}(或把它加入 PATH)`;
  return { raw: s, kind, target, hint };
}

/** PATH 扫描(不 spawn):跨平台处理 PATHEXT;绝对路径直接看文件。 */
export function commandExists(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!cmd) return false;
  if (path.isAbsolute(cmd)) {
    try { return fs.existsSync(cmd); } catch { return false; }
  }
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const d of dirs) {
    for (const e of exts) {
      try { if (fs.existsSync(path.join(d, cmd + e))) return true; } catch { /* 跳过坏目录 */ }
    }
  }
  return false;
}

export type CheckOpts = {
  /** file: 相对的基准目录 = 技能目录 */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 注入点(测试/插件环境可覆盖) */
  commandExists?: (cmd: string) => boolean;
  skillExists?: (name: string) => boolean;
  exists?: (p: string) => boolean;
};

export function checkRequirements(raws: string[], opts: CheckOpts = {}): RequirementReport {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? ((p: string): boolean => { try { return fs.existsSync(p); } catch { return false; } });
  const hasCmd = opts.commandExists ?? ((c: string): boolean => commandExists(c, env));
  const requirements = (raws ?? []).map(parseRequirement).filter((r) => !!r.target);
  const missing = requirements.filter((r) => {
    if (r.kind === 'env') return !env[r.target];
    if (r.kind === 'file') return !exists(path.isAbsolute(r.target) ? r.target : path.resolve(opts.cwd ?? process.cwd(), r.target));
    if (r.kind === 'skill') return opts.skillExists ? !opts.skillExists(r.target) : false;
    return !hasCmd(r.target);
  });
  return { ok: missing.length === 0, requirements, missing, hints: missing.map((m) => m.hint) };
}

/** 一行到多行的缺失说明;就绪时返回空串。 */
export function formatMissing(report: RequirementReport, skillName?: string): string {
  if (report.ok) return '';
  const head = skillName ? `技能 ${skillName} 的依赖未就绪:` : '依赖未就绪:';
  return [head, ...report.missing.map((m) => `- ${m.raw} → ${m.hint}`)].join('\n');
}
