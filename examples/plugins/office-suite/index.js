// office-suite 插件入口 —— 办公文档工具集 (v2)
// 依赖: pandoc / python3+openpyxl / pdftotext(poppler) / tesseract(可选) / PowerShell+Office COM(Windows)
// 工具返回中文,与项目惯例一致。

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── 基础工具 ──────────────────────────────────────────────

// 封装 exec 为 Promise, 超时可配, 合并 stdout+stderr。
function execAsync(cmd, cwd, timeout = 60000) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.killed) { resolve('⏱ 执行超时'); return; }
      if (err) { resolve(`❌ ${err.message}\n${stderr}`); return; }
      resolve(stdout || stderr || '✅ 完成');
    });
  });
}

// 安全写入临时文件, 返回路径。
function tmpFile(ext, cwd, content) {
  const p = path.join(cwd, `.kinet-tmp-${Date.now()}${ext}`);
  fs.writeFileSync(p, content);
  return p;
}

// 转义 PowerShell 单引号字符串内嵌的单引号 (' → '')。
function psQuote(s) {
  return String(s).replace(/'/g, "''");
}

// 检测命令是否可用 (which / where)。
async function hasCmd(cmd, cwd) {
  const check = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
  const out = await execAsync(check, cwd, 5000);
  return !out.startsWith('❌');
}

// ── CSV 工具 ──────────────────────────────────────────────

// 简易 CSV 解析(支持引号包裹和逗号转义)。
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQuotes) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else { field += c; }
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// 判断值是否为数字。
function isNum(v) {
  return v !== '' && v != null && !isNaN(Number(v));
}

// ── 导出工具 ──────────────────────────────────────────────

module.exports = {
  tools: [
    // ══════════════════════════════════════════════════════
    // 第一档: 零外部依赖 (纯 Node)
    // ══════════════════════════════════════════════════════

    // ── CSV 分析 ──
    {
      name: 'csv_analyze',
      description: '分析 CSV 文件:自动推断列类型,输出每列的统计摘要(行数/唯一值/数值列的 min/max/mean/sum)。纯 Node,无需外部依赖。',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'CSV 文件路径' },
          delimiter: { type: 'string', description: '分隔符(默认逗号, 可选 \\t / ; / |)' },
        },
        required: ['file'],
      },
      readOnly: true,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const fp = path.resolve(cwd, args.file);
        if (!fs.existsSync(fp)) return `❌ 文件不存在: ${args.file}`;
        const raw = fs.readFileSync(fp, 'utf8');
        const delim = args.delimiter === '\\t' ? '\t' : (args.delimiter || ',');
        const text = delim === ',' ? raw : raw.replace(new RegExp(delim, 'g'), ',');
        const rows = parseCSV(text);
        if (rows.length < 2) return '❌ CSV 行数不足(需要至少表头 + 1 行数据)';
        const headers = rows[0];
        const dataRows = rows.slice(1);
        const lines = [`📊 CSV 分析: ${args.file}`, `总行数(含表头): ${rows.length}, 数据行: ${dataRows.length}, 列数: ${headers.length}`, ''];
        for (let ci = 0; ci < headers.length; ci++) {
          const col = headers[ci];
          const vals = dataRows.map(r => r[ci] ?? '');
          const nonEmpty = vals.filter(v => v.trim() !== '');
          const numeric = vals.filter(isNum);
          const unique = new Set(nonEmpty).size;
          if (numeric.length > nonEmpty.length * 0.6) {
            const nums = numeric.map(Number);
            const sum = nums.reduce((a, b) => a + b, 0);
            const mean = sum / nums.length;
            const sorted = [...nums].sort((a, b) => a - b);
            const median = sorted.length % 2
              ? sorted[(sorted.length - 1) >> 1]
              : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
            lines.push(`  📐 ${col} (数值): min=${Math.min(...nums)}, max=${Math.max(...nums)}, mean=${mean.toFixed(2)}, median=${median}, sum=${sum.toFixed(2)}, 唯一值=${unique}`);
          } else {
            lines.push(`  📝 ${col} (文本): 非空=${nonEmpty.length}, 唯一值=${unique}`);
            // 列举出现频率前 5 的值
            const freq = {};
            for (const v of nonEmpty) freq[v] = (freq[v] || 0) + 1;
            const top5 = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5);
            if (top5.length <= 8) lines.push(`       常见值: ${top5.map(([v, c]) => `"${v}"(${c})`).join(', ')}`);
          }
        }
        return lines.join('\n');
      },
    },

    {
      name: 'csv_filter',
      description: '筛选 CSV 行:按列值过滤、排序、去重,输出结果为 Markdown 表格(前 50 行)或写入文件。纯 Node。',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'CSV 文件路径' },
          where: { type: 'string', description: '筛选条件,格式: 列名 操作符 值。操作符支持: ==, !=, >, <, >=, <=, contains, startswith。多条用 AND 连接。例: age > 25 AND city == 北京' },
          sort_by: { type: 'string', description: '排序的列名(可选)' },
          sort_desc: { type: 'boolean', description: '是否降序排序(默认 false 升序)' },
          output: { type: 'string', description: '输出文件路径(可选, 不填则在对话中展示)' },
        },
        required: ['file'],
      },
      readOnly: false,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const fp = path.resolve(cwd, args.file);
        if (!fs.existsSync(fp)) return `❌ 文件不存在: ${args.file}`;
        const rows = parseCSV(fs.readFileSync(fp, 'utf8'));
        if (rows.length < 2) return '❌ CSV 行数不足';
        const headers = rows[0];
        let data = rows.slice(1);
        // 解析 where 条件
        if (args.where) {
          const clauses = String(args.where).split(/\s+AND\s+/i).map(s => s.trim());
          data = data.filter(row => clauses.every(clause => {
            const m = clause.match(/^(\S+)\s*(==|!=|>=|<=|>|<|contains|startswith)\s*(.+)$/i);
            if (!m) return true;
            const [, colName, op, val] = m;
            const ci = headers.indexOf(colName);
            if (ci === -1) return true;
            const cell = String(row[ci] ?? '').trim();
            const target = val.replace(/^["']|["']$/g, '').trim();
            switch (op.toLowerCase()) {
              case '==': return cell === target;
              case '!=': return cell !== target;
              case '>': return Number(cell) > Number(target);
              case '<': return Number(cell) < Number(target);
              case '>=': return Number(cell) >= Number(target);
              case '<=': return Number(cell) <= Number(target);
              case 'contains': return cell.includes(target);
              case 'startswith': return cell.startsWith(target);
              default: return true;
            }
          }));
        }
        // 排序
        if (args.sort_by) {
          const si = headers.indexOf(args.sort_by);
          if (si !== -1) {
            data.sort((a, b) => {
              const av = a[si] ?? '', bv = b[si] ?? '';
              const an = Number(av), bn = Number(bv);
              if (!isNaN(an) && !isNaN(bn)) return args.sort_desc ? bn - an : an - bn;
              return args.sort_desc ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
            });
          }
        }
        const result = [headers, ...data];
        if (args.output) {
          fs.writeFileSync(path.resolve(cwd, args.output), result.map(r => r.join(',')).join('\n'), 'utf8');
          return `✅ 筛选完成: ${data.length} 行已写入 ${args.output}`;
        }
        // Markdown 表格(前 50 行)
        const preview = data.slice(0, 50);
        const md = [
          `| ${headers.join(' | ')} |`,
          `| ${headers.map(() => '---').join(' | ')} |`,
          ...preview.map(r => `| ${headers.map((_, i) => String(r[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`),
        ];
        const note = data.length > 50 ? `\n\n_(仅显示前 50 行, 共 ${data.length} 行)_` : '';
        return `筛选结果: ${data.length} 行\n\n${md.join('\n')}${note}`;
      },
    },

    // ── 格式互转 ──
    {
      name: 'convert_format',
      description: '文档格式互转。利用 pandoc 实现 Markdown/HTML/docx/epub/RTF/PDF 等格式互转。需安装 pandoc。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '输入文件路径' },
          output: { type: 'string', description: '输出文件路径(扩展名决定格式)' },
          template: { type: 'string', description: 'pandoc 模板文件(可选)' },
        },
        required: ['input', 'output'],
      },
      readOnly: false,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const input = path.resolve(cwd, args.input);
        const output = path.resolve(cwd, args.output);
        if (!fs.existsSync(input)) return `❌ 输入文件不存在: ${args.input}`;
        const tmplFlag = args.template ? ` --template="${path.resolve(cwd, args.template)}"` : '';
        const out = await execAsync(`pandoc "${input}" -o "${output}"${tmplFlag}`, cwd, 120000);
        return out.startsWith('❌')
          ? `${out}\n💡 提示: pandoc 可能未安装。Windows: winget install pandoc`
          : `✅ 已转换: ${args.input} → ${args.output}`;
      },
    },

    {
      name: 'markdown_to_html',
      description: '将 Markdown 转换为 HTML 文件(纯 Node, 内置基础样式)。无需外部依赖。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Markdown 文件路径' },
          output: { type: 'string', description: '输出 HTML 路径(可选, 默认同名 .html)' },
          title: { type: 'string', description: 'HTML 页面标题(可选)' },
        },
        required: ['input'],
      },
      readOnly: false,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const input = path.resolve(cwd, args.input);
        if (!fs.existsSync(input)) return `❌ 文件不存在: ${args.input}`;
        const md = fs.readFileSync(input, 'utf8');
        const output = args.output ? path.resolve(cwd, args.output) : input.replace(/\.md$/i, '.html');
        // 极简 Markdown → HTML (不引依赖, 够用)
        let html = md
          .replace(/^### (.+)$/gm, '<h3>$1</h3>')
          .replace(/^## (.+)$/gm, '<h2>$1</h2>')
          .replace(/^# (.+)$/gm, '<h1>$1</h1>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.+?)\*/g, '<em>$1</em>')
          .replace(/`(.+?)`/g, '<code>$1</code>')
          .replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>')
          .replace(/(<li>.+<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
          .replace(/\n\n/g, '</p><p>')
          .replace(/^(?!<)/gm, m => m);
        const page = `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>${args.title || path.basename(output)}</title>
<style>body{max-width:720px;margin:40px auto;font:15px/1.7 system-ui,sans-serif;color:#222}
h1,h2,h3{margin:1.2em 0 .4em} code{background:#f4f4f4;padding:2px 6px;border-radius:3px}
ul{padding-left:1.4em} a{color:#09f} blockquote{border-left:4px solid #ddd;margin:0;padding-left:1em;color:#666}
table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:6px 10px}</style>
</head><body><div>${html}</div></body></html>`;
        fs.writeFileSync(output, page, 'utf8');
        return `✅ 已生成 HTML: ${path.relative(cwd, output)}`;
      },
    },

    // ── 文本批量处理 ──
    {
      name: 'batch_text',
      description: '批量文本处理:对文件的每一行或全文执行正则替换、去重、排序、编码转换等操作。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '输入文件路径' },
          output: { type: 'string', description: '输出文件路径(可选, 不填则返回预览)' },
          action: { type: 'string', description: '操作类型: replace / dedup / sort / sort_desc / trim / uppercase / lowercase / encode_utf8 / encode_gbk' },
          pattern: { type: 'string', description: '正则表达式(action=replace 时必填)' },
          replacement: { type: 'string', description: '替换文本(action=replace 时必填)' },
          per_line: { type: 'boolean', description: '是否逐行操作(默认 true)' },
        },
        required: ['input', 'action'],
      },
      readOnly: false,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const fp = path.resolve(cwd, args.input);
        if (!fs.existsSync(fp)) return `❌ 文件不存在: ${args.input}`;
        let text = fs.readFileSync(fp, 'utf8');
        const action = args.action;
        let lines = args.per_line !== false ? text.split('\n') : [text];
        const isWin = process.platform === 'win32';
        switch (action) {
          case 'replace': {
            if (!args.pattern) return '❌ action=replace 需要 pattern 参数';
            const re = new RegExp(args.pattern, 'g');
            lines = lines.map(l => l.replace(re, args.replacement ?? ''));
            break;
          }
          case 'dedup': {
            const seen = new Set(); lines = lines.filter(l => { const k = l.trim(); if (seen.has(k)) return false; seen.add(k); return true; });
            break;
          }
          case 'sort': lines.sort((a, b) => a.localeCompare(b)); break;
          case 'sort_desc': lines.sort((a, b) => b.localeCompare(a)); break;
          case 'trim': lines = lines.map(l => l.trim()); break;
          case 'uppercase': lines = lines.map(l => l.toUpperCase()); break;
          case 'lowercase': lines = lines.map(l => l.toLowerCase()); break;
          case 'encode_utf8': /* 已是 utf8, 仅保存 */ break;
          case 'encode_gbk': {
            if (isWin) {
              // Windows 上用 PowerShell 转码
              const out = args.output || fp + '.gbk';
              const ps = `$c=[System.Text.Encoding]::GetEncoding('gbk');[System.IO.File]::WriteAllBytes('${psQuote(out)}',$c.GetBytes([System.IO.File]::ReadAllText('${psQuote(fp)}','UTF-8')))`;
              await execAsync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, cwd);
              return `✅ 已转码为 GBK: ${path.relative(cwd, out)}`;
            }
            return '❌ GBK 编码转换仅支持 Windows';
          }
          default: return `❌ 未知 action: ${action}`;
        }
        const result = lines.join('\n');
        if (args.output) {
          fs.writeFileSync(path.resolve(cwd, args.output), result, 'utf8');
          return `✅ 处理完成, 已写入 ${args.output}`;
        }
        const preview = result.split('\n').slice(0, 30).join('\n');
        return `处理结果预览(前 30 行):\n\n${preview}`;
      },
    },

    // ── 文件批量重命名 ──
    {
      name: 'batch_rename',
      description: '批量重命名目录下的文件。支持模板({index}序号/{date}日期/{ext}扩展名/{name}原名)和正则替换。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '目标目录' },
          pattern: { type: 'string', description: '文件名 glob 筛选(如 *.jpg / *.docx), 默认 *' },
          template: { type: 'string', description: '重命名模板, 变量: {index}(序号, 可 {index:3} 补零), {date}, {name}(原名无扩展名), {ext}(扩展名)' },
          regex: { type: 'string', description: '正则替换模式(可选, 和 template 二选一)' },
          replacement: { type: 'string', description: '正则替换文本(配合 regex)' },
          dry_run: { type: 'boolean', description: '预览模式, 不实际改名(默认 true)' },
        },
        required: ['dir'],
      },
      readOnly: false,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const dir = path.resolve(cwd, args.dir);
        if (!fs.existsSync(dir)) return `❌ 目录不存在: ${args.dir}`;
        const glob = args.pattern || '*';
        const regex = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        const re = new RegExp(`^${regex}$`);
        const files = fs.readdirSync(dir).filter(f => {
          const ent = fs.statSync(path.join(dir, f));
          return ent.isFile() && re.test(f);
        });
        if (!files.length) return `❌ 没有匹配的文件: ${glob}`;
        const dry = args.dry_run !== false;
        const results = [];
        files.forEach((f, i) => {
          const ext = path.extname(f);
          const base = path.basename(f, ext);
          let newName;
          if (args.template) {
            const idx = String(i + 1);
            const padMatch = args.template.match(/\{index:(\d+)\}/);
            const padded = padMatch ? idx.padStart(Number(padMatch[1]), '0') : idx;
            newName = args.template
              .replace(/\{index:\d+\}/g, padded)
              .replace(/\{index\}/g, idx)
              .replace(/\{date\}/g, new Date().toISOString().slice(0, 10))
              .replace(/\{name\}/g, base)
              .replace(/\{ext\}/g, ext);
          } else if (args.regex) {
            newName = f.replace(new RegExp(args.regex, 'g'), args.replacement ?? '');
            if (newName === f) { results.push(`  ⏭ ${f} → (无变化)`); return; }
          } else {
            results.push(`  ⏭ ${f} → (无规则)`);
            return;
          }
          const oldPath = path.join(dir, f);
          const newPath = path.join(dir, newName);
          if (!dry && oldPath !== newPath) {
            try { fs.renameSync(oldPath, newPath); } catch (e) { results.push(`  ❌ ${f} → ${newName} (失败: ${e.message})`); return; }
          }
          results.push(`  ${dry ? '🔍' : '✅'} ${f} → ${newName}`);
        });
        return `${dry ? '预览模式(未实际改名)' : '重命名完成'} — ${files.length} 个文件:\n${results.join('\n')}`;
      },
    },

    // ══════════════════════════════════════════════════════
    // 第二档: 需命令行工具 (pandoc / python3 / tesseract / pdftotext)
    // ══════════════════════════════════════════════════════

    // ── Word 文档 ──
    {
      name: 'create_doc',
      description: '创建 Word 文档(.docx)。用 pandoc 把 Markdown 转 docx。需安装 pandoc。',
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
        const tmp = tmpFile('.md', cwd, (args.title ? `# ${args.title}\n\n` : '') + String(args.content));
        const out = await execAsync(`pandoc "${tmp}" -o "${path.resolve(cwd, args.output)}"`, cwd, 120000);
        try { fs.unlinkSync(tmp); } catch (_) { /* noop */ }
        return out.startsWith('❌')
          ? `${out}\n💡 提示: 安装 pandoc — Windows: winget install pandoc`
          : `✅ 已创建文档: ${args.output}`;
      },
    },

    {
      name: 'read_doc',
      description: '读取 Word/PDF/EPUB/HTML/RTF 文档内容, 转为纯文本或 Markdown。利用 pandoc 解析。需安装 pandoc。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '输入文件路径(.docx/.pdf/.epub/.html/.rtf)' },
          format: { type: 'string', description: '输出格式: plain / markdown(默认 markdown)' },
        },
        required: ['input'],
      },
      readOnly: true,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const fp = path.resolve(cwd, args.input);
        if (!fs.existsSync(fp)) return `❌ 文件不存在: ${args.input}`;
        const fmt = args.format === 'plain' ? 'plain' : 'markdown';
        const out = await execAsync(`pandoc "${fp}" -t ${fmt}`, cwd, 60000);
        return out.startsWith('❌')
          ? `${out}\n💡 提示: 安装 pandoc — Windows: winget install pandoc`
          : out.slice(0, 50000); // 截断超长文档
      },
    },

    // ── Excel ──
    {
      name: 'excel_read',
      description: '读取 Excel 文件(.xlsx), 返回指定 sheet 的数据为 Markdown 表格(前 50 行)。需要 python3 + openpyxl。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Excel 文件路径' },
          sheet: { type: 'string', description: '工作表名(可选, 默认第一个)' },
          max_rows: { type: 'number', description: '最大返回行数(默认 50)' },
        },
        required: ['input'],
      },
      readOnly: true,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const fp = path.resolve(cwd, args.input);
        if (!fs.existsSync(fp)) return `❌ 文件不存在: ${args.input}`;
        const maxR = args.max_rows || 50;
        const py = [
          'import openpyxl, json, sys',
          `wb = openpyxl.load_workbook("${fp.replace(/"/g, '\\"')}", read_only=True)`,
          `ws = wb["${String(args.sheet || '').replace(/"/g, '\\"')}"] if "${String(args.sheet || '').replace(/"/g, '\\"')}" else wb.active`,
          `rows = list(ws.iter_rows(values_only=True, max_row=${maxR + 1}))`,
          'sheets = wb.sheetnames',
          'data = [[str(c) if c is not None else "" for c in r] for r in rows]',
          'print(json.dumps({"sheet": ws.title, "sheets": sheets, "rows": data}))',
        ].join('\n');
        const raw = await execAsync(`python3 -c '${py.replace(/'/g, "'\\''")}'`, cwd);
        if (raw.startsWith('❌')) return `${raw}\n💡 提示: 需安装 python3 + pip install openpyxl`;
        try {
          const obj = JSON.parse(raw.trim().split('\n').pop());
          const rows = obj.rows;
          if (!rows.length) return `⚠ 工作表 "${obj.sheet}" 为空`;
          const sheetInfo = obj.sheets.length > 1 ? `工作表: ${obj.sheets.join(', ')} (当前: ${obj.sheet})\n\n` : '';
          const md = [
            `| ${rows[0].join(' | ')} |`,
            `| ${rows[0].map(() => '---').join(' | ')} |`,
            ...rows.slice(1).map(r => `| ${r.join(' | ')} |`),
          ];
          return `${sheetInfo}${md.join('\n')}`;
        } catch (e) {
          return `❌ 解析失败: ${e.message}`;
        }
      },
    },

    {
      name: 'excel_write',
      description: '创建/写入 Excel 文件(.xlsx)。支持多 sheet、标题行样式、列宽自适应。需要 python3 + openpyxl。',
      parameters: {
        type: 'object',
        properties: {
          output: { type: 'string', description: '输出 Excel 文件路径' },
          sheet_name: { type: 'string', description: '工作表名(可选, 默认 Sheet1)' },
          data: { type: 'array', description: '二维数组, 第一行为表头', items: { type: 'array', items: { type: 'string' } } },
          freeze_header: { type: 'boolean', description: '是否冻结首行(默认 true)' },
        },
        required: ['output', 'data'],
      },
      readOnly: false,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const out = path.resolve(cwd, args.output);
        // 把 data 写临时 JSON, 避免命令行过长
        const tmpJson = tmpFile('.json', cwd, JSON.stringify(args.data));
        const py = [
          'import openpyxl, json, sys',
          `with open("${tmpJson.replace(/"/g, '\\"')}") as f: data = json.load(f)`,
          `wb = openpyxl.Workbook()`,
          `ws = wb.active`,
          `ws.title = "${String(args.sheet_name || 'Sheet1').replace(/"/g, '\\"')}"`,
          'for r in data:',
          '    ws.append(r)',
          // 标题行加粗
          'if data:',
          '    from openpyxl.styles import Font',
          '    for c in ws[1]: c.font = Font(bold=True)',
          // 列宽自适应
          '    for col in ws.columns:',
          '        maxlen = max(len(str(c.value or "")) for c in col)',
          '        ws.column_dimensions[col[0].column_letter].width = min(maxlen + 4, 50)',
          // 冻结首行
          `${args.freeze_header !== false ? 'ws.freeze_panes = "A2"' : 'pass'}`,
          `wb.save("${out.replace(/"/g, '\\"')}")`,
          'print("done")',
        ].join('\n');
        const result = await execAsync(`python3 -c '${py.replace(/'/g, "'\\''")}'`, cwd);
        try { fs.unlinkSync(tmpJson); } catch (_) { /* noop */ }
        return result.startsWith('❌')
          ? `${result}\n💡 提示: 需安装 python3 + pip install openpyxl`
          : `✅ 已创建 Excel: ${args.output} (${args.data.length - 1} 行数据)`;
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
          'import openpyxl, csv',
          `wb = openpyxl.load_workbook("${String(args.input).replace(/"/g, '\\"')}")`,
          `ws = wb["${String(args.sheet || '').replace(/"/g, '\\"')}"] if "${String(args.sheet || '').replace(/"/g, '\\"')}" else wb.active`,
          `with open("${String(args.output).replace(/"/g, '\\"')}", "w", newline="", encoding="utf-8-sig") as f:`,
          '    csv.writer(f).writerows(ws.iter_rows(values_only=True))',
          'print("done")',
        ].join('\n');
        const result = await execAsync(`python3 -c '${py.replace(/'/g, "'\\''")}'`, cwd);
        return result.startsWith('❌')
          ? `${result}\n💡 提示: 需安装 python3 + pip install openpyxl`
          : `✅ 已导出 CSV: ${args.output}`;
      },
    },

    // ── PDF ──
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
        const fp = path.resolve(cwd, args.input);
        if (!fs.existsSync(fp)) return `❌ 文件不存在: ${args.input}`;
        const pageFlag = args.pages ? ` -f ${args.pages}` : '';
        const out = await execAsync(`pdftotext${pageFlag} "${fp}" -`, cwd);
        return out.startsWith('❌')
          ? `${out}\n💡 提示: 安装 poppler — Windows: winget install poppler`
          : out.slice(0, 50000);
      },
    },

    {
      name: 'create_pdf',
      description: '从 Markdown 创建 PDF 文档。利用 pandoc(需 LaTeX) 或 wkhtmltopdf。需安装 wkhtmltopdf 或 pandoc+tectonic。',
      parameters: {
        type: 'object',
        properties: {
          output: { type: 'string', description: '输出 PDF 路径' },
          content: { type: 'string', description: '内容(Markdown)' },
          title: { type: 'string', description: '标题(可选)' },
        },
        required: ['output', 'content'],
      },
      readOnly: false,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const tmpMd = tmpFile('.md', cwd, (args.title ? `# ${args.title}\n\n` : '') + String(args.content));
        const outPdf = path.resolve(cwd, args.output);
        // 先试 pandoc, 失败则试 wkhtmltopdf
        let result = await execAsync(`pandoc "${tmpMd}" -o "${outPdf}"`, cwd, 120000);
        if (result.startsWith('❌')) {
          // fallback: 先转 HTML 再用 wkhtmltopdf
          const tmpHtml = tmpMd.replace(/\.md$/, '.html');
          await execAsync(`pandoc "${tmpMd}" -o "${tmpHtml}"`, cwd, 30000);
          result = await execAsync(`wkhtmltopdf "${tmpHtml}" "${outPdf}"`, cwd, 120000);
          try { fs.unlinkSync(tmpHtml); } catch (_) { /* noop */ }
        }
        try { fs.unlinkSync(tmpMd); } catch (_) { /* noop */ }
        return result.startsWith('❌')
          ? `${result}\n💡 提示: 需要 pandoc+LaTeX 或 wkhtmltopdf`
          : `✅ 已创建 PDF: ${args.output}`;
      },
    },

    // ── OCR ──
    {
      name: 'ocr_image',
      description: '对图片执行 OCR 文字识别, 返回识别到的文本。支持中文+英文。需要 tesseract。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '图片文件路径(.png/.jpg/.tiff/.bmp)' },
          lang: { type: 'string', description: '识别语言(默认 chi_sim+eng, 可选 eng / chi_sim / chi_tra+eng / jpn+eng)' },
        },
        required: ['input'],
      },
      readOnly: true,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const fp = path.resolve(cwd, args.input);
        if (!fs.existsSync(fp)) return `❌ 文件不存在: ${args.input}`;
        const lang = args.lang || 'chi_sim+eng';
        const out = await execAsync(`tesseract "${fp}" stdout -l ${lang}`, cwd, 120000);
        return out.startsWith('❌')
          ? `${out}\n💡 提示: 安装 tesseract — Windows: winget install tesseract-ocr`
          : out.trim() || '⚠ 未识别到文字';
      },
    },

    // ══════════════════════════════════════════════════════
    // 第三档: Windows COM 自动化 (需安装 Office, 仅 Windows)
    // ══════════════════════════════════════════════════════

    {
      name: 'outlook_send_mail',
      description: '通过 Outlook 发送邮件(Windows + Outlook)。利用 PowerShell COM 自动化。需安装 Outlook。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收件人邮箱(多个用分号分隔)' },
          cc: { type: 'string', description: '抄送(可选)' },
          subject: { type: 'string', description: '邮件主题' },
          body: { type: 'string', description: '邮件正文' },
          html: { type: 'boolean', description: '正文是否为 HTML 格式(默认 false)' },
          attachment: { type: 'string', description: '附件路径(可选, 多个用分号)' },
        },
        required: ['to', 'subject', 'body'],
      },
      readOnly: false,
      async run(args, ctx) {
        if (process.platform !== 'win32') return '❌ Outlook COM 自动化仅支持 Windows';
        const ps = [
          `$o = New-Object -ComObject Outlook.Application`,
          `$m = $o.CreateItem(0)`,
          `$m.To = '${psQuote(args.to)}'`,
          args.cc ? `$m.CC = '${psQuote(args.cc)}'` : '',
          `$m.Subject = '${psQuote(args.subject)}'`,
          args.html ? `$m.HTMLBody = '${psQuote(args.body)}'` : `$m.Body = '${psQuote(args.body)}'`,
          args.attachment ? args.attachment.split(';').map(a => `$m.Attachments.Add('${psQuote(a.trim())}')`).join('\n') : '',
          `$m.Send()`,
          `Write-Output 'sent'`,
        ].filter(Boolean).join('\n');
        const result = await execAsync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, ctx?.cwd ?? process.cwd(), 30000);
        return result.includes('sent')
          ? `✅ 邮件已发送: ${args.to}`
          : `❌ 发送失败: ${result}\n💡 请确认 Outlook 已安装并登录`;
      },
    },

    {
      name: 'outlook_list_mail',
      description: '读取 Outlook 收件箱的最近邮件列表(Windows + Outlook)。利用 PowerShell COM 自动化。',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: '文件夹名(默认 Inbox, 可选 Sent Items / Drafts 等)' },
          count: { type: 'number', description: '读取封数(默认 10, 最大 50)' },
          unread_only: { type: 'boolean', description: '仅未读(默认 false)' },
        },
      },
      readOnly: true,
      async run(args, ctx) {
        if (process.platform !== 'win32') return '❌ Outlook COM 自动化仅支持 Windows';
        const count = Math.min(args.count || 10, 50);
        const ps = [
          `$o = New-Object -ComObject Outlook.Application`,
          `$ns = $o.GetNamespace('MAPI')`,
          `$folder = $ns.GetDefaultFolder([Microsoft.Office.Interop.Outlook.OlDefaultFolders]::olFolderInbox)`,
          // folder 参数不支持运行时切换枚举值, 用名称查找
          args.folder && args.folder !== 'Inbox' ? `$folder = $ns.Folders.Item(1).Folders.Item('${psQuote(args.folder)}')` : '',
          `$items = $folder.Items`,
          args.unread_only ? `$items = $items.Restrict("[Unread]=true")` : '',
          `$items.Sort("[ReceivedTime]", $true)`,
          `$items = $items.GetLast()`, // fallback
          // 用循环拿
          `$result = @()`,
          `$count = ${count}`,
          `for ($i = 1; $i -le $count; $i++) {`,
          `  try { $item = $folder.Items.Item($i) } catch { break }`,
          `  if (-not $item) { break }`,
          `  $result += "$($i). [$($item.ReceivedTime)] $($item.Subject) — from: $($item.SenderName)"`,
          `}`,
          `$result -join "`n"`,
        ].filter(Boolean).join('\n');
        const result = await execAsync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, ctx?.cwd ?? process.cwd(), 30000);
        return result.startsWith('❌') || result.trim() === ''
          ? `❌ 读取失败或无邮件\n💡 请确认 Outlook 已安装并打开`
          : `📬 收件箱 (最近 ${count} 封):\n\n${result}`;
      },
    },

    {
      name: 'excel_com',
      description: 'Excel 高级操作(Windows + Office):打开/修改 .xlsx, 支持公式、条件格式、VBA 宏。通过 PowerShell COM。需安装 Excel。',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Excel 文件路径' },
          action: { type: 'string', description: '操作: set_formula / set_cell / run_macro / add_chart / get_formula / list_sheets' },
          sheet: { type: 'string', description: '工作表名(可选)' },
          cell: { type: 'string', description: '目标单元格(如 A1, B2:C10)' },
          value: { type: 'string', description: '值或公式(action=set_*时必填, 公式以=开头)' },
          macro: { type: 'string', description: 'VBA 宏名(action=run_macro时必填)' },
          chart_type: { type: 'string', description: '图表类型(action=add_chart时: bar / line / pie)' },
        },
        required: ['file', 'action'],
      },
      readOnly: false,
      async run(args, ctx) {
        if (process.platform !== 'win32') return '❌ Excel COM 自动化仅支持 Windows';
        const fp = path.resolve(ctx?.cwd ?? process.cwd(), args.file);
        if (!fs.existsSync(fp)) return `❌ 文件不存在: ${args.file}`;
        // 构建 PowerShell 脚本
        let psBody = '';
        switch (args.action) {
          case 'list_sheets':
            psBody = [
              `$wb = $xl.Workbooks.Open('${psQuote(fp)}')`,
              `($wb.Sheets | ForEach-Object { $_.Name }) -join ', '`,
              `$wb.Close($false)`,
            ].join('\n');
            break;
          case 'set_cell':
            if (!args.cell || args.value === undefined) return '❌ set_cell 需要 cell 和 value';
            psBody = [
              `$wb = $xl.Workbooks.Open('${psQuote(fp)}')`,
              args.sheet ? `$ws = $wb.Sheets.Item('${psQuote(args.sheet)}')` : `$ws = $wb.ActiveSheet`,
              `$ws.Range('${psQuote(args.cell)}').Value = '${psQuote(String(args.value))}'`,
              `$wb.Save()`,
              `$wb.Close()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          case 'set_formula':
            if (!args.cell || !args.value) return '❌ set_formula 需要 cell 和 value(公式)';
            psBody = [
              `$wb = $xl.Workbooks.Open('${psQuote(fp)}')`,
              args.sheet ? `$ws = $wb.Sheets.Item('${psQuote(args.sheet)}')` : `$ws = $wb.ActiveSheet`,
              `$ws.Range('${psQuote(args.cell)}').Formula = '${psQuote(args.value)}'`,
              `$wb.Save()`,
              `$wb.Close()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          case 'get_formula':
            if (!args.cell) return '❌ get_formula 需要 cell';
            psBody = [
              `$wb = $xl.Workbooks.Open('${psQuote(fp)}')`,
              args.sheet ? `$ws = $wb.Sheets.Item('${psQuote(args.sheet)}')` : `$ws = $wb.ActiveSheet`,
              `$r = $ws.Range('${psQuote(args.cell)}')`,
              `Write-Output "$($r.Address): formula=$($r.Formula) value=$($r.Value)"`,
              `$wb.Close($false)`,
            ].join('\n');
            break;
          case 'run_macro':
            if (!args.macro) return '❌ run_macro 需要 macro 名';
            psBody = [
              `$wb = $xl.Workbooks.Open('${psQuote(fp)}')`,
              `$xl.Run('${psQuote(args.macro)}')`,
              `$wb.Save()`,
              `$wb.Close()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          case 'add_chart':
            if (!args.cell) return '❌ add_chart 需要 cell(数据范围)';
            const chartConst = { bar: 'xlColumnClustered', line: 'xlLine', pie: 'xlPie' }[args.chart_type || 'bar'] || 'xlColumnClustered';
            psBody = [
              `$wb = $xl.Workbooks.Open('${psQuote(fp)}')`,
              args.sheet ? `$ws = $wb.Sheets.Item('${psQuote(args.sheet)}')` : `$ws = $wb.ActiveSheet`,
              `$range = $ws.Range('${psQuote(args.cell)}')`,
              `$chart = $ws.ChartObjects().Add(100, 50, 400, 300)`,
              `$chart.Chart.SetSourceData($range)`,
              `$chart.Chart.ChartType = [Microsoft.Office.Interop.Excel.XlChartType]::${chartConst}`,
              `$wb.Save()`,
              `$wb.Close()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          default:
            return `❌ 未知 action: ${args.action}`;
        }
        const ps = [
          `$xl = New-Object -ComObject Excel.Application`,
          `$xl.Visible = $false`,
          `$xl.DisplayAlerts = $false`,
          psBody,
          `$xl.Quit()`,
          `[System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null`,
        ].join('\n');
        const result = await execAsync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, ctx?.cwd ?? process.cwd(), 60000);
        return result.startsWith('❌')
          ? `${result}\n💡 请确认 Excel 已安装`
          : result.includes('done') ? `✅ 操作完成: ${args.action}` : result;
      },
    },

    {
      name: 'word_com',
      description: 'Word 高级操作(Windows + Office):打开/修改 .docx, 支持查找替换、插入目录、修订追踪。通过 PowerShell COM。需安装 Word。',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Word 文件路径' },
          action: { type: 'string', description: '操作: find_replace / add_toc / track_changes / accept_changes / get_page_count / export_pdf' },
          find: { type: 'string', description: '查找文本(action=find_replace时)' },
          replace: { type: 'string', description: '替换文本(action=find_replace时)' },
          output: { type: 'string', description: '导出路径(action=export_pdf时)' },
        },
        required: ['file', 'action'],
      },
      readOnly: false,
      async run(args, ctx) {
        if (process.platform !== 'win32') return '❌ Word COM 自动化仅支持 Windows';
        const fp = path.resolve(ctx?.cwd ?? process.cwd(), args.file);
        if (!fs.existsSync(fp)) return `❌ 文件不存在: ${args.file}`;
        let psBody = '';
        switch (args.action) {
          case 'find_replace':
            if (!args.find) return '❌ find_replace 需要 find 和 replace';
            psBody = [
              `$wd = New-Object -ComObject Word.Application`,
              `$wd.Visible = $false`,
              `$doc = $wd.Documents.Open('${psQuote(fp)}')`,
              `$find = $doc.Content.Find`,
              `$find.ClearFormatting()`,
              `$find.Replacement.ClearFormatting()`,
              `$find.Execute('${psQuote(args.find)}', $false, $false, $false, $false, $false, $true, 1, $false, '${psQuote(args.replace || '')}', 2)`,
              `$doc.Save()`,
              `$doc.Close()`,
              `$wd.Quit()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          case 'add_toc':
            psBody = [
              `$wd = New-Object -ComObject Word.Application`,
              `$wd.Visible = $false`,
              `$doc = $wd.Documents.Open('${psQuote(fp)}')`,
              `$range = $doc.Content`,
              `$range.Collapse(0)`,
              `$doc.TablesOfContents.Add($range, $true)`,
              `$doc.TablesOfContents.Item(1).Update()`,
              `$doc.Save()`,
              `$doc.Close()`,
              `$wd.Quit()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          case 'track_changes':
            psBody = [
              `$wd = New-Object -ComObject Word.Application`,
              `$wd.Visible = $false`,
              `$doc = $wd.Documents.Open('${psQuote(fp)}')`,
              `$doc.TrackRevisions = $true`,
              `$doc.Save()`,
              `$doc.Close()`,
              `$wd.Quit()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          case 'accept_changes':
            psBody = [
              `$wd = New-Object -ComObject Word.Application`,
              `$wd.Visible = $false`,
              `$doc = $wd.Documents.Open('${psQuote(fp)}')`,
              `$doc.AcceptAllRevisions()`,
              `$doc.Save()`,
              `$doc.Close()`,
              `$wd.Quit()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          case 'get_page_count':
            psBody = [
              `$wd = New-Object -ComObject Word.Application`,
              `$wd.Visible = $false`,
              `$doc = $wd.Documents.Open('${psQuote(fp)}')`,
              `$doc.Repaginate()`,
              `Write-Output $doc.ComputeStatistics(2)`,
              `$doc.Close($false)`,
              `$wd.Quit()`,
            ].join('\n');
            break;
          case 'export_pdf':
            psBody = [
              `$wd = New-Object -ComObject Word.Application`,
              `$wd.Visible = $false`,
              `$doc = $wd.Documents.Open('${psQuote(fp)}')`,
              `$doc.SaveAs('${psQuote(path.resolve(ctx?.cwd ?? process.cwd(), args.output || fp.replace(/\.docx?$/i, '.pdf')))}', 17)`,
              `$doc.Close()`,
              `$wd.Quit()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          default:
            return `❌ 未知 action: ${args.action}`;
        }
        const result = await execAsync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, ctx?.cwd ?? process.cwd(), 60000);
        return result.startsWith('❌')
          ? `${result}\n💡 请确认 Word 已安装`
          : result.includes('done') ? `✅ 操作完成: ${args.action}` : (args.action === 'get_page_count' ? `📄 页数: ${result.trim()}` : result);
      },
    },
  ],
};
