// V4 Legis — 断言校验器(纯函数,0 LLM)
//
// 断言分两类(设计文档 §5.2/§5.4):
//   环境无关(输出即证据):exitZero / outputContains / jsonParses …
//   环境敏感(需 cwd):fileExists / lineCountMin
// Runtime 在步级 / 节点级 / 验收级调用 evaluateAssertions,失败清单直接
// 构成唤回的"最小故障现场"。
// Pure assertion evaluators — the deterministic half of the V4 verify layer.

import * as fs from 'fs';
import * as path from 'path';
import type { Assertion } from './plan';

// ── 简易 glob(项目内无独立 glob 模块,断言层用 fs 遍历实现)──
// Simple glob — walk cwd up to 2 levels to match pattern segments (* ? []).
function globFiles(cwd: string, pattern: string): string[] {
  const base = path.dirname(path.join(cwd, pattern));
  const leaf = path.basename(pattern);
  if (!fs.existsSync(base)) return [];
  try {
    return fs.readdirSync(base).filter(f => matchSeg(f, leaf)).map(f => path.join(base, f));
  } catch { return []; }
}
function matchSeg(name: string, pat: string): boolean {
  const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(name);
}

export interface AssertionFailure {
  assertion: Assertion;
  reason: string;
}

export interface AssertOutcome {
  passed: boolean;
  failures: AssertionFailure[];
  /** 全部断言的人类可读摘要(事件流/status 用)。 */
  summary: string;
}

/** shell 工具输出格式约定:[exit N] 前缀 / [超时…] 开头 = 失败。 */
function shellExitOk(output: string): boolean {
  return !/\[exit \d+\]/.test(output) && !output.startsWith('[超时') && !output.startsWith('[timeout');
}

/** 求值一组断言(全部求值,不短路 —— 唤回现场需要完整失败清单)。 */
export function evaluateAssertions(
  asserts: Assertion[] | undefined,
  evidence: { output?: string; cwd?: string; durationMs?: number },
): AssertOutcome {
  const failures: AssertionFailure[] = [];
  if (!asserts || asserts.length === 0) {
    return { passed: true, failures, summary: '(无断言)' };
  }
  for (const a of asserts) {
    const r = evaluateOne(a, evidence);
    if (!r.ok) failures.push({ assertion: a, reason: r.reason });
  }
  const passed = failures.length === 0;
  const summary = passed
    ? `${asserts.length} 项断言全过`
    : `${failures.length}/${asserts.length} 项断言失败: ${failures.map((f) => `${f.assertion.type}${f.assertion.value !== undefined ? `(${String(f.assertion.value).slice(0, 60)})` : ''} — ${f.reason}`).join('; ').slice(0, 400)}`;
  return { passed, failures, summary };
}

function evaluateOne(
  a: Assertion,
  evidence: { output?: string; cwd?: string; durationMs?: number },
): { ok: boolean; reason: string } {
  const out = evidence.output ?? '';
  switch (a.type) {
    case 'exitZero':
      return shellExitOk(out)
        ? { ok: true, reason: '' }
        : { ok: false, reason: `命令失败: ${out.slice(0, 120) || '(空输出)'}` };
    case 'outputContains':
      return out.includes(String(a.value ?? ''))
        ? { ok: true, reason: '' }
        : { ok: false, reason: `输出未包含 "${String(a.value ?? '')}"` };
    case 'outputNotContains':
      return !out.includes(String(a.value ?? ''))
        ? { ok: true, reason: '' }
        : { ok: false, reason: `输出不应包含 "${String(a.value ?? '')}"` };
    case 'outputEmpty':
      return out.trim() === ''
        ? { ok: true, reason: '' }
        : { ok: false, reason: `输出非空(${out.slice(0, 60)}…)` };
    case 'outputNotEmpty':
      return out.trim() !== ''
        ? { ok: true, reason: '' }
        : { ok: false, reason: '输出为空' };
    case 'jsonParses':
      try { JSON.parse(out.trim()); return { ok: true, reason: '' }; }
      catch { return { ok: false, reason: '输出不是合法 JSON' }; }
    case 'fileExists':
    case 'fileNotExists': {
      const p = String(a.value ?? '');
      const resolved = evidence.cwd ? (path.isAbsolute(p) ? p : path.join(evidence.cwd, p)) : p;
      let exists = false;
      try { exists = fs.existsSync(resolved); } catch { exists = false; }
      // 通配:直接 existsSync 失败时,尝试目录遍历匹配(仅当路径含 * ? [)
      if (!exists && /[*?[]/.test(p) && evidence.cwd) {
        try { exists = globFiles(evidence.cwd, p).length > 0; } catch { exists = false; }
      }
      if (a.type === 'fileExists') {
        return exists ? { ok: true, reason: '' } : { ok: false, reason: `文件不存在: ${p}` };
      }
      return !exists ? { ok: true, reason: '' } : { ok: false, reason: `文件仍存在: ${p}` };
    }
    case 'lineCountMin': {
      const p = String(a.value ?? '');
      const resolved = evidence.cwd ? (path.isAbsolute(p) ? p : path.join(evidence.cwd, p)) : p;
      const min = typeof a.value === 'number' ? a.value : Number(a.value);
      try {
        const n = fs.readFileSync(resolved, 'utf8').split('\n').length;
        return n >= min ? { ok: true, reason: '' } : { ok: false, reason: `${p} 仅 ${n} 行 < ${min}` };
      } catch {
        return { ok: false, reason: `无法读取 ${p}` };
      }
    }
    case 'durationMsMax': {
      const max = typeof a.value === 'number' ? a.value : Number(a.value);
      if (!Number.isFinite(max)) return { ok: true, reason: '(无效阈值,忽略)' };
      const d = evidence.durationMs ?? 0;
      return d <= max ? { ok: true, reason: '' } : { ok: false, reason: `耗时 ${d}ms > ${max}ms` };
    }
    default:
      return { ok: true, reason: `(未知断言类型 ${a.type},忽略)` };
  }
}
