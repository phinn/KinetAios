// viz 卡片「按内容宽收敛」的判定(纯函数,便于回归测试)。
// Viz card width-convergence decision (pure, unit-testable).
//
// 背景 / Why:内层文档上报内容宽,宿主据此把卡片收窄到内容宽。旧实现有两个正反馈源,
// 实测表现是「卡片宽度一直不停地变宽」:
//   ① 内层用 body{width:fit-content} 量宽。fit-content = min(max-content, 可用宽),
//      所以一旦 iframe 被收窄,**流体内容**(width:100%、会换行的段落)量回来的就是
//      "刚给它的那个宽度";宿主再按 w+2 写回 → 每轮 +2px,一路顶到容器满宽。
//      (每写一次 iframe 宽都会触发内层 resize → 内层重新上报 → 再写回。)
//   ② 若判定基准取 card.clientWidth(被自己改写过),窄↔宽来回翻。
// 修法:内层改用 width:max-content(内在宽,与可用宽无关),宿主侧再加一道「饱和闸」
// —— 上报值 ≥ 当前 iframe 宽时,说明这个数字是可用宽的回声而不是内容宽,一律按"铺满"处理。
// 于是「写回的宽度不可能让下一次测量变大」,数学上不可能成环。
//
// Invariant: what we write back can never increase the next measurement.
// That is the only thing that actually stops a grow loop — hysteresis alone cannot.

/** 进入窄态的阈值:内容宽 < 基准 × 0.78 */
export const VIZ_NARROW_ENTER = 0.78;
/** 退出窄态的阈值:内容宽 ≥ 基准 × 0.92(迟滞带,贴阈值时不再来回跳) */
export const VIZ_NARROW_EXIT = 0.92;
/** 卡片相对 iframe 的横向装饰宽度(card = w + 18,frame = w + 2 → 差 16) */
const CARD_CHROME_X = 16;
/** 卡片最小宽:内容太窄时不至于收成一条 */
const MIN_CARD_W = 160;

export interface VizWidthInput {
  /** 内层上报的内容宽(max-content 测得的内在宽) */
  measuredW: number;
  /** iframe 当前 clientWidth(0 = 尚未布局) */
  frameW: number;
  /** 卡片父容器宽 —— 恒定基准,不能用被自己改写过的卡片宽 */
  parentW: number;
  /** 上一次判定是否为窄态(迟滞用) */
  wasNarrow: boolean;
}

export interface VizWidthPlan {
  narrow: boolean;
  /** 要写的卡片内联宽(px);null = 清掉内联宽,铺满 */
  cardW: number | null;
  /** 要写的 iframe 内联宽(px);null = 清掉内联宽,铺满 */
  frameW: number | null;
}

const WIDE: VizWidthPlan = { narrow: false, cardW: null, frameW: null };

/** 决策:不改变任何尺寸(测量无效/容器未布局时用) */
function noop(wasNarrow: boolean): VizWidthPlan {
  return { narrow: wasNarrow, cardW: null, frameW: null };
}

/**
 * 把「内层上报的内容宽」翻译成「宿主该写的尺寸」。
 * 返回 narrow=false + 两个 null = 卡片应铺满(清掉内联宽)。
 */
export function planVizWidth(input: VizWidthInput): VizWidthPlan {
  const w = Math.round(input.measuredW);
  if (!Number.isFinite(w) || w <= 0) return noop(input.wasNarrow);

  const parentW = Math.round(input.parentW);
  if (!Number.isFinite(parentW) || parentW <= 0) return noop(input.wasNarrow); // 还没布局,别瞎改
  const base = parentW - 2;

  // 饱和闸 / saturation guard:
  // 测出来的宽 ≥ 当前 iframe 宽 ⇒ 这个数字受"我给它的宽度"限制(回声),不是内在宽。
  // 也可能是内容真的比 iframe 宽 —— 两种情况都该铺满,绝不能拿去再收窄。
  if (input.frameW > 0 && w >= input.frameW) return WIDE;

  const isNarrow = input.wasNarrow ? w < base * VIZ_NARROW_EXIT : w < base * VIZ_NARROW_ENTER;
  if (!isNarrow) return WIDE;

  // 上限一律夹到基准宽:卡片永远不可能比父容器宽(否则溢出/横向滚动也会被看成"变宽")
  const cardW = Math.max(MIN_CARD_W, Math.min(w + 18, base));
  const frameW = Math.max(MIN_CARD_W - CARD_CHROME_X, Math.min(w + 2, base - CARD_CHROME_X));
  return { narrow: true, cardW, frameW };
}
