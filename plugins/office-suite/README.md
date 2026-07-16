# office-suite 插件

办公文档工具套件，15 个工具覆盖三档能力：

## 🟢 零依赖（纯 Node）

| 工具 | 功能 |
|---|---|
| `csv_analyze` | CSV 统计摘要（列类型推断 / min/max/mean/sum） |
| `csv_filter` | CSV 筛选排序（==, !=, >, <, contains... + 导出） |
| `convert_format` | pandoc 格式互转（md/docx/html/epub/rtf/pdf） |
| `markdown_to_html` | 纯 Node MD→HTML（内置 CSS） |
| `batch_text` | 正则替换/去重/排序/大小写/编码 |
| `batch_rename` | 模板/正则批量重命名（支持 dry_run 预览） |

## 🟡 需命令行工具

| 工具 | 依赖 | 安装 |
|---|---|---|
| `create_doc` | pandoc | `winget install pandoc` |
| `read_doc` | pandoc | 同上 |
| `excel_read` | python3 + openpyxl | `winget install Python.Python.3` → `pip install openpyxl` |
| `excel_write` | python3 + openpyxl | 同上 |
| `excel_to_csv` | python3 + openpyxl | 同上 |
| `pdf_extract_text` | pdftotext (poppler) | `winget install poppler` |
| `create_pdf` | wkhtmltopdf | `winget install wkhtmltopdf` |
| `ocr_image` | tesseract | `winget install UB-Mannheim.TesseractOCR` |

## 🔴 Windows COM（需安装 Office）

| 工具 | 功能 |
|---|---|
| `outlook_send_mail` | 发送邮件（收件人/抄送/HTML/附件） |
| `outlook_list_mail` | 收件箱列表（读最近 N 封/仅未读） |
| `excel_com` | Excel 高级（公式/图表/VBA 宏） |
| `word_com` | Word 高级（查找替换/目录/修订/导出 PDF） |

## Slash 命令

| 命令 | 用途 |
|---|---|
| `/analyze-data` | 分析 CSV/Excel 数据文件 |
| `/send-email` | 通过 Outlook 发送邮件 |
| `/scan-document` | 图片/PDF 提取文字（OCR） |
| `/batch-files` | 批量处理文件 |
| `/read-summary` | 读取文档并生成摘要 |

## 安全

- PowerShell / Python 脚本一律写临时 `.ps1` / `.py` 文件 + `-File` 执行，不走 `-c` 拼接
- 路径用 `shellQuote()` 安全引用，防止引号截断注入
- 临时文件 try/finally 确保清理
