// 历史 turn_feedback 回填(2026-11-19)。
//
// 问题:turn_feedback 是"技能淘汰 / 基因选择 / 私有基准集"的唯一真信号来源,但它 11-18 才
// 接上通道 —— 之前 8000+ 轮的成败信息全丢了。实测 8766 轮里只有 5 条反馈,于是淘汰判据只能
// 退化成"14 天 0 加载"这种时间弱信号(会把季节性但好用的技能误杀)。
//
// 数据其实都还在:① turns 里有每轮的 prompt 序列(能否读出"用户带着不满回来"和"重问一遍");
// ② turns.data 里有 error / done(引擎失败、用户中止)。这里一次性把它们折成反馈账本。
//
// 三个刻意的设计:
//   · 只写负样本(rating -1)—— 与线上 gradeLastTurn 同口径,正样本无来源(没有点赞入口),
//     编不出"用户满意"的证据;
//   · 分页 + setTimeout 让出事件循环 —— 8766 行的 JSON 解析不能一口气做,启动不能被它卡住;
//   · app_meta 记完成标记 —— 中途崩了下次启动续跑,跑完永不重跑。

import * as store from './store';
import { CORRECTION_RE, isReask } from './turn-signal';

const FLAG = 'turn_feedback_backfill_v1';
const BATCH = 300;

/** 判定一轮是否该记负反馈。抽成纯函数便于单测(阈值/话术都在 turn-signal 里)。 */
export function tagsForTurn(
  cur: { id: string; ts: number; prompt: string; error: string | null; done: boolean | null },
  next: { prompt: string } | undefined,
): string[] {
  const tags: string[] = [];
  if (cur.error) tags.push('error');
  // done===false 且有下一轮 = 这轮没跑完就被新消息顶掉了(中止/崩溃),用户没拿到结果。
  else if (cur.done === false && next) tags.push('aborted');
  if (next?.prompt) {
    if (CORRECTION_RE.test(next.prompt)) tags.push('correction');
    if (isReask(next.prompt, cur.prompt)) tags.push('reask');
  }
  return tags;
}

/** 对一批(已按 conv 分组、按 ts 排序)的轮次计算标签。导出供测试直接调用。 */
export function labelTurns(
  turns: Array<{ id: string; convId: string; ts: number; prompt: string; error: string | null; done: boolean | null }>,
): Array<{ id: string; tags: string[]; ts: number }> {
  const byConv = new Map<string, typeof turns>();
  for (const t of turns) {
    const list = byConv.get(t.convId);
    if (list) list.push(t);
    else byConv.set(t.convId, [t]);
  }
  const out: Array<{ id: string; tags: string[]; ts: number }> = [];
  for (const list of byConv.values()) {
    list.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < list.length; i++) {
      const tags = tagsForTurn(list[i], list[i + 1]);
      if (tags.length) out.push({ id: list[i].id, tags, ts: list[i].ts });
    }
  }
  return out;
}

/** 启动后调用一次。已完成 → 立即返回;未完成 → 后台分页跑,不阻塞启动。
 *  delayMs/batch 只为测试可注入(生产用 3s / 300 行)。 */
export function startTurnFeedbackBackfill(opts: { delayMs?: number; batch?: number } = {}): void {
  if (store.getMeta(FLAG) === 'done') return;
  const delay = opts.delayMs ?? 3000;
  const batchSize = opts.batch ?? BATCH;
  const rows: store.BackfillTurnRow[] = [];
  let cursor = 0;
  // 回填开始时的上界快照:只补历史,不追这次运行期间新写的轮次(否则用户边聊边补,
  // rowid 永远有更大的,收不了尾)。新轮次由线上 gradeLastTurn 实时记账。
  const ceiling = store.maxTurnRowid();
  const collect = (): void => {
    try {
      const batch = cursor >= ceiling ? [] : store.turnsForBackfill(cursor, batchSize).filter((r) => r.rowid <= ceiling);
      if (batch.length) {
        rows.push(...batch);
        cursor = batch[batch.length - 1].rowid;
        setTimeout(collect, 20);
        return;
      }
      const labeled = labelTurns(rows);
      for (const l of labeled) {
        // 用原轮次时间戳落账 —— 否则几千条历史会全部堆在"今天",把近7天/近30天的统计冲垮。
        try { store.recordTurnFeedback(l.id, -1, l.tags, l.ts || undefined); } catch { /* 单条失败不中断 */ }
      }
      store.setMeta(FLAG, 'done');
      store.setMeta(
        `${FLAG}_stats`,
        `${rows.length} turns scanned / ${labeled.length} labeled @ ${new Date().toISOString()}`,
      );
      console.log(`[turn-backfill] 历史反馈回填完成:${rows.length} 轮扫描,${labeled.length} 轮标记为否定`);
    } catch (e) {
      // 解析/写入失败:不置位 → 下次启动从 rowid 0 重跑(recordTurnFeedback 幂等,重复打标无害)。
      console.warn('[turn-backfill] 中断,下次启动续跑:', (e as Error)?.message ?? e);
    }
  };
  // 启动 3 秒后才开始,把 CPU 让给窗口首屏与 store 加载。
  setTimeout(collect, delay);
}
