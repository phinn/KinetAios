// 窗口候选排序:截错窗口后给最接近的标题,避免模型继续猜。
import { assert, test, run } from './harness';
import { rankWindowCandidates, formatWindowCandidates } from '../../src/main/window-match';

const wins = [
  { name: 'KinetAios', owner: 'Electron' },
  { name: 'package.json — KinetAiosWin', owner: 'Visual Studio Code' },
  { name: '收件箱 - 邮件', owner: 'Mail' },
  { name: 'Untitled-1', owner: 'Visual Studio Code' },
];

test('最接近的标题排在前面(标题或宿主名匹配)', () => {
  const c = rankWindowCandidates('KinetAios', wins);
  assert.equal(c[0].name, 'KinetAios');
  const byOwner = rankWindowCandidates('Visual Studio Code', wins);
  assert.ok(byOwner.length >= 1);
  assert.ok(byOwner[0].owner === 'Visual Studio Code');
});

test('无相似结果时返回空,不硬凑候选', () => {
  assert.deepEqual(rankWindowCandidates('完全无关的标题 zzz', wins), []);
  assert.deepEqual(rankWindowCandidates('', wins), []);
});

test('格式化输出可直接复制', () => {
  const c = rankWindowCandidates('package.json', wins);
  const s = formatWindowCandidates(c);
  assert.ok(s.includes('package.json'));
  assert.ok(s.includes('Visual Studio Code'));
});
