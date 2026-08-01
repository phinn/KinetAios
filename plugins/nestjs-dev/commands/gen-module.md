---
name: gen-module
description: 一键生成 NestJS 完整模块 —— Controller + Service + DTO + Entity + Module
---

你现在要帮用户生成一个完整的 NestJS 模块。请按以下步骤操作:

## 1. 确认模块信息

向用户确认:
- 模块名称(如 "产品" / "Product" / "PurchaseOrder")
- 核心字段列表(字段名 + 类型 + 说明)
- 表名(不确认则自动推断)

## 2. 使用工具生成

调用 `nest_module` 工具,传入 name 和 fields 数组。

每个 field 格式:
```json
{
  "name": "productName",
  "type": "string",
  "comment": "产品名称",
  "required": true,
  "length": 200
}
```

## 3. 写入文件

工具会返回所有文件内容。使用 `write_file` 逐个写入:
- `src/modules/<kebab-name>/<kebab-name>.module.ts`
- `src/modules/<kebab-name>/<kebab-name>.controller.ts`
- `src/modules/<kebab-name>/<kebab-name>.service.ts`
- `src/modules/<kebab-name>/dto/create-<kebab-name>.dto.ts`
- `src/modules/<kebab-name>/dto/update-<kebab-name>.dto.ts`
- `src/modules/<kebab-name>/dto/query-<kebab-name>.dto.ts`
- `src/modules/<kebab-name>/entities/<kebab-name>.entity.ts`

## 4. 注册模块

提醒用户在 `app.module.ts` 的 imports 数组中加入新模块。

## 5. 验证

建议用户运行 `npm run build` 确认无 TypeScript 编译错误。
