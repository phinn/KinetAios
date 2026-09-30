#!/usr/bin/env node
// codemode spike:验证 Code Mode 工具在真实依赖下端到端可用。
// Verifies the codemode tool end-to-end against the real @earendil-works/pi-codemode runtime.
//
// 场景 = 宣发文案的「批量打标」:12 条用户评论,沙箱脚本循环调 classify-comment(打标器),
// 中间结果(每条的完整评论+标签)不进上下文,只 return 一行汇总 —— 这就是上下文税的对照证据。
//
// 跑法:node scripts/spike-codemode.js
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');

// ① 用工程自带 esbuild 把 src/main/codemode.ts + 依赖打成单文件 CJS(tools.ts 也一起进去,
//    electron require 在纯 Node 下会失败 → 注入 stub alias)。
const esbuildBin = path.join(root, 'node_modules', '.bin', 'esbuild');
// bundle 产物放工程 tmp-test/ 下:动态 import() 沿目录树向上找 node_modules(ESM 不吃 NODE_PATH)。
// Emit the bundle under <root>/tmp-test so the sandbox's ESM import resolves <root>/node_modules.
const outDir = path.join(root, 'tmp-test');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `codemode_spike_${process.pid}.cjs`);
const stubElectron = path.join(os.tmpdir(), 'codemode_electron_stub.ts');
fs.writeFileSync(stubElectron, 'export const app = { getPath: () => process.env.TMPDIR || "/tmp" };\n');

execFileSync(esbuildBin, [
  path.join(root, 'src/main/codemode.ts'),
  '--bundle', '--platform=node', '--format=cjs',
  `--outfile=${outFile}`,
  `--alias:electron=${stubElectron}`,
  '--external:@earendil-works/pi-codemode', // ESM-only 保持外部,运行时动态 import
  '--external:quickjs-wasi',
  '--log-level=warning', '--legal-comments=none',
]);

const { codemodeTool } = require(outFile);

// ── 假工具集:read_file(真读) + classify_comment(打标器,确定性) ──
const comments = [
  '启动速度比之前快多了,但设置页偶尔卡死', '太好用了,每日精选推送正中需求',
  '崩溃两次,数据丢了,愤怒', '界面好看,不过价格偏贵', '客服响应很快,问题当场解决',
  '同步总是失败,重试十次', '还行吧,中规中矩', '导出 PDF 格式全乱,无法接受',
  '新版本修复了我提的 bug,点赞', '隐私政策写得不清楚,担忧数据去向', '翻译质量意外地好',
  '内存占用越来越高,风扇狂转',
];
// 打标器输出「很大」——每条 2KB 的原始 JSON,模拟真实工具的肥输出
function classifyComment(args) {
  const text = String(args?.text ?? '');
  const neg = ['崩溃', '丢失', '失败', '乱', '担忧', '卡死', '占用', '愤怒'].some((k) => text.includes(k));
  const pos = ['好用', '快', '点赞', '好', '解决', '修复', '赞'].some((k) => text.includes(k));
  const label = neg ? '负面' : pos ? '正面' : '中性';
  const filler = 'x'.repeat(2000); // 肥输出:如果不做 codemode,12 条 × 2KB 全进上下文
  return JSON.stringify({ text, label, confidence: neg || pos ? 0.9 : 0.6, raw: filler });
}
const fakeTools = [
  { name: 'read_file', description: '读取本地文件', parameters: { type: 'object', properties: { path: { type: 'string' } } }, readOnly: true,
    async run(args) { return fs.readFileSync(String(args.path), 'utf8'); } },
  { name: 'classify_comment', description: '给一条评论打情感标签(负面/正面/中性),返回大 JSON', parameters: { type: 'object', properties: { text: { type: 'string' } } }, readOnly: true,
    async run(args) { return classifyComment(args); } },
];

(async () => {
  // 模拟引擎:ctx.nestedTools 回填(与 engines.ts/DirectV2Engine.ts 相同动作)
  const ctx = {
    cwd: root, convId: 'spike-test',
    confirm: async () => true,
    nestedTools: fakeTools,
    emit: undefined,
  };

  // ── 模型会写的脚本:循环 + 提炼,return 一行汇总 ──
  const code = `
    const comments = (await tools.read_file({ path: COMMENTS_FILE })).split('\\n').filter(Boolean);
    const out = [];
    for (const c of comments) {
      const r = JSON.parse(await tools.classify_comment({ text: c }));
      out.push(r.label); // 只留标签,肥输出(raw 2KB/条)被沙箱吃掉,不进上下文
    }
    const counts = {};
    for (const l of out) counts[l] = (counts[l] ?? 0) + 1;
    store('labels', out);
    return { total: comments.length, counts };
  `;
  // COMMENTS_FILE 通过临时文件传(避免把 12 条评论写进代码字符串,更贴近真实路径)
  const commentsFile = path.join(os.tmpdir(), 'codemode_spike_comments.txt');
  fs.writeFileSync(commentsFile, comments.join('\n'));

  const finalCode = code.replace('COMMENTS_FILE', JSON.stringify(commentsFile));
  const r = await codemodeTool.run({ code: finalCode }, ctx);

  console.log('═══ codemode 返回给模型的全文 ═══');
  console.log(r);
  console.log();

  // ── 断言 ──
  const ret = r.length;
  const ok1 = r.includes('✅ 完成');
  // 断言不写死标签数(词表匹配属实现细节),只验证:总数=12 且三档加起来=12
  const m = r.match(/"total": (\d+)/);
  const neg = Number((r.match(/"负面": (\d+)/) || [])[1]);
  const pos = Number((r.match(/"正面": (\d+)/) || [])[1]);
  const neu = Number((r.match(/"中性": (\d+)/) || [])[1]);
  const ok2 = m && Number(m[1]) === 12 && neg + pos + neu === 12;
  const ok3 = !r.includes('xxxx'); // 肥输出没漏进来
  const ok4 = r.includes('12 成功 / 0 失败') || r.includes('共 13 次'); // 12 打标 + 1 读文件
  const ok5 = r.includes('未进入对话上下文');
  // store 落盘验证
  const storeFile = path.join((process.env.TMPDIR || '/tmp'), 'codemode-store', 'spike-test.json');
  const storeData = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const ok6 = Array.isArray(storeData.labels) && storeData.labels.length === 12;

  console.log(`断言: 完成=${ok1} 汇总正确=${ok2} 肥输出未漏=${ok3} 调用台账=${ok4} 免税声明=${ok5} store落盘=${ok6}`);
  console.log(`返回文本长度: ${ret} 字符(对照:12 条肥输出直接进上下文 ≈ 24000+ 字符 → 省约 ${Math.round((1 - ret / 24600) * 100)}%)`);
  const pass = ok1 && ok2 && ok3 && ok4 && ok5 && ok6;
  console.log(pass ? '\nSPIKE PASS ✅' : '\nSPIKE FAIL ❌');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
