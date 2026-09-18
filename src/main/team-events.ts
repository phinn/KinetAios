// 循环依赖破解(同 main-instance 模式):team 事件广播从 main.ts 抽出,
// engines/DirectV2Engine 不再 `import('./main')` —— 那会把整个 main.ts
// (BrowserWindow/Tray/全量 IPC)拉进测试 bundle,job 测试无法独立运行。
// main.ts 启动时 setTeamEventEmitter 注册真实实现;未注册时静默丢弃(测试环境)。
import type { TeamEvent } from '../shared/types';

type Emitter = (teamId: string, ev: TeamEvent) => void;
let emitter: Emitter | null = null;

export function setTeamEventEmitter(fn: Emitter): void {
  emitter = fn;
}

export function emitTeamEvent(teamId: string, ev: TeamEvent): void {
  emitter?.(teamId, ev);
}
