// 参数闸 + 应用名兜底(2026-11-20)
// 由来(两条都是实测数据,不是推测):
//   ① 近 30 天 41.8 万条事件里,「工具调用参数完全为空」2617 次,其中约 1000 次落在**有必填字段**
//      的工具上(shell 695 / browser_eval 159 / edit_file 62 / read_file 28 …)。按模型归因:
//      glm-5.3-flash 占 shell 空参 695/699,分布在 54 个会话 —— 是模型侧流式丢参,不是用户手滑。
//      旧行为 `JSON.parse('' || '{}')` → {} → `exec('')` 抛 Node TypeError,模型只能猜着重试。
//   ② screenshot_window 1358 次调用 242 次失败(17.8%),且 11-19 修过一轮后仍 24%。
//      逐条看:窗口标题是**文档名**(预览的标题是 `_v3_sheet_duoh.png`),模型写的是**应用名**
//      (「Preview」「Simulator」「DeviceHub」),两个命名空间对不上,猜多少次都落空。
import { assert, test, run } from './harness';
import { desktopCapturer } from 'electron';
import { guardToolArgs, normalizeAliasArgs, type Tool } from '../../src/main/tools';
import { captureWindowByName, setWindowDetailProvider } from '../../src/main/computer-use';

const shellLike: Tool = {
  name: 'shell',
  description: 'x',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      timeout: { type: 'number', description: '超时秒数' },
    },
    required: ['command'],
  },
  async run() { return 'ran'; },
};

test('空参数:提示"没携带任何参数"并列出必填字段与说明', () => {
  const msg = guardToolArgs(shellLike, {});
  assert(msg !== null, '空参必须被拦下');
  assert(msg!.includes('没有携带任何参数'), `应点明是丢参,实际: ${msg}`);
  assert(msg!.includes('command'), `应列出必填字段,实际: ${msg}`);
  assert(msg!.includes('要执行的 shell 命令'), `应带字段说明,实际: ${msg}`);
});

test('部分缺参:报缺哪个 + 本次传了什么', () => {
  const msg = guardToolArgs(shellLike, { timeout: 60 });
  assert(msg !== null, '缺 command 应被拦下');
  assert(msg!.includes('缺少必填参数:command'), `应精确点名,实际: ${msg}`);
  assert(msg!.includes('本次只传了:timeout'), `应回显已传字段,实际: ${msg}`);
});

test('空字符串视同缺失(旧逻辑会一路走到 exec("") 抛 TypeError)', () => {
  assert(guardToolArgs(shellLike, { command: '   ' }) !== null, '空白 command 应被拦');
});

test('参数齐备:放行', () => {
  assert(guardToolArgs(shellLike, { command: 'ls' }) === null);
});

test('别名归一:cmd → command,不覆盖已给的规范字段', () => {
  const a = normalizeAliasArgs('shell', { cmd: 'ls -la' });
  assert(a.command === 'ls -la', `应补齐 command,实际: ${JSON.stringify(a)}`);
  const b = normalizeAliasArgs('shell', { command: 'pwd', cmd: 'ls' });
  assert(b.command === 'pwd', `规范字段优先,实际: ${JSON.stringify(b)}`);
});

test('别名归一:read_file 的 file_path / filePath 都认', () => {
  assert(normalizeAliasArgs('read_file', { file_path: '/tmp/a' }).path === '/tmp/a');
  assert(normalizeAliasArgs('read_file', { filePath: '/tmp/b' }).path === '/tmp/b');
});

test('shell 工具自身:空命令给可执行提示,不再抛异常', async () => {
  const shellTool = (await import('../../src/main/tools')).allTools().find((t) => t.name === 'shell')!;
  const out = await shellTool.run({}, { cwd: '/tmp', confirm: async () => true });
  assert(out.includes('缺少 command'), `应提示缺 command,实际: ${out}`);
  assert(!out.includes('TypeError'), `不该再出现 TypeError,实际: ${out}`);
  assert(out.includes('read_file'), `应给出替代工具,实际: ${out}`);
});

// ── 应用名兜底 ────────────────────────────────────────────────
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
// 真实系统上:Xcode 26 的设备窗口归在「Device Hub」应用下,标题是「Devices」;
// 「预览」打开图片时标题是文件名。这正是模型猜不中的两类。
const REAL_WINDOWS = [
  { name: 'Devices', owner: 'Device Hub' },
  { name: '_v3_sheet_duoh.png', owner: '预览' },
  { name: 'ipadh2_c0_small.png', owner: '预览' },
  { name: 'KinetAios', owner: 'Electron' },
];
setWindowDetailProvider(async () => REAL_WINDOWS);

// minHeight 让流程停在尺寸闸前,不触碰真实截屏/坐标换算。
const PROBE = { minHeight: 99_999 };

test('应用名兜底:DeviceHub(无空格)→ 命中「Device Hub」下的 Devices', async () => {
  mockWindows(['Devices', 'KinetAios']);
  const r = await captureWindowByName('DeviceHub', PROBE);
  assert(!r.error!.includes('未找到'), `应按应用名命中,实际: ${r.error}`);
  assert(r.error!.includes('窗口「Devices」'), `应选中 Devices,实际: ${r.error}`);
});

test('应用名兜底目标应用多窗口:列出来让模型挑,不替它猜', async () => {
  mockWindows(['_v3_sheet_duoh.png', 'ipadh2_c0_small.png', 'KinetAios']);
  const r = await captureWindowByName('预览', PROBE);
  assert(!r.ok, '多窗口应报错');
  assert(r.error!.includes('有 2 个窗口'), `应报窗口数,实际: ${r.error}`);
  assert(r.error!.includes('_v3_sheet_duoh.png'), `应列出候选标题,实际: ${r.error}`);
});

test('中英别名:Preview → 预览(中文系统下真名是中文)', async () => {
  mockWindows(['_v3_sheet_duoh.png', 'KinetAios']);
  const r = await captureWindowByName('Preview', PROBE);
  assert(!r.error!.includes('未找到'), `应经别名命中「预览」,实际: ${r.error}`);
  assert(r.error!.includes('_v3_sheet_duoh.png'), `应选中唯一窗口,实际: ${r.error}`);
});

test('失败清单带宿主应用名,模型下次能对上号', async () => {
  mockWindows(['Devices', 'KinetAios']);
  const r = await captureWindowByName('zzz-nonexistent', PROBE);
  assert(!r.ok, '未命中应失败');
  assert(r.error!.includes('「Devices」(Device Hub)'), `候选应带应用名,实际: ${r.error}`);
});

run();
