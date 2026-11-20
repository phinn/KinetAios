// screenshot_window "先看后选"(2026-11-20)
// 由来:该工具近 7 天 79 次调用 39 次失败(49%)。逐条看失败原因,几乎全是同一个模式 ——
// 模型在一个它看不见的命名空间里猜名字:
//   拿截图文件名当窗口标题:`_v3_sheet_duoh.png` / `cur_R.png` / `duo-inner.png`
//   拿业务词当标题:`简报` / `verify4`
// 失败路径本来就会回吐候选清单,但那一轮已经白花了。改成 title 可省略 = 只列清单不截图,
// 让模型花一次廉价调用把命名空间看清楚,再决定截哪个。
import { assert, test, run } from './harness';
import { desktopCapturer } from 'electron';
import { setWindowDetailProvider } from '../../src/main/computer-use';
import { allTools } from '../../src/main/tools';
import { toolOutcomeOf } from '../../src/main/AgentLoop';

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
  (desktopCapturer as unknown as { getSources: () => Promise<unknown[]> }).getSources = async () => names.map(win);
}
// 真实命名空间:预览的标题是图片文件名,Devices 归在 Device Hub 应用下。
setWindowDetailProvider(async () => [
  { name: 'Devices', owner: 'Device Hub' },
  { name: '_v3_sheet_duoh.png', owner: '预览' },
  { name: 'KinetAios', owner: 'Electron' },
]);

const tool = () => allTools().find((t) => t.name === 'screenshot_window')!;
const ctx = { cwd: '/tmp', confirm: async () => true } as never;

test('省略 title:列出可截窗口清单,不截图', async () => {
  mockWindows(['Devices', '_v3_sheet_duoh.png', 'KinetAios']);
  const out = await tool().run({}, ctx);
  assert(out.includes('当前可截窗口清单'), `应回清单,实际: ${out}`);
  assert(out.includes('「Devices」(Device Hub)'), `应带宿主应用名,实际: ${out}`);
  assert(out.includes('_v3_sheet_duoh.png'), `应列出文档名窗口,实际: ${out}`);
  assert(!out.includes('__IMAGE_BASE64__'), `不该真的截图,实际带了图片数据`);
  assert(!out.includes('❌'), `列清单不是失败,不该带 ❌,实际: ${out}`);
});

test('空字符串 title 视同省略', async () => {
  mockWindows(['KinetAios']);
  const out = await tool().run({ title: '   ' }, ctx);
  assert(out.includes('当前可截窗口清单'), `应回清单,实际: ${out}`);
});

test('清单结果记 outcome=ok(不是工具失败)', async () => {
  mockWindows(['KinetAios']);
  const out = await tool().run({}, ctx);
  assert(toolOutcomeOf(out) === 'ok', `列清单不该算失败,实际 ${toolOutcomeOf(out)}`);
});

test('title 改成可选:不再被参数闸拦下', () => {
  const t = tool();
  const required = (t.parameters as { required?: string[] }).required ?? [];
  assert(!required.includes('title'), `title 应为可选,实际 required=${JSON.stringify(required)}`);
});

test('排序按可读性:限 24 条以内,超出标总数', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `w${i}.png`);
  mockWindows(many);
  const out = await tool().run({}, ctx);
  assert(out.includes('等共 30 个'), `超量应标总数,实际: ${out}`);
});

run();
