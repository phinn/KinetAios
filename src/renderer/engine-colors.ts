// 引擎身份色 — 单一来源(single source of truth)。
// 之前三处各自维护且互不一致:nexus.ts(星系图)/ dashboard.ts(雷达图)/ styles.css(.dot.eng-* 侧栏点)。
// 收口规则:Direct 家族用设计过的三色(紫/蓝/薄荷,亮暗主题都可读),Claude/Codex 用官方品牌色。
// 用色处:nexus 星系节点与光晕、dashboard 雷达多边形、侧栏/头部 dot(styles.css 的值与本表保持一致)。
// Engine identity colors — single source; styles.css `.dot.eng-*` values must mirror this table.
import type { EngineKind } from '../shared/types';

export const ENGINE_COLORS: Record<EngineKind, string> = {
  direct: '#c4a7ff',     // Kaios — 主紫光(Aurora 强调色系)
  directV2: '#8ab4ff',   // Kaios v2 — 冷蓝
  directV3: '#7eeab5',   // Kaios v3 — 薄荷绿
  claudeCode: '#d97757', // Claude — 品牌橙
  codex: '#10a37f',      // Codex — 品牌绿
};

const FALLBACK = '#a8b0c2'; // 未知引擎/插件引擎的兜底灰

export function engineColor(engine: string | undefined | null): string {
  if (!engine) return FALLBACK;
  return (ENGINE_COLORS as Record<string, string>)[engine] ?? FALLBACK;
}
