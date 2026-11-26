// 工具级遥测:成败判定与错误分类必须同源(一张前缀表),分类能支撑「按原因聚合错误率」。
import { assert, test, run } from './harness';
import { summarizeToolError, toolTelemetryOf } from '../../src/main/tool-telemetry';

test('ok:业务性"没结果"不算失败,且不带错误分类', () => {
  for (const r of ['grep 无命中', '文件共 120 行', '已替换 1 处 → /tmp/a.ts', '📷 截屏成功 (1512×982)']) {
    const tel = toolTelemetryOf(r);
    assert.equal(tel.outcome, 'ok', r);
    assert.equal(tel.errorKind, undefined, r);
  }
  // 正文里引用失败文案不算失败(只认首句前缀 / 头部特征)
  assert.equal(toolTelemetryOf('说明:未找到要替换的片段时请重试').outcome, 'ok');
});

test('aborted:用户停止单独一档,不归入错误', () => {
  const tel = toolTelemetryOf('[已停止]');
  assert.equal(tel.outcome, 'aborted');
  assert.equal(tel.errorKind, undefined);
});

test('错误分类:每类固定前缀/特征各自归类', () => {
  const cases: Array<[string, string]> = [
    ['工具出错: TypeError: x is not a function', 'exception'],
    ['未知工具: foo', 'unknown_tool'],
    ['⚠️ 参数解析失败:模型输出的 JSON 不完整', 'bad_args'],
    ['[now: 2026-11-26 10:00:00] ⏳ 超时(120s),保留部分输出…', 'timeout'],
    ['[exit 1] npm ERR! missing script', 'exit_code'],
    ['未找到要替换的片段: ok\n请检查 old_string', 'edit_mismatch'],
    ['文件不存在: /tmp/nope.png', 'not_found'],
    ['读不到: /root/secret', 'not_found'],
    ['写入失败: EIO', 'io'],
    ['文件超过 50MB 上限: 60MB', 'unsupported'],
    ['拒绝编辑二进制文件: a.png', 'unsupported'],
    ['该文件是 UTF-16 编码,请用支持 UTF-16 的编辑器', 'unsupported'],
    ['❌ 窗口截取失败: 未找到', 'reported'],
    ['❌ EACCES: permission denied, open /etc/x', 'permission'],
    ['缺少 path: read_file 需要 path 参数', 'bad_args'],
  ];
  for (const [result, kind] of cases) {
    const tel = toolTelemetryOf(result);
    assert.equal(tel.outcome, 'error', result);
    assert.equal(tel.errorKind, kind, result);
  }
});

test('错误摘要:单行、去 ANSI、去截图载荷、有长度上限', () => {
  assert.equal(summarizeToolError('\u001b[31m❌ 失败\u001b[0m\n第二行'), '❌ 失败');
  assert.equal(summarizeToolError('📷 截屏成功\n__IMAGE_BASE64__:AAAA\nBBBB'), '📷 截屏成功');
  assert.equal(summarizeToolError(''), '');
  const long = summarizeToolError('x'.repeat(500), 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('…'));
  // 遥测里带的摘要就是这条单行摘要
  assert.equal(toolTelemetryOf('❌ 窗口截取失败: 未找到').errorSummary, '❌ 窗口截取失败: 未找到');
});

test('错误分类与 outcome 判定一致:error 必有摘要', () => {
  for (const r of ['工具出错: x', '❌ 失败', '[exit 2] x', '⚠️ 参数无效']) {
    const tel = toolTelemetryOf(r);
    assert.equal(tel.outcome, 'error');
    assert.ok((tel.errorSummary ?? '').length > 0, r);
  }
});

run();
