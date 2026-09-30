// codemode.ts —— 「Code Mode」工具:模型写 JavaScript,在 QuickJS-WASM 沙箱里编排其它工具。
// Code Mode tool: the model writes JavaScript that orchestrates other tools inside a
// QuickJS-WASM sandbox (via @earendil-works/pi-codemode, MIT, zero KinetAios deps beyond quickjs-wasi).
//
// 核心价值(vs 逐个 function calling):
// ① 嵌套工具调用与中间结果**不进 LLM 上下文** —— 只有脚本 return/output 进。
// ② 一段代码 = 批量 / 循环 / Promise.allSettled 并行 / 过滤大输出(20KB 以上工具结果脚本拿全量)。
// ③ store()/load() 跨调用共享 JSON(挂 convId 存证,与 remember_fact 同语义层)。
//
// 安全模型(与 Pi 同构):
// - 沙箱无 fs/无网络/无 timer —— 唯一能力是调用注入的嵌套工具;
// - 每次执行独立 worker + VM,超时整体 terminate(防 wasm 自旋死循环);
// - **嵌套调用复用各工具自身的审批/沙箱/隐私闸逻辑**(ctx 原样传递)→ shell 照样弹窗、
//   readOnly 沙箱照样拦写、隐私闸照样检测 —— codemode 是编排层,不是提权层。
//
// CJS/ESM 边界(本项目特有,tsc module=CommonJS 下 import() 会被编译成 require 包装 →
// ERR_REQUIRE_ESM;Electron 31 = Node 20 无 require(esm)):用 new Function 动态 import 逃逸。
// 模块级懒加载单例:首次调用才拉包(冷启动 ~100ms),进程内复用 wasm/声明缓存。
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { Tool, ToolCtx } from './tools';

// ── 类型(与 pi-codemode 解耦的本地最小形状,避免 CJS 侧顶层 type import 编译问题)──
interface CodemodeCallLog { name: string; status: string; durationMs: number }

// ── 动态 import 逃逸 + 单例缓存 ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let piMod: any = null;
function dynImport(): Promise<any> {
  // tsc 不转换 Function 构造器内的代码 → 真正的动态 import,能加载 ESM-only 包。
  // tsc does not transform code inside Function() → a real dynamic import that can load ESM.
  const loader = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
  return loader('@earendil-works/pi-codemode');
}

// ── 嵌套工具表:每次执行由 ctx 决定(主 agent 全量/子 agent 只读),不跨会话缓存 ctx ──
// ── 每会话 store 存证目录:<userData>/codemode-store/<convId>.json ──
// ponytail: store 直接落 JSON 文件而不是 SQLite —— 量小(key-value 快照)、无查询需求,
// 升级路径:迁到 store.ts 的 memories 表加 kind='codemode' 列即可。

function storePath(convId: string | undefined): string {
  // userData 路径从 app.getPath 拿;测试环境(无 electron)退化到 os.tmpdir()。
  let base = os.tmpdir();
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app?.getPath) base = app.getPath('userData');
  } catch { /* 非 Electron 环境 */ }
  return path.join(base, 'codemode-store', `${convId || 'default'}.json`);
}

function loadStore(convId: string | undefined): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(storePath(convId), 'utf8')) as Record<string, unknown>; }
  catch { return {}; }
}

function saveStore(convId: string | undefined, data: Record<string, unknown>): void {
  try {
    const p = storePath(convId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data), 'utf8');
  } catch { /* 存证失败不阻塞脚本结果返回 */ }
}

// ── 嵌套工具适配:KinetAios Tool → pi CodemodeTool ──
// 输入原样透传(工具自己校验参数并返回中文错误文本,与直接调用同一体验)。
function toCodemodeTools(
  tools: readonly Tool[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: ToolCtx,
): { register: (sb: unknown) => void; names: string[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapted: any[] = [];
  const names: string[] = [];
  for (const t of tools) {
    // codemode 自己不暴露给自己(防无限递归);写类工具是否可调由原工具的沙箱/confirm 逻辑把关。
    if (t.name === 'codemode') continue;
    names.push(t.name);
    adapted.push({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
      execute: async (args: unknown, context: { signal?: AbortSignal }) => {
        // 嵌套调用走工具自身的 run() → 审批桥/沙箱/隐私闸全部复用;signal 传沙箱的(超时即全断)。
        const sig = context?.signal && !context.signal.aborted ? context.signal : ctx.signal;
        const res = await t.run((args as Record<string, unknown>) ?? {}, { ...ctx, signal: sig });
        // 工具返回 string,原样透传 —— 脚本视角的类型必须与直接调用工具完全一致(工具契约就是 string)。
        // 此前在这里 JSON.parse 过一次:脚本再 JSON.parse(对象) 会在 QuickJS 里报
        // "unexpected token: object"(Node 抛的错文案不同,QuickJS 的更迷惑)。别动这行语义。
        // Tools return strings; pass through unchanged so script-side types match direct calls.
        return res;
      },
    });
  }
  return {
    names,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    register: (sb: any) => {
      for (const a of adapted) sb.registerTool(a);
    },
  };
}

// ── 声明缓存:同工具集(renderDeclarations 输入)只渲染一次 ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let declCache: { key: string; text: string } | null = null;

/** 给 system prompt 的 codemode 指南 + 嵌套工具声明(供 v2 引擎拼 prompt)。 */
export function codemodePromptSection(tools: readonly Tool[]): string {
  kickWarm(tools);
  const names = tools.filter((t) => t.name !== 'codemode').map((t) => t.name);
  const head = `
# codemode —— 代码编排工具(批量/并行/过滤大输出,中间结果不占上下文)

写一段 JavaScript(异步函数体,顶层 await/return 可用),在沙箱里通过 \`tools.<工具名>(参数)\` 调用其它工具。
嵌套工具调用的**全部中间结果不进对话上下文** —— 只有脚本 return 的值会返回给你。

适用:批量打标/分类 N 个条目、链式调用(搜→读→提炼)、\`await Promise.allSettled([...])\` 并行、
把大输出过滤成小摘要、循环调用直到条件满足。单次调用一个工具时**不要**用 codemode(直接调更便宜)。

规则:
- 原生 JS,无 require/import/fetch/fs/timer;只读工具照常可用,shell 等写操作的审批弹窗照常触发
- 参数是对象;\`tools["mcp__x__y"](…)\` 与 \`tools.mcp__x__y(…)\` 等价
- 脚本抛错/参数非法 → 该次调用 reject(Error,消息为工具错误文本);用 try/catch 或 allSettled 兜
- \`store(key,val)\`/\`load(key)\` 跨 codemode 调用共享 JSON(随会话持久);\`console.log\` 与 return 一起返回
- **Promise.allSettled 并行只对只读工具有意义**:写类工具(shell/write_file)每个都要人工确认弹窗,
  并行的多个确认弹窗只会保留最后一个、其余自动拒绝 —— 并行发写工具等于全部被拒
- 脚本中途失败/超时,本次已写入的 store() 不会落盘(宿主契约),别依赖"先存一半再出错"
- 返回值务必精炼:对象/数组/短文本。不要 return 整个原始工具输出(那等于白干)`;
  return head + `\n\n## 嵌套工具声明(TypeScript 签名)\n\n\`\`\`ts\n${codemodeDeclarations(tools)}\n\`\`\``;
}

// 首次构建 prompt 时模块多半还没加载完(ESM 动态 import ~100ms)→ 触发一次后台预热:
// 加载完成后下一轮 run 的 systemPrompt 就带上完整 TS 签名(带工具集 key,变化时自动重渲染)。
// Kick off a background warm-up on first prompt build; the next turn gets full TS signatures.
let warmKicked = false;
function kickWarm(tools: readonly Tool[]): void {
  if (warmKicked) return;
  warmKicked = true;
  void warmCodemode(tools);
}

/** renderDeclarations 的带缓存包装(工具集 key = 名字+描述长度哈希;模块未加载时给名字清单)。 */
// ponytail: key 用名字+描述长度而非内容哈希 —— MCP 工具热更描述且长度恰好不变时会用旧签名
// (后果仅限 prompt 略旧,参数 schema 同源)。升级路径:换 djb2 内容哈希。
function codemodeDeclarations(tools: readonly Tool[]): string {
  const key = tools.filter((t) => t.name !== 'codemode').map((t) => t.name + ':' + t.description.length).join('|');
  if (declCache && declCache.key === key) return declCache.text;
  // 模块还没加载好(预热未跑/失败)→ 降级为纯名字清单,不阻塞 prompt 构建。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pi = piMod as any;
  if (!pi) return `可用工具:${namesList(tools)}`;
  try {
    const text = pi.renderDeclarations({ tools: adaptedForDecl(tools) });
    declCache = { key, text };
    return text;
  } catch {
    return `可用工具:${namesList(tools)}`;
  }
}

function namesList(tools: readonly Tool[]): string {
  return tools.filter((t) => t.name !== 'codemode').map((t) => t.name).join(', ');
}

// renderDeclarations 只读 name/description/inputSchema/outputSchema —— 造轻量视图即可。
function adaptedForDecl(tools: readonly Tool[]): Array<Pick<Tool, 'name' | 'description' | 'parameters'>> {
  return tools.filter((t) => t.name !== 'codemode').map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/** 预热:拉模块 + 填声明缓存(引擎 idle 时调用,首次 codemode 调用更快)。失败静默。 */
export async function warmCodemode(tools: readonly Tool[]): Promise<void> {
  try {
    if (!piMod) piMod = await dynImport();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pi = piMod as any;
    const key = tools.filter((t) => t.name !== 'codemode').map((t) => t.name + ':' + t.description.length).join('|');
    declCache = { key, text: pi.renderDeclarations({ tools: adaptedForDecl(tools) }) };
  } catch { /* 环境缺包时不打扰主流程 */ }
}

// ── 工具本体 ──
const DEFAULT_TIMEOUT_MS = 300_000; // 与 pi 默认对齐:整个脚本(含工具耗时)5 分钟
const MAX_RETURN_CHARS = 20_000;    // 与 tools.ts 其它工具的上下文截断口径一致

export const codemodeTool: Tool = {
  name: 'codemode',
  description:
    'Run JavaScript that calls other tools (chains, loops, Promise.allSettled, filtering large results). ' +
    'Evaluates the code in a sandboxed QuickJS VM as an async function body (top-level await/return work). ' +
    'Nested tools are on the global `tools` object: `await tools.read_file({path:"..."})`. ' +
    'Nested tool calls and intermediate results do NOT enter the conversation context — only the return value does. ' +
    'No fs/network/timers; shell and other write tools still trigger their normal approval flow. ' +
    'Use for batching/looping/parallel tool calls and shrinking large outputs; do not use it for a single call.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JavaScript source (async function body). Raw JS — no markdown fences, no JSON quoting.' },
      timeoutMs: { type: 'number', description: `Overall deadline in ms including nested tool time. Default ${DEFAULT_TIMEOUT_MS}.` },
    },
    required: ['code'],
  },
  // 只读标记只影响并发调度;真正的写安全由嵌套工具自身把关。
  readOnly: true,
  async run(args, ctx) {
    const code = String(args.code ?? '');
    if (!code.trim()) return '错误:code 不能为空。';
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000), 600_000);

    // ① 懒加载 pi-codemode(ESM 动态 import)
    if (!piMod) {
      try { piMod = await dynImport(); }
      catch (e) {
        return `错误:codemode 运行时加载失败(${(e as Error)?.message})。` +
          '请确认已安装依赖:npm i @earendil-works/pi-codemode';
      }
    }

    // ② 嵌套工具表 = 当前会话工具集(引擎组装后回填 ctx.nestedTools,含 allTools + MCP)。
    const nested: readonly Tool[] | undefined = ctx.nestedTools;
    if (!nested || !nested.length) return '错误:codemode 未配置嵌套工具集(nestedTools)。';

    // ③ 组沙箱:每次执行独立 worker+VM;ctx.signal(用户停等)透传为执行 signal。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { CodemodeSandbox } = piMod as any;
    const adapter = toCodemodeTools(nested, ctx);
    const sb = new CodemodeSandbox({ timeoutMs });
    try {
      adapter.register(sb);
      // store:会话级持久 JSON(与 remember_fact 同语义层;codemode 内的 store() 写回同一份)
      const storeData = loadStore(ctx.convId);
      // memoryLimitBytes 默认 256MB:pi 默认不限制,wasm 线性内存按需涨,一个失控脚本能把主机内存吃爆。
      // 256MB 对批量编排绰绰有余;溢出时 QuickJS 抛 RangeError(可被脚本 catch),worker 不炸。
      const result = await sb.execute(code, { signal: ctx.signal, store: storeData, memoryLimitBytes: 256 * 1024 * 1024 });

      // ④ 落存证(storeWrites)—— 仅成功时:pi 的 done 消息只在成功路径带 writes,
      // 失败/超时/中止时 worker 已终止,中途 store() 的进度拿不到(pi 契约,已在 prompt 指南声明)。
      if (result.ok && result.storeWrites) {
        const next = { ...storeData };
        for (const [k, v] of Object.entries(result.storeWrites.set ?? {})) next[k] = v;
        for (const k of result.storeWrites.delete ?? []) delete next[k];
        saveStore(ctx.convId, next);
      }

      // ⑤ 组返回文本:返回值 + output(console)+ 调用统计(嵌套调用本身不进上下文,给个台账)
      const lines: string[] = [];
      if (!result.ok) {
        const err = result.error ?? {};
        lines.push(`❌ 脚本${err.kind === 'timeout' ? `超时(>${timeoutMs}ms,worker 已终止)` : err.kind === 'aborted' ? '被中止' : '失败'}:`);
        lines.push(String((err as { message?: string }).message ?? 'unknown error'));
      } else {
        lines.push('✅ 完成。');
      }
      // console 输出设上限:pi 不限制,模型可以 console.log 巨量数据把它灌进上下文,
      // 等于绕过「中间结果不进上下文」的卖点。单条 4K / 总量 16K,超出截断并提示用 return 精炼值。
      // Console output capped: unlimited output would flood the context and defeat the purpose.
      const MAX_CONSOLE_LINE = 4_000;
      const MAX_CONSOLE_TOTAL = 16_000;
      let consoleTotal = 0;
      let consoleTruncated = false;
      for (const item of result.output ?? []) {
        if (item.type !== 'text' || !item.text) continue;
        if (consoleTotal >= MAX_CONSOLE_TOTAL) { consoleTruncated = true; break; }
        const t2 = item.text.length > MAX_CONSOLE_LINE ? item.text.slice(0, MAX_CONSOLE_LINE) + '…[截断]' : item.text;
        consoleTotal += t2.length;
        lines.push(`[console] ${t2}`);
      }
      if (consoleTruncated) lines.push(`…[console 输出超 ${MAX_CONSOLE_TOTAL} 字符已截断 —— 大数据请 return 精炼汇总,不要 console.log]`);
      if (result.ok) {
        // value 精炼化:超长截断(带全量落盘提示,与其它工具口径一致)
        let text: string;
        try { text = typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2); }
        catch { text = String(result.value); }
        if (text && text !== 'undefined') {
          if (text.length > MAX_RETURN_CHARS) {
            const tmp = path.join(os.tmpdir(), `codemode_out_${Date.now()}.json`);
            try { fs.writeFileSync(tmp, text, 'utf8'); } catch { /* 落盘失败就算了 */ }
            lines.push(`\n[返回值](前 ${MAX_RETURN_CHARS} 字符,全量 ${text.length} 字符已落 ${tmp})\n${text.slice(0, MAX_RETURN_CHARS)}\n…[截断]`);
          } else {
            lines.push(`\n[返回值]\n${text}`);
          }
        }
        const calls: CodemodeCallLog[] = result.calls ?? [];
        const okN = calls.filter((c) => c.status === 'ok').length;
        const errN = calls.filter((c) => c.status === 'error').length;
        const totalMs = calls.reduce((s, c) => s + c.durationMs, 0);
        lines.push(`\n[嵌套调用] ${okN} 成功 / ${errN} 失败,共 ${calls.length} 次,累计 ${Math.round(totalMs)}ms(这些调用的输出未进入对话上下文)`);
      }
      return lines.join('\n');
    } finally {
      // close() 会 abort 在途执行并拒绝新执行 —— 单次工具调用一个沙箱,生命周期干净。
      await sb.close().catch(() => undefined);
    }
  },
};
