// did-you-mean:失败回吐候选(2026-11-19)
// 由来:ocr_image 近7天失败率 26.8%,逐条看几乎全是「文件不存在」;screenshot_window 224/249
// 是「未找到标题含 X」。两类都不是能力不足,而是模型在看不见的命名空间里猜名字,猜错就要
// 白掉一整轮。这里钉住相似度与候选渲染的口径。
import { assert, test, run } from './harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { similarity, similarNames, similarPaths, formatPathMiss } from '../../src/main/did-you-mean';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-dym-'));
for (const f of ['sb_p10.png', 'sb_p2.png', 't5_reviews.png', 'Paywall_Before.png']) {
  fs.writeFileSync(path.join(dir, f), 'x');
}
fs.mkdirSync(path.join(dir, 'shots'));

test('sim:同名=1,前缀相近>无关文件', () => {
  assert(similarity('sb_p1.png', 'sb_p1.png') === 1);
  const near = similarity('sb_p1.png', 'sb_p10.png');
  const far = similarity('sb_p1.png', 't5_reviews.png');
  assert(near > 0.6, `同前缀应高分,实际 ${near}`);
  assert(far < 0.3, `无关文件应低分,实际 ${far}`);
});

test('similarNames:按相似度降序且过滤低分项', () => {
  const r = similarNames(['sb_p10.png', 'sb_p2.png', 't5_reviews.png'], 'sb_p1.png', 2);
  assert(r.length <= 2);
  assert(r[0].startsWith('sb_p'), `最像的应是 sb_p*，实际 ${r[0]}`);
  assert(!r.includes('t5_reviews.png'), '低分项不该进候选');
});

test('similarPaths:同目录近似文件(ocr_image 的典型场景)', () => {
  const miss = path.join(dir, 'sb_p1.png');
  const r = similarPaths(miss);
  assert(r.dir === dir, `应指向所在目录,实际 ${r.dir}`);
  assert(r.names.length >= 1, '应至少给一个候选');
  assert(r.names.some((n) => n.includes('sb_p')), `应含 sb_p*,实际 ${r.names.join(',')}`);
});

test('similarPaths:大小写/分隔符只差 → 明确标出来', () => {
  const r = similarPaths(path.join(dir, 'paywall_before.png'));
  assert(r.names.includes('Paywall_Before.png'), `应命中大小写变体,实际 ${r.names.join(',')}`);
  assert(r.note?.includes('大小写'), `应给出说明,实际 ${r.note}`);
});

test('similarPaths:目录整体不存在 → 指向父目录的同级目录', () => {
  const r = similarPaths(path.join(dir, 'shotz', 'a.png'));
  assert(r.dir === dir, `应回退到已存在的父目录,实际 ${r.dir}`);
  assert(r.names.includes('shots'), `应列出相近的同级目录,实际 ${r.names.join(',')}`);
  assert(r.note?.includes('不存在'), `应说明目录不存在,实际 ${r.note}`);
});

test('formatPathMiss:有候选时给出可复制的完整路径 + 别再猜', () => {
  const msg = formatPathMiss(path.join(dir, 'sb_p1.png'));
  assert(msg.includes('最接近'), `应点明最接近,实际: ${msg}`);
  assert(msg.includes('不要再猜'), `应给出下一步,实际: ${msg}`);
  assert(msg.includes(path.join(dir, 'sb_p')), `应给完整路径,实际: ${msg}`);
});

test('formatPathMiss:空目录不编造候选', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kinet-dym-empty-'));
  const msg = formatPathMiss(path.join(empty, 'zzz_qqq.png'));
  assert(!msg.includes('最接近'), `无候选时不该说"最接近",实际: ${msg}`);
  assert(msg.includes('没有相近的文件'), `应如实说没有,实际: ${msg}`);
});

run();
