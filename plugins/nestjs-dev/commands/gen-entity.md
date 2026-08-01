---
name: gen-entity
description: 从 SQL 建表语句或字段描述生成 TypeORM Entity
---

你现在要帮用户生成 TypeORM Entity。请按以下步骤操作:

## 1. 获取字段信息

向用户索要:
- 表名
- 字段列表(可以是 SQL DDL / 自然语言描述 / Markdown 表格)

如果用户给的是 SQL,自动解析字段名和类型:
- `VARCHAR(n)` → string, length=n
- `TEXT` → string
- `INT` / `BIGINT` → number
- `DECIMAL(p,s)` → number
- `BOOLEAN` / `TINYINT(1)` → boolean
- `DATETIME` / `TIMESTAMP` → Date
- `JSON` → string (或 any)

## 2. 生成 Entity

调用 `nest_entity` 工具,传入:
- name: 实体名(PascalCase)
- table_name: 表名
- fields: 解析后的字段数组

## 3. 写入文件

将生成的代码写入 `src/modules/<kebab>/entities/<kebab>.entity.ts`。

## 4. 关系处理

如果用户需要关联关系(OneToMany / ManyToOne / ManyToMany),手动补充:
```typescript
@OneToMany(() => OrderItem, (item) => item.order)
items: OrderItem[];
```

## 5. 索引处理

如果 SQL 中有 `INDEX` 或 `UNIQUE KEY`，对应:
- `@Index()` 装饰器
- `@Index({ unique: true })` 唯一索引
