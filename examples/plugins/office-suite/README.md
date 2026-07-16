# Office Suite 插件文档

> **版本**: v2.0.0  
> **适用引擎**: Direct (Kaios)  
> **权限**: `shell` · `fs` · `powershell` · `com-automation`  
> **入口**: `index.js` → `module.exports.tools`

---

## 目录

- [快速开始](#快速开始)
- [依赖安装](#依赖安装)
- [工具总览](#工具总览)
- [第一档：零依赖工具（纯 Node）](#第一档零依赖工具纯-node)
- [第二档：命令行工具](#第二档命令行工具)
- [第三档：Windows COM 自动化](#第三档windows-com-自动化)
- [Slash 命令](#slash-命令)
- [System Prompt](#system-prompt)
- [目录结构](#目录结构)
- [Manifest (plugin.json)](#manifest-pluginjson)

---

## 快速开始

```
# 1. 复制插件到 userData
cp -r examples/plugins/office-suite ~/Library/Application\ Support/KinetAios/plugins/
# Windows: %APPDATA%\KinetAios\plugins\office-suite\

# 2. 重启 KinetAios（或设置页点击「重新加载」）

# 3. 在 Direct 引擎对话中使用
> 分析 data.csv
> 把 report.md 转成 Word
> 读取 sales.xlsx 的数据
```

---

## 依赖安装

工具按依赖程度分三档。**第一档零依赖，装好插件即可用。** 第二、三档按需安装：

| 依赖 | 安装命令 (Windows) | macOS | 使用的工具 |
|---|---|---|---|
| **pandoc** | `winget install pandoc` | `brew install pandoc` | create_doc · read_doc · convert_format · create_pdf |
| **python3** + openpyxl | `winget install python3` 然后 `pip install openpyxl` | `brew install python3 && pip install openpyxl` | excel_read · excel_write · excel_to_csv |
| **poppler** (pdftotext) | `winget install poppler` | `brew install poppler` | pdf_extract_text |
| **tesseract** | `winget install tesseract-ocr` | `brew install tesseract` | ocr_image |
| **wkhtmltopdf** (可选) | `winget install wkhtmltopdf` | `brew install wkhtmltopdf` | create_pdf (fallback 路径) |
| **Microsoft Office** | 预装 | — | outlook_send_mail · outlook_list_mail · excel_com · word_com |

> 💡 缺少依赖时工具会返回友好错误提示和安装命令，不会崩溃。

---

## 工具总览

共 **18 个工具**，按依赖程度分三档：

| # | 工具名 | 档位 | 依赖 | 只读 | 说明 |
|---|---|---|---|---|---|
| 1 | `csv_analyze` | 🟢 零依赖 | 无 | ✅ | CSV 统计分析 |
| 2 | `csv_filter` | 🟢 零依赖 | 无 | ✅ | CSV 筛选/排序/导出 |
| 3 | `convert_format` | 🟢 零依赖 | 无 | ❌ | 格式互转（调用 pandoc） |
| 4 | `markdown_to_html` | 🟢 零依赖 | 无 | ❌ | Markdown → HTML |
| 5 | `batch_text` | 🟢 零依赖 | 无 | ❌ | 批量文本处理 |
| 6 | `batch_rename` | 🟢 零依赖 | 无 | ❌ | 批量文件重命名 |
| 7 | `create_doc` | 🟡 命令行 | pandoc | ❌ | 创建 Word 文档 |
| 8 | `read_doc` | 🟡 命令行 | pandoc | ✅ | 读取文档内容 |
| 9 | `excel_read` | 🟡 命令行 | python3+openpyxl | ✅ | 读取 Excel |
| 10 | `excel_write` | 🟡 命令行 | python3+openpyxl | ❌ | 创建/写入 Excel |
| 11 | `excel_to_csv` | 🟡 命令行 | python3+openpyxl | ❌ | Excel → CSV |
| 12 | `pdf_extract_text` | 🟡 命令行 | pdftotext | ✅ | PDF 提取文字 |
| 13 | `create_pdf` | 🟡 命令行 | pandoc 或 wkhtmltopdf | ❌ | Markdown → PDF |
| 14 | `ocr_image` | 🟡 命令行 | tesseract | ✅ | 图片 OCR |
| 15 | `outlook_send_mail` | 🔴 COM | Outlook (Windows) | ❌ | 发送邮件 |
| 16 | `outlook_list_mail` | 🔴 COM | Outlook (Windows) | ✅ | 读取收件箱 |
| 17 | `excel_com` | 🔴 COM | Excel (Windows) | ❌ | Excel 高级操作 |
| 18 | `word_com` | 🔴 COM | Word (Windows) | ❌ | Word 高级操作 |

---

## 第一档：零依赖工具（纯 Node）

### 1. csv_analyze

> 分析 CSV 文件，自动推断每列类型，输出统计摘要。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | string | ✅ | CSV 文件路径 |
| `delimiter` | string | | 分隔符（默认逗号，可选 `\t` / `;` / `\|`） |

**输出**：行数/列数/列类型推断 + 数值列的 min/max/mean/median/sum + 文本列的常见值频率。

```
> 分析 sales.csv
📊 CSV 分析: sales.csv
总行数(含表头): 101, 数据行: 100, 列数: 5

  📐 amount (数值): min=10, max=9800, mean=2456.30, median=2100, sum=245630.00, 唯一值=87
  📝 region (文本): 非空=100, 唯一值=5
       常见值: "华东"(32), "华北"(25), "华南"(20), "西部"(15), "东北"(8)
```

---

### 2. csv_filter

> 按条件筛选 CSV 行，支持排序、去重，输出 Markdown 表格或写入文件。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | string | ✅ | CSV 文件路径 |
| `where` | string | | 筛选条件，如 `age > 25 AND city == 北京` |
| `sort_by` | string | | 排序列名 |
| `sort_order` | string | | `asc` 或 `desc`（默认 asc） |
| `output` | string | | 写入文件路径（不填则返回 Markdown 表格） |

**操作符**：`==` · `!=` · `>` · `<` · `>=` · `<=` · `contains` · `startswith`

```
> 筛选 sales.csv 里 amount > 5000 的，按 amount 降序
→ 返回 Markdown 表格（前 50 行）
```

---

### 3. convert_format

> 文档格式互转，底层调用 pandoc。支持 md / docx / html / epub / rtf / pdf 等格式。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `input` | string | ✅ | 输入文件路径 |
| `output` | string | ✅ | 输出文件路径（扩展名决定目标格式） |

```
> 把 report.html 转成 report.docx
> 把 notes.md 转成 epub 电子书
```

---

### 4. markdown_to_html

> 纯 Node 实现的 Markdown → HTML 转换，内置 CSS 样式，无需 pandoc。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `input` | string | ✅ | Markdown 文件路径 |
| `output` | string | | 输出 HTML 路径（不填返回 HTML 字符串） |
| `title` | string | | HTML `<title>` |
| `style` | string | | CSS 样式：`default` / `minimal` / `github` / `none`（默认 default） |

---

### 5. batch_text

> 批量文本处理：正则替换、去重、排序、编码转换。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `input` | string | ✅ | 输入文件路径（或目录） |
| `output` | string | | 输出路径（不填返回处理结果） |
| `mode` | string | ✅ | 操作模式：`replace` / `dedupe` / `sort` / `encoding` |
| `find` | string | | 正则（mode=replace 时） |
| `replace` | string | | 替换文本（mode=replace 时） |
| `encoding` | string | | 目标编码（mode=encoding 时，如 `gbk` / `utf8`） |

---

### 6. batch_rename

> 批量重命名文件，支持模板和正则两种模式。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `dir` | string | ✅ | 目标目录 |
| `pattern` | string | | 文件名 glob 筛选（如 `*.jpg`），默认 `*` |
| `template` | string | | 模板模式，变量：`{index}` / `{index:3}` / `{date}` / `{name}` / `{ext}` |
| `regex` | string | | 正则模式（与 template 二选一） |
| `replacement` | string | | 正则替换文本（配合 regex） |
| `dry_run` | boolean | | 预览模式（默认 true，不实际改名） |

**模板示例**：
- `{date}_{name}{ext}` → `2025-01-15_report.docx`
- `{index:3}.{ext}` → `001.jpg`, `002.jpg`, `003.jpg`

---

## 第二档：命令行工具

### 7. create_doc

> 从 Markdown 创建 Word 文档。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `output` | string | ✅ | 输出文件路径（.docx） |
| `content` | string | ✅ | 文档内容（Markdown 格式） |
| `title` | string | | 文档标题（一级标题） |

**依赖**：pandoc (`winget install pandoc`)

---

### 8. read_doc

> 读取 Word/PDF/EPUB/HTML/RTF 文档内容，转为文本或 Markdown。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `input` | string | ✅ | 输入文件（.docx / .pdf / .epub / .html / .rtf） |
| `format` | string | | 输出格式：`plain` / `markdown`（默认 markdown） |

**依赖**：pandoc  
**截断**：超长文档截断至 50,000 字符

---

### 9. excel_read

> 读取 Excel 文件，返回指定 sheet 的数据为 Markdown 表格。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `input` | string | ✅ | Excel 文件路径 |
| `sheet` | string | | 工作表名（默认第一个） |
| `max_rows` | number | | 最大返回行数（默认 50） |

**依赖**：python3 + openpyxl (`pip install openpyxl`)  
**输出**：Markdown 表格 + 所有 sheet 列表（如多个）

---

### 10. excel_write

> 创建/写入 Excel 文件，支持多 sheet、标题行样式、列宽自适应、冻结首行。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `output` | string | ✅ | 输出 Excel 文件路径 |
| `data` | array | ✅ | 二维数组，第一行为表头 |
| `sheet_name` | string | | 工作表名（默认 Sheet1） |
| `freeze_header` | boolean | | 冻结首行（默认 true） |

**依赖**：python3 + openpyxl  
**特性**：表头加粗 + 列宽自适应 + 冻结首行

---

### 11. excel_to_csv

> Excel 转 CSV。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `input` | string | ✅ | Excel 文件路径 |
| `output` | string | | 输出 CSV 路径（不填返回内容） |
| `sheet` | string | | 工作表名（默认第一个） |

**依赖**：python3 + openpyxl  
**编码**：UTF-8 with BOM（Windows Excel 友好）

---

### 12. pdf_extract_text

> 从 PDF 提取纯文本。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `input` | string | ✅ | PDF 文件路径 |
| `pages` | string | | 页码范围（如 `1-5`） |

**依赖**：pdftotext (poppler) (`winget install poppler`)

---

### 13. create_pdf

> 从 Markdown 创建 PDF。自动 fallback：先试 pandoc，失败则试 wkhtmltopdf。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `output` | string | ✅ | 输出 PDF 路径 |
| `content` | string | ✅ | 内容（Markdown） |
| `title` | string | | 标题（可选） |

**依赖**：pandoc + LaTeX（或 tectonic），或 wkhtmltopdf（二选一）

---

### 14. ocr_image

> 对图片执行 OCR 文字识别。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `input` | string | ✅ | 图片路径（.png / .jpg / .tiff / .bmp） |
| `lang` | string | | 语言（默认 `chi_sim+eng`，可选 `eng` / `chi_sim` / `chi_tra+eng` / `jpn+eng`） |

**依赖**：tesseract (`winget install tesseract-ocr`)

---

## 第三档：Windows COM 自动化

> ⚠️ 以下工具**仅 Windows 可用**，需安装 Microsoft Office。通过 PowerShell COM 接口操控 Office 应用。

### 15. outlook_send_mail

> 通过 Outlook 发送邮件。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `to` | string | ✅ | 收件人邮箱（多个用分号分隔） |
| `subject` | string | ✅ | 邮件主题 |
| `body` | string | ✅ | 邮件正文 |
| `cc` | string | | 抄送 |
| `html` | boolean | | 正文为 HTML 格式（默认 false） |
| `attachment` | string | | 附件路径（多个用分号） |

**依赖**：Outlook (Windows)

---

### 16. outlook_list_mail

> 读取 Outlook 收件箱的最近邮件。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `folder` | string | | 文件夹名（默认 Inbox） |
| `count` | number | | 读取封数（默认 10，最大 50） |
| `unread_only` | boolean | | 仅未读（默认 false） |

**依赖**：Outlook (Windows)

---

### 17. excel_com

> Excel 高级操作（公式、宏、图表）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | string | ✅ | Excel 文件路径 |
| `action` | string | ✅ | 操作类型（见下表） |
| `sheet` | string | | 工作表名 |
| `cell` | string | | 目标单元格（如 `A1` / `B2:C10`） |
| `value` | string | | 值或公式（公式以 `=` 开头） |
| `macro` | string | | VBA 宏名 |
| `chart_type` | string | | 图表类型（`bar` / `line` / `pie`） |

**action 取值**：

| action | 说明 | 额外参数 |
|---|---|---|
| `set_cell` | 设置单元格值 | cell + value |
| `set_formula` | 设置公式 | cell + value（以 `=` 开头） |
| `get_formula` | 获取单元格公式和值 | cell |
| `list_sheets` | 列出所有工作表名 | — |
| `run_macro` | 执行 VBA 宏 | macro |
| `add_chart` | 插入图表 | cell（数据范围）+ chart_type |

**依赖**：Excel (Windows)

---

### 18. word_com

> Word 高级操作（查找替换、目录、修订、导出 PDF）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | string | ✅ | Word 文件路径 |
| `action` | string | ✅ | 操作类型（见下表） |
| `find` | string | | 查找文本 |
| `replace` | string | | 替换文本 |
| `output` | string | | 导出路径（export_pdf 时） |

**action 取值**：

| action | 说明 | 额外参数 |
|---|---|---|
| `find_replace` | 查找替换 | find + replace |
| `add_toc` | 插入目录 | — |
| `track_changes` | 开启修订追踪 | — |
| `accept_changes` | 接受所有修订 | — |
| `get_page_count` | 获取页数 | — |
| `export_pdf` | 导出为 PDF | output |

**依赖**：Word (Windows)

---

## Slash 命令

插件贡献 7 个 slash 命令，在 Direct 引擎对话中输入 `/` 触发：

| 命令 | 说明 | 涉及工具 |
|---|---|---|
| `/make-doc` | 自然语言生成 Word 文档 | create_doc |
| `/convert-table` | Excel 转 CSV 或在对话中展示 | excel_to_csv |
| `/analyze-data` | 分析 CSV/Excel 数据文件 | excel_read · csv_analyze · csv_filter |
| `/send-email` | 通过 Outlook 发送邮件 | outlook_send_mail |
| `/scan-document` | 从图片/PDF 提取文字 | ocr_image · pdf_extract_text · read_doc |
| `/batch-files` | 批量处理文件 | batch_rename · convert_format · batch_text |
| `/read-summary` | 读取文档并生成摘要 | read_doc · excel_read · pdf_extract_text |

---

## System Prompt

插件通过 `prompts/office.md` 向 Direct 引擎注入系统提示，包含：

1. **18 个工具的分类说明**（零依赖 / 命令行 / COM 自动化）
2. **使用原则**：零依赖优先、按场景选工具
3. **依赖缺失的容错指引**

---

## 目录结构

```
office-suite/
├── plugin.json              # 插件 manifest
├── index.js                 # 入口：module.exports.tools (18 个工具)
├── icon.svg                 # 插件图标
├── commands/                # Slash 命令 (.md)
│   ├── make-doc.md
│   ├── convert-table.md
│   ├── analyze-data.md
│   ├── send-email.md
│   ├── scan-document.md
│   ├── batch-files.md
│   └── read-summary.md
└── prompts/
    └── office.md            # System prompt 注入
```

---

## Manifest (plugin.json)

```json
{
  "name": "office-suite",
  "version": "2.0.0",
  "description": "办公工具套件:CSV分析/文档转换/Excel读写/PDF/OCR/Outlook邮件/Office COM自动化(共18个工具)",
  "author": "Kinet",
  "category": "office",
  "icon": "icon.svg",
  "engines": ["direct"],
  "permissions": ["shell", "fs", "powershell", "com-automation"],
  "tools": "index.js#tools",
  "slashCommands": "commands/",
  "systemPrompt": "prompts/office.md"
}
```

**字段说明**：

| 字段 | 说明 |
|---|---|
| `name` | 插件唯一标识，对应 `<userData>/plugins/<name>/` 目录名 |
| `version` | 语义版本号 |
| `category` | 分类标签，用于设置页分组展示 |
| `engines` | 适配的引擎列表（目前仅 `direct`） |
| `permissions` | 声明使用的权限（告知性质，非强制沙箱） |
| `tools` | 工具入口，格式 `<file>#<exportName>` |
| `slashCommands` | Slash 命令目录路径 |
| `systemPrompt` | 注入到引擎的 system prompt 文件路径 |
