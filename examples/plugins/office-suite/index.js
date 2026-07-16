// office-suite 插件入口 —— 办公文档工具集。
// 依赖系统命令: pandoc / python3+openpyxl / pdftotext(poppler-utils)。
// 工具返回中文,与项目惯例一致。

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// 封装 exec 为 Promise, 超时 60s, 合并 stdout+stderr。
function execAsync(cmd, cwd, timeout = 60000) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.killed) { resolve('⏱ 执行超时'); return; }
      if (err) { resolve(`❌ ${err.message}\n${stderr}`); return; }
      resolve(stdout || stderr || '✅ 完成');
    });
  });
}

module.exports = {
  tools: [
    {
      name: 'create_doc',
      description: '创建 Word 文档(.docx)。用 pandoc 把 Markdown 转 docx。',
      parameters: {
        type: 'object',
        properties: {
          output: { type: 'string', description: '输出文件路径(.docx)' },
          content: { type: 'string', description: '文档内容(Markdown 格式)' },
          title: { type: 'string', description: '文档标题(一级标题, 可选)' },
        },
        required: ['output', 'content'],
      },
      readOnly: false,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const tmp = path.join(cwd, `.kinet-tmp-${Date.now()}.md`);
        const titleLine = args.title ? `# ${args.title}\n\n` : '';
        fs.writeFileSync(tmp, titleLine + String(args.content));
        const out = await execAsync(`pandoc "${tmp}" -o "${args.output}"`, cwd);
        try { fs.unlinkSync(tmp); } catch (_) { /* noop */ }
        return out.includes('完成') || out.includes('✅')
          ? `已创建文档: ${args.output}`
          : out;
      },
    },
    {
      name: 'excel_to_csv',
      description: '将 Excel 文件(.xlsx/.xls)转为 CSV。需要 python3 + openpyxl。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Excel 文件路径' },
          output: { type: 'string', description: '输出 CSV 路径' },
          sheet: { type: 'string', description: '工作表名(可选, 默认第一个)' },
        },
        required: ['input', 'output'],
      },
      readOnly: false,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const py = [
          'import openpyxl, csv, sys',
          `wb = openpyxl.load_workbook("${args.input}")`,
          `ws = wb["${args.sheet}"] if "${args.sheet}" else wb.active`,
          `with open("${args.output}", "w", newline="", encoding="utf-8") as f:`,
          '    csv.writer(f).writerows(ws.iter_rows(values_only=True))',
          'print("done")',
        ].join('\n');
        return execAsync(`python3 -c '${py.replace(/'/g, "'\\''")}'`, cwd);
      },
    },
    {
      name: 'pdf_extract_text',
      description: '从 PDF 提取纯文本。需要 pdftotext(poppler-utils)。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'PDF 文件路径' },
          pages: { type: 'string', description: '页码范围(可选, 如 1-5)' },
        },
        required: ['input'],
      },
      readOnly: true,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const pageFlag = args.pages ? ` -f ${args.pages}` : '';
        return execAsync(`pdftotext${pageFlag} "${args.input}" -`, cwd);
      },
    },
  ],
};
