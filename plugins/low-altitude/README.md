# low-altitude — 低空经济行业插件

为 KinetAios 提供低空经济领域的行业工具集、工作流命令和领域知识。

## 功能

### 工具 (4 个)

| 工具 | 功能 | 数据源 |
|------|------|--------|
| `weather_brief` | 航空气象简报(风/能见度/降水/云底高) | Open-Meteo 免费 API(默认)或自定义气象服务 |
| `airspace_check` | 低空空域/限飞区查询 | 内置中国低空空域分类规则或自定义空管平台 |
| `flight_plan` | 航线规划(航程/时间/电量估算 + 航点 CSV) | 内置 Haversine 估算或本地航线规划 CLI |
| `compliance_check` | 法规合规检查(机型/场景/空域 vs 法规库) | 内置 CCAR-92 等法规知识 |

### Slash 命令 (3 个)

| 命令 | 功能 |
|------|------|
| `/plan-flight` | 飞行任务一键规划: 查气象 + 查空域 + 算航线 + 生成任务书 |
| `/inspect-report` | 巡检报告生成: 整理数据 + 识别缺陷 + 对比历史 + 输出报告 |
| `/airspace-brief` | 空域态势简报: 限飞状态 + 法规要求 + 气象条件 |

### 系统提示词

`prompt.md` 注入低空经济领域知识(空域分类、无人机分类、法规参考)和安全原则,让 Direct 引擎在处理飞行相关问题时具备专业判断力。

## 安装

将 `low-altitude/` 目录复制到 KinetAios 的 `<userData>/plugins/` 下,重启应用即可。

### 开发安装

在 KinetAios 设置页 → 插件管理 → 安装插件,选择本目录。

## 环境变量(可选)

插件默认使用免费/内置数据源,企业部署可配置以下环境变量接入自有服务:

| 变量 | 说明 |
|------|------|
| `LOWALT_WEATHER_API` | 自定义气象 API 端点 (`?lat=&lon=&hours=`) |
| `LOWALT_AIRSPACE_API` | 自定义空管平台 API 端点 (`?lat=&lon=&altitude=`) |
| `LOWALT_FLIGHT_PLANNER` | 本地航线规划 CLI 路径 (接收 JSON 航点参数) |

不配置时,工具自动降级到:
- 气象 → Open-Meteo 免费API
- 空域 → 内置通用规则估算
- 航线 → 内置 Haversine 距离 + 电量经验公式

## 架构

```
low-altitude/
├── plugin.json          # 插件 manifest
├── index.js             # 工具集 (4 个 Tool)
├── prompt.md            # 系统提示词 (领域知识 + 安全原则)
├── icon.svg             # 插件图标
├── commands/
│   ├── plan-flight.md       # /plan-flight 工作流
│   ├── inspect-report.md    # /inspect-report 工作流
│   └── airspace-brief.md    # /airspace-brief 工作流
└── README.md
```

所有工具均为 `readOnly: true`,不直接修改系统。生成文件(航点 CSV、巡检报告等)由 Agent 通过 `write_file` 工具完成,用户可审查确认。

## 许可证

MIT
