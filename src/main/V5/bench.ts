// 离线评测任务集 —— 给「进化是否变好」一个可复跑的固定环境。
//
// 问题:没有固定任务和 grader,abCompare 无从比较,突变好坏只能靠线上噪声。
// 这里用确定性 mock 工具 + 脚本化模型跑一组覆盖读/命令/检索/写产物的任务,
// 产出每个基因的成功率/步数/成本对比。
//
// 关键口径:任务工具列表不进入 express 的「必需工具保护」—— 基因把工具摘掉就是
// 物理不可调(essential_tool_missing),这与真实个体一致,才测得出选择压力。
import type { Genome } from './phylum-types';
import { express } from './express';
import { runBodyPlan, type ChatFn } from './bodyplan';
import type { Tool } from '../tools';
import type { Completion, ToolCall } from '../glm';

export interface BenchTask {
  id: string;
  prompt: string;
  /** 脚本模型会依次调用的工具(被亲和摘除 → 个体物理不可调 → 失败) */
  tools: string[];
}

export interface BenchSide { label: string; genome: Genome }

export interface BenchRow {
  taskId: string;
  label: string;
  success: boolean;
  steps: number;
  tokens: number;
  cause: string;
}

export interface BenchSummary {
  label: string;
  trials: number;
  successes: number;
  avgSteps: number;
  avgTokens: number;
}

export interface BenchReport {
  rows: BenchRow[];
  summary: BenchSummary[];
  /** 成功率最高、同分步数最少者;全败 = null */
  winner: string | null;
}

export const BENCH_TASKS: BenchTask[] = [
  { id: 'read', prompt: '读取 data.txt 并总结要点', tools: ['read_file'] },
  { id: 'shell', prompt: '跑一次测试并报告结果', tools: ['shell'] },
  { id: 'search', prompt: '搜索主题资料', tools: ['web_search'] },
  { id: 'write', prompt: '把结论写成报告', tools: ['write_file'] },
  { id: 'read-shell', prompt: '读文件后执行命令', tools: ['read_file', 'shell'] },
  { id: 'search-write', prompt: '搜索后写报告', tools: ['web_search', 'write_file'] },
  { id: 'full', prompt: '检索、读文件、执行并写报告', tools: ['web_search', 'read_file', 'shell', 'write_file'] },
];

/** 确定性 mock 工具:输出稳定,不依赖磁盘/网络,保证同一基因每次跑分一致。 */
export function benchTools(): Tool[] {
  const tool = (name: string, text: string): Tool => ({
    name,
    description: `bench ${name}`,
    parameters: { type: 'object', properties: {} },
    async run() { return text; },
  });
  return [
    tool('read_file', '文件内容:line-1\nline-2'),
    tool('shell', 'ok\n[exit 0]'),
    tool('web_search', '搜索结果:相关片段 1/2/3'),
    tool('write_file', '已写入 report.md (128 字节)'),
  ];
}

/** 脚本化模型:依次调用任务工具,最后交 final answer。 */
function benchChat(task: BenchTask): ChatFn {
  let i = 0;
  return async (): Promise<Completion> => {
    if (i < task.tools.length) {
      const name = task.tools[i];
      i++;
      const call: ToolCall = { id: `c-${task.id}-${i}`, name, arguments: '{}' };
      return {
        content: '',
        toolCalls: [call],
        rawAssistant: {
          role: 'assistant', content: '',
          tool_calls: [{ id: call.id, type: 'function', function: { name, arguments: '{}' } }],
        },
        tokensIn: 20, tokensOut: 8,
      };
    }
    return { content: '完成', toolCalls: [], rawAssistant: { role: 'assistant', content: '完成' }, tokensIn: 5, tokensOut: 2 };
  };
}

/** 跑一轮离线评测:每个基因 × 每个任务一次(不结算、不进账本)。 */
export async function runBench(opts: {
  sides: BenchSide[];
  tools?: Tool[];
  cwd?: string;
  tasks?: BenchTask[];
  chatFactory?: (task: BenchTask) => ChatFn;
}): Promise<BenchReport> {
  const tasks = opts.tasks ?? BENCH_TASKS;
  const tools = opts.tools ?? benchTools();
  const cwd = opts.cwd ?? '/tmp/phylum-bench';
  const rows: BenchRow[] = [];
  for (const side of opts.sides) {
    for (const task of tasks) {
      const body = express(side.genome, tools, []);
      const r = await runBodyPlan({
        task: task.prompt,
        cwd,
        body,
        genome: side.genome,
        chat: (opts.chatFactory ?? benchChat)(task),
        tools: body.tools,
      });
      rows.push({
        taskId: task.id, label: side.label,
        success: r.success, steps: r.steps, tokens: r.tokens, cause: r.cause,
      });
    }
  }
  const summary: BenchSummary[] = opts.sides.map(({ label }) => {
    const rs = rows.filter((r) => r.label === label);
    return {
      label,
      trials: rs.length,
      successes: rs.filter((r) => r.success).length,
      avgSteps: rs.length ? rs.reduce((s, r) => s + r.steps, 0) / rs.length : 0,
      avgTokens: rs.length ? rs.reduce((s, r) => s + r.tokens, 0) / rs.length : 0,
    };
  }).sort((a, b) => b.successes - a.successes || a.avgSteps - b.avgSteps || a.avgTokens - b.avgTokens);
  return { rows, summary, winner: summary[0] && summary[0].successes > 0 ? summary[0].label : null };
}
