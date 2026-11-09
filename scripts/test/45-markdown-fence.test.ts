// markdown fence 提取回归(2026-11-09 双写 fence 事故):
// 模型偶发把 ```html 开/闭栏双写,旧非贪婪正则被内容里的 ``` 提前闭合,
// 第一块变空、HTML 正文整段掉到 <p> 被转义显示(截图级事故)。
// 现为 CommonMark 逐行状态机:带 info string 的开栏只认「行首裸 ```」闭合。
// Regression for doubled-fence degradation: state-machine extraction per
// CommonMark — an info-string opener only closes on a bare fence line.
import { assert, test, run } from './harness';
import { renderMarkdown } from '../../src/renderer/markdown';

// ── S1:双写开栏 + 双写闭合(真实事故输入形态)──
const doc1 = [
  '前言段落。',
  '',
  '```html',
  '```html',
  '<div style="font-family:-apple-system,sans-serif;background:#f6f6f8;color:#1e1e24;border-radius:12px;padding:18px;max-width:760px">',
  '<div style="font-weight:700;font-size:15px;margin-bottom:12px">Brickfall 增强 — 优先级矩阵</div>',
  '<table style="width:100%;border-collapse:collapse;font-size:13px"><tr><th>优先级</th><th>项</th></tr><tr><td>P0 死项</td><td>实现 CoreHaptics</td></tr></table>',
  '</div>',
  '```',
  '```',
  '',
  '## 我的建议执行顺序',
  '',
  '1. **P0 两项**',
].join('\n');

test('S1 双写fence:仍渲染成 viz-card', () => {
  const out = renderMarkdown(doc1);
  assert.ok(out.includes('viz-card'), '双写开栏必须仍命中卡片');
});

test('S1 双写fence:折叠区外无 HTML 泄漏(核心事故症状)', () => {
  const out = renderMarkdown(doc1);
  // viz-card 的「查看代码」折叠区会转义存储源码,那里有 &lt;div 是正常的;
  // 只查折叠区以外的部分(details 之前的正文)。
  const beforeDetails = out.split('<details')[0];
  assert.ok(!beforeDetails.includes('&lt;div'), '正文区出现转义 div = 泄漏');
  assert.ok(!beforeDetails.includes('```'), '正文区残留字面 fence = 泄漏');
});

test('S1 双写fence:双闭残渣不吞后续正文', () => {
  const out = renderMarkdown(doc1);
  assert.ok(out.includes('建议执行顺序'), '后续正文被吞进代码块');
});

// ── S2:正常 viz-card(回归哨兵,不得被状态机改动破坏)──
test('S2 正常html fence:照常渲染成 viz-card', () => {
  const doc = '介绍:\n\n```html\n<div style="padding:12px">' +
    '<table style="width:100%"><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table></div>\n```\n\n结尾。';
  const out = renderMarkdown(doc);
  assert.ok(out.includes('viz-card'), '正常卡片不得回归');
  assert.ok(out.includes('结尾。'), '栏后正文可见');
});

// ── S3:双写但内容不达卡片门槛 → 退普通代码块,残渣不吞正文 ──
test('S3 双写短html:退普通代码块且正文可见', () => {
  const doc = '```html\n```html\n<p>x</p>\n```\n```\n\n后续正文必须可见。';
  const out = renderMarkdown(doc);
  assert.ok(!out.includes('viz-card'), '不达标内容不渲染卡片');
  assert.ok(out.includes('后续正文必须可见'), '多余裸闭合行不得当新开栏吞正文');
});

// ── S4:未闭合裸栏(流式中途)→ 整体成代码块,不崩溃不泄漏 ──
test('S4 未闭合裸栏:内容安全呈现在代码块内', () => {
  const out = renderMarkdown('看代码:\n\n```\nconst a = 1;\n');
  assert.ok(out.includes('看代码'), '前导正文可见');
  assert.ok(out.includes('code-block'), '未闭合栏仍渲染为代码块');
  assert.ok(!out.includes('const a = 1;</p>'), '代码内容不得掉到正文');
});

// ── S5:紧邻两块(无空行分隔)→ 占位符不粘连 ──
test('S5 紧邻双块:各自成块,后续正文不被吞', () => {
  const doc = '```js\nconst a = 1;\n```\n```py\nb = 2\n```\ndone';
  const out = renderMarkdown(doc);
  assert.equal((out.match(/code-lang/g) || []).length, 2, '两块各自渲染');
  const outside = out.slice(out.lastIndexOf('```') + 1);
  assert.ok(/done/.test(out.split('code-block').join('')), 'done 在块外正文');
});

run();
