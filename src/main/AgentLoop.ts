// ReAct loop: model ↔ tools until the model answers without a tool_call, or max turns hit.
// Verbatim port of Swift AgentLoop.run. DirectEngine's trim-history logic lives here too.
import type { AgentEvent, ChatMsg, ConfigSnapshot, ContentPart, EngineContextPolicy } from '../shared/types';
import { priceUSD, type Completion, type Provider, type ToolDef } from './glm';
import { toolDef, type Tool, type ToolCtx } from './tools';
import { t } from '../shared/i18n';
import { getSettings } from './settings';
import { saveFact, loadFact } from './store';

// ── File Operation Tracking (compaction 时程序化提取,不依赖 LLM 猜) ──
// 借鉴 pi-main:从被 compact 的 tool_calls 中精确提取文件路径,持久化到 conv_facts,
// 跨多轮 compaction 累积。compaction summary 末尾自动附加 <read-files> / <modified-files>。

interface FileOps { read: Set<string>; written: Set<string>; edited: Set<string>; }

function createFileOps(): FileOps {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

/**
 * 从一批消息的 tool_calls 中提取文件操作(read_file/write_file/edit_file)。
 * 精确匹配 arguments.path / arguments.file_path,不依赖 LLM 摘要。
 */
function extractFileOps(msgs: ChatMsg[]): FileOps {
  const ops = createFileOps();
  for (const m of msgs) {
    if (!m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      const name = tc.function.name;
      let args: Record<string, unknown>;
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { continue; }
      // 匹配多种可能的路径字段名(path / file_path / filePath)
      const p = (args.path ?? args.file_path ?? args.filePath) as string | undefined;
      if (!p || typeof p !== 'string') continue;
      switch (name) {
        case 'read_file': ops.read.add(p); break;
        case 'write_file': ops.written.add(p); break;
        case 'edit_file': ops.edited.add(p); break;
      }
    }
  }
  return ops;
}

/**
 * 把本轮提取的 FileOps merge 到 conv_facts 中已有的 file_registry(JSON)。
 * modified = written ∪ edited;readOnly = read - modified。
 */
function mergeFileOpsWithPersisted(convId: string, newOps: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
  // 从 conv_facts 读取已有的 file_registry
  let existing: { read: string[]; written: string[]; edited: string[] };
  try {
    const raw = loadFact(convId, 'file_registry');
    existing = raw ? JSON.parse(raw) : { read: [], written: [], edited: [] };
  } catch {
    existing = { read: [], written: [], edited: [] };
  }

  const read = new Set([...existing.read, ...newOps.read]);
  const written = new Set([...existing.written, ...newOps.written]);
  const edited = new Set([...existing.edited, ...newOps.edited]);

  // 持久化(累积)
  saveFact(convId, 'file_registry', JSON.stringify({
    read: [...read].sort(),
    written: [...written].sort(),
    edited: [...edited].sort(),
  }));

  // 计算:modified = written ∪ edited;readOnly = read - modified
  const modified = new Set<string>([...written, ...edited]);
  const readOnly = [...read].filter((f) => !modified.has(f)).sort();
  return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

/** 格式化文件列表为 XML 标签,append 到 compaction summary 末尾。 */
function formatFileOps(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join('\n')}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`);
  if (sections.length === 0) return '';
  return `\n\n${sections.join('\n\n')}`;
}

/**
 * CLI 引擎(Claude Code / Codex)的 tool event 也可以调用此函数提取文件路径。
 * 从 tool event 的 name + args 中解析,写入 conv_facts 的 file_registry。
 */
export function trackFileOpFromToolEvent(convId: string, name: string, argsStr: string): void {
  let path: string | undefined;
  switch (name) {
    case 'Read': case 'read':
    case 'Write': case 'write':
    case 'Edit': case 'edit': case 'edit_file': case 'write_file': case 'read_file': {
      // args 可能是 JSON 或自由文本
      try {
        const args = JSON.parse(argsStr);
        path = args.path ?? args.file_path ?? args.filePath;
      } catch {
        // Claude Code 的 args 可能是 "path=xxx" 或纯路径
        const m = argsStr.match(/path[=:]\s*"?([^\s"]+)/);
        if (m) path = m[1];
      }
      break;
    }
    case 'shell': case 'Bash': {
      // shell 命令里的文件路径太杂,跳过(shell 操作的文件不可靠)
      return;
    }
    default: return;
  }
  if (!path || typeof path !== 'string') return;

  const ops = createFileOps();
  switch (name) {
    case 'Read': case 'read': case 'read_file': ops.read.add(path); break;
    case 'Write': case 'write': case 'write_file': ops.written.add(path); break;
    case 'Edit': case 'edit': case 'edit_file': ops.edited.add(path); break;
  }
  mergeFileOpsWithPersisted(convId, ops);
}

export interface RunOpts {
  provider: Provider;
  tools: Tool[];
  systemPrompt: string;
  // 长期记忆块:每轮注入到 history 头部一条 user 消息(标 _memory),不进 systemPrompt。
  // 这样 base+rules+context 跨轮稳定 → Anthropic cache_control 不被记忆变化打穿;
  // 该消息 trim/compact 时永远保留,且不写回 directHistory(dropTransient 过滤)。
  memoryBlock?: string;
  snapshot: import('../shared/types').ConfigSnapshot;
  userInput: string;
  history: ChatMsg[]; // prior turns (already without the system prompt)
  ctx: ToolCtx;
  signal: AbortSignal;
  maxTurns?: number;
  // 上下文模式:hifi 时不截断 tool result + 更大上下文预算(适合多数据源交叉分析,代价是更多 token)。
  // ponytail: 历史 ContextMode 字段保留以兼容 settings.json 旧数据,真正策略统一从 ENGINE_POLICIES 取。
  contextMode?: 'standard' | 'hifi';
  // 高保真模式的上下文预算(token)——从设置页读取,控制 reactive trim 上限。
  hifiContextBudget?: number;
  // 引擎上下文策略包:覆盖默认 ENGINE_POLICIES[engine]。调用方按 engine 传不同策略。
  // 不传 → 用 resolveEnginePolicy(EngineKind, contextMode) 的解析结果。
  policy?: EngineContextPolicy;
  onEvent: (e: AgentEvent) => void;
}

// Runs one turn. Returns the accumulated messages (minus the system prompt and the transient
// memory message) for next-turn history.
export async function runAgentLoop(opts: RunOpts): Promise<ChatMsg[]> {
  const { provider, tools, systemPrompt, memoryBlock, snapshot, userInput, history, ctx, signal, onEvent } = opts;
  // reactive trim 预算:从策略包取(覆盖硬编码 15K)。hifi 模式策略 trimBudget 已翻倍,不用再读 hifiContextBudget。
  const trimBudget = opts.policy?.trimBudget ?? 15_000;
  // maxTurns 解析(修复:用户设置曾被 V3 硬编码完全无视):
  // - settings.maxTurns 是全局天花板;opts.maxTurns(内部路径上限,如 fast=5/std=20)只在比它更紧时生效。
  // - 用户设 0 = 无限 → 全链路不限轮,内部硬编码上限全部失效。
  // User setting is the global ceiling; internal path caps only apply when tighter.
  const userMax = getSettings().maxTurns ?? 50;
  let maxTurns: number;
  if (userMax <= 0) {
    maxTurns = Infinity; // 用户显式要求无限
  } else if (opts.maxTurns != null && opts.maxTurns > 0) {
    maxTurns = Math.min(opts.maxTurns, userMax); // 内部上限与用户天花板取紧
  } else {
    maxTurns = userMax; // 无内部上限 → 用用户设置(含 opts.maxTurns===0 的历史语义)
  }
  const defs: ToolDef[] = tools.map(toolDef);

  // 记忆作为 history 头部 user 消息:模型看得到,但不拼进 systemPrompt(稳定系统缓存)。
  const memMsg: ChatMsg[] = memoryBlock && memoryBlock.trim()
    ? [{ role: 'user', content: memoryBlock, _memory: true }]
    : [];

  let messages: ChatMsg[] = [{ role: 'system', content: systemPrompt }, ...memMsg, ...history];
  // 多模态:解析 \x00IMAGES[...]\\x00 标记,将图片转为 OpenAI vision content parts。
  const imgMatch = userInput.match(/\x00IMAGES(\[.+?\])\x00/s);
  let userContent: string | ContentPart[] = userInput;
  if (imgMatch) {
    const cleanText = userInput.replace(/\x00IMAGES\[.+?\]\x00/s, '').trim();
    try {
      const imgs = JSON.parse(imgMatch[1]) as string[];
      const parsed = imgs.map((s) => JSON.parse(s) as { name: string; dataUrl: string });
      const parts: ContentPart[] = [{ type: 'text', text: cleanText }];
      for (const img of parsed) {
        parts.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: 'auto' } });
      }
      userContent = parts;
    } catch {
      // 解析失败 → 纯文本(去标记)
      userContent = cleanText;
    }
  }
  messages.push({ role: 'user', content: userContent });

  // reactive trim 用:上下文超长报错时三级 fallback — 全预算 → 1/4 → nuclear 退出。
  // ponytail:错误格式不统一,best-effort。
  let retriedAfterShrink = false;
  let retriedNuclear = false;
  for (let i = 0; i < maxTurns; i++) {
    let completion: Completion;
    try {
      completion = await provider.streamComplete(messages, defs, snapshot, signal, (tok) =>
        onEvent({ type: 'token', text: tok }),
      );
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'AbortError' || signal.aborted) return finalizeAbortedMessages(messages); // user hit stop
      // 超长兜底:三级 fallback — 全预算 → 砍半 → 1/4。
      // P0-fix: 原版三级改动的第二级缺 continue,trim 后直接 return 退出而非重试。
      // 且第一级从 trimBudget 降到 trimBudget/2 更激进,导致原来能跑的任务提前崩溃。
      if (isContextTooLong(e)) {
        if (!retriedAfterShrink) {
          // 第一级:用 trimBudget 全预算重试(与 fa7740a 前的原版一致,不再过度激进)
          retriedAfterShrink = true;
          messages = [{ role: 'system', content: systemPrompt }, ...memMsg, ...trimHistoryToTokenBudget(dropTransient(messages), trimBudget, snapshot.apiProtocol)];
          onEvent({ type: 'status', text: t(getSettings().lang, 'al.ctxTooLong') });
          onEvent({ type: 'context', action: 'trimmed', beforeTokens: 0, afterTokens: estTokenCount(messages) } as AgentEvent & { type: 'context' });
          i--; // 抵消 for 的 i++,本轮重试
          continue;
        } else if (!retriedNuclear) {
          // 第二级:1/4 预算激进 trim,然后重试(不再直接 return)
          retriedNuclear = true;
          const miniBudget = Math.floor(trimBudget / 4);
          messages = [{ role: 'system', content: systemPrompt }, ...memMsg, ...trimHistoryToTokenBudget(dropTransient(messages), miniBudget, snapshot.apiProtocol)];
          onEvent({ type: 'status', text: '⚠️ 上下文严重超长,已激进裁剪到最小集' });
          onEvent({ type: 'context', action: 'trimmed', beforeTokens: 0, afterTokens: estTokenCount(messages) } as AgentEvent & { type: 'context' });
          continue; // ⚠️ 必须重试 — 不 continue 就会 fall-through 到 return,任务直接中断
        } else {
          // 第三级(nuclear):1/4 trim 后仍超长 → systemPrompt + memory 本身就接近或超出窗口,
          // 再重试只会反复空转烧 API 调用直到 maxTurns 耗尽。直接报错退出。
          onEvent({ type: 'error', message: '上下文长度超出模型窗口:即使裁剪到最小集仍然超长。请减少记忆块大小或更换更大窗口的模型。' });
          return dropTransient(messages);
        }
      }
      // 非 context-too-long 的错误(网络/API 错误等)才走这里
      onEvent({ type: 'error', message: errMsg(e) });
      return dropTransient(messages);
    }

    // Report cost each LLM call — multi-turn tool-calling totals sum across calls.
    if (completion.tokensIn + completion.tokensOut > 0) {
      const usd = priceUSD(snapshot.model, completion.tokensIn, completion.tokensOut);
      onEvent({
        type: 'cost',
        usd,
        tokens: completion.tokensIn + completion.tokensOut,
        tokensIn: completion.tokensIn,
        tokensOut: completion.tokensOut,
      });
    }
    // 用这轮真实 prompt_tokens 校准 token 估算系数(给 trimHistoryToTokenBudget / compactHistory 用)。
    // 按协议分别校准:GLM(OpenAI 协议)与 Claude 的 token/char 比差异大,混用一个系数会导致并发会话互相干扰。
    calibrateTokens(completion.tokensIn, messages, snapshot.apiProtocol);

    messages.push(completion.rawAssistant);
    if (completion.toolCalls.length === 0) {
      onEvent({ type: 'traj', records: snapshotTraj(messages) });
      onEvent({ type: 'done' });
      return dropTransient(messages);
    }

    // 工具执行:同轮里只读工具(readOnly)并发,写工具串行。结果按原序回填(tool_call_id 配对)。
    messages.push(...(await runToolBatch(completion.toolCalls, tools, ctx, signal, onEvent, opts.policy?.truncateThreshold ?? 8000)));
    // abort 在工具执行中触发 → runToolBatch 补了 [已停止] 后正常返回,
    // 但不应继续下一轮 LLM 调用 → 在这里截断,确保 messages 以合法 assistant 结尾。
    if (signal.aborted) return finalizeAbortedMessages(messages);
  }
  onEvent({ type: 'error', message: t(getSettings().lang, 'al.maxTurns', { max: maxTurns }) });
  return dropTransient(messages);
}

// 尝试修复被 max_tokens 截断的 tool_call arguments JSON。
// 场景:模型生成长 write_file content 时,输出被 max_tokens 切断,
// arguments JSON 字符串不完整(引号/括号未闭合)→ JSON.parse 失败。
// 策略:逐字符追踪字符串/对象/数组层级,在安全位置截断并补全闭合符号。
function repairTruncatedJSON(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s.startsWith('{')) return null; // 不是对象开头,放弃

  // 逐字符扫描,追踪状态
  let inStr = false;       // 是否在字符串内
  let escape = false;      // 上一个字符是否为反斜杠
  let depth = 0;           // 对象/数组嵌套深度
  let lastValidEnd = -1;   // 最后一个完整 key-value 后的位置(逗号或开括号后)
  let lastKeyEnd = -1;     // 最后一个完整 key 的冒号位置
  let bracketStack: string[] = []; // 栈:追踪 { 和 [

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inStr = false; continue; }
      continue;
    }
    // 不在字符串内
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') { depth++; bracketStack.push(ch); continue; }
    if (ch === '}' || ch === ']') {
      depth--;
      // 安全:只弹出匹配的括号类型,防止 {] 或 [} 交叉畸形导致栈状态错误。
      // Security: only pop matching bracket type, preventing mismatched {] or [} from corrupting stack.
      if (bracketStack.length > 0) {
        const top = bracketStack[bracketStack.length - 1];
        if ((ch === '}' && top === '{') || (ch === ']' && top === '[')) {
          bracketStack.pop();
        } else {
          // 不匹配 → 跳过这个畸形的闭括号(不弹栈)
          depth++; // 撤销 depth-- 因为这个闭括号是畸形的
        }
      }
      if (depth > 0) lastValidEnd = i; // 记录顶层 value 结束位置
      continue;
    }
    if (ch === ',' && depth === 1) { lastValidEnd = i; } // 顶层逗号
    if (ch === ':' && depth === 1) { lastKeyEnd = i; }
  }

  // 情况 1:JSON 意外结束,字符串仍在 open 状态 → content value 被截断
  if (inStr) {
    // 找到最后一个顶层 key 的冒号位置,确定是哪个 value 被截断
    // 截断到冒号后开始一个空字符串 value,关闭所有打开的括号
    // 策略:在最后一个完整 key-value 后截断(如果有逗号,在逗号后截;否则去掉这个不完整的 key-value)
    if (lastValidEnd >= 0) {
      // 在最后一个完整逗号位置后截断
      s = raw.slice(0, lastValidEnd + 1);
    } else {
      // 没有完整的 key-value,整个对象可能只有一个不完整的 key
      // 尝试:保留最后一个完整 key,给空值
      if (lastKeyEnd >= 0) {
        // 找到 key 名
        const keyRegion = raw.slice(0, lastKeyEnd);
        const keyMatch = keyRegion.match(/"([^"]*)"\s*:$/);
        if (keyMatch) {
          // 保留这个 key,给空字符串值
          s = raw.slice(0, lastKeyEnd + 1) + ' ""';
        } else {
          s = '{}';
        }
      } else {
        s = '{}';
      }
    }
    // 如果仍在字符串内,闭合引号
    // (此时 s 可能已经不需要,但保险起见再检查)
  } else if (depth > 0) {
    // 情况 2:不在字符串内,但括号没闭合 → 补全
    if (lastValidEnd >= 0) {
      s = raw.slice(0, lastValidEnd + 1);
    }
    // 移除末尾可能残留的逗号
    s = s.replace(/,\s*$/, '');
  }

  // 如果仍在字符串内,先闭合字符串
  // 重新扫描确认
  inStr = false; escape = false;
  for (let i = 0; i < s.length; i++) {
    if (escape) { escape = false; continue; }
    if (s[i] === '"') {
      if (!inStr) inStr = true;
      else { inStr = false; }
      continue;
    }
    if (inStr && s[i] === '\\') { escape = true; continue; }
  }
  if (inStr) {
    // 字符串未闭合 → 补引号
    s += '"';
  }

  // 重新计算需要关闭的括号
  bracketStack = [];
  inStr = false; escape = false;
  for (let i = 0; i < s.length; i++) {
    if (escape) { escape = false; continue; }
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') bracketStack.push(ch);
    if (ch === '}' || ch === ']') {
      // 安全:匹配检查,与第一段扫描一致
      if (bracketStack.length > 0) {
        const top = bracketStack[bracketStack.length - 1];
        if ((ch === '}' && top === '{') || (ch === ']' && top === '[')) {
          bracketStack.pop();
        }
      }
    }
  }

  // 从栈顶向下补全闭合括号
  const closing = bracketStack.reverse().map((b) => b === '{' ? '}' : ']').join('');
  s += closing;

  // 移除末尾多余的逗号(JSON 不允许尾逗号)
  s = s.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function execute(tc: { name: string; arguments: string }, tools: Tool[], ctx: ToolCtx): Promise<string> {
  const tool = tools.find((t) => t.name === tc.name);
  if (!tool) return `未知工具: ${tc.name}`;
  let args: Record<string, unknown> = {};
  let parsedOk = true;
  try {
    args = JSON.parse(tc.arguments || '{}');
  } catch {
    // JSON 解析失败 —— 很可能是模型输出被 max_tokens 截断。
    // 尝试容错修复截断的 JSON,提取已完整的字段。
    const repaired = repairTruncatedJSON(tc.arguments);
    if (repaired) {
      args = repaired;
      // 如果 write_file 的 content 被截断(修复后值为空或异常短,但原 arguments 很长),
      // 说明内容不完整,不应写入半截文件。
      if (tc.name === 'write_file' || tc.name === 'edit_file') {
        const contentLen = typeof args.content === 'string' ? args.content.length : 0;
        const originalLen = tc.arguments.length;
        // 原始 arguments 有数 KB 但提取出的 content 为空或极短 → content 被截断
        if (originalLen > 500 && contentLen < 50) {
          return `⚠️ 参数 JSON 被 max_tokens 截断(原始长度 ${originalLen} 字符),content 字符串不完整。` +
            `请缩短单次写入内容,或改用 edit_file 分段写入。如果是新文件,可以先写一个骨架框架,再用 edit_file 逐步补充内容。`;
        }
      }
      console.warn(`[AgentLoop] ${tc.name} JSON 被截断,已容错修复提取部分字段。原始长度: ${tc.arguments.length}`);
    } else {
      parsedOk = false;
      console.error(`[AgentLoop] ${tc.name} args 不是合法 JSON: ${tc.arguments.slice(0, 400)}`);
    }
  }
  if (!parsedOk && Object.keys(args).length === 0) {
    return `⚠️ 参数解析失败:模型输出的 JSON 不完整(可能被 max_tokens 截断)。请重试,缩短参数内容。`;
  }
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    if (ctx.signal?.aborted) return '[已停止]';
    return `工具出错: ${e}`;
  }
}

// 轨迹快照:把最终 messages 转成可持久化的 TrajRecord 列表。
// - system → system;_memory → context(记忆注入);content 以 [早期对话摘要] 开头 → compacted
// - tool role / 带 tool_calls 的 assistant → tool;其余 assistant → message
// 每条截断 2K 字符(traj 只做透视,不做回放)。
// Snapshot final messages into TrajRecords for the Trajectory inspector.
const TRAJ_TEXT_LIMIT = 2000;
function snapshotTraj(messages: ChatMsg[]): import('../shared/types').TrajRecord[] {
  const out: import('../shared/types').TrajRecord[] = [];
  for (const m of messages) {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p) => p.type === 'text' ? p.text : `[${p.type}]`).join('')
        : '';
    const kind: import('../shared/types').TrajRecord['kind'] = m._memory
      ? 'context'
      : m.role === 'system'
        ? 'system'
        : typeof text === 'string' && text.startsWith('[早期对话摘要]')
          ? 'compacted'
          : m.role === 'tool' || (m.tool_calls && m.tool_calls.length)
            ? 'tool'
            : m.role === 'assistant'
              ? 'message'
              : 'user';
    out.push({
      kind,
      role: m.role,
      text: text.length > TRAJ_TEXT_LIMIT ? text.slice(0, TRAJ_TEXT_LIMIT) + '\n…[截断]' : text,
    });
  }
  return out;
}

// Drop transient messages (system prompt + the in-flight memory marker msg) before persisting
// history. The memory msg is re-injected fresh every turn by runAgentLoop, so it must not write
// back to directHistory (otherwise it'd stack up across turns and go stale).
function dropTransient(messages: ChatMsg[]): ChatMsg[] {
  return messages
    .filter((m) => m.role !== 'system' && !m._memory)
    .map((m) => {
      // 持久化前清理:image content parts 转回纯文本(base64 太大不存 directHistory)。
      if (typeof m.content === 'string' && m.content.includes('\x00IMAGES')) {
        return { ...m, content: m.content.replace(/\x00IMAGES\[.+?\]\x00/s, '').trim() };
      }
      if (Array.isArray(m.content)) {
        const textPart = m.content.find((p) => p.type === 'text');
        return { ...m, content: textPart?.text ?? '' };
      }
      return m;
    });
}

// 用户中断后,确保 messages 以合法的 assistant 消息结尾(否则下一轮 send 时 API 会收到
// 连续两个 user 消息或 tool 后面直接跟 user → 模型不知道之前做了什么)。
// 三种需要补尾的情况:
//   1. 最后一条是 user      → abort 发生在首轮 LLM 回复前(还没 push assistant)
//   2. 最后一条是 tool       → abort 发生在工具执行后、下一轮 LLM 回复前
//   3. 最后一条是 assistant 且有 tool_calls → 缺 tool result 配对(API 要求 assistant.tool_calls 后必须跟 tool)
function finalizeAbortedMessages(raw: ChatMsg[]): ChatMsg[] {
  const msgs = dropTransient(raw);
  if (!msgs.length) return msgs;
  const last = msgs[msgs.length - 1];
  if (last.role === 'user') {
    // 情况 1:补一条占位 assistant(让下一轮 API 看到正常的 user→assistant 交替)
    msgs.push({ role: 'assistant', content: '[已中断]' });
  } else if (last.role === 'tool') {
    // 情况 2:tool 后面缺 assistant 回复 → 补占位
    msgs.push({ role: 'assistant', content: '[已中断]' });
  } else if (last.role === 'assistant' && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
    // 情况 3:assistant 要求调工具但还没执行 → 补假 tool results 配对
    for (const tc of last.tool_calls) {
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: '[已停止]' });
    }
    msgs.push({ role: 'assistant', content: '[已中断]' });
  }
  return msgs;
}

function errMsg(e: unknown): string {
  const err = e as { kind?: string; code?: number; message?: string; detail?: string };
  const lang = getSettings().lang;
  if (err && err.kind === 'noKey') return t(lang, 'al.noKey');
  if (err && err.kind === 'http') return t(lang, 'al.httpErr', { code: err.code ?? 0, detail: err.detail ? ` — ${err.detail}` : '' });
  return t(lang, 'al.err', { msg: (e as Error)?.message ?? String(e) });
}

// Token estimation, calibrated from real API usage.
// ponytail: GLM/Claude/OpenAI 的 tokenizer 各不同且不公开 → 不上 tiktoken(加 ~1MB 依赖、打包变大)。
// 改用「字符数 × 校准系数」:每轮拿 API 真实 prompt_tokens 反推 token/char 比,滑动平均,自动贴合实际模型。
// 按协议(openai/anthropic)分别保存系数,避免并发会话互相干扰(GLM 中英文比 ≠ Claude)。
// 默认值 0.75:中文 1 字 ≈ 1-2 token(偏保守),英文 ~4 字符 ≈ 1 token → 混合场景 0.75 比旧 0.6 更安全。
// 首轮 API 返回后 calibrateTokens 会立即校准到真实值,默认值只在首次调用时使用一次。
const tokenCoefByProto: Record<string, number> = {};
function coefFor(proto?: string): number {
  const k = proto ?? 'default';
  if (tokenCoefByProto[k] === undefined) tokenCoefByProto[k] = 0.75;
  return tokenCoefByProto[k];
}
// 消息字符体积 = content + tool_calls(JSON 串)。tool_calls 之前漏算 → 大 tool result 误判余量、超发。
export function estMsgChars(m: ChatMsg): number {
  let content = '';
  if (typeof m.content === 'string') content = m.content;
  else if (Array.isArray(m.content)) content = m.content.map((p) => { const tp = p as { text?: string }; return tp.text ?? ''; }).join('');
  const tc = Array.isArray(m.tool_calls) ? JSON.stringify(m.tool_calls).length : 0;
  return content.length + tc;
}

// 导出给 renderer / UI 用:估算一批消息的 token 总量(用当前校准系数)。
// 用于上下文进度条 —— 用户实时看到当前对话大约用了多少 token。
export function estTokenCount(msgs: ChatMsg[], proto?: string): number {
  if (!msgs.length) return 0;
  const c = coefFor(proto);
  return msgs.reduce((s, m) => s + Math.floor(estMsgChars(m) * c) + 20, 0);
}

// 导出当前系数(UI 可选显示"估算精度")。
export function getTokenCoef(proto?: string): number {
  return coefFor(proto);
}
// 用这批 messages 的真实 prompt_tokens 校准 tokenCoef(滑动平均 0.5/0.5,抗单轮抖动)。
function calibrateTokens(realPromptTokens: number, msgs: ChatMsg[], proto?: string): void {
  const chars = msgs.reduce((s, m) => s + estMsgChars(m), 0);
  const k = proto ?? 'default';
  if (realPromptTokens > 0 && chars > 0) {
    tokenCoefByProto[k] = coefFor(k) * 0.5 + (realPromptTokens / chars) * 0.5;
  }
}

// Keep the tail of history within a token budget. Mirrors Swift DirectEngine.
// Sanitize after trimming: a hard byte-cut can split an assistant(tool_calls) ↔ tool pair, leaving
// an "orphan" tool message whose assistant was dropped — both OpenAI and Anthropic reject that.
// 标了 _memory 的消息(长期记忆块)永远保留:它是参考材料,不是对话历史,不该被裁掉。
// 标了 _pinned 的消息(用户锁定的关键 turn)同样永远保留。
export function trimHistoryToTokenBudget(msgs: ChatMsg[], budget: number, proto?: string): ChatMsg[] {
  if (!msgs.length) return [];
  const c = coefFor(proto);
  const memoryMsgs = msgs.filter((m) => m._memory);
  const pinnedMsgs = msgs.filter((m) => m._pinned);
  // P1-fix: compactHistory 产出的摘要消息(content 以 [早期对话摘要] 开头)永远保留。
  // 否则第一轮 compact 生成的摘要,第二轮 trim 时作为普通消息从头部被丢弃 → 信息完全丢失。
  const summaryMsgs = msgs.filter((m) =>
    typeof m.content === 'string' && m.content.startsWith('[早期对话摘要]'));
  const rest = msgs.filter((m) => !m._memory && !m._pinned &&
    !(typeof m.content === 'string' && m.content.startsWith('[早期对话摘要]')));
  if (!rest.length) return [...memoryMsgs, ...pinnedMsgs, ...summaryMsgs];
  let total = 0;
  const kept: ChatMsg[] = [];
  for (const m of [...rest].reverse()) {
    const tokens = Math.floor(estMsgChars(m) * c) + 20; // +20 per-message overhead
    if (total + tokens > budget && kept.length) break;
    total += tokens;
    kept.push(m);
  }
  // 记忆消息本就处于头部,pinned 紧随其后,摘要消息在 pinned 之后(它们都是"永不可丢"的头部上下文)。
  return [...memoryMsgs, ...pinnedMsgs, ...summaryMsgs, ...sanitizeToolPairs(kept.reverse())];
}

// Drop orphan tool messages (their caller assistant was trimmed away) so the next API call is valid.
function sanitizeToolPairs(msgs: ChatMsg[]): ChatMsg[] {
  // 收集所有 tool 消息的 tool_call_id(有结果的 call)
  const answeredCalls = new Set<string>();
  for (const m of msgs) {
    if (m.role === 'tool' && m.tool_call_id) answeredCalls.add(m.tool_call_id);
  }
  // 第一遍:删除"孤儿 assistant"(tool_calls 里至少一个没对应 tool 结果,且无文本内容)
  // 同时收集存活的 assistant 的 tool_call_id
  const liveCallIds = new Set<string>();
  const afterAssistant = msgs.filter((m) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const allAnswered = m.tool_calls.every((tc) => answeredCalls.has(tc.id));
      const hasText = typeof m.content === 'string' && m.content.trim().length > 0;
      if (!allAnswered && !hasText) return false; // 孤儿 → 删
      for (const tc of m.tool_calls) liveCallIds.add(tc.id);
    }
    return true;
  });
  // 第二遍:删除"孤儿 tool 消息"(对应的 assistant 在上一遍被删了)
  return afterAssistant.filter((m) => {
    if (m.role === 'tool' && m.tool_call_id) return liveCallIds.has(m.tool_call_id);
    return true;
  });
}

// 摘要压缩:历史超 budget 时,把将被丢弃的头部调一次 LLM 压成一条摘要,保留尾部完整轮次。
// 长 conversation 不再丢早期上下文。失败 → 回退纯尾部 trim(不丢功能)。
// _memory 消息不参与摘要(它是参考,不是对话),摘要后照旧 prepend 回头部。
// ponytail: ① 每 turn 末尾按需摘一次,未做摘要缓存;② 摘要消息受 trimHistoryToTokenBudget 保护(不会被二次丢弃)。
// 优化:结构化摘要 prompt — 不再让 LLM 自由发挥,而是要求固定字段(目标/决策/文件/结论),
// 这样摘要消息对后续步骤的信息密度远高于旧版的自由文本摘要。
export async function compactHistory(
  msgs: ChatMsg[],
  budget: number,
  provider: Provider,
  snap: ConfigSnapshot,
  signal: AbortSignal,
  onEvent?: (e: AgentEvent) => void,
  convId?: string, // 传入 convId 时启用文件追踪:程序化提取 + 持久化到 conv_facts + 注入 summary
): Promise<ChatMsg[]> {
  const memoryMsgs = msgs.filter((m) => m._memory);
  const pinnedMsgs = msgs.filter((m) => m._pinned);
  // P1-fix: 已有的摘要消息也跟 memory/pinned 一样跳过 compact(不再被二次摘要)。
  const summaryMsgs = msgs.filter((m) =>
    typeof m.content === 'string' && m.content.startsWith('[早期对话摘要]'));
  const rest = msgs.filter((m) => !m._memory && !m._pinned &&
    !(typeof m.content === 'string' && m.content.startsWith('[早期对话摘要]')));
  const tail = trimHistoryToTokenBudget(rest, budget, snap.apiProtocol);
  if (tail.length === rest.length) {
    return [...memoryMsgs, ...pinnedMsgs, ...summaryMsgs, ...tail]; // 没超预算,无需摘要
  }
  const head = rest.slice(0, rest.length - tail.length);
  if (!head.length) return [...memoryMsgs, ...pinnedMsgs, ...summaryMsgs, ...tail];
  // 文件追踪:从被丢弃的 head 消息中程序化提取文件操作,merge 到 conv_facts 的 file_registry。
  // 这比让 LLM 从 transcript 里"猜"文件路径精确得多,且跨多轮 compaction 累积不丢。
  let fileAppendix = '';
  if (convId) {
    const ops = extractFileOps(head);
    const { readFiles, modifiedFiles } = mergeFileOpsWithPersisted(convId, ops);
    fileAppendix = formatFileOps(readFiles, modifiedFiles);
  }
  try {
    // 结构化摘要 prompt:固定字段 → 信息密度远高于自由文本摘要。
    // 对标 Claude Code 的 compaction:保留"决策语义"而非原始文本片段。
    // 注意:文件列表已从 tool_calls 程序化提取并 append 到摘要末尾(<read-files>/<modified-files>),
    // 摘要 prompt 中【已改文件】字段改为可选(LLM 只需补充"为什么改"的语义,路径列表不需要重复)。
    const sys = `你是对话摘要器。把下面这段早期对话压成结构化中文摘要,严格按以下格式输出:

【任务目标】一句话描述用户要完成什么
【关键决策】列出已确定的技术方案/架构选择(每条一行,最多 5 条)
【已改文件】简述涉及哪些模块(只需语义描述如"AgentLoop.ts 的 compactHistory"或"无",精确路径列表已自动附加)
【执行命令】列出关键 shell 命令及其结果(成功/失败)
【重要结论】已完成步骤的核心产出(每条一行,最多 5 条)
【待办事项】尚未完成的遗留问题

规则:
- 丢掉寒暄、一次性细节、中间探查过程(如 ls/cat 输出)
- 保留命令、错误信息、技术栈名称的原文
- 每个字段不超过 3 行;没有内容的字段写"无"
- 不要输出任何标题/前言,直接从【任务目标】开始`;

    const transcript = head
      .map((m) => {
        const role = m.role === 'tool' ? '工具结果' : m.role;
        const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.type === 'text' ? p.text : '').join('') : JSON.stringify(m.tool_calls ?? '');
        return `[${role}] ${text}`;
      })
      .join('\n');
    // 截断到 16K 字符(旧版 12K),在行边界截(避免截在消息中间导致摘要 LLM 看到半截)。
    // 提高到 16K 是因为结构化摘要需要更多原始材料才能准确提取文件路径和命令。
    const MAX_TRANSCRIPT = 16_000;
    let trimmed = transcript;
    if (transcript.length > MAX_TRANSCRIPT) {
      const cut = transcript.slice(0, MAX_TRANSCRIPT);
      const lastNl = cut.lastIndexOf('\n');
      trimmed = (lastNl > MAX_TRANSCRIPT * 0.5 ? cut.slice(0, lastNl) : cut) + '\n…[截断]';
    }
    const comp = await provider.streamComplete(
      [{ role: 'system', content: sys }, { role: 'user', content: trimmed }],
      [],
      snap,
      signal,
      () => {},
    );
    // 摘要 LLM 调用的 cost 也要上报(否则长对话压缩成本漏报)
    if (onEvent && (comp.tokensIn > 0 || comp.tokensOut > 0)) {
      onEvent({ type: 'cost', usd: priceUSD(snap.model, comp.tokensIn, comp.tokensOut), tokens: comp.tokensIn + comp.tokensOut });
    }
    const summary = comp.content.trim();
    if (!summary) return [...memoryMsgs, ...pinnedMsgs, ...summaryMsgs, ...tail];
    // 文件列表 append 到摘要末尾(程序化提取,100% 准确,不依赖 LLM)。
    const finalSummary = fileAppendix ? `${summary}${fileAppendix}` : summary;
    // 发压缩事件 → renderer 高亮提示「已自动压缩 headTokens → summaryTokens」。
    if (onEvent) {
      const headTokens = head.reduce((s, m) => s + Math.floor(estMsgChars(m) * coefFor(snap.apiProtocol)) + 20, 0);
      const summaryTokens = Math.floor(finalSummary.length * coefFor(snap.apiProtocol)) + 20;
      onEvent({ type: 'status', text: `已自动压缩 ${headTokens} → ${summaryTokens} tokens(早期对话结构化摘要)` });
      onEvent({ type: 'context', action: 'compacted', beforeTokens: headTokens, afterTokens: summaryTokens } as AgentEvent & { type: 'context' });
    }
    return [...memoryMsgs, ...pinnedMsgs, ...summaryMsgs, { role: 'user', content: `[早期对话摘要]\n${finalSummary}` }, ...tail];
  } catch {
    return [...memoryMsgs, ...pinnedMsgs, ...summaryMsgs, ...tail]; // 摘要失败 → 纯尾部,不丢功能
  }
}

// Run a turn's tool calls:连续的只读(readOnly)工具并发执行,含写的工具串行。
// 结果按原 toolCalls 顺序回填 messages(配对靠 tool_call_id)。abort 时补"已停止"占位以维持配对。
async function runToolBatch(
  calls: { id: string; name: string; arguments: string }[],
  tools: Tool[],
  ctx: ToolCtx,
  signal: AbortSignal,
  onEvent: (e: AgentEvent) => void,
  // 截断阈值:从策略包取(覆盖硬编码 8K)。hifi 模式 truncateThreshold 已翻倍到 12K。
  truncateThreshold = 8000,
): Promise<ChatMsg[]> {
  const results: ChatMsg[] = [];
  // 执行前发个 status → 聊天框 streaming 区显示「执行 X, Y…」,让用户知道在跑工具(不只三点)。
  if (calls.length) onEvent({ type: 'status', text: t(getSettings().lang, 'al.executing', { tools: calls.map((c) => c.name).join(', ') }) });
  let i = 0;
  while (i < calls.length) {
    if (signal.aborted) {
      while (i < calls.length) {
        const c = calls[i];
        onEvent({ type: 'tool', name: c.name, args: c.arguments, result: '[已停止]' });
        results.push({ role: 'tool', tool_call_id: c.id, content: '[已停止]' });
        i++;
      }
      break;
    }
    const call = calls[i];
    const tool = tools.find((t) => t.name === call.name);
    if (tool?.readOnly) {
      // 收集连续只读段,一起并发。
      const start = i;
      while (i < calls.length && tools.find((t) => t.name === calls[i].name)?.readOnly) i++;
      const batch = calls.slice(start, i);
      const outs = await Promise.all(
        batch.map(async (c) => {
          if (signal.aborted) return { c, result: '[已停止]' as string, dur: 0 };
          const t0 = Date.now();
          const result = await execute(c, tools, ctx);
          const dur = Date.now() - t0;
          onEvent({ type: 'tool', name: c.name, args: c.arguments, result: parseScreenshotResult(result) ? '📷 截屏成功 (图片已发送给模型)' : result, durationMs: dur }); // UI 不显示 base64
          // 截图结果不截断(base64 不能被截断,否则图片损坏)→ 走多模态路径
          const forModel = parseScreenshotResult(result) ? result : truncateForModel(result, truncateThreshold);
          return { c, result: forModel, dur };
        }),
      );
      for (const { c, result } of outs) {
        // screenshot 工具返回 __IMAGE_BASE64__: 标记 → 转为多模态 tool 消息(文本+图片)
        const shot = parseScreenshotResult(result);
        if (shot) {
          results.push({
            role: 'tool',
            tool_call_id: c.id,
            content: [
              { type: 'text', text: shot.textPart || 'Screenshot captured.' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${shot.b64}`, detail: 'auto' } },
            ],
          });
        } else {
          results.push({ role: 'tool', tool_call_id: c.id, content: result });
        }
      }
    } else {
      // 写工具:串行单个执行。
      const t0 = Date.now();
      const result = signal.aborted ? '[已停止]' : await execute(call, tools, ctx);
      const dur = Date.now() - t0;
      onEvent({ type: 'tool', name: call.name, args: call.arguments, result: parseScreenshotResult(result) ? '📷 截屏成功 (图片已发送给模型)' : result, durationMs: dur });
      // 截图工具(只读,但防御性处理)—— 不截断 base64
      const shot = parseScreenshotResult(result);
      if (shot) {
        results.push({
          role: 'tool',
          tool_call_id: call.id,
          content: [
            { type: 'text', text: shot.textPart || 'Screenshot captured.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${shot.b64}`, detail: 'auto' } },
          ],
        });
      } else {
        results.push({ role: 'tool', tool_call_id: call.id, content: truncateForModel(result, truncateThreshold) });
      }
      i++;
    }
  }
  return results;
}

// ponytail: __IMAGE_BASE64__ 标记可能被"读源码 / grep 命中字面量"伪造(2026-08-31 的 GLM 1214 事故:
// agent read_file 读到本标记所在源码段,剩余 JS 源码被拼进 data: URL 发给 GLM → 400 [1214])。
// payload 必须是纯 base64 且够长才认定为真截图,否则当普通文本。
const IMG_MARKER = '__IMAGE_BASE64__:';
function parseScreenshotResult(result: string): { textPart: string; b64: string } | null {
  const idx = result.indexOf(IMG_MARKER);
  if (idx < 0) return null;
  const b64 = result.slice(idx + IMG_MARKER.length).trim();
  if (b64.length < 100 || !/^[A-Za-z0-9+/=\r\n]+$/.test(b64)) return null;
  return { textPart: result.slice(0, idx).trim(), b64 };
}

// 长 tool result 截断喂模型(不影响 UI 看完整原文)。read_file 一个 4MB 文件 / shell 几 MB 输出
// / web_fetch 全页如果不截,下一轮全字面进 input → 爆 input token。模型基本只需头尾(路径/错误/概要)。
// ponytail: 头尾按比例,中间省略号,简单粗暴;真要全文可加 follow-up 让 read_file 偏移读。
// 阈值由调用方传入(从 ENGINE_POLICIES 解析),默认 8K = direct 的策略。
function truncateForModel(s: string, threshold = 8000): string {
  if (s.length <= threshold) return s;
  const edge = Math.floor(threshold * 0.375); // 头尾各 ~37.5%,剩余 25% 留给省略号注释
  const omitted = s.length - 2 * edge;
  return `${s.slice(0, edge)}\n\n…[省略 ${omitted} 字符;UI 步骤详情可见完整结果]…\n\n${s.slice(-edge)}`;
}

// Detect "context too long" from a provider error (GLMError or raw). ponytail: OpenAI-compatible
// error wording varies by endpoint — match loosely, best-effort.
function isContextTooLong(e: unknown): boolean {
  const err = e as { kind?: string; code?: number; detail?: string; message?: string };
  if (err?.code === 413) return true;
  const text = `${err?.detail ?? ''} ${err?.message ?? ''}`.toLowerCase();
  return /context length|too long|maximum context|上下文|exceed|prompt is too/.test(text);
}
