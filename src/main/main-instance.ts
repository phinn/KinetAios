// 循环依赖破解:让 mcp-server 等延迟加载的模块拿到 main.ts 的 taskManager 单例。
// main.ts 在初始化后调用 setTaskManager(tm);其它模块 require('./main-instance') 取用。
// ponytail: 不用 DI 容器 —— 一个全局变量够用,项目只有这一个 TaskManager 实例。
import type { TaskManager } from './TaskManager';

let _tm: TaskManager | null = null;

export function setTaskManager(tm: TaskManager): void {
  _tm = tm;
}

export const __getTM = (): TaskManager | null => _tm;

// 给 mcp-server.ts 的 require('./main-instance') 用 —— 返回一个 getter 包装。
// 不能直接导出 _tm(那会是 null,因为 require 时机早于 setTaskManager)。
// 用 Proxy 延迟到访问时才读 _tm。
export const taskManager = new Proxy({} as TaskManager, {
  get(_target, prop) {
    if (!_tm) throw new Error('TaskManager 尚未初始化(setTaskManager 未调用)');
    const val = (_tm as unknown as Record<string | symbol, unknown>)[prop];
    return typeof val === 'function' ? val.bind(_tm) : val;
  },
}) as TaskManager;
