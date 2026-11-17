// workflow-job — workflow_run 后台 Job 化(P0-3):多阶段编排从 turn 内联搬到 jobs 表持久化。
// workflow as persistent job (P0-3): multi-stage pipeline survives conversation switch & app restart.
//
// 设计(复用既有基建,不造新轮):
// - JobManager(jobs 表 + checkpoint 列 + worker 池) — v3-deep 同款生命周期
// - WorkflowState(shared/types)整表推进,每阶段完成 checkpointSink(重启后可续跑)
// - member 执行复用 teams.runMember(member history 持久化/TeamEvent/cost 记账全继承)
// - resume 语义:重建 worker 需要的 provider/tools/ctx 由 engines 层的 workerFactory 注册表提供
//   (worker 是闭包,重启后 DB 里的 checkpoint 无闭包可跑 —— factory 按 convId 重建执行环境)
//
// 纯函数拆出(topoOrder/validateStages/…)便于无 LLM 单测;submitWorkflowJob 是 IO 壳。

import type { ToolCtx } from './tools';
import type { WorkflowState } from '../shared/types';
import type { MemberRunOpts } from './teams';

/** workflow 执行所需环境(engines.ts 的 workflowJobFactory 注册/提供) */
export interface WorkflowJobEnv {
  runOpts: MemberRunOpts;
}

/** 已完成阶段 + 各阶段产出(重启后从此续跑) */
export interface WorkflowCheckpoint {
  workflowId: string;
  title: string;
  /** stages[i].label → 该阶段每成员的回答(workflowId 冗余防错挂) */
  doneStages: Array<{ label: string; answers: Record<string, string> }>;
}

// ── 纯函数:阶段图校验 / 拓扑分层 / prompt 组装 / 结果归并 / 重试计划 ──

export interface StageDef {
  label: string;
  members: Array<{ name: string; prompt: string }>;
  /** 依赖的阶段 label 列表;空 = 与上一阶段串行相接(默认)。显式给出则按 DAG 编排。 */
  depends_on?: string[];
  /** true = 与其他无依赖阶段并行跑(需要显式声明,防误烧 token) */
  parallel?: boolean;
}

const MAX_STAGE_MEMBERS = 8;

/** 阶段定义校验:label/members/依赖引用/环检测。返回 {error} 或 {stages(规范化后)} */
export function validateStages(
  stages: StageDef[],
  teamId: string,
): { error: string } | { error?: undefined; stages: StageDef[] } {
  if (!stages.length) return { error: '工作流至少需要一个阶段' };
  const byLabel = new Map<string, StageDef>();
  for (const s of stages) {
    const label = String(s.label ?? '').trim();
    if (!label) return { error: '每个阶段必须有 label' };
    if (byLabel.has(label)) return { error: `阶段 label 重复: ${label}` };
    if (!s.members?.length) return { error: `阶段「${label}」没有成员` };
    if (s.members.length > MAX_STAGE_MEMBERS) return { error: `阶段「${label}」成员过多(上限 ${MAX_STAGE_MEMBERS})` };
    for (const m of s.members) {
      if (!m.name?.trim() || !m.prompt?.trim()) return { error: `阶段「${label}」的每个成员必须有 name 和 prompt` };
    }
    byLabel.set(label, s);
  }
  // 依赖引用校验:只能引用【更早】出现的阶段(串行语义下未来阶段尚未定义,不猜意图)
  for (const s of stages) {
    for (const dep of s.depends_on ?? []) {
      if (!byLabel.has(dep)) return { error: `阶段「${s.label}」依赖不存在的阶段: ${dep}` };
      if (dep === s.label) return { error: `阶段「${s.label}」依赖自身` };
      if (stages.findIndex((x) => x.label === dep) > stages.findIndex((x) => x.label === s.label)) {
        return { error: `阶段「${s.label}」依赖了未来的阶段「${dep}」(依赖必须更早出现)` };
      }
    }
  }
  // 环检测(依赖只指向更早阶段时结构上不可能成环;显式 parallel 图仍防一手)
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const visit = (label: string): string | null => {
    color.set(label, GREY);
    const s = byLabel.get(label);
    for (const dep of s?.depends_on ?? []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GREY) return dep;
      if (c === WHITE) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
    }
    color.set(label, BLACK);
    return null;
  };
  for (const s of stages) {
    if ((color.get(s.label) ?? WHITE) === WHITE) {
      const cyc = visit(s.label);
      if (cyc) return { error: `阶段依赖成环(经 ${cyc}),请检查 depends_on` };
    }
  }
  void teamId; // 预留:阶段数上限按 team 等级区分
  return { stages };
}

/**
 * 拓扑分层:返回 level 数组,同层可并行,层间串行。
 * 默认依赖(未写 depends_on)= 依赖紧邻上一阶段(label 顺序);成环 throws。
 */
export function topoOrder(stages: StageDef[]): string[][] {
  // 规范化默认依赖:无 depends_on 字段的阶段 → 依赖前一个阶段(首个阶段无依赖)
  const norm = stages.map((s, i) => ({
    label: s.label,
    deps: s.depends_on ? [...s.depends_on] : i > 0 ? [stages[i - 1].label] : [],
  }));
  const level = new Map<string, number>();
  const depth = (label: string, seen: Set<string>): number => {
    if (seen.has(label)) throw new Error(`阶段依赖成环(经 ${label})`);
    if (level.has(label)) return level.get(label)!;
    seen.add(label);
    const s = norm.find((n) => n.label === label)!;
    const d = s.deps.length ? Math.max(...s.deps.map((d2) => depth(d2, seen))) + 1 : 0;
    level.set(label, d);
    return d;
  };
  for (const n of norm) depth(n.label, new Set());
  const layers: string[][] = [];
  for (const [label, d] of [...level.entries()].sort((a, b) => a[1] - b[1])) {
    (layers[d] ??= []).push(label);
  }
  return layers;
}

/** 组装某阶段某成员的最终 prompt(上一阶段汇总 + 分工 + 本阶段任务) */
export function buildStagePrompt(
  stagePrompt: string,
  prevAnswers: Map<string, string>,
  members: Array<{ name: string; prompt: string }>,
): string {
  const digest = [...prevAnswers.entries()]
    .map(([n, a]) => `### ${n}\n${a}`)
    .join('\n');
  const roles = members.map((m) => `- ${m.name}: ${m.prompt}`).join('\n');
  return [
    prevAnswers.size ? `# 上一阶段产出(供参考/批判/接力)\n${digest}\n` : '',
    `# 本阶段任务\n${stagePrompt}`,
    `# 本阶段分工\n${roles}`,
  ].filter(Boolean).join('\n');
}

/** 归并一个阶段的结果:缺失/空 → failed(不掩盖) */
export function mergeStageResults(
  members: Array<{ name: string; prompt: string }>,
  answers: Map<string, string>,
): Record<string, 'done' | 'failed'> {
  const out: Record<string, 'done' | 'failed'> = {};
  for (const m of members) out[m.name] = answers.get(m.name)?.trim() ? 'done' : 'failed';
  return out;
}

/**
 * 重试计划:返回本阶段需要重跑的失败成员名;超过 retryLimit → null(整阶段放弃)。
 * @param memberStatus 当前阶段各成员状态
 * @param allNames 全部成员名
 * @param retried 该成员已重试次数(简单起见:全阶段共享一个计数,首次实现够用)
 * @param retryLimit 上限
 */
export function nextRetryPlan(
  memberStatus: Record<string, string>,
  allNames: string[],
  retried: number,
  retryLimit: number,
): string[] | null {
  if (retried >= retryLimit) return null;
  return allNames.filter((n) => memberStatus[n] === 'failed');
}

/** 断点续跑:跳过 checkpoint 里已完成的阶段(返回原列表,由调用方按 label 过滤) */
export function skippedDoneStages(doneLabels: string[]): string[] {
  return doneLabels.slice();
}

// ── IO 壳:JobManager 提交 / 工厂注册 ──

/** workflow 执行环境工厂:engines 层注册;resume 时按 convId 重建 runOpts */
let envFactory: ((convId: string) => WorkflowJobEnv | undefined) | null = null;
export function setWorkflowJobFactory(fn: (convId: string) => WorkflowJobEnv | undefined): void {
  envFactory = fn;
}

export interface SubmitWorkflowOpts {
  convId: string;
  teamId: string;
  title: string;
  stages: StageDef[];
}

/**
 * 提交 workflow 后台 job。返回 job id;失败返回错误(调用方回落同步路径)。
 * 断点 = 已完成阶段数组(每阶段整体覆写,与 v3-deep 的 checkpointSink 同模式)。
 */
export async function submitWorkflowJob(opts: SubmitWorkflowOpts): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { jobManager } = await import('./JobManager');
  const { runMembersParallel } = await import('./teams');
  const env = envFactory?.(opts.convId);
  if (!env) return { ok: false, error: 'workflow job 环境未注册(会话可能已关闭)' };
  const v = validateStages(opts.stages, opts.teamId);
  if (v.error) return { ok: false, error: v.error };
  const runOpts = env.runOpts;
  const stages: StageDef[] = (v as { stages: StageDef[] }).stages;

  const submit = jobManager().submit({
    convId: opts.convId,
    turnId: null,
    kind: 'workflow',
    title: opts.title,
    payload: { teamId: opts.teamId, stages: stages.map((s) => s.label) },
    worker: async ({ signal, onEvent, checkpointSink, initialCheckpoint }) => {
      const cp = initialCheckpoint as WorkflowCheckpoint | undefined;
      // 防错挂:checkpoint 与本次提交的 team/title 不一致 → 丢弃旧断点从头跑
      const done: WorkflowCheckpoint['doneStages'] =
        cp && cp.workflowId === opts.teamId && cp.title === opts.title ? cp.doneStages.slice() : [];

      // WorkflowState 只做 UI 展示(实时卡);持久化断点独立走 checkpoint 列
      const state: WorkflowState = {
        workflowId: opts.teamId, title: opts.title,
        stages: stages.map((s, i) => ({
          label: s.label,
          status: (i < done.length ? 'done' : i === done.length ? 'running' : 'pending') as 'pending' | 'running' | 'done' | 'failed',
          members: s.members.map((m) => ({ name: m.name, role: '', status: 'pending' as const })),
        })),
        activeStage: Math.min(done.length, stages.length - 1),
        status: 'running',
        usd: 0,
      };
      const emitState = (): void => onEvent({ type: 'workflow', state: JSON.parse(JSON.stringify(state)) });
      const layers = topoOrder(stages);
      const answersByLabel = new Map<string, Record<string, string>>();
      for (const d of done) answersByLabel.set(d.label, d.answers);

      for (const layer of layers) {
        // 跳过已完成阶段(断点续跑)
        const todo = layer.filter((l) => !answersByLabel.has(l));
        if (!todo.length) continue;
        if (signal.aborted) throw new Error('已取消');
        for (const label of todo) {
          const stage = stages.find((s) => s.label === label)!;
          state.activeStage = stages.findIndex((s) => s.label === label);
          const stState = state.stages[state.activeStage];
          stState.status = 'running';
          emitState();
          onEvent({ type: 'status', note: `[workflow] 阶段:${stage.label}` });

          // 依赖阶段的产出汇总注入(有显式依赖用依赖的;否则用紧邻上一完成阶段)
          const depLabels = stage.depends_on?.length
            ? stage.depends_on
            : layers[layers.findIndex((l) => l.includes(label)) - 1] ?? [];
          const prev = new Map<string, string>();
          for (const dl of depLabels) {
            for (const [n, a] of Object.entries(answersByLabel.get(dl) ?? {})) prev.set(`${dl}/${n}`, a);
          }

          // job 信号 → runOpts.signal 桥接(kill job = abort 所有 member)
          const res = await runMembersParallel({
            members: stage.members.map((m) => ({
              team_id: opts.teamId, member_id: m.name, name: m.name, role: '',
              history: '[]', last_message: null, last_result: null,
              status: 'idle', created_at: 0, updated_at: 0,
            })),
            message: buildStagePrompt(stage.members.map((m) => m.prompt).join('\n---\n'), prev, stage.members),
            runOpts: { ...runOpts, signal },
          });

          const answers: Record<string, string> = {};
          for (const m of stage.members) answers[m.name] = res.get(m.name)?.answer ?? '';
          // 黑板沉淀已由 runMember 内部 depositToBoard 完成(此处不重复写,防双份 note)
          const statuses = mergeStageResults(stage.members, new Map(Object.entries(answers)));

          // 阶段内失败成员重试一轮(只重跑失败者;超限放弃整阶段,不中止全局)
          const failedNames = Object.entries(statuses).filter(([, s]) => s === 'failed').map(([n]) => n);
          if (failedNames.length) {
            const plan = nextRetryPlan(statuses, stage.members.map((m) => m.name), 0, 1);
            if (plan?.length) {
              onEvent({ type: 'status', note: `[workflow] 阶段「${stage.label}」重试失败成员: ${plan.join(',')}` });
              const res2 = await runMembersParallel({
                members: stage.members.filter((m) => plan.includes(m.name)).map((m) => ({
                  team_id: opts.teamId, member_id: m.name, name: m.name, role: '',
                  history: '[]', last_message: null, last_result: null,
                  status: 'idle', created_at: 0, updated_at: 0,
                })),
                message: buildStagePrompt(`${stage.members.map((m) => m.prompt).join('\n---\n')}\n\n(上一次执行失败,请重试并力求完成)`, prev, stage.members),
                runOpts: { ...runOpts, signal },
              });
              for (const n of plan) {
                const a2 = res2.get(n);
                if (a2?.answer?.trim()) { answers[n] = a2.answer; statuses[n] = 'done'; }
              }
            }
          }

          stState.members = stage.members.map((m) => ({
            name: m.name, role: '',
            status: (statuses[m.name] ?? 'failed') as 'done' | 'failed',
            summary: (answers[m.name] ?? '').slice(0, 300),
          }));
          stState.status = Object.values(statuses).every((s) => s === 'done') ? 'done' : 'failed';
          emitState();
          answersByLabel.set(label, answers);
          // 每阶段完成即落 checkpoint(整体覆写;crash 后 resume 跳过已完成阶段)
          checkpointSink({
            workflowId: opts.teamId, title: opts.title,
            doneStages: [...answersByLabel.entries()].map(([l, a]) => ({ label: l, answers: a })),
          } satisfies WorkflowCheckpoint);
        }
      }

      state.status = state.stages.some((s) => s.status === 'failed') ? 'failed' : 'done';
      emitState();
      // 汇总输出(与 tools.ts 同步版同格式)
      const parts: string[] = [`# 工作流「${opts.title}」完成`];
      for (let i = 0; i < stages.length; i++) {
        parts.push(`## 阶段 ${i + 1}:${stages[i].label}`);
        for (const m of stages[i].members) parts.push(`### ${m.name}\n${answersByLabel.get(stages[i].label)?.[m.name] ?? '(无回答)'}\n`);
      }
      return { result: { text: parts.join('\n') } };
    },
  });
  return submit;
}

/** resume 时重建 worker 用的环境(engines 层在 conv 存活时注册) */
export function buildWorkflowEnv(args: { runOpts: MemberRunOpts }): WorkflowJobEnv {
  return { runOpts: args.runOpts };
}
