// UI 文件改动后的自动视觉验收 —— 把"看一眼再交付"从模型自觉变成流程硬闸。
//
// 触发条件(全部满足才跑,缺一即静默跳过):
//   1. 改的是 UI 文件(tsx/jsx/vue/svelte/astro/css/scss/sass/less/html/mdx);
//   2. 已经有一个 agent Chrome 页面开着,且 URL 是本地页面(localhost / 127.0.0.1 / file:);
//   3. 距上次自动验收超过 90 秒(避免连续编辑把视觉调用打爆)。
//
// 为什么不截整屏:桌面可能压着编辑器/聊天窗口,截出来的"页面"根本不是刚改的东西。
// 只截本地页面,验的才是这次改动的实际渲染结果。截图/模型调用失败一律静默(硬闸不能反过来卡编辑)。
// 关闭:KINET_NO_AUTOVISUAL=1。
import { AUTO_VISUAL_CRITERIA, buildVisionMessages, formatVisionVerdict, parseVisionVerdict, type VisionResult } from './visual-verify';
import { resolveModelRoute } from './model-router';

export { AUTO_VISUAL_CRITERIA };

const UI_FILE_RE = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html?|mdx)$/i;
const LOCAL_URL_RE = /^(https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|file:\/\/)/i;
const THROTTLE_MS = 90_000;

export function isUiFile(p: string): boolean {
  return UI_FILE_RE.test(p);
}

/** 从 tab 列表里挑一个本地页面(自动验收只看本地页面)。 */
export function pickLocalTab<T extends { id: string; url: string }>(tabs: T[]): T | null {
  return tabs.find((t) => t && typeof t.url === 'string' && LOCAL_URL_RE.test(t.url)) ?? null;
}

/** 把判定渲染成附在编辑结果后面的短文本。 */
export function formatAutoVisual(result: VisionResult, pageUrl: string, model: string): string {
  const page = pageUrl.replace(/^https?:\/\//, '').slice(0, 80);
  if (result.verdict === 'pass') return `👁 自动视觉验收:通过 (${page} · ${model})`;
  if (result.verdict === 'unclear') {
    return `👁 自动视觉验收:未得出结论 (${page})\n  ${(result.raw ?? '').slice(0, 200)}`;
  }
  const issues = result.issues.length ? result.issues.map((s, i) => `  ${i + 1}. ${s}`).join('\n') : '  (模型未给出具体问题)';
  return `⚠️ 自动视觉验收未通过 (${page} · ${model})\n${issues}\n  修复建议:${result.fix || '按上述问题修复后复验'}\n  [刚改的 UI 已渲染。先修掉这些问题再宣布完成;若确认是误判,继续即可]`;
}

const lastRun = new Map<string, number>();

/**
 * 编辑后自动视觉验收。返回要拼进工具结果的文本;不适用/没条件 → 空串。
 * 动态 require:cdp/glm/settings 依赖 Electron 运行时,纯函数测试不该被拖进来。
 */
export async function autoVisualAfterEdit(opts: { cwd: string; file: string }): Promise<string> {
  if (process.env.KINET_NO_AUTOVISUAL === '1') return '';
  if (!isUiFile(opts.file)) return '';
  const last = lastRun.get(opts.cwd) ?? 0;
  if (Date.now() - last < THROTTLE_MS) return '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cdp = require('./cdp') as typeof import('./cdp');
    const tabs = await cdp.peekTabs();
    const tab = pickLocalTab(tabs);
    if (!tab) return ''; // 没有本地页面:不截屏、不猜
    // 等 dev server / HMR 把这次改动渲染出来,再截图(否则验的是上一版)。
    await new Promise((r) => setTimeout(r, 900));
    const shot = await cdp.browserScreenshot(tab.id);
    if (!shot.ok || !shot.base64) return '';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getSettings } = require('./settings') as typeof import('./settings');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { supervisorComplete } = require('./glm') as typeof import('./glm');
    const settings = getSettings();
    const route = resolveModelRoute({ capability: 'vision', settings, convModel: settings.model, baseModel: settings.model });
    const out = await supervisorComplete(
      buildVisionMessages(`data:image/png;base64,${shot.base64}`, AUTO_VISUAL_CRITERIA),
      route.profileId ?? null,
      AbortSignal.timeout(90_000),
      route.model || undefined,
    );
    lastRun.set(opts.cwd, Date.now());
    return formatAutoVisual(parseVisionVerdict(out.content ?? ''), tab.url, route.model || '默认模型');
  } catch {
    return ''; // 自动视觉失败绝不拖累编辑
  }
}
