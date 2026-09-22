// ── 用户打断(Steer)缓冲:运行中会话的"原地转向"通道 ──
// User-interruption (steer) buffer: lets the user redirect an in-flight turn
// without cancelling it.
//
// 链路:UI ⌘/Ctrl+Enter → IPC 'interrupt' → TaskManager.interrupt() 写这里
// → Direct 系引擎(AgentLoop 轮边界 / DirectV2 步骤边界)pull 时注入为 user 消息;
//   CLI 引擎(claudeCode/codex)无注入通道,走 kill+resume:interrupt 同时调
//   triggerKill 杀子进程,run() 外层循环在退出边界 pull → --resume 续段重发。
//
// 语义约定:
// - 不 abort、不换 turn:同一个 turn 继续流式输出,进度零丢失。
// - 注入的消息**不带 _transient**:打断是真实用户输入,应写回 directHistory,
//   后续轮次(甚至后续 turn 的 planner/Judge)都要看得到。
// - 只存最新一条:打断期间用户再次 ⌘Enter,覆盖旧文本(UI 会立即反馈)。
// - pull 是"取走即清除":引擎仅在确定要消费时才 pull;终态(done/error 已发)
//   后禁止 pull,残留文本由 TaskManager 收尾 clearSteer 统一清理。
//
// Steer buffer: latest-wins. inject() while a pending steer exists overwrites it;
// pull() atomically takes it at the next engine-loop boundary.
import type { ChatMsg } from '../shared/types';

const buffers = new Map<string, { text: string; at: number }>();

/** UI → 主进程:登记一条打断文本(覆盖旧值)。返回 false = 会话没在跑,没登记。 */
export function pushSteer(convId: string, text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  buffers.set(convId, { text: t, at: Date.now() });
  return true;
}

/** 引擎循环边界调用:取走(并清除)待注入的打断文本;无则返回 null。 */
export function pullSteer(convId: string): string | null {
  const b = buffers.get(convId);
  if (!b) return null;
  buffers.delete(convId);
  return b.text;
}

/** 会话删除/引擎退出时清理,防 Map 无限累积。 */
export function clearSteer(convId: string): void {
  buffers.delete(convId);
}

// ── CLI 软打断的 kill 通道 ──
// Direct 系只需 pull 注入;CLI 引擎(claudeCode/codex)没有注入通道,必须真的杀掉
// 子进程,run() 的外层循环才能在边界 pull 到 steer 并 --resume 续段。
// run() 注册 kill hook(TaskManager.interrupt 触发),收尾时清理。
const killHooks = new Map<string, () => void>();

/** 引擎 run 期间注册当前子进程的终止器(closure 读 childRef,触发时取最新)。 */
export function setKillHook(convId: string, fn: () => void): void {
  killHooks.set(convId, fn);
}

/** interrupt 调用:杀掉当前 CLI 子进程。返回 false = 无注册(引擎已收尾)。 */
export function triggerKill(convId: string): boolean {
  const fn = killHooks.get(convId);
  killHooks.delete(convId);
  fn?.();
  return !!fn;
}

/** run 收尾清理(正常结束/abort/异常路径统一走这里)。 */
export function clearKillHook(convId: string): void {
  killHooks.delete(convId);
}

/**
 * 打断文本的标准包裹格式。让模型明确知道:这是用户在任务执行中插话,
 * 已完成的不要重做,按新指令调整后续动作。
 */
export function steerText(text: string): string {
  return `[⚡ 用户打断] 用户在任务执行过程中插入了新指令:\n${text}\n\n不要重做已完成的工作。评估这条指令对当前任务的影响:若需要改变方向,立即调整后续动作;若是补充信息,把它纳入后续步骤。`;
}

/**
 * 构造注入消息。包裹格式让模型明确知道:这是用户在任务执行中插话,
 * 已完成的不要重做,按新指令调整后续动作。
 */
export function steerMessage(text: string): ChatMsg {
  return {
    role: 'user',
    content: steerText(text),
  };
}
