// 链接预览:分类器纯逻辑测试(overlay/webview 走手测,不进 node runner)
// 特性:src/renderer/link-preview.ts 的 previewableKind()
import { strict as assert } from 'node:assert';
import { previewableKind } from '../../src/renderer/link-preview';

export function test(): void {
  // http/https/file 才预览
  assert.equal(previewableKind('https://example.com/report.html'), 'html');
  assert.equal(previewableKind('http://127.0.0.1:8421/index.html'), 'html');
  assert.equal(previewableKind('file:///Users/x/docs/readme.md'), 'md');
  assert.equal(previewableKind('https://raw.githubusercontent.com/u/r/main/README.md'), 'md');

  // md 家族 + 文本类全部当 md 渲染
  assert.equal(previewableKind('https://a.b/c.MARKDOWN'), 'md');
  assert.equal(previewableKind('https://a.b/x.txt'), 'md');
  assert.equal(previewableKind('https://a.b/guide.rst'), 'md');

  // 非文本扩展名 / 无扩展名 / 裸域 → null(原路系统浏览器)
  assert.equal(previewableKind('https://github.com/phinn/KinetAios'), null);
  assert.equal(previewableKind('https://example.com/app/download'), null);
  assert.equal(previewableKind('https://example.com/img.png'), null);
  assert.equal(previewableKind('https://example.com/pkg.zip'), null);

  // 危险协议一律 null
  assert.equal(previewableKind('javascript:alert(1)'), null);
  assert.equal(previewableKind('data:text/html;base64,xxx'), null);
  assert.equal(previewableKind('file://evil.com/share.md'), null);
}
