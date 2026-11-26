// 视觉验收内环 —— 交付前的"看一眼再宣布完成"。
//
// 为什么需要:模型写完 UI/网页/图表后,只能凭"代码看起来对"宣布完成;截图明明在手边,
// 却没有一个"按验收标准看图判定"的动作。结果是人眼兜底 —— 布局错位、文字重叠、
// 白屏/空图都要用户自己发现。这里把截图 → 视觉模型 → pass/问题/修复建议 做成一个工具。
//
// 本文件只放纯函数(提示词组装 / 回复解析 / 输出格式化),好测;截图与模型调用在 tools.ts。
import type { ChatMsg, ContentPart } from '../shared/types';

export type VisionVerdict = 'pass' | 'fail' | 'unclear';

export interface VisionResult {
  verdict: VisionVerdict;
  /** 不合格时的问题清单(可观察、可定位) */
  issues: string[];
  /** 修复建议(通过时通常为空) */
  fix: string;
  /** verdict='unclear' 时保存模型原始回复,便于人工复核 */
  raw?: string;
}

const MAX_ISSUES = 10;

/** 视觉验收的系统提示:判定只看图里可见的事实。 */
export const VISION_SYSTEM_PROMPT =
  '你是严格的视觉验收员。只依据图片中可见的事实判定,不臆测未显示的内容,不因为"大体还行"就放行。';

/** UI 改动后的自动验收标准:只查"渲染有没有坏",不评价设计好坏(避免误报干扰)。 */
export const AUTO_VISUAL_CRITERIA =
  '页面正常渲染(不是空白页/错误页/加载转圈卡死);主要区域没有文字重叠、被裁切或明显错位;图片与图表可见;没有报错遮罩或控制台错误弹层。';

/**
 * 组装验收提示词。验收标准由调用方给出(必须可观察);
 * 输出约定为单个 JSON,便于 parseVisionVerdict 稳定解析。
 */
export function buildVisionPrompt(criteria: string, context?: string): string {
  const lines = [
    '请按下面的验收标准检查这张图。',
    `验收标准:${criteria.trim()}`,
  ];
  if (context?.trim()) lines.push(`背景:${context.trim()}`);
  lines.push(
    '只输出一个 JSON 对象,不要输出任何解释或 markdown:',
    '{"verdict":"pass" 或 "fail","issues":["问题1","问题2"],"fix":"一句可执行的修复建议"}',
    '判定规则:',
    '- 所有标准都满足才 pass;任何一条不满足即 fail。',
    '- 每条 issue 必须指向图中具体位置或元素(如"右上角按钮与标题重叠"),不要写空泛评价。',
    '- pass 时 issues 为空数组,fix 为空字符串。',
  );
  return lines.join('\n');
}

/**
 * 解析视觉模型的回复。模型偶尔会包 ```json 围栏或前后加一句话 —— 先取最外层 JSON,
 * 解析失败再按关键词兜底;两者都不成 → unclear(不把"没看懂"当通过)。
 */
export function parseVisionVerdict(text: string): VisionResult {
  const raw = (text ?? '').trim();
  const json = extractJsonObject(raw);
  if (json) {
    const verdict = normalizeVerdict(json.verdict);
    if (verdict) {
      return {
        verdict,
        issues: normalizeIssues(json.issues),
        fix: typeof json.fix === 'string' ? json.fix.trim() : '',
      };
    }
  }
  // 兜底:模型没给 JSON 时按明确措辞判定;含糊不清 → unclear。
  if (/\bpass(ed)?\b|通过|符合要求/i.test(raw) && !/\bfail(ed)?\b|不通过|未通过|失败/i.test(raw)) {
    return { verdict: 'pass', issues: [], fix: '' };
  }
  if (/\bfail(ed)?\b|不通过|未通过|失败/i.test(raw)) {
    return { verdict: 'fail', issues: [], fix: '', raw: raw.slice(0, 800) };
  }
  return { verdict: 'unclear', issues: [], fix: '', raw: raw.slice(0, 800) };
}

/** 把判定渲染成给模型看的工具结果。❌/✅ 前缀与 tool-telemetry 的成败判定对齐。 */
export function formatVisionVerdict(result: VisionResult, criteria: string): string {
  if (result.verdict === 'pass') {
    return `✅ 视觉验收通过\n标准:${criteria}${result.fix ? `\n备注:${result.fix}` : ''}`;
  }
  if (result.verdict === 'fail') {
    const list = result.issues.length
      ? result.issues.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '(模型未给出具体问题清单)';
    return `❌ 视觉验收未通过\n标准:${criteria}\n问题:\n${list}\n修复建议:${result.fix || '按上述问题逐条修复后重新验收'}`;
  }
  return `⚠️ 视觉验收未得出结论\n标准:${criteria}\n模型原始回复:${result.raw || '(空)'}\n请人工复核,或把验收标准写得更具体后重试。`;
}

/** 组装给视觉模型的消息:一条 user 消息,文本 + 图片。 */
export function buildVisionMessages(imageDataUrl: string, criteria: string, context?: string): ChatMsg[] {
  const content: ContentPart[] = [
    { type: 'text', text: buildVisionPrompt(criteria, context) },
    { type: 'image_url', image_url: { url: imageDataUrl, detail: 'auto' } },
  ];
  return [
    { role: 'system', content: VISION_SYSTEM_PROMPT },
    { role: 'user', content },
  ];
}

/** 视觉模型不支持图片的 400(与 AgentLoop.isImageModalityError 同一族措辞,这里只要人话提示)。 */
export function looksLikeVisionUnsupported(message: string): boolean {
  return /only supports text modality|does not support image|not support image|image input|多模态|不支持图片|不支持图像/i.test(message);
}

/**
 * 体系提示引导:固定文本(不随文件变化)→ 不会打穿 prompt 缓存。
 * 只注入给有 verify_visual 工具的引擎(direct / directV2)。
 */
export const VISUAL_VERIFY_HINT =
  '\n\n# 视觉验收(交付前必做)\n产出或修改 UI / 网页 / 图表 / 任何视觉产物后,先调 verify_visual(image_path=产物截图路径, criteria=可观察的验收标准) 自查:通过再宣布完成;不通过按问题清单修复后复验(最多 2 轮)。现场效果可直接给 window_title 让工具截图验收。';

// ── 内部 ──

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeVerdict(v: unknown): VisionVerdict | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'pass' || s === 'passed' || s === 'ok' || s === '通过') return 'pass';
  if (s === 'fail' || s === 'failed' || s === '不通过' || s === '未通过' || s === '失败') return 'fail';
  return null;
}

function normalizeIssues(v: unknown): string[] {
  if (!Array.isArray(v)) {
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return [];
  }
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, MAX_ISSUES);
}
