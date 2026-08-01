// NestJS 后端脚手架插件 —— 工具集
// Tool 接口签名见 src/main/tools.ts: Tool { name; description; parameters; readOnly?; run(args, ctx) }
//
// 工具列表:
//   1. nest_module    — 生成完整的 NestJS 模块(controller + service + dto + module)
//   2. nest_entity    — 从 SQL/描述生成 TypeORM Entity(含装饰器、关系、索引)
//   3. nest_crud      — 生成 CRUD 模板(Swagger 装饰器 + DTO 验证 + 分页 + 软删除)
//   4. nest_guard     — 生成 JWT/Auth Guard、RBAC 装饰器、多租户拦截器
//
// 生成策略: 纯字符串模板(零依赖),通过 write_file 写入。不调用 nest CLI(避免项目上下文丢失)。
// 生成的代码遵循 NestJS + TypeORM + Swagger + class-validator 约定。

// ── 辅助: 大驼峰 / 小驼峰 / kebab 转换 ──────────────────
function toPascal(str) {
  return str
    .replace(/[-_](.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (_, c) => c.toUpperCase());
}

function toCamel(str) {
  const p = toPascal(str);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function toKebab(str) {
  return str
    .replace(/([A-Z])/g, '-$1')
    .replace(/[-_]+/g, '-')
    .replace(/^-/, '')
    .toLowerCase();
}

// ── 辅助: 类型映射 (SQL → TypeScript) ────────────────────
function sqlToTs(sqlType) {
  const t = sqlType.toLowerCase();
  if (t.includes('int') || t.includes('serial') || t.includes('bit')) return 'number';
  if (t.includes('decimal') || t.includes('float') || t.includes('double') || t.includes('numeric')) return 'number';
  if (t.includes('bool')) return 'boolean';
  if (t.includes('date') || t.includes('time')) return 'Date';
  if (t.includes('json') || t.includes('text')) return 'string';
  return 'string';
}

// ── 模板: Controller ─────────────────────────────────────
function tplController(name, pascalName, camelName, kebabName) {
  return `import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ${pascalName}Service } from './${kebabName}.service';
import { Create${pascalName}Dto } from './dto/create-${kebabName}.dto';
import { Update${pascalName}Dto } from './dto/update-${kebabName}.dto';
import { Query${pascalName}Dto } from './dto/query-${kebabName}.dto';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';

@ApiTags('${name}')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('${kebabName}')
export class ${pascalName}Controller {
  constructor(private readonly ${camelName}Service: ${pascalName}Service) {}

  @Post()
  @ApiOperation({ summary: '创建${name}' })
  create(@Body() createDto: Create${pascalName}Dto) {
    return this.${camelName}Service.create(createDto);
  }

  @Get()
  @ApiOperation({ summary: '${name}列表(分页)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  findAll(@Query() query: Query${pascalName}Dto) {
    return this.${camelName}Service.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: '${name}详情' })
  findOne(@Param('id') id: string) {
    return this.${camelName}Service.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新${name}' })
  update(@Param('id') id: string, @Body() updateDto: Update${pascalName}Dto) {
    return this.${camelName}Service.update(id, updateDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除${name}(软删除)' })
  remove(@Param('id') id: string) {
    return this.${camelName}Service.remove(id);
  }
}
`;
}

// ── 模板: Service ────────────────────────────────────────
function tplService(pascalName, camelName, kebabName) {
  return `import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, FindManyOptions } from 'typeorm';
import { ${pascalName} } from './entities/${kebabName}.entity';
import { Create${pascalName}Dto } from './dto/create-${kebabName}.dto';
import { Update${pascalName}Dto } from './dto/update-${kebabName}.dto';
import { Query${pascalName}Dto } from './dto/query-${kebabName}.dto';

@Injectable()
export class ${pascalName}Service {
  constructor(
    @InjectRepository(${pascalName})
    private readonly repo: Repository<${pascalName}>,
  ) {}

  async create(createDto: Create${pascalName}Dto) {
    const entity = this.repo.create(createDto);
    return this.repo.save(entity);
  }

  async findAll(query: Query${pascalName}Dto) {
    const { page = 1, pageSize = 20, keyword, ...rest } = query;
    const where: FindManyOptions<${pascalName}>['where'] = { ...rest };
    if (keyword) {
      // TODO: 按需调整搜索字段 / Adjust search fields as needed
      // where.name = Like(\`%\${keyword}%\`);
    }
    const [list, total] = await this.repo.findAndCount({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { createdAt: 'DESC' },
    });
    return { list, total, page, pageSize };
  }

  async findOne(id: string) {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity) throw new NotFoundException(\`${pascalName} #\${id} 不存在\`);
    return entity;
  }

  async update(id: string, updateDto: Update${pascalName}Dto) {
    const entity = await this.findOne(id);
    Object.assign(entity, updateDto);
    return this.repo.save(entity);
  }

  async remove(id: string) {
    const entity = await this.findOne(id);
    // 软删除 / Soft delete
    await this.repo.softRemove(entity);
    return { success: true };
  }
}
`;
}

// ── 模板: Module ─────────────────────────────────────────
function tplModule(pascalName, camelName, kebabName) {
  return `import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ${pascalName}Service } from './${kebabName}.service';
import { ${pascalName}Controller } from './${kebabName}.controller';
import { ${pascalName} } from './entities/${kebabName}.entity';

@Module({
  imports: [TypeOrmModule.forFeature([${pascalName}])],
  controllers: [${pascalName}Controller],
  providers: [${pascalName}Service],
  exports: [${pascalName}Service],
})
export class ${pascalName}Module {}
`;
}

// ── 模板: DTOs ───────────────────────────────────────────
function tplCreateDto(pascalName, kebabName, fields) {
  const fieldLines = fields.map((f) => {
    const decorators = [];
    if (f.required) decorators.push(`@IsNotEmpty({ message: '${f.name}不能为空' })`);
    if (f.type === 'string') decorators.push(`@IsString({ message: '${f.name}必须是字符串' })`);
    if (f.type === 'number') decorators.push(`@IsNumber({}, { message: '${f.name}必须是数字' })`);
    if (f.type === 'boolean') decorators.push(`@IsBoolean({ message: '${f.name}必须是布尔值' })`);
    if (f.type === 'Date') decorators.push(`@IsDateString({}, { message: '${f.name}必须是有效日期' })`);
    if (f.length) decorators.push(`@MaxLength(${f.length}, { message: '${f.name}长度不能超过${f.length}' })`);

    const apiProp = `@ApiProperty({ description: '${f.comment || f.name}'${f.required ? '' : ', required: false'}${f.example ? `, example: ${JSON.stringify(f.example)}` : ''} })`;
    return `  ${apiProp}\n  ${decorators.join('\n  ')}\n  ${f.type} ${f.name};`;
  }).join('\n\n');

  return `import { IsNotEmpty, IsString, IsNumber, IsBoolean, IsDateString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class Create${pascalName}Dto {
${fieldLines}
}
`;
}

function tplUpdateDto(pascalName) {
  return `import { PartialType } from '@nestjs/swagger';
import { Create${pascalName}Dto } from './create-${pascalName.charAt(0).toLowerCase() + pascalName.slice(1)}.dto';

export class Update${pascalName}Dto extends PartialType(Create${pascalName}Dto) {}
`;
}

function tplQueryDto(pascalName) {
  return `import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class Query${pascalName}Dto {
  @ApiPropertyOptional({ description: '页码', default: 1 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数', default: 20 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1)
  pageSize?: number;

  @ApiPropertyOptional({ description: '关键词搜索' })
  @IsOptional() @IsString()
  keyword?: string;
}
`;
}

// ── 模板: Entity ─────────────────────────────────────────
function tplEntity(pascalName, camelName, kebabName, tableName, fields) {
  const fieldLines = fields.map((f) => {
    const decorators = [`@Column({${f.length ? ` length: ${f.length},` : ''}${f.nullable ? ' nullable: true,' : ''} comment: '${f.comment || f.name}' })`];
    if (f.unique) decorators.unshift(`@Index({ unique: true })`);
    return `  ${decorators.join('\n  ')}\n  ${f.type} ${f.name};`;
  }).join('\n\n');

  return `import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, DeleteDateColumn, Index } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

@Entity('${tableName || kebabName + 's'}')
export class ${pascalName} {
  @ApiProperty({ description: 'ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

${fieldLines}

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn({ name: 'created_at', comment: '创建时间' })
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn({ name: 'updated_at', comment: '更新时间' })
  updatedAt: Date;

  @ApiProperty({ description: '删除时间(软删除)' })
  @DeleteDateColumn({ name: 'deleted_at', comment: '删除时间', nullable: true })
  deletedAt: Date;
}
`;
}

// ── 工具 1: 生成完整模块 ──────────────────────────────────
// Tool 1: nest_module — generate a complete NestJS module (controller + service + dto + module + entity).
const nestModule = {
  name: 'nest_module',
  description: '生成完整的 NestJS 模块代码(controller + service + module + DTO + entity)。自动加 Swagger 装饰器、class-validator 验证、TypeORM 软删除、分页查询。返回所有文件内容供直接写入。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '模块名称(中英文均可,如 "产品" 或 "product" 或 "PurchaseOrder")',
      },
      table_name: {
        type: 'string',
        description: '数据库表名(默认自动推断,如 "products" 或 "purchase_orders")',
      },
      fields: {
        type: 'array',
        description: '字段列表(除 id/createdAt/updatedAt/deletedAt 自动生成外)',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '字段名(camelCase)' },
            type: { type: 'string', enum: ['string', 'number', 'boolean', 'Date'], description: 'TypeScript 类型' },
            comment: { type: 'string', description: '字段注释' },
            required: { type: 'boolean', description: 'DTO 是否必填' },
            nullable: { type: 'boolean', description: '数据库是否可空' },
            unique: { type: 'boolean', description: '是否唯一' },
            length: { type: 'number', description: '字符串长度' },
            example: { description: '示例值' },
          },
        },
      },
      output_dir: {
        type: 'string',
        description: '输出目录(默认当前工作目录下的 src/<模块名>/)',
      },
    },
    required: ['name'],
  },
  readOnly: false,
  async run(args, ctx) {
    const rawName = args.name;
    const pascalName = toPascal(rawName);
    const camelName = toCamel(rawName);
    const kebabName = toKebab(rawName);
    const tableName = args.table_name || (kebabName + 's');
    const fields = (args.fields || []).map((f) => ({
      name: f.name,
      type: f.type || 'string',
      comment: f.comment || f.name,
      required: f.required !== false,
      nullable: f.nullable || false,
      unique: f.unique || false,
      length: f.length,
      example: f.example,
    }));

    // 默认字段: name (string)
    if (fields.length === 0) {
      fields.push({ name: 'name', type: 'string', comment: '名称', required: true, nullable: false, unique: false, length: 100 });
    }

    const outputDir = args.output_dir || `${ctx.cwd}/src/${kebabName}`;

    // 生成所有文件
    const files = {
      [`${outputDir}/${kebabName}.module.ts`]: tplModule(pascalName, camelName, kebabName),
      [`${outputDir}/${kebabName}.controller.ts`]: tplController(rawName, pascalName, camelName, kebabName),
      [`${outputDir}/${kebabName}.service.ts`]: tplService(pascalName, camelName, kebabName),
      [`${outputDir}/dto/create-${kebabName}.dto.ts`]: tplCreateDto(pascalName, kebabName, fields),
      [`${outputDir}/dto/update-${kebabName}.dto.ts`]: tplUpdateDto(pascalName),
      [`${outputDir}/dto/query-${kebabName}.dto.ts`]: tplQueryDto(pascalName),
      [`${outputDir}/entities/${kebabName}.entity.ts`]: tplEntity(pascalName, camelName, kebabName, tableName, fields),
    };

    const lines = [
      `🏗️ NestJS 模块生成: ${pascalName}Module`,
      `📁 输出目录: ${outputDir}/`,
      `📊 表名: ${tableName}`,
      `📝 字段: ${fields.map((f) => f.name).join(', ')}`,
      ``,
      `以下 ${Object.keys(files).length} 个文件已准备好,请用 write_file 写入:`,
      ``,
    ];

    for (const [filePath, content] of Object.entries(files)) {
      lines.push(`── ${filePath} ──`);
      lines.push('```typescript');
      lines.push(content.trim());
      lines.push('```');
      lines.push('');
    }

    lines.push(`💡 记得在 app.module.ts 的 imports 中注册 ${pascalName}Module`);

    return lines.join('\n');
  },
};

// ── 工具 2: 生成 TypeORM Entity ───────────────────────────
// Tool 2: nest_entity — generate a TypeORM entity from field descriptions.
const nestEntity = {
  name: 'nest_entity',
  description: '从字段描述生成 TypeORM Entity 代码。包含 Swagger @ApiProperty、@Column/@Index 装饰器、软删除基类字段。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '实体名称(如 "Product" / "PurchaseOrder")',
      },
      table_name: {
        type: 'string',
        description: '表名(默认自动推断)',
      },
      fields: {
        type: 'array',
        description: '字段列表',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['string', 'number', 'boolean', 'Date'] },
            comment: { type: 'string' },
            nullable: { type: 'boolean' },
            unique: { type: 'boolean' },
            length: { type: 'number' },
          },
        },
      },
    },
    required: ['name', 'fields'],
  },
  readOnly: false,
  async run(args) {
    const pascalName = toPascal(args.name);
    const camelName = toCamel(args.name);
    const kebabName = toKebab(args.name);
    const tableName = args.table_name || (kebabName + 's');
    const fields = (args.fields || []).map((f) => ({
      name: f.name,
      type: f.type || 'string',
      comment: f.comment || f.name,
      required: f.required !== false,
      nullable: f.nullable || false,
      unique: f.unique || false,
      length: f.length,
    }));

    const code = tplEntity(pascalName, camelName, kebabName, tableName, fields);

    const lines = [
      `📊 TypeORM Entity: ${pascalName} (表: ${tableName})`,
      ``,
      '```typescript',
      code.trim(),
      '```',
      ``,
      `📁 文件路径: src/${kebabName}/entities/${kebabName}.entity.ts`,
    ];

    return lines.join('\n');
  },
};

// ── 工具 3: 生成 CRUD 模板 ────────────────────────────────
// Tool 3: nest_crud — generate CRUD service + controller with Swagger decorators.
const nestCrud = {
  name: 'nest_crud',
  description: '生成 NestJS CRUD 代码模板(Controller + Service)。包含: Swagger 装饰器、分页查询、软删除、DTO 验证。适合快速搭建 RESTful API。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '模块名称',
      },
    },
    required: ['name'],
  },
  readOnly: false,
  async run(args) {
    const rawName = args.name;
    const pascalName = toPascal(rawName);
    const camelName = toCamel(rawName);
    const kebabName = toKebab(rawName);

    const lines = [
      `🔄 CRUD 模板: ${pascalName}`,
      ``,
      `── ${kebabName}.controller.ts ──`,
      '```typescript',
      tplController(rawName, pascalName, camelName, kebabName).trim(),
      '```',
      ``,
      `── ${kebabName}.service.ts ──`,
      '```typescript',
      tplService(pascalName, camelName, kebabName).trim(),
      '```',
    ];

    return lines.join('\n');
  },
};

// ── 工具 4: 生成 Guard / 装饰器 / 拦截器 ────────────────
// Tool 4: nest_guard — generate JWT Guard, RBAC decorators, tenant interceptor.
const nestGuard = {
  name: 'nest_guard',
  description: '生成 NestJS 认证/授权代码模板。支持: JWT Auth Guard、RBAC 权限装饰器(@Permissions)、多租户拦截器(TenantInterceptor)。',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['jwt-guard', 'rbac', 'tenant', 'all'],
        description: '生成类型: jwt-guard=JWT认证守卫, rbac=RBAC权限装饰器, tenant=多租户拦截器, all=全部',
      },
    },
    required: ['type'],
  },
  readOnly: false,
  async run(args) {
    const type = args.type;
    const lines = [];

    if (type === 'jwt-guard' || type === 'all') {
      lines.push(`── jwt-auth.guard.ts ──`);
      lines.push('```typescript');
      lines.push(`import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest(err: any, user: any) {
    if (err || !user) {
      throw err || new UnauthorizedException('身份验证失败');
    }
    return user;
  }
}`);
      lines.push('```');
      lines.push('');
    }

    if (type === 'rbac' || type === 'all') {
      lines.push(`── permissions.decorator.ts ──`);
      lines.push('```typescript');
      lines.push(`import { SetMetadata } from '@nestjs/common';
export const PERMISSIONS_KEY = 'permissions';

// 权限装饰器: @Permissions('user:read', 'user:write')
export const Permissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
`);
      lines.push('```');
      lines.push('');
      lines.push(`── permissions.guard.ts ──`);
      lines.push('```typescript');
      lines.push(`import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    const userPerms = user?.permissions || [];
    const hasAll = required.every((p) => userPerms.includes(p));
    if (!hasAll) {
      throw new ForbiddenException(\`缺少权限: \${required.join(', ')}\`);
    }
    return true;
  }
}`);
      lines.push('```');
      lines.push('');
    }

    if (type === 'tenant' || type === 'all') {
      lines.push(`── tenant.interceptor.ts ──`);
      lines.push('```typescript');
      lines.push(`import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { RequestContext } from '../contexts/request.context';

// 多租户拦截器: 从 JWT payload 提取 tenantId 注入 RequestContext
// Multi-tenant interceptor: extract tenantId from JWT and inject into RequestContext
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;

    if (user?.tenantId) {
      RequestContext.set('tenantId', user.tenantId);
    }

    return next.handle();
  }
}
`);
      lines.push('```');
      lines.push('');
      lines.push(`── request.context.ts ──`);
      lines.push('```typescript');
      lines.push(`import { AsyncLocalStorage } from 'async_hooks';

// 基于 AsyncLocalStorage 的请求上下文(线程安全)
// Thread-safe request context based on AsyncLocalStorage
const als = new AsyncLocalStorage<Map<string, any>>();

export class RequestContext {
  static run<T>(fn: () => T): T {
    return als.run(new Map(), fn);
  }

  static get(key: string): any {
    const store = als.getStore();
    return store?.get(key);
  }

  static set(key: string, value: any): void {
    const store = als.getStore();
    store?.set(key, value);
  }

  static get tenantId(): string | undefined {
    return this.get('tenantId');
  }

  static get userId(): string | undefined {
    return this.get('userId');
  }
}
`);
      lines.push('```');
    }

    return lines.length > 0 ? lines.join('\n') : `❌ 未知类型: ${type}`;
  },
};

// ── 导出 ────────────────────────────────────────────────────
module.exports = {
  tools: [nestModule, nestEntity, nestCrud, nestGuard],
};
