// screenshot_window 的候选窗口清单(2026-11-19)
// 背景:近 30 天 screenshot_window 调用 1,423 次、失败 249 次(17.5%),失败原因高度集中:
//   「未找到标题含「iPhone Duo」的窗口」17 次、「窗口名查询「」太短」9 次、
//   「窗口名查询「预览」太短」5 次、「窗口名查询「设置」太短」3 次……
// 根因不是截不到,而是模型看不到候选集:它只能猜标题,而旧逻辑对 ≤2 字符的短名一律硬拒
// (防误中),把主窗口标题本身就两个字的情况(预览/设置/终端)变成永远不可达,模型只能换词重试。
//
// 本文件钉住三条:
//   ① 短名唯一命中 → 放行(不再因"太短"自伤)
//   ② 短名命中多个 → 报错并列出全部候选,要求补关键字
//   ③ 空名 / 未命中 → 报错时直接带可截窗口清单(去重,同名只列一次)
import { assert, test, run } from './harness';
import { desktopCapturer } from 'electron';
import { captureWindowByName } from '../../src/main/computer-use';

type Src = { id: string; name: string; thumbnail: unknown };

function win(name: string): Src {
  return {
  id: name,
  name,
  thumbnail: {
    isEmpty: () => false,
    getSize: () => ({ width: 800, height: 600 }),
    toBitmap: () => Buffer.alloc(800 * 600 * 4),
    toDataURL: () => 'data:image/png;base64,AA==',
  },
  };
}

function mockWindows(names: string[]): void {
  (desktopCapturer as unknown as { getSources: () => Promise<unknown[]> }).getSources =
  async () => names.map(win);
}

// 传 minHeight 让它停在「内容过小」这道闸前 —— 该闸在 resolveWindowBounds / 黑帧检测之前,
// 因此本文件不触碰真实截屏、JXA 与权限,纯字符串判定。
const PROBE = { minHeight: 99_999 };

test('短名唯一命中:不再报"太短",按正常流程继续', async () => {
  mockWindows(['设置', 'App Store Connect', 'KinetAios']);
  const r = await captureWindowByName('设置', PROBE);
  assert(!r.ok, '探测用 minHeight 应拦在内容过小');
  assert(!r.error!.includes('太短'), `不该再因短名拒绝,实际: ${r.error}`);
  assert(r.error!.includes('内容过小'), `应走到尺寸闸,实际: ${r.error}`);
  assert(r.error!.includes('设置'), `尺寸闸应回显命中的窗口名,实际: ${r.error}`);
});

test('短名命中多个且无精确同名:报错并列出全部候选', async () => {
  mockWindows(['系统设置 - 显示', '设置助理', 'KinetAios']);
  const r = await captureWindowByName('设置', PROBE);
  assert(!r.ok, '多命中应报错');
  assert(r.error!.includes('命中 2 个窗口'), `应报歧义数量,实际: ${r.error}`);
  assert(r.error!.includes('「系统设置 - 显示」') && r.error!.includes('「设置助理」'), `应列出两个候选,实际: ${r.error}`);
});

test('同名窗口不算歧义:两个「设置」仍按唯一命中处理', async () => {
  mockWindows(['设置', '设置', 'KinetAios']);
  const r = await captureWindowByName('设置', PROBE);
  assert(!r.error!.includes('太短'), `同名实例不算歧义,实际: ${r.error}`);
  assert(r.error!.includes('内容过小'), `应走到尺寸闸,实际: ${r.error}`);
});

test('短名命中"精确同名 + 带后缀":精确同名优先,不判歧义', async () => {
  mockWindows(['访达', '访达 - 下载', 'KinetAios']);
  const r = await captureWindowByName('访达', PROBE);
  assert(!r.error!.includes('太短'), `精确同名应直接采信,实际: ${r.error}`);
  assert(r.error!.includes('窗口「访达」'), `应选中精确同名窗口,实际: ${r.error}`);
});

test('空标题:直接给出可截窗口清单', async () => {
  mockWindows(['iPhone Duo 镜像', 'KinetAios', 'Xcode']);
  const r = await captureWindowByName('   ');
  assert(!r.ok, '空标题应失败');
  assert(r.error!.includes('请提供窗口标题关键字'), `应提示补标题,实际: ${r.error}`);
  assert(
    r.error!.includes('「iPhone Duo 镜像」') && r.error!.includes('「KinetAios」'),
    `应列出候选窗口,实际: ${r.error}`,
  );
});

test('未命中:报错带候选清单,且同名窗口只列一次', async () => {
  mockWindows(['iPhone Duo 镜像', 'iPhone Duo 镜像', 'Chrome', 'Xcode']);
  const r = await captureWindowByName('DuoPhone');
  assert(!r.ok, '未命中应失败');
  assert(r.error!.includes('未找到标题含「DuoPhone」的窗口'), `应说明未命中,实际: ${r.error}`);
  const hits = r.error!.split('「iPhone Duo 镜像」').length - 1;
  assert(hits === 1, `同名窗口应去重只列一次,实际出现 ${hits} 次`);
  assert(r.error!.includes('「Chrome」'), `应列出其他候选,实际: ${r.error}`);
  assert(r.error!.includes('原样作为 title 重试'), `应给出下一步动作,实际: ${r.error}`);
});

test('整串未命中:最长词元唯一命中则采信(语序/后缀不同不再白失败)', async () => {
  // 真实案例:模型写「iPhone Duo」/「Chrome 浏览器」,实际标题是「iPhone Duo 镜像」/「Google Chrome」
  mockWindows(['Google Chrome', 'KinetAios', 'Xcode']);
  const r = await captureWindowByName('Chrome 浏览器', PROBE);
  assert(!r.error!.includes('未找到标题含'), `最长词元应命中,实际: ${r.error}`);
  assert(r.error!.includes('窗口「Google Chrome」'), `应选中 Google Chrome,实际: ${r.error}`);
});

test('整串未命中且词元命中多个:仍报错并列出候选,不猜', async () => {
  mockWindows(['Google Chrome', 'Chrome Remote Desktop', 'KinetAios']);
  const r = await captureWindowByName('Chrome 浏览器', PROBE);
  assert(!r.ok, '多个词元候选不应猜');
  assert(r.error!.includes('未找到标题含'), `应回到未命中提示,实际: ${r.error}`);
  assert(r.error!.includes('「Chrome Remote Desktop」'), `应列出候选,实际: ${r.error}`);
});

run();
