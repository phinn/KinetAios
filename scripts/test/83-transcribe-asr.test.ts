// 83-transcribe-asr.test.ts — 语音转写 ASR 配置与纯函数测试
// 覆盖: ①transcribeViaOpenAI multipart 组包正确 ②非2xx 返回 ok:false+根因
// ③404 场景(anthropic 协议主 provider 无 ASR 端点 = 实际 bug 现场)④空文本 ok:true
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { transcribeViaOpenAI } from '../../src/main/ipc/tools';

// 起一次性本地 http server,回放各场景
function serve(handler: (req: http.IncomingMessage, body: Buffer) => [number, string]): Promise<{ url: string; close: () => void; lastBody: () => Buffer }> {
  let lastBody = Buffer.alloc(0);
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks);
      const [code, out] = handler(req, lastBody);
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(out);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => srv.close(), lastBody: () => lastBody });
    });
  });
}

const B64 = Buffer.from('fake-audio-bytes').toString('base64');

test('asr: 成功路径 — multipart 含 file+model,text 回传', async () => {
  const s = await serve(() => [200, JSON.stringify({ text: '你好世界' })]);
  try {
    const r = await transcribeViaOpenAI(s.url + '/', 'sk-test', 'whisper-1', B64, 'audio/webm');
    assert.equal(r.ok, true);
    assert.equal(r.text, '你好世界');
    const body = s.lastBody().toString('latin1');
    assert.match(body, /name="file"; filename="audio\.webm"/);
    assert.match(body, /name="model"\r\n\r\nwhisper-1/);
    assert.match(body, /fake-audio-bytes/);
  } finally { s.close(); }
});

test('asr: 404 — anthropic 协议主 provider 无 ASR 端点(实际 bug 现场)', async () => {
  const s = await serve(() => [404, '404 page not found']);
  try {
    const r = await transcribeViaOpenAI(s.url, 'sk-test', 'whisper-1', B64, 'audio/m4a');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /HTTP 404/);
  } finally { s.close(); }
});

test('asr: 401 鉴权失败 — 带状态码根因', async () => {
  const s = await serve(() => [401, '{"error":"invalid api key"}']);
  try {
    const r = await transcribeViaOpenAI(s.url, 'sk-bad', 'whisper-1', B64, 'audio/m4a');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /HTTP 401/);
  } finally { s.close(); }
});

test('asr: baseURL 尾斜杠归一 — 不产生双斜杠', async () => {
  const s = await serve((req) => {
    assert.ok(!req.url?.includes('//audio'), '不应出现 //audio 双斜杠, 实际: ' + req.url);
    return [200, JSON.stringify({ text: 'ok' })];
  });
  try {
    const r = await transcribeViaOpenAI(s.url + '/', 'sk-test', 'glm-asr', B64, 'audio/mp4');
    assert.equal(r.ok, true);
  } finally { s.close(); }
});

test('asr: 空 text 返回 ok:true + 空串', async () => {
  const s = await serve(() => [200, JSON.stringify({ text: '' })]);
  try {
    const r = await transcribeViaOpenAI(s.url, 'sk-test', 'whisper-1', B64, 'audio/webm');
    assert.equal(r.ok, true);
    assert.equal(r.text, '');
  } finally { s.close(); }
});
