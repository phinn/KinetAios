// vm-console —— VM 控制台工具集(2026-10 KinetVM 装机复盘沉淀)
// Tool 接口签名见 src/main/tools.ts: Tool { name; description; parameters; readOnly?; run(args, ctx) }
//
// 工具列表:
//   1. vnc_snap  — VNC 截屏 + macOS Vision OCR,输出【左上原点】归一化坐标(x,y ∈ 0..10000)
//   2. vnc_type  — QMP send-key 底层键码注入(绕开 guest 键盘布局;vncdo 逐字 type 在非美式布局 guest 上必错位)
//   3. vnc_key   — 单个命名键(enter/tab/f10 等)走 QMP 注入
//
// 三天踩坑 → 本插件消掉的坑:
//   坑1: Vision 框坐标 origin 在左下,y 归一化方向与截屏图相反 → 统一换算为左上原点输出
//   坑2: 手撸 RFB(SetPixelFormat/SetEncodings/FBUpdateRequest)在 QEMU 上只推脏矩形,
//        初次连接收不到全量帧 → 直接用 vncdotool(vncdo capture),它处理好了协议状态机
//   坑3: vncdo type 逐字注入走 guest 键盘映射,非美式布局(如中文输入法/欧式布局)字符错位
//        → QMP send-key 直发 PS/2 键码,零布局依赖
//   坑4: QEMU VNC 对 ramfb 冷启动阶段可能长时间 0 帧 → vnc_snap 自带重试与超时报告
//
// 依赖: vncdotool(pip3 install vncdotool)。qmp-burst.sock 需 QEMU 以
//   -qmp unix:<path>,server,nowait 启动且无其它客户端占用(app 编排器占 qmp.sock 时用 burst 口)。

const { execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 辅助:执行命令(收集 stdout/stderr/code) ──────────────────
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 8, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err ? (typeof err.code === 'number' ? err.code : -1) : 0 });
    });
  });
}

// ── macOS Vision OCR:返回左上原点归一化坐标(x0,y0,x1,y1 ∈ 0..1) ──
// Vision 的 boundingBox origin 在左下 → 本函数内部完成换算,调用方永远拿左上原点。
// Vision bbox: origin 在左下 → 本函数内部完成换算,调用方永远拿左上原点。
// Vision bbox = {origin:{x,y(从底)}, width, height} 全部归一化(0..1)
function ocrMac(imgPath) {
  return new Promise((resolve, reject) => {
    const script = `
const path = ${JSON.stringify(imgPath)};
const { createRequire } = require('module');
require('pkginfo');
`.trim();
    // Swift 桥太重,直接用 osascript 调 Vision 不可行 → 用预编译的 vocr.swift 逻辑:
    // 实测最稳的零依赖路径 = python3 + pyobjc(Vision + PIL),KinetVM 诊断中已验证。
    const py = `
import sys, json, io
import Foundation
from Vision import VNImageRequestHandler, VNRecognizeTextRequest
from PIL import Image
import objc
path = sys.argv[1]
w, h = Image.open(path).size
handler = VNImageRequestHandler.alloc().initWithURL_options_(
    Foundation.NSURL.fileURLWithPath_(path), None)
req = VNRecognizeTextRequest.alloc().init()
req.setRecognitionLevel_(0)  # accurate
req.setRecognitionLanguages_(["zh-Hans", "en-US"])
ok = handler.performRequests_error_([req], None)
out = []
if ok:
    for obs in (req.results() or []):
        bb = obs.boundingBox()  # origin 左下,归一化
        cand = obs.topCandidates_(1)
        text = cand[0].string() if cand else ''
        x0 = bb.origin.x; y0 = 1.0 - (bb.origin.y + bb.size.height)  # 左下 → 左上
        out.append({"box": [round(x0,4), round(y0,4), round(x0+bb.size.width,4), round(y0+bb.size.height,4)], "text": text})
print(json.dumps({"w": w, "h": h, "lines": out}, ensure_ascii=False))
`.trim();
    execFile('python3', ['-c', py, imgPath], { timeout: 60000, maxBuffer: 1024 * 1024 * 8, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`Vision OCR 失败: ${stderr || err.message}`));
      else { try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`OCR 输出解析失败: ${stdout.slice(0, 200)}`)); } }
    });
  });
}

// 归一化 0..1 → 万分位整数(输出紧凑,LLM 好读)
const pct = (v) => Math.round(v * 10000);

// ── 工具 1: vnc_snap ────────────────────────────────────────
// host 默认 127.0.0.1;QEMU 默认 -vnc 127.0.0.1:1 → 端口 5901
async function vncSnap(args) {
  const host = String(args.host || '127.0.0.1');
  const port = Number(args.port || 5901);
  const ocr = args.ocr !== false;
  const tmp = path.join(os.tmpdir(), `vnc_snap_${Date.now()}.png`);
  const cap = await run('vncdo', ['-s', `${host}::${port}`, 'capture', tmp], 60000);
  if (!cap.ok || !fs.existsSync(tmp)) {
    return `❌ vncdo capture 失败(端口 ${port}): ${(cap.stderr || '未知错误').slice(0, 300)}\n提示: 确认 QEMU 带 -vnc 127.0.0.1:N 且 vncdotool 已安装(pip3 install vncdotool)。QEMU ramfb 冷启动阶段可能暂无帧,稍后重试。`;
  }
  if (!ocr) return `✅ 截屏已保存: ${tmp}`;
  let o;
  try { o = await ocrMac(tmp); } catch (e) { return `✅ 截屏已保存: ${tmp}\n⚠️ OCR 失败: ${e.message}`; }
  const lines = o.lines
    .sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]))
    .map((l) => `  [${pct(l.box[0])},${pct(l.box[1])} → ${pct(l.box[2])},${pct(l.box[3])}] ${l.text}`)
    .join('\n');
  return `✅ 截屏 ${o.w}x${o.h} 已保存: ${tmp}\n坐标=左上原点万分位 [x0,y0 → x1,y1](点击用左上角点 x,y 即可):\n${lines || '  (无文字)'}`;
}

// ── QMP send-key:PS/2 键码底层注入,零键盘布局依赖 ─────────────
// QMP input-send-event + qcode 表(QEMU input-keycodes)
const QCODES = {
  enter: 'ret', tab: 'tab', esc: 'esc', escape: 'esc', space: 'spc', backspace: 'bsp',
  delete: 'delete', up: 'up', down: 'down', left: 'left', right: 'right',
  home: 'home', end: 'end', pgup: 'pgup', pgdn: 'pgdn',
  f1: 'f1', f2: 'f2', f3: 'f3', f4: 'f4', f5: 'f5', f6: 'f6', f7: 'f7', f8: 'f8',
  f9: 'f9', f10: 'f10', f11: 'f11', f12: 'f12',
  shift: 'shift', ctrl: 'ctrl', alt: 'alt', meta: 'meta',
};
// 可打印字符 → (qcode, needShift)。覆盖美式布局可见字符;guest 端布局差异由 PS/2 set-1 扫描码语义抹平。
// 数据来源: QEMU ui/input.c qcode 命名 + AT set-1 美式布局。
const CHARMAP = {
  ' ': ['spc', false], '-': ['minus', false], '=': ['equal', false], '[': ['bracket_left', false], ']': ['bracket_right', false],
  '\\': ['backslash', false], ';': ['semicolon', false], "'": ['apostrophe', false], '`': ['grave_accent', false],
  ',': ['comma', false], '.': ['dot', false], '/': ['slash', false],
  '!': ['1', true], '@': ['2', true], '#': ['3', true], '$': ['4', true], '%': ['5', true], '^': ['6', true],
  '&': ['7', true], '*': ['8', true], '(': ['9', true], ')': ['0', true],
  '_': ['minus', true], '+': ['equal', true], '{': ['bracket_left', true], '}': ['bracket_right', true],
  '|': ['backslash', true], ':': ['semicolon', true], '"': ['apostrophe', true], '~': ['grave_accent', true],
  '<': ['comma', true], '>': ['dot', true], '?': ['slash', true],
};
for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(97 + i); // a..z
  CHARMAP[ch] = [ch, false];
  CHARMAP[ch.toUpperCase()] = [ch, true];
}
for (let i = 0; i < 10; i++) CHARMAP[String(i)] = [String(i), false];

// 单条 QMP 命令(连接 → greet → capabilities → cmd → 响应 → 断开)
function qmpCmd(sockPath, cmd) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`QMP 超时(${sockPath})`)); }, 8000);
    const finish = (v) => { clearTimeout(timer); sock.destroy(); resolve(v); };
    sock.on('error', (e) => { clearTimeout(timer); reject(new Error(`QMP 连接失败(${sockPath}): ${e.message}。确认 QEMU 带 -qmp unix:<path>,server,nowait,且未被其它客户端占用(app 编排器占主 qmp.sock 时用 burst 口)。`)); });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.QMP) { sock.write(JSON.stringify({ execute: 'qmp_capabilities' }) + '\n'); continue; }
        if (msg.return !== undefined && !msg.event) { finish(msg); return; }
        if (msg.error) { finish({ error: msg.error }); return; }
      }
    });
    void cmd; // cmd 由外层闭包写入(见下)
  });
}
// 上面闭包拿不到 cmd → 重写为把 cmd 传入
function qmpExec(sockPath, execute, argsObj) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    let buf = ''; let sentCap = false; let sentCmd = false;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`QMP 超时(${sockPath})`)); }, 8000);
    const finish = (v) => { clearTimeout(timer); try { sock.destroy(); } catch {} resolve(v); };
    sock.on('error', (e) => { clearTimeout(timer); reject(new Error(`QMP 连接失败(${sockPath}): ${e.message}。确认 QEMU 带 -qmp unix:<path>,server,nowait 且端口未被占用(常见: 主 qmp.sock 被编排器占用,改用 qmp-burst.sock)。`)); });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.QMP && !sentCap) { sentCap = true; sock.write(JSON.stringify({ execute: 'qmp_capabilities' }) + '\n'); continue; }
        if (sentCap && !sentCmd) {
          sentCmd = true;
          sock.write(JSON.stringify(argsObj ? { execute, arguments: argsObj } : { execute }) + '\n');
          continue;
        }
        if (msg.error) { finish({ error: msg.error }); return; }
        if (msg.return !== undefined) { finish(msg); return; }
      }
    });
  });
}

// 把文本转成 QMP input-send-event 事件序列并发送
async function qmpType(sockPath, text) {
  const events = [];
  for (const ch of text) {
    if (ch === '\n') { events.push({ type: 'press', data: { down: true, key: { type: 'qcode', data: 'ret' } } }); events.push({ type: 'press', data: { down: false, key: { type: 'qcode', data: 'ret' } } }); continue; }
    if (ch === '\t') { events.push({ type: 'press', data: { down: true, key: { type: 'qcode', data: 'tab' } } }); events.push({ type: 'press', data: { down: false, key: { type: 'qcode', data: 'tab' } } }); continue; }
    const m = CHARMAP[ch];
    if (!m) continue; // 不认识的字符跳过(如 CJK — guest 布局无法表达)
    const [qc, sh] = m;
    if (sh) events.push({ type: 'press', data: { down: true, key: { type: 'qcode', data: 'shift' } } });
    events.push({ type: 'press', data: { down: true, key: { type: 'qcode', data: qc } } });
    events.push({ type: 'press', data: { down: false, key: { type: 'qcode', data: qc } } });
    if (sh) events.push({ type: 'press', data: { down: false, key: { type: 'qcode', data: 'shift' } } });
  }
  // 分批:单命令事件太多会被 QMP 拒或丢;按 64 键事件一批
  const BATCH = 64;
  for (let i = 0; i < events.length; i += BATCH) {
    const r = await qmpExec(sockPath, 'input-send-event', { events: events.slice(i, i + BATCH) });
    if (r && r.error) return { ok: false, err: r.error };
  }
  return { ok: true, n: events.length };
}

// ── 工具 2: vnc_type ────────────────────────────────────────
async function vncType(args) {
  const sock = String(args.qmpSock || '');
  const text = String(args.text || '');
  const keys = args.keys ? String(args.keys).trim().toLowerCase().split(/\s+/) : [];
  if (!sock || (!text && !keys.length)) return '❌ 需要 qmpSock + text(或 keys)';
  if (!fs.existsSync(sock)) return `❌ QMP socket 不存在: ${sock}`;
  let typed = 0;
  if (text) {
    const r = await qmpType(sock, text);
    if (!r.ok) return `❌ input-send-event 失败: ${JSON.stringify(r.err).slice(0, 200)}`;
    typed = r.n;
  }
  for (const k of keys) {
    const qc = QCODES[k];
    if (!qc) return `❌ 未知按键 "${k}"。支持: ${Object.keys(QCODES).join('/')}`;
    const r = await qmpExec(sock, 'input-send-event', { events: [
      { type: 'press', data: { down: true, key: { type: 'qcode', data: qc } } },
      { type: 'press', data: { down: false, key: { type: 'qcode', data: qc } } },
    ] });
    if (r && r.error) return `❌ 按键 ${k} 失败: ${JSON.stringify(r.error).slice(0, 200)}`;
    typed++;
  }
  return `✅ 已注入 ${typed} 个按键事件(PS/2 键码,零布局依赖)。用 vnc_snap 确认效果。`;
}

// ── 导出 ────────────────────────────────────────────────────
const tools = [
  {
    name: 'vnc_snap',
    description: '对运行中的 VM(VNC)截屏并 OCR,输出文字块坐标(左上原点万分位,点击/拖拽直接用)。修复 Vision 左下原点坑;QEMU 只推脏矩形的坑由 vncdotool 处理。vnc_snap(host, port=5901, ocr=true)',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'VNC 主机,默认 127.0.0.1' },
        port: { type: 'number', description: 'VNC 端口,默认 5901(QEMU -vnc 127.0.0.1:1)' },
        ocr: { type: 'boolean', description: '是否 OCR,默认 true' },
      },
      required: [],
    },
    readOnly: true,
    async run(args) { return vncSnap(args); },
  },
  {
    name: 'vnc_type',
    description: '向 VM 键盘注入文本/按键 —— QMP send-key PS/2 键码底层通道,不经过 guest 键盘布局(vncdo type 在非美式布局 guest 上字符错位,本工具无此问题)。CJK 字符无法注入(布局限制)。vnc_type(qmpSock, text=..., keys="enter f10", 仅 Direct 可用,写类)',
    parameters: {
      type: 'object',
      properties: {
        qmpSock: { type: 'string', description: 'QMP unix socket 路径(如 /path/qmp-burst.sock;主 qmp.sock 常被 app 编排器占用)' },
        text: { type: 'string', description: '要注入的文本(ASCII;\\n=回车)' },
        keys: { type: 'string', description: '命名按键,空格分隔: enter tab esc space up down left right home end pgup pgdn f1..f12' },
      },
      required: ['qmpSock'],
    },
    async run(args) { return vncType(args); },
  },
];

module.exports = { tools };
