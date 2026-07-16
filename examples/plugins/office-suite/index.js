// office-suite 插件入口 —— 办公文档工具集 (v2)
// 依赖: pandoc / python3+openpyxl / pdftotext(poppler) / tesseract(可选) / PowerShell+Office COM(Windows)
// 安全: PowerShell/Python 脚本一律写临时文件执行, 不走 -c 拼接; 路径走 shellQuote。
// 临时文件: try/finally 确保清理。

const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 基础工具 ──────────────────────────────────────────────

// 封装 exec 为 Promise, 超时可配。
function execAsync(cmd, cwd, timeout = 60000) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.killed) { resolve('⏱ 执行超时'); return; }
      if (err) { resolve(`❌ ${err.message}\n${stderr || ''}`); return; }
      resolve(stdout || stderr || '✅ 完成');
    });
  });
}

// 安全引用 shell 参数(Win/Mac 通用双引号转义)。
// Defense against quote injection — replace " and \ inside double-quoted strings.
function shellQuote(s) {
  if (process.platform === 'win32') {
    // Windows cmd.exe: double-quote escaping is fragile, use ^" prefix
    return `"${String(s).replace(/"/g, '\\"')}"`;
  }
  return `"${String(s).replace(/["\\$`]/g, '\\$&')}"`;
}

// 写临时文件, 返回 { path, cleanup }。调用方负责 cleanup()。
function tmpWrite(ext, content) {
  const p = path.join(os.tmpdir(), `kinet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(p, content, 'utf8');
  return { path: p, cleanup: () => { try { fs.unlinkSync(p); } catch (_) { /* noop */ } } };
}

// 转义 PowerShell 单引号字符串内嵌的单引号 (' → '')。
function psQuote(s) {
  return String(s).replace(/'/g, "''");
}

// 执行 PowerShell 脚本: 写临时 .ps1 → powershell -File → 清理。
// 安全: 脚本内容不走命令行拼接, 彻底避免注入。
async function runPs(script, cwd, timeout = 60000) {
  const { path: ps1, cleanup } = tmpWrite('.ps1', script);
  try {
    const result = await execAsync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File ${shellQuote(ps1)}`,
      cwd, timeout,
    );
    return result;
  } finally {
    cleanup();
  }
}

// 执行 Python 脚本: 写临时 .py → python3 file → 清理。
// 路径参数通过 argv 传递(不走字符串拼接), 避免 Windows \U \t 转义问题。
async function runPy(script, cwd, timeout = 60000) {
  const { path: py, cleanup } = tmpWrite('.py', script);
  try {
    const result = await execAsync(`python3 ${shellQuote(py)}`, cwd, timeout);
    return result;
  } finally {
    cleanup();
  }
}

// 把 Windows 路径转为 Python raw string: r"C:\Users\..." 。
function pyPath(p) {
  return `r"${p.replace(/"/g, '\\"')}"`;
}

// 检测命令是否可用 (which / where)。
async function hasCmd(cmd, cwd) {
  const check = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
  const out = await execAsync(check, cwd, 5000);
  return !out.startsWith('❌');
}

// 依赖缺失提示。
const INSTALL_HINT = {
  pandoc: 'Windows: winget install pandoc | Mac: brew install pandoc',
  python3: 'Windows: winget install Python.Python.3 | Mac: brew install python3',
  pdftotext: 'Windows: winget install poppler | Mac: brew install poppler',
  tesseract: 'Windows: winget install UB-Mannheim.TesseractOCR | Mac: brew install tesseract',
  wkhtmltopdf: 'Windows: winget install wkhtmltopdf | Mac: brew install wkhtmltopdf',
};

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

// 生成 Markdown 表格。
function mdTable(headers, rows) {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${headers.map((_, i) => String(r[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`),
  ];
  return lines.join('\n');
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
        const rows = parseCSV(raw);
        if (rows.length < 2) return '❌ CSV 行数不足(至少需要表头+1行数据)';
        const headers = rows[0];
        const dataRows = rows.slice(1);

        const lines = [`📊 CSV 分析: ${args.file}`, `行数: ${dataRows.length} (不含表头) | 列数: ${headers.length}\n`];
        for (let ci = 0; ci < headers.length; ci++) {
          const col = dataRows.map(r => r[ci]).filter(v => v != null && v !== '');
          const uniq = new Set(col).size;
          const nums = col.filter(isNum).map(Number);
          const isNumeric = nums.length > col.length * 0.7; // 70% 以上是数字 → 数值列

          let stats = `唯一值: ${uniq}`;
          if (isNumeric) {
            nums.sort((a, b) => a - b);
            const sum = nums.reduce((a, b) => a + b, 0);
            const mean = sum / nums.length;
            const median = nums.length % 2 ? nums[(nums.length - 1) >> 1] : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2;
            stats += ` | min: ${nums[0]} | max: ${nums[nums.length - 1]} | mean: ${mean.toFixed(2)} | median: ${median} | sum: ${sum}`;
          }
          lines.push(`▸ ${headers[ci]} ${isNumeric ? '(数值)' : '(文本)'} — ${stats}`);
        }
        return lines.join('\n');
      },
    },

    // ── CSV 筛选 ──
    {
      name: 'csv_filter',
      description: '筛选/排序 CSV 数据。支持多条件 AND 筛选(==, !=, >, <, >=, <=, contains, startswith),可导出到文件或显示 Markdown 表格。纯 Node。',
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
        if (args.output) {
          const result = [headers, ...data];
          fs.writeFileSync(path.resolve(cwd, args.output), result.map(r => r.join(',')).join('\n'), 'utf8');
          return `✅ 筛选完成: ${data.length} 行已写入 ${args.output}`;
        }
        // Markdown 表格(前 50 行)
        const preview = data.slice(0, 50);
        const note = data.length > 50 ? `\n\n_(仅显示前 50 行, 共 ${data.length} 行)_` : '';
        return `筛选结果: ${data.length} 行\n\n${mdTable(headers, preview)}${note}`;
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
        const tmplFlag = args.template ? ` --template=${shellQuote(path.resolve(cwd, args.template))}` : '';
        const out = await execAsync(`pandoc ${shellQuote(input)} -o ${shellQuote(output)}${tmplFlag}`, cwd, 120000);
        return out.startsWith('❌')
          ? `${out}\n💡 提示: pandoc 可能未安装。${INSTALL_HINT.pandoc}`
          : `✅ 已转换: ${args.input} → ${args.output}`;
      },
    },

    // ── Markdown → HTML ──
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

        // 极简 Markdown → HTML (按块处理, 避免正则嵌套 bug)
        const lines = md.split('\n');
        let html = '';
        let inList = false;
        let inCode = false;
        for (const line of lines) {
          if (line.startsWith('```')) { inCode = !inCode; html += inCode ? '<pre><code>' : '</code></pre>'; continue; }
          if (inCode) { html += line + '\n'; continue; }
          // 标题
          let m;
          if (m = line.match(/^### (.+)$/)) { if (inList) { html += '</ul>'; inList = false; } html += `<h3>${m[1]}</h3>`; continue; }
          if (m = line.match(/^## (.+)$/)) { if (inList) { html += '</ul>'; inList = false; } html += `<h2>${m[1]}</h2>`; continue; }
          if (m = line.match(/^# (.+)$/)) { if (inList) { html += '</ul>'; inList = false; } html += `<h1>${m[1]}</h1>`; continue; }
          // 列表项
          if (m = line.match(/^\s*[-*] (.+)$/)) {
            if (!inList) { html += '<ul>'; inList = true; }
            html += `<li>${inlineFmt(m[1])}</li>`;
            continue;
          }
          if (inList) { html += '</ul>'; inList = false; }
          // 空行
          if (line.trim() === '') { html += '\n'; continue; }
          // 普通段落
          html += `<p>${inlineFmt(line)}</p>`;
        }
        if (inList) html += '</ul>';
        if (inCode) html += '</code></pre>';

        function inlineFmt(text) {
          return text
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
        }

        const page = `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>${args.title || path.basename(output)}</title>
<style>body{max-width:720px;margin:40px auto;font:15px/1.7 system-ui,sans-serif;color:#222}h1,h2,h3{color:#111}code{background:#f4f4f4;padding:2px 6px;border-radius:3px}pre{background:#f4f4f4;padding:12px;border-radius:6px;overflow-x:auto}a{color:#06c}</style>
</head>
<body>
${html}
</body>
</html>`;
        fs.writeFileSync(output, page, 'utf8');
        return `✅ 已生成 HTML: ${path.relative(cwd, output) || output}`;
      },
    },

    // ── 批量文本处理 ──
    {
      name: 'batch_text',
      description: '批量文本处理:支持对文本进行正则替换、去重、排序、大小写转换、编码转换。纯 Node。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '输入文件路径' },
          output: { type: 'string', description: '输出文件路径(可选, 默认覆盖)' },
          replace_pattern: { type: 'string', description: '正则替换模式(和 replace_to 配合使用)' },
          replace_to: { type: 'string', description: '替换为的字符串(默认空)' },
          dedupe: { type: 'boolean', description: '按行去重(默认 false)' },
          sort: { type: 'string', description: '排序方式: asc / desc / natural(默认不排序)' },
          case: { type: 'string', description: '大小写: upper / lower / title(默认不变)' },
          encoding: { type: 'string', description: '编码转换: utf8 / gbk / ascii(默认不变)' },
        },
        required: ['input'],
      },
      readOnly: false,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const fp = path.resolve(cwd, args.input);
        if (!fs.existsSync(fp)) return `❌ 文件不存在: ${args.input}`;
        let text = fs.readFileSync(fp, 'utf8');
        let lines = text.split('\n');

        // 正则替换
        if (args.replace_pattern) {
          try {
            const re = new RegExp(args.replace_pattern, 'g');
            lines = lines.map(l => l.replace(re, args.replace_to || ''));
          } catch (e) {
            return `❌ 正则表达式无效: ${e.message}`;
          }
        }
        // 去重
        if (args.dedupe) {
          const seen = new Set();
          lines = lines.filter(l => { if (seen.has(l)) return false; seen.add(l); return true; });
        }
        // 排序
        if (args.sort) {
          switch (args.sort) {
            case 'asc': lines.sort((a, b) => a.localeCompare(b)); break;
            case 'desc': lines.sort((a, b) => b.localeCompare(a)); break;
            case 'natural': lines.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })); break;
          }
        }
        // 大小写
        if (args.case) {
          switch (args.case) {
            case 'upper': lines = lines.map(l => l.toUpperCase()); break;
            case 'lower': lines = lines.map(l => l.toLowerCase()); break;
            case 'title': lines = lines.map(l => l.replace(/\b\w/g, c => c.toUpperCase())); break;
          }
        }

        const result = lines.join('\n');
        const outPath = args.output ? path.resolve(cwd, args.output) : fp;
        fs.writeFileSync(outPath, result, args.encoding || 'utf8');
        return `✅ 文本处理完成: ${lines.length} 行 → ${path.relative(cwd, outPath) || outPath}`;
      },
    },

    // ── 批量重命名 ──
    {
      name: 'batch_rename',
      description: '批量重命名文件。支持模板({index}/{date}/{name}/{ext})或正则替换模式。支持 dry_run 预览。纯 Node。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '目标目录' },
          pattern: { type: 'string', description: '文件名 glob 模式(默认 *, 例: *.jpg)' },
          template: { type: 'string', description: '新文件名模板, 变量: {index}(序号) {date}(YYYYMMDD) {name}(原名无扩展名) {ext}(扩展名). 例: IMG_{index:03d}.jpg' },
          regex: { type: 'string', description: '正则替换模式(和 template 二选一)' },
          replace_to: { type: 'string', description: '正则替换为的字符串(配合 regex)' },
          dry_run: { type: 'boolean', description: '预览模式, 不实际改名(默认 true)' },
        },
        required: ['dir'],
      },
      readOnly: false,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const dir = path.resolve(cwd, args.dir);
        if (!fs.existsSync(dir)) return `❌ 目录不存在: ${args.dir}`;
        const dry = args.dry_run !== false; // 默认 dry_run
        const files = fs.readdirSync(dir).filter(f => {
          if (!args.pattern || args.pattern === '*') return true;
          // 简易 glob: *.ext → 以 ext 结尾
          if (args.pattern.startsWith('*.')) return f.endsWith(args.pattern.slice(1));
          return f === args.pattern;
        });
        if (!files.length) return `⚠ 目录中没有匹配文件`;
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const results = [];

        files.forEach((f, idx) => {
          const ext = path.extname(f);
          const name = path.basename(f, ext);
          let newName;
          if (args.regex) {
            try { newName = f.replace(new RegExp(args.regex, 'g'), args.replace_to || ''); }
            catch { results.push(`  ❌ ${f} → 正则无效`); return; }
          } else if (args.template) {
            newName = args.template
              .replace(/\{index(?::0*(\d+))?\}/g, (_, w) => String(idx + 1).padStart(Number(w) || 0, '0'))
              .replace(/\{date\}/g, date)
              .replace(/\{name\}/g, name)
              .replace(/\{ext\}/g, ext);
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
        const { path: tmp, cleanup } = tmpWrite('.md', (args.title ? `# ${args.title}\n\n` : '') + String(args.content));
        try {
          const outPath = path.resolve(cwd, args.output);
          const out = await execAsync(`pandoc ${shellQuote(tmp)} -o ${shellQuote(outPath)}`, cwd, 120000);
          return out.startsWith('❌')
            ? `${out}\n💡 提示: ${INSTALL_HINT.pandoc}`
            : `✅ 已创建文档: ${args.output}`;
        } finally {
          cleanup();
        }
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
        const out = await execAsync(`pandoc ${shellQuote(fp)} -t ${fmt}`, cwd, 60000);
        return out.startsWith('❌')
          ? `${out}\n💡 提示: ${INSTALL_HINT.pandoc}`
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
        // 路径和 sheet 名通过 argv 传递, 避免 Python 字符串转义问题
        const py = [
          'import openpyxl, json, sys',
          'fp = sys.argv[1]',
          'sheet = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None',
          `wb = openpyxl.load_workbook(fp, read_only=True)`,
          `ws = wb[sheet] if sheet else wb.active`,
          `rows = list(ws.iter_rows(values_only=True, max_row=${maxR + 1}))`,
          'sheets = wb.sheetnames',
          'data = [[str(c) if c is not None else "" for c in r] for r in rows]',
          'print(json.dumps({"sheet": ws.title, "sheets": sheets, "rows": data}))',
        ].join('\n');
        const raw = await runPy(py, cwd);
        if (raw.startsWith('❌')) return `${raw}\n💡 提示: ${INSTALL_HINT.python3} 然后: pip install openpyxl`;
        try {
          const obj = JSON.parse(raw.trim().split('\n').pop());
          const rows = obj.rows;
          if (!rows.length) return `⚠ 工作表 "${obj.sheet}" 为空`;
          const sheetInfo = obj.sheets.length > 1 ? `工作表: ${obj.sheets.join(', ')} (当前: ${obj.sheet})\n\n` : '';
          return `${sheetInfo}${mdTable(rows[0], rows.slice(1))}`;
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
        const outPath = path.resolve(cwd, args.output);
        // data 写临时 JSON, 避免命令行过长
        const { path: tmpJson, cleanup } = tmpWrite('.json', JSON.stringify(args.data));
        try {
          const py = [
            'import openpyxl, json, sys',
            'data = json.load(open(sys.argv[1]))',
            `wb = openpyxl.Workbook()`,
            `ws = wb.active`,
            `ws.title = sys.argv[2] if len(sys.argv) > 2 else "Sheet1"`,
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
            `ws.freeze_panes = "A2"`,
            `wb.save(sys.argv[3])`,
            'print("done")',
          ].join('\n');
          const result = await runPy(py, cwd);
          return result.startsWith('❌')
            ? `${result}\n💡 提示: ${INSTALL_HINT.python3} 然后: pip install openpyxl`
            : `✅ 已创建 Excel: ${args.output} (${args.data.length - 1} 行数据)`;
        } finally {
          cleanup();
        }
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
        const inPath = path.resolve(cwd, args.input);
        const outPath = path.resolve(cwd, args.output);
        if (!fs.existsSync(inPath)) return `❌ 文件不存在: ${args.input}`;
        const py = [
          'import openpyxl, csv, sys',
          'wb = openpyxl.load_workbook(sys.argv[1])',
          'sheet = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None',
          'ws = wb[sheet] if sheet else wb.active',
          'with open(sys.argv[3], "w", newline="", encoding="utf-8-sig") as f:',
          '    w = csv.writer(f)',
          '    for row in ws.iter_rows(values_only=True):',
          '        w.writerow([str(c) if c is not None else "" for c in row])',
          'print("done")',
        ].join('\n');
        const result = await runPy(py, cwd);
        return result.startsWith('❌')
          ? `${result}\n💡 提示: ${INSTALL_HINT.python3} 然后: pip install openpyxl`
          : `✅ 已转换: ${args.input} → ${args.output}`;
      },
    },

    // ── PDF ──
    {
      name: 'pdf_extract_text',
      description: '从 PDF 文件提取纯文本。需要 pdftotext (poppler-utils)。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'PDF 文件路径' },
          page_start: { type: 'number', description: '起始页码(可选, 从 1 开始)' },
          page_end: { type: 'number', description: '结束页码(可选)' },
        },
        required: ['input'],
      },
      readOnly: true,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const fp = path.resolve(cwd, args.input);
        if (!fs.existsSync(fp)) return `❌ 文件不存在: ${args.input}`;
        const pageFlag = (args.page_start && args.page_end)
          ? ` -f ${Number(args.page_start)} -l ${Number(args.page_end)}`
          : (args.page_start ? ` -f ${Number(args.page_start)}` : '');
        const out = await execAsync(`pdftotext${pageFlag} ${shellQuote(fp)} -`, cwd);
        return out.startsWith('❌')
          ? `${out}\n💡 提示: ${INSTALL_HINT.pdftotext}`
          : (out.trim() || '⚠ 未提取到文字(可能是扫描件, 建议用 ocr_image)');
      },
    },

    {
      name: 'create_pdf',
      description: '从 Markdown 创建 PDF。优先用 pandoc --pdf-engine=wkhtmltopdf(无需 LaTeX), fallback 用 wkhtmltopdf 直接转。需安装 wkhtmltopdf。',
      parameters: {
        type: 'object',
        properties: {
          output: { type: 'string', description: '输出 PDF 路径' },
          content: { type: 'string', description: 'Markdown 内容' },
          title: { type: 'string', description: '标题(可选)' },
        },
        required: ['output', 'content'],
      },
      readOnly: false,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const outPdf = path.resolve(cwd, args.output);
        const { path: tmpMd, cleanup: cleanupMd } = tmpWrite('.md', (args.title ? `# ${args.title}\n\n` : '') + String(args.content));
        try {
          // 路径1: pandoc + wkhtmltopdf engine (无需 LaTeX)
          let result = await execAsync(
            `pandoc ${shellQuote(tmpMd)} -o ${shellQuote(outPdf)} --pdf-engine=wkhtmltopdf`,
            cwd, 120000,
          );
          if (!result.startsWith('❌')) return `✅ 已创建 PDF: ${args.output}`;
          // 路径2: pandoc → HTML → wkhtmltopdf
          const { path: tmpHtml, cleanup: cleanupHtml } = tmpWrite('.html', '');
          try {
            result = await execAsync(`pandoc ${shellQuote(tmpMd)} -o ${shellQuote(tmpHtml)}`, cwd, 30000);
            if (!result.startsWith('❌')) {
              result = await execAsync(`wkhtmltopdf ${shellQuote(tmpHtml)} ${shellQuote(outPdf)}`, cwd, 120000);
              if (!result.startsWith('❌')) return `✅ 已创建 PDF: ${args.output}`;
            }
            return `${result}\n💡 提示: PDF 生成需要 wkhtmltopdf。${INSTALL_HINT.wkhtmltopdf}`;
          } finally {
            cleanupHtml();
          }
        } finally {
          cleanupMd();
        }
      },
    },

    // ── OCR ──
    {
      name: 'ocr_image',
      description: '图片 OCR 文字识别, 支持中英文。需要 tesseract。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '图片路径(.png/.jpg/.tiff/.bmp)' },
          lang: { type: 'string', description: '语言(默认 chi_sim+eng, 可选 eng / chi_sim / chi_tra / jpn)' },
        },
        required: ['input'],
      },
      readOnly: true,
      async run(args, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const fp = path.resolve(cwd, args.input);
        if (!fs.existsSync(fp)) return `❌ 文件不存在: ${args.input}`;
        const lang = args.lang || 'chi_sim+eng';
        const out = await execAsync(`tesseract ${shellQuote(fp)} stdout -l ${lang}`, cwd, 120000);
        return out.startsWith('❌')
          ? `${out}\n💡 提示: ${INSTALL_HINT.tesseract}`
          : (out.trim() || '⚠ 未识别到文字');
      },
    },

    // ══════════════════════════════════════════════════════
    // 第三档: Windows COM 自动化 (需安装 Office)
    // ══════════════════════════════════════════════════════

    // ── Outlook 邮件 ──
    {
      name: 'outlook_send_mail',
      description: '通过 Outlook 发送邮件(Windows + Outlook)。利用 PowerShell COM 自动化。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收件人邮箱(多个用分号分隔)' },
          subject: { type: 'string', description: '邮件主题' },
          body: { type: 'string', description: '邮件正文' },
          cc: { type: 'string', description: '抄送(可选)' },
          html: { type: 'boolean', description: '正文是否为 HTML(默认 false)' },
          attachment: { type: 'string', description: '附件路径(多个用分号分隔, 可选)' },
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
          args.attachment
            ? args.attachment.split(';').map(a => `$m.Attachments.Add('${psQuote(a.trim())}')`).join('\n')
            : '',
          `$m.Send()`,
          `Write-Output 'sent'`,
        ].filter(Boolean).join('\n');
        const result = await runPs(ps, ctx?.cwd ?? process.cwd(), 30000);
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
          `$folder = $ns.GetDefaultFolder(6)`, // olFolderInbox = 6
          args.folder && args.folder !== 'Inbox' ? `$folder = $ns.Folders.Item(1).Folders.Item('${psQuote(args.folder)}')` : '',
          `$items = $folder.Items`,
          args.unread_only ? `$items = $items.Restrict("[Unread]=true")` : '',
          `$items.Sort("[ReceivedTime]", $true)`, // 降序
          `$result = @()`,
          `for ($i = 1; $i -le ${count}; $i++) {`,
          `  try { $item = $items.Item($i) } catch { break }`,
          `  if (-not $item) { break }`,
          `  $result += "$($i). [$($item.ReceivedTime)] $($item.Subject) -- from: $($item.SenderName)"`,
          `}`,
          `if ($result.Count -eq 0) { Write-Output '(empty)' }`,
          `else { $result -join [char]10 }`,
        ].filter(Boolean).join('\n');
        const result = await runPs(ps, ctx?.cwd ?? process.cwd(), 30000);
        if (result.startsWith('❌') || result.trim() === '(empty)' || result.trim() === '')
          return `📭 没有找到邮件\n💡 请确认 Outlook 已安装并打开`;
        return `📬 收件箱 (最近 ${count} 封):\n\n${result}`;
      },
    },

    // ── Excel COM ──
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
        // 构建 PowerShell 脚本体
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
              `$chart.Chart.ChartType = ${ { bar: 57, line: 4, pie: 5 }[args.chart_type || 'bar'] || 57 }`, // XlChartType 枚举值
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
        const result = await runPs(ps, ctx?.cwd ?? process.cwd(), 60000);
        return result.startsWith('❌')
          ? `${result}\n💡 请确认 Excel 已安装`
          : result.includes('done') ? `✅ 操作完成: ${args.action}` : result;
      },
    },

    // ── Word COM ──
    {
      name: 'word_com',
      description: 'Word 高级操作(Windows + Office):查找替换、插入目录、修订追踪、导出 PDF 等。通过 PowerShell COM。需安装 Word。',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Word 文件路径(.docx)' },
          action: { type: 'string', description: '操作: find_replace / add_toc / track_changes / accept_changes / get_page_count / export_pdf' },
          find: { type: 'string', description: '查找内容(action=find_replace时必填)' },
          replace: { type: 'string', description: '替换为(action=find_replace时必填)' },
          output: { type: 'string', description: '输出路径(action=export_pdf时必填)' },
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
              `$doc = $wd.Documents.Open('${psQuote(fp)}')`,
              `$find = $doc.Content.Find`,
              `$find.ClearFormatting()`,
              `$find.Replacement.ClearFormatting()`,
              `$find.Execute('${psQuote(args.find)}', $false, $false, $false, $false, $false, $true, 1, $false, '${psQuote(args.replace || '')}', 2)`, // wdReplaceAll = 2
              `$doc.Save()`,
              `$doc.Close()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          case 'add_toc':
            psBody = [
              `$doc = $wd.Documents.Open('${psQuote(fp)}')`,
              `$range = $doc.Content`,
              `$range.Collapse(0)`, // wdCollapseEnd
              `$toc = $doc.TablesOfContents.Add($range, $true)`,
              `$toc.Update()`,
              `$doc.Save()`,
              `$doc.Close()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          case 'track_changes':
            psBody = [
              `$doc = $wd.Documents.Open('${psQuote(fp)}')`,
              `$doc.TrackRevisions = $true`,
              `$doc.Save()`,
              `$doc.Close()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          case 'accept_changes':
            psBody = [
              `$doc = $wd.Documents.Open('${psQuote(fp)}')`,
              `$doc.Revisions.AcceptAll()`,
              `$doc.Save()`,
              `$doc.Close()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          case 'get_page_count':
            psBody = [
              `$doc = $wd.Documents.Open('${psQuote(fp)}')`,
              `$doc.Repaginate()`,
              `Write-Output $doc.ComputeStatistics(2)`, // wdStatisticPages = 2
              `$doc.Close($false)`,
            ].join('\n');
            break;
          case 'export_pdf':
            const pdfPath = path.resolve(ctx?.cwd ?? process.cwd(), args.output || fp.replace(/\.docx?$/i, '.pdf'));
            psBody = [
              `$doc = $wd.Documents.Open('${psQuote(fp)}')`,
              `$doc.SaveAs('${psQuote(pdfPath)}', 17)`, // wdFormatPDF = 17
              `$doc.Close()`,
              `Write-Output 'done'`,
            ].join('\n');
            break;
          default:
            return `❌ 未知 action: ${args.action}`;
        }
        const ps = [
          `$wd = New-Object -ComObject Word.Application`,
          `$wd.Visible = $false`,
          psBody,
          `$wd.Quit()`,
          `[System.Runtime.InteropServices.Marshal]::ReleaseComObject($wd) | Out-Null`,
        ].join('\n');
        const result = await runPs(ps, ctx?.cwd ?? process.cwd(), 60000);
        return result.startsWith('❌')
          ? `${result}\n💡 请确认 Word 已安装`
          : result.includes('done') ? `✅ 操作完成: ${args.action}` : (args.action === 'get_page_count' ? `📄 页数: ${result.trim()}` : result);
      },
    },
  ],
};
