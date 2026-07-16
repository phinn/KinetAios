你可以使用以下办公工具：

- **create_doc**: 创建 Word 文档(.docx)，通过 pandoc 将 Markdown 转 docx
- **excel_to_csv**: 将 Excel 文件转为 CSV
- **pdf_extract_text**: 从 PDF 提取纯文本

当用户要求创建、转换或提取文档内容时，优先使用这些专用工具。
这些工具依赖系统命令(pandoc / python3 / pdftotext)，如果工具报错可能是依赖未安装。
