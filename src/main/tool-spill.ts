// 工具输出溢出(spill-to-file)——超长工具输出全文落盘 + grep_tool_output 回捞。
// 灵感: context-mode(2026-10 调研,docs/agent-ecosystem-research-20261020.md)。
// 动机: truncateForModel / shell 20k 截断会把中段永久丢给模型 —— 截断即信息损失。
// 这里改成: 截断同时把**全文**落盘 userData/tool-outputs/<convId>/<ts>-<n>-<tool>.txt,
// agent 可用只读工具 grep_tool_output 按正则回捞被截掉的中段。
//
// 与 AgentLoop 的 spills(压缩备份,JSON 快照)无关 —— 那是人工审计层,这是模型可用层。
// 支持 KINET_TOOL_OUTPUT_DIR 环境变量覆盖目录(测试用),落盘失败静默(增强不能阻断主流程)。

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

// 溢出阈值: 工具结果超过该长度才落盘(与 AgentLoop.truncateForModel 默认一致)
export const TOOL_OUTPUT_SPILL_THRESHOLD = 8000;
// 单会话最多保留文件数(防膨胀;超过删最旧)
const MAX_FILES_PER_CONV = 40;
// 单文件写上限(工具结果理论上限 ~几 MB;防御性截断)
const MAX_FILE_CHARS = 8 * 1024 * 1024;

let seq = 0; // 同毫秒撞名防护(同 AgentLoop.spillToFile 思路)

function spillRoot(): string {
  return process.env.KINET_TOOL_OUTPUT_DIR || path.join(app.getPath('userData'), 'tool-outputs');
}

/**
 * 超长工具结果全文落盘,返回文件路径;未超阈值返回 null。
 * full — 工具原始全文(截断前的完整输出)。
 * Tool spill: persist full output beyond threshold, return file path (null = not spilled).
 */
export function spillToolOutput(convId: string, toolName: string, full: string): string | null {
  if (!convId || full.length <= TOOL_OUTPUT_SPILL_THRESHOLD) return null;
  try {
    const dir = path.join(spillRoot(), convId);
    fs.mkdirSync(dir, { recursive: true });
    seq = (seq + 1) % 10000;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = toolName.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool';
    const file = path.join(dir, `${ts}-${seq}-${safeName}.txt`);
    fs.writeFileSync(file, full.length > MAX_FILE_CHARS ? full.slice(0, MAX_FILE_CHARS) : full);
    // 防膨胀: 单会话只留最近 MAX_FILES_PER_CONV 份
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
    while (files.length > MAX_FILES_PER_CONV) {
      try { fs.unlinkSync(path.join(dir, files.shift()!)); } catch { /* 竞态忽略 */ }
    }
    return file;
  } catch {
    return null;
  }
}

/**
 * 回捞: 在本会话的溢出文件里按正则找内容。只读本会话目录,不碰其他会话。
 * Search spilled tool outputs of THIS conversation only. Returns formatted hits.
 */
export function grepToolOutput(
  convId: string,
  pattern: string,
  opts: { context?: number; maxHits?: number; file?: string } = {},
): string {
  const ctxN = Math.max(0, Math.min(opts.context ?? 2, 10));
  const maxHits = Math.max(1, Math.min(opts.maxHits ?? 12, 40));
  let files: string[] = [];
  try {
    const dir = path.join(spillRoot(), convId);
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
    if (opts.file) files = files.filter((f) => f.includes(opts.file!));
  } catch {
    return `无溢出文件: 会话 ${convId} 没有超长工具输出被落盘。`;
  }
  if (!files.length) return opts.file ? `无匹配文件名「${opts.file}」的溢出文件。` : `无溢出文件: 本会话没有超长工具输出被落盘。`;

  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (e) {
    return `无效正则: ${(e as Error).message}`;
  }

  const hits: string[] = [];
  for (const f of files) {
    if (hits.length >= maxHits) break;
    let text = '';
    try { text = fs.readFileSync(path.join(spillRoot(), convId, f), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
      if (!re.test(lines[i])) continue;
      const from = Math.max(0, i - ctxN);
      const to = Math.min(lines.length, i + ctxN + 1);
      const ctx = lines.slice(from, to).map((l, j) => `${from + j + 1}: ${l}`).join('\n');
      hits.push(`\n【${f}:${i + 1}】\n${ctx}`);
      i = to - 1; // 跳过已展示的上下文行
    }
  }
  if (!hits.length) return `溢出文件 ${files.length} 份中未匹配到 /${pattern}/。`;
  return `命中 ${hits.length} 处(溢出文件 ${files.length} 份):\n${hits.join('\n')}`;
}
