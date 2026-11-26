// 视觉验收内环:提示词组装、判定解析、结果格式化。解析必须"拿不准就 unclear",
// 绝不把没看懂的回复当通过(通过 = 交付,误判代价最大)。
import { assert, test, run } from './harness';
import {
  buildVisionMessages,
  buildVisionPrompt,
  formatVisionVerdict,
  looksLikeVisionUnsupported,
  parseVisionVerdict,
} from '../../src/main/visual-verify';
import { toolTelemetryOf } from '../../src/main/tool-telemetry';

test('提示词:包含验收标准 + 背景 + 固定 JSON 输出约定', () => {
  const p = buildVisionPrompt('按钮居中;无文字重叠', '登录页');
  assert.ok(p.includes('验收标准:按钮居中;无文字重叠'));
  assert.ok(p.includes('背景:登录页'));
  assert.ok(p.includes('"verdict"'));
  assert.ok(!buildVisionPrompt('x').includes('背景:'));
});

test('消息组装:system + user(text+image_url)', () => {
  const msgs = buildVisionMessages('data:image/png;base64,AAA', '无白屏');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  const content = msgs[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  assert.equal(content[0].type, 'text');
  assert.ok(content[0].text?.includes('无白屏'));
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url?.url, 'data:image/png;base64,AAA');
});

test('解析:纯 JSON / ```json 围栏 / 前后夹杂文字', () => {
  const a = parseVisionVerdict('{"verdict":"pass","issues":[],"fix":""}');
  assert.equal(a.verdict, 'pass');
  assert.deepEqual(a.issues, []);
  const b = parseVisionVerdict('好的,结果如下:\n```json\n{"verdict":"fail","issues":["按钮被截断"],"fix":"缩小字号"}\n```');
  assert.equal(b.verdict, 'fail');
  assert.deepEqual(b.issues, ['按钮被截断']);
  assert.equal(b.fix, '缩小字号');
  // issues 给成字符串也接住
  assert.deepEqual(parseVisionVerdict('{"verdict":"fail","issues":"白屏"}').issues, ['白屏']);
});

test('解析:非 JSON 时按明确措辞兜底;含糊 → unclear', () => {
  assert.equal(parseVisionVerdict('整体通过,符合要求').verdict, 'pass');
  assert.equal(parseVisionVerdict('不通过:右侧溢出').verdict, 'fail');
  const unsure = parseVisionVerdict('图片有点模糊,不太确定');
  assert.equal(unsure.verdict, 'unclear');
  assert.ok((unsure.raw ?? '').length > 0);
  // 关键字同时出现 pass 和 fail → 不能判通过
  assert.equal(parseVisionVerdict('pass 部分,但 fail 了按钮对齐').verdict, 'fail');
});

test('格式化:前缀与工具成败判定对齐(✅ ok / ❌ error / ⚠️ unclear)', () => {
  const pass = formatVisionVerdict({ verdict: 'pass', issues: [], fix: '' }, '无重叠');
  assert.ok(pass.startsWith('✅'));
  const fail = formatVisionVerdict({ verdict: 'fail', issues: ['按钮溢出', '文字重叠'], fix: '缩小字号' }, '无重叠');
  assert.ok(fail.startsWith('❌'));
  assert.ok(fail.includes('1. 按钮溢出'));
  assert.ok(fail.includes('修复建议:缩小字号'));
  const unclear = formatVisionVerdict({ verdict: 'unclear', issues: [], fix: '', raw: '看不清' }, '无重叠');
  assert.ok(unclear.startsWith('⚠️'));
  assert.ok(unclear.includes('看不清'));
  // 与工具级遥测同源:验收失败必须计入工具错误率
  assert.equal(toolTelemetryOf(fail).outcome, 'error');
  assert.equal(toolTelemetryOf(fail).errorKind, 'reported');
  assert.equal(toolTelemetryOf(pass).outcome, 'ok');
});

test('纯文本模型:能识别人话提示的拒图错误', () => {
  assert.equal(looksLikeVisionUnsupported('400 only supports text modality'), true);
  assert.equal(looksLikeVisionUnsupported('该模型不支持图片输入'), true);
  assert.equal(looksLikeVisionUnsupported('429 rate limit'), false);
});

run();
