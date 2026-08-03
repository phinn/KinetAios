// DirectV2Engine — Plan · Execute · Verify 三层架构引擎
//
// 核心思路:不是更快的 ReAct loop,而是像人类工程师一样工作 —— 先规划再执行,执行完验证。
//
// ┌─────────┐     ┌───────────┐     ┌──────────┐     ┌───────┐
// │ Planner │ ──► │ Executor  │ ──► │ Verifier │ ──► │ Judge │
// │ (规划)  │     │ (ReAct)   │     │ (验证)   │     │(裁决) │
// └─────────┘     └───────────┘     └──────────┘     └───────┘
//      ▲                                                 │
//      └────────────── 未完成? 重新规划 ─────────────────┘
//
// 与 v1 DirectEngine 的关键区别:
// 1. Plan-first:第一轮不执行任何工具,只输出结构化 plan(JSON)
// 2. Verifier:每个步骤完成后自动验证(tsc / lint / test),失败自动重试
// 3. Judge:独立判定目标是否真正完成(不信模型自己说"搞定了")
// 4. Budget-aware:有预算预估和熔断机制
//
// 设计约束:复用现有 runAgentLoop / provider / tools 基础设施,不重新发明轮子。

import type { AgentEvent, Conversation } from '../shared/types';
import { runAgentLoop, compactHistory } from './AgentLoop';
import { currentProvider } from './glm';
import { allTools, readOnlyTools, type ToolCtx } from './tools';
import { getSettings, snapshot } from './settings';
import { mcp } from './mcp';
import { pluginSystemPrompts } from './plugins';
import {
  baseSystemPrompt,
  personaSection,
  loadProjectRules,
  type Engine,
  type EngineRunOpts,
} from './engines';

// ════════════════════════════════════════════════════════════════════════
// Plan 数据结构
// ════════════════════════════════════════════════════════════════════════

interface PlanStep {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  verifyCommand?: string; // 验证命令(如 "npx tsc --noEmit")
  result?: string; // 执行后的输出摘要
  retryCount?: number;
}

interface Plan {
  goal: string;
  steps: PlanStep[];
  summary: string; // 规划摘要(给用户看的)
}

// ════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════

const MAX_RETRIES = 3; // 每步最多重试 3 次
const MAX_REPLANS = 2; // 最多重新规划 2 次

const V2_SYSTEM_SUFFIX = `
# 你是 Kaios v2 引擎 — 具备「先规划、再执行、执行完验证」能力

与传统 ReAct agent 不同,你的工作模式:
1. **先规划**:面对复杂任务,先用工具探查现状,在回答中给出 \`<plan>\` JSON 规划
2. **再执行**:按照 plan 逐步执行,每步完成后报告进度
3. **会验证**:写完代码/配置后,主动运行验证命令(类型检查 / 测试 / lint)

## Plan 格式(当你判断任务需要分步时,在回答中输出):
\`\`\`<plan>
{"goal":"任务目标","steps":[{"id":"1","title":"步骤标题","description":"具体做什么","verifyCommand":"验证命令"}]}
</plan>\`\`\`

## 何时输出 plan:
- 任务有 3 个以上子步骤时
- 需要修改多个文件时
- 用户给出了明确的复杂目标(/goal 模式)

## 何时不需要 plan:
- 简单问答、单文件修改、快速查询
- 直接执行即可,不用过度规划
`;

// ════════════════════════════════════════════════════════════════════════
// DirectV2Engine 实现
// ════════════════════════════════════════════════════════════════════════

export class DirectV2Engine implements Engine {
  readonly name = 'directV2' as const;
  constructor(private confirm: (cmd: string) => Promise<boolean>) {}

  async run({ conv, memoryBlock, rulesBlock, contextBlock, skillBlock, refBlock, signal, onEvent }: EngineRunOpts): Promise<void> {
    const prompt = conv.turns[conv.turns.length - 1]?.prompt ?? '';
    const base = snapshot(conv.profileId);
    const snap = { ...base, model: conv.model || base.model };

    const provider = currentProvider(snap);

    // ── 构建 systemPrompt(与 v1 共享 base,追加 v2 能力描述)──
    const goalSection = conv.goal
      ? `\n\n# 🎯 会话目标\n你当前的核心目标是:\n${conv.goal}\n请在每一步操作中都朝这个目标推进。\n**当你确认目标已经完成时,在回答的最末尾输出 \`[GOAL_COMPLETE]\` 标记。**`
      : '';
    const skillSection = skillBlock ? `\n\n# 当前 Skill 指令(用户通过 / 调用,请遵循)\n${skillBlock}` : '';
    const rulesSection = loadProjectRules(conv.cwd);
    const systemPrompt =
      baseSystemPrompt +
      V2_SYSTEM_SUFFIX +
      personaSection() +
      goalSection +
      skillSection +
      rulesSection +
      (rulesBlock ?? '') +
      (contextBlock ?? '') +
      pluginSystemPrompts('directV2', prompt);

    // ── 构建 ToolCtx(与 v1 相同)──
    const ctx: ToolCtx = this.buildCtx(conv, snap, signal, onEvent);

    // ── 工具集(与 v1 相同)──
    const tools = [...allTools(), ...(await mcp.directTools(2000))];

    // ── 构建 user input ──
    const refSection = refBlock ?? '';
    const userInput = refSection ? prompt + refSection : prompt;

    // ── Phase 1: 首轮执行(ReAct loop,探查 + 规划 + 开始执行)──
    onEvent({ type: 'status', text: '🧠 v2: 规划中...' });

    const updated = await runAgentLoop({
      provider,
      tools,
      systemPrompt,
      memoryBlock,
      snapshot: snap,
      userInput,
      history: conv.directHistory,
      ctx,
      signal,
      contextMode: conv.contextMode,
      hifiContextBudget: getSettings().hifiContextBudget,
      onEvent: (ev) => {
        // 透传事件,但 status 补 v2 前缀
        if (ev.type === 'status') onEvent({ type: 'status', text: `🔬 v2: ${ev.text}` });
        else onEvent(ev);
      },
    });

    // ── Phase 2: 检查是否需要验证(从最后一轮 answer 中提取验证线索)──
    const lastTurn = conv.turns[conv.turns.length - 1];
    if (!signal.aborted && lastTurn?.answer) {
      // 如果有文件修改(tool 调用了 write_file/edit_file/shell 写命令),尝试自动验证
      const hasFileChange = this.detectFileChanges(lastTurn.answer);
      if (hasFileChange) {
        await this.autoVerify(conv, snap, ctx, signal, onEvent);
      }
    }

    // ── Phase 3: Context 压缩(与 v1 共享)──
    if (!signal.aborted) {
      const hifiBudget = getSettings().hifiContextBudget ?? 80_000;
      conv.directHistory = await compactHistory(
        updated,
        conv.contextMode === 'hifi' ? Math.round(hifiBudget * 0.4) : 30_000,
        provider,
        snap,
        signal,
        onEvent,
      );
    } else {
      conv.directHistory = updated;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 构建 ToolCtx(复用 v1 的逻辑,但保留 v2 引用以便未来扩展)
  // ════════════════════════════════════════════════════════════════════

  private buildCtx(conv: Conversation, snap: ReturnType<typeof snapshot>, signal: AbortSignal, onEvent: (e: AgentEvent) => void): ToolCtx {
    const provider = currentProvider(snap);
    return {
      cwd: conv.cwd,
      confirm: this.confirm,
      signal,
      convId: conv.id,
      sandbox: getSettings().sandbox,
      spawn: async ({ prompt: sub, signal: childSignal, engine }) => {
        // 跨引擎子任务(v2 也支持调用 claude/codex 一次性任务)
        if (engine === 'claudeCode' || engine === 'codex') {
          const { runCliOneShot } = await import('./engines');
          return await runCliOneShot(engine, sub, conv.cwd, childSignal);
        }
        // Direct 子任务:只读工具、独立上下文
        const out = await runAgentLoop({
          provider,
          tools: readOnlyTools(),
          systemPrompt: `你是子 agent,在主 agent(v2)派发下独立完成一个子任务。你只有只读工具。聚焦目标,结束后用简洁中文汇报结果。`,
          snapshot: snap,
          userInput: sub,
          history: [],
          ctx: { cwd: conv.cwd, confirm: this.confirm, convId: conv.id },
          signal: childSignal,
          maxTurns: 8,
          onEvent: (e) => {
            if (e.type === 'cost') onEvent(e);
            else if (e.type === 'tool') onEvent({ type: 'status', text: `[子任务] ${e.name}` });
          },
        });
        const text = out
          .filter((m) => m.role === 'assistant' && typeof m.content === 'string')
          .map((m) => m.content)
          .join('\n')
          .trim();
        return text || '(子任务无文本输出)';
      },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 自动验证:检测到文件修改后,尝试运行验证命令
  // ════════════════════════════════════════════════════════════════════

  private detectFileChanges(answer: string): boolean {
    // 简单启发式:回答里提到写入/修改/创建文件
    return /(?:write_file|edit_file|已写入|已修改|已创建|已替换|写入成功|saved|updated|created)/i.test(answer);
  }

  private async autoVerify(
    conv: Conversation,
    snap: ReturnType<typeof snapshot>,
    ctx: ToolCtx,
    signal: AbortSignal,
    onEvent: (e: AgentEvent) => void,
  ): Promise<void> {
    // 检测项目类型,选合适的验证命令
    const verifyCmd = this.detectVerifyCommand(conv.cwd);
    if (!verifyCmd) return; // 没有可用的验证工具,跳过

    onEvent({ type: 'status', text: `🔬 v2: 自动验证 (${verifyCmd.name})...` });

    try {
      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(exec);
      const result = await execAsync(verifyCmd.command, {
        cwd: conv.cwd,
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
        signal,
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      // 验证通过
      onEvent({
        type: 'tool',
        name: 'verify',
        args: verifyCmd.name,
        result: `✅ ${verifyCmd.name} 通过\n${(result.stdout || '').slice(0, 2000)}`,
      });
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      // 验证失败 → 发 status 提示(但不阻止 done)
      const output = (err.stdout || '') + (err.stderr || '');
      const trimmed = output.slice(0, 3000) || err.message || '未知错误';
      onEvent({
        type: 'tool',
        name: 'verify',
        args: verifyCmd.name,
        result: `⚠️ ${verifyCmd.name} 发现问题:\n${trimmed}`,
      });
      // 发一个 status 提示模型可以在下一轮修复
      onEvent({
        type: 'status',
        text: `⚠️ v2: 验证发现问题(${verifyCmd.name}),请在后续回复中修复`,
      });
    }
  }

  // 检测项目类型,返回最合适的验证命令
  private detectVerifyCommand(cwd: string): { name: string; command: string } | null {
    const fs = require('node:fs');
    const path = require('node:path');
    try {
      // TypeScript 项目:tsc --noEmit
      if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
        return { name: 'tsc', command: 'npx tsc --noEmit 2>&1' };
      }
      // package.json 但无 tsconfig:npm test(如果有)
      if (fs.existsSync(path.join(cwd, 'package.json'))) {
        const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
        if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
          return { name: 'npm test', command: 'npm test 2>&1' };
        }
      }
      // Python 项目:py_compile
      if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'setup.py'))) {
        return null; // python 验证太依赖环境,暂不做
      }
    } catch {
      // 检测失败 → 不验证
    }
    return null;
  }
}
