// ⚠️ 本文件由 scripts/split-ipc.mjs 机械生成(main.ts registerIpc 拆分),勿手改;改 main.ts 后重跑生成器
// 域: register
import { register as r_misc } from './misc';
import { register as r_convs } from './convs';
import { register as r_collab } from './collab';
import { register as r_tools } from './tools';
import { register as r_memory } from './memory';
import { register as r_ai } from './ai';

export function register(): void {
  r_misc();
  r_convs();
  r_collab();
  r_tools();
  r_memory();
  r_ai();
}
