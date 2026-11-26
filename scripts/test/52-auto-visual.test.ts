// 自动视觉硬闸的纯逻辑:UI 文件识别、本地页面挑选、结果文案。
import { assert, test, run } from './harness';
import {
  AUTO_VISUAL_CRITERIA,
  autoVisualAfterEdit,
  formatAutoVisual,
  isUiFile,
  pickLocalTab,
} from '../../src/main/auto-visual';

test('UI 文件识别:只覆盖渲染相关后缀', () => {
  for (const p of ['a.tsx', 'a.jsx', 'a.vue', 'a.svelte', 'a.css', 'a.scss', 'a.html', 'a.mdx']) {
    assert.equal(isUiFile(p), true, p);
  }
  for (const p of ['a.ts', 'a.py', 'a.go', 'a.json', 'a.png']) {
    assert.equal(isUiFile(p), false, p);
  }
});

test('只挑本地页面:外网/空白页不触发自动验收', () => {
  const tabs = [
    { id: '1', url: 'https://example.com' },
    { id: '2', url: 'http://localhost:5173/app' },
  ];
  assert.equal(pickLocalTab(tabs)?.id, '2');
  assert.equal(pickLocalTab([{ id: '3', url: 'http://127.0.0.1:3000' }])?.id, '3');
  assert.equal(pickLocalTab([{ id: '4', url: 'file:///tmp/a.html' }])?.id, '4');
  assert.equal(pickLocalTab([{ id: '5', url: 'about:blank' }, { id: '6', url: 'https://x.com' }]), null);
});

test('文案:通过 / 未通过 / 未得出结论,失败不伪装成工具失败前缀', () => {
  const pass = formatAutoVisual({ verdict: 'pass', issues: [], fix: '' }, 'http://localhost:5173/app', 'glm-4.6');
  assert.ok(pass.startsWith('👁'));
  assert.ok(pass.includes('通过'));
  const fail = formatAutoVisual({ verdict: 'fail', issues: ['按钮被裁切'], fix: '加 flex-wrap' }, 'http://localhost:5173/app', 'glm-4.6');
  assert.ok(fail.startsWith('⚠️'));
  assert.ok(fail.includes('1. 按钮被裁切'));
  assert.ok(fail.includes('修复建议:加 flex-wrap'));
  assert.ok(!fail.startsWith('❌'), '自动验收失败不应污染 write 工具的成败判定');
  const unclear = formatAutoVisual({ verdict: 'unclear', issues: [], fix: '', raw: '看不清' }, 'http://localhost:1', 'm');
  assert.ok(unclear.includes('未得出结论'));
});

test('入口:非 UI 文件直接跳过(不加载浏览器/不起模型调用)', async () => {
  assert.equal(await autoVisualAfterEdit({ cwd: '/tmp', file: '/tmp/a.ts' }), '');
  assert.ok(AUTO_VISUAL_CRITERIA.includes('正常渲染'));
});

run();
