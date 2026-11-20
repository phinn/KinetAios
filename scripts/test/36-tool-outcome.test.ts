// 工具失败判定(outcome)埋点补漏(2026-11-20)
// 由来(实测数据,不是推测):近 10 天 22,545 次 tool/call 里,判成败的 toolOutcomeOf 只认
// 5 种标记(工具出错:/未知工具:/⚠️ 参数/[超时( /[exit N]/❌)。于是两类真实失败被记成 ok:
//
//   ① edit_file 的「未找到要替换的片段」216 次(占该工具 9.6%)。
//      216 次里只有 119 次在后续 6 个调用内重试成功 —— 剩下 97 次 agent 以为改好了就往下走,
//      用户看到的是「已修改」,磁盘上文件一个字节没动。2026-11-20 14:06 的 DuoFolio 会话
//      (给 Swift drainCaptures 加快门纪律)正好踩中,属于丢改动、不是丢观感。
//   ② shell 超时:2026-11 把超时文案改成「[now: …] + [⏳ 超时 120s,已终止」以保留已产生的
//      输出,但判定用的还是旧的 `includes('[超时(')` —— 前缀变了,3 次超时全被记成 ok。
//
// 判定必须走 startsWith:工具返回的第一句就是失败前缀,正文里出现同样字样(比如 grep 命中
// 一段含「未找到」的代码)不该被误判。
import { assert, test, run } from './harness';
import { toolOutcomeOf } from '../../src/main/AgentLoop';

test('edit_file 未匹配到 old_string → error(丢改动的最大来源)', () => {
  const r = '未找到要替换的片段(检查缩进/空格是否完全一致)。文件 15499 字节,未改动。';
  assert(toolOutcomeOf(r) === 'error', `应判失败,实际 ${toolOutcomeOf(r)}`);
});

test('shell 超时:新版文案(首行 [now: …] 再跟 ⏳)→ error', () => {
  const r = '[now: 2026-11-20 05:25:14 | epoch=1795152314]\n[⏳ 超时 300s,已终止 —— 命令未执行完]\n[exit timeout]\n下一步……';
  assert(toolOutcomeOf(r) === 'error', `应判失败,实际 ${toolOutcomeOf(r)}`);
});

test('shell 超时:旧版文案([超时(120s))→ error(向后兼容存量数据)', () => {
  const r = '[now: 2026-11-09 17:16:20 | epoch=1794244580]\n[超时(120s),已终止。]\n';
  assert(toolOutcomeOf(r) === 'error', `应判失败,实际 ${toolOutcomeOf(r)}`);
});

test('发文件类:文件不存在/为空/超限/类型不支持 → error', () => {
  const cases = [
    '文件不存在: /tmp/a.pdf',
    '文件为空: /tmp/b.pdf',
    '文件超过 50MB 上限: 61.3MB',
    '不支持的文件类型: .psd。支持: 图片(png/jpg/gif/webp)…',
  ];
  for (const r of cases) assert(toolOutcomeOf(r) === 'error', `应判失败: ${r}`);
});

test('读写类硬失败 → error', () => {
  const cases = [
    '读不到: /tmp/x.txt (ENOENT)',
    '写入失败: EACCES',
    '拒绝编辑二进制文件: a.png(.png)。文本工具会损坏它。',
    '拒绝覆盖二进制文件: b.pdf(.pdf)。文本工具会损坏它。',
    '该文件是 UTF-16 编码,字符串级编辑会破坏它,请用支持编码的编辑器处理。',
  ];
  for (const r of cases) assert(toolOutcomeOf(r) === 'error', `应判失败: ${r}`);
});

test('不误伤:grep 无命中是正常业务结果,不是失败', () => {
  const r = '无匹配「fooBar」';
  assert(toolOutcomeOf(r) === 'ok', `grep 无命中不该算失败,实际 ${toolOutcomeOf(r)}`);
});

test('不误伤:recall_memory 空库提示 → ok', () => {
  const r = '没有匹配「部署流程」的历史(仅本会话;如需更早背景,换个关键词再试)。注意:这只说明记忆库里没存过。';
  assert(toolOutcomeOf(r) === 'ok', `召回空结果不算工具失败,实际 ${toolOutcomeOf(r)}`);
});

test('不误伤:正文中出现"未找到/失败"但不在开头 → ok', () => {
  const r = '已替换 1 处 → /tmp/a.ts\n(上下文:此前有 未找到 的告警,已解决)';
  assert(toolOutcomeOf(r) === 'ok', `startsWith 应只认首句,实际 ${toolOutcomeOf(r)}`);
});

test('既有判定不回归:工具出错/未知工具/⚠️ 参数/[exit N]/❌/已停止', () => {
  assert(toolOutcomeOf('工具出错: TypeError: x') === 'error');
  assert(toolOutcomeOf('未知工具: foo') === 'error');
  assert(toolOutcomeOf('⚠️ 参数解析失败:模型输出的 JSON 不完整') === 'error');
  assert(toolOutcomeOf('[exit 1] npm ERR!') === 'error');
  assert(toolOutcomeOf('❌ 窗口截取失败: 未找到') === 'error');
  assert(toolOutcomeOf('[已停止]') === 'aborted');
});

test('正常成功结果 → ok', () => {
  assert(toolOutcomeOf('已替换 1 处 → /tmp/a.ts') === 'ok');
  assert(toolOutcomeOf('文件共 120 行') === 'ok');
});

run();
