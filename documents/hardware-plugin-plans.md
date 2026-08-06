# KinetAios 硬件开发插件方案

> 状态：**规划中，尚未实现**。本文档供后续开发参考。

## 背景

KinetAios 插件系统支持 5 种贡献点：**Tools（Node 模块）、Slash Commands、System Prompt、Panel（iframe）、Hooks**。Tools 跑在 main 进程，可 `require('child_process')`、`require('https')` 等 Node 内置模块，能直接操作串口、调外部 CLI、跑仿真。

---

## 方案 1：串口/设备通信工具

**场景**：AI 直接与 MCU/开发板交互——读传感器、发指令、刷固件

**目录结构**：

```
plugins/hardware-dev/
  plugin.json
  index.js          ← tools
  system-prompt.md  ← 嵌入式领域知识
  commands/
    flash.md        ← /flash — 编译+烧录一键流程
    monitor.md      ← /monitor — 串口监控+AI分析
```

**Tools 设计**：

| 工具 | 作用 | 实现方式 |
|------|------|---------|
| `serial_list` | 列出可用串口 | spawn `serialport list` 或解析 `/dev/tty*` |
| `serial_send` | 发送命令到设备 | `node-serialport` 或 spawn `echo > /dev/ttyUSB0` |
| `serial_read` | 读取串口输出 | 持续读 + 返回缓冲区 |
| `flash_firmware` | 烧录固件 | spawn `esptool.py` / `avrdude` / `openocd` |
| `device_info` | 读取设备信息 | USB 描述符解析 (`lsusb` / `systemprofiler`) |

**关键约束**：`node-serialport` 是 native module，需要和 Electron ABI 匹配编译。**替代方案**：全部用 `child_process` spawn 外部 CLI（`esptool`、`picocom`），零编译开销。

---

## 方案 2：嵌入式代码生成 + 编译验证闭环

**场景**：用户描述需求 → AI 生成 C/C++ 固件代码 → 自动编译验证 → 报错反馈循环

**核心优势**：直接发挥 Direct 引擎的 ReAct 循环——AI 写代码 → 编译 → 修错 → 再编译，天然闭环。

**目录结构**：

```
plugins/embedded-dev/
  index.js
  system-prompt.md  ← 嵌入式编码规范、寄存器知识、平台 SDK 文档
  commands/
    build.md        ← /build — 编译当前项目
    debug.md        ← /debug — 分析编译错误
```

**Tools 设计**：

| 工具 | 作用 | 实现 |
|------|------|------|
| `compile` | 编译固件项目 | spawn `make` / `idf.py build` / `arduino-cli compile` |
| `read_schematic` | 读取引脚定义 | 解析 `.ioc`（STM32CubeMX）/ `platformio.ini` |
| `pin_map` | 查询芯片引脚映射 | 内置常用芯片 JSON 数据 |
| `logic_analyze` | 分析逻辑分析仪数据 | 解析 `.sal`（Saleae）/ `.csv` 导出文件 |

**System Prompt 要点**：

```markdown
你是嵌入式固件工程师。规则：
- 所有代码必须包含错误处理（HAL_GetTick() 超时检查）
- GPIO 初始化前先检查引脚冲突
- 中断处理函数保持最短
- 串口/UART 波特率默认 115200
- 使用 /build 命令验证编译
```

---

## 方案 3：原理图/PCB 辅助设计（Panel 型）

**场景**：可视化展示电路设计，AI 辅助器件选型、连线检查

**目录结构**：

```
plugins/circuit-design/
  plugin.json
  panel.html        ← 原理图可视化面板（SVG/KiCad 渲染）
  index.js          ← BOM 解析、器件查询工具
  system-prompt.md  ← 电路设计知识
```

**Panel 能力**：
- 读 `.kicad_sch`（KiCad 原理图）渲染为 SVG
- 高亮 AI 指出的错误连线
- 器件选型对比表格
- 注意：panel iframe 是 sandbox，不能直接读文件，需通过 `window.kinet` IPC → main 进程读

**Tools 设计**：

| 工具 | 作用 |
|------|------|
| `parse_schematic` | 解析 KiCad/Altium 原理图文件，提取器件列表和连线 |
| `query_part` | 查询 LCSC/立创商城/贸泽 器件参数（`https` 请求） |
| `check_design_rules` | DRC 检查——最小线宽、安全间距、过孔规格 |
| `estimate_cost` | BOM 成本估算 |

---

## 方案 4：Arduino / PlatformIO 集成

**场景**：面向 Arduino/ESP32/STM32duino 用户，零配置硬件开发

**核心思路**：包装 `arduino-cli` 或 `platformio` CLI 为 AI 工具

**Tools 示例**：

```javascript
{
  name: 'arduino_compile',
  description: '编译 Arduino 项目（指定开发板）',
  parameters: {
    type: 'object',
    properties: {
      board: { type: 'string', description: '开发板 FQBN, 如 esp32:esp32:esp32s3' },
      sketch_dir: { type: 'string' }
    },
    required: ['board', 'sketch_dir']
  },
  async run(args, ctx) {
    const { execSync } = require('child_process');
    await ctx.confirm(`arduino-cli compile --fqbn ${args.board} ${args.sketch_dir}`);
    const out = execSync(`arduino-cli compile --fqbn ${args.board} "${args.sketch_dir}"`, 
      { cwd: ctx.cwd, encoding: 'utf-8', timeout: 60000 });
    return out;
  }
}
```

| 工具 | 说明 |
|------|------|
| `arduino_compile` | 编译指定开发板 |
| `arduino_upload` | 烧录到设备 |
| `arduino_monitor` | 串口监控 |
| `arduino_search` | 搜索可用库 |
| `arduino_install` | 安装库/开发板支持 |

**Slash Commands**：
- `/new-project <芯片型号>` — 生成项目骨架代码
- `/wiring` — 描述接线方案（文字 + ASCII 图）

---

## 方案 5：仿真集成（Renode / Wokwi）

**场景**：不需要实体硬件，AI 生成代码后直接仿真验证

**方案 A — Renode（嵌入式仿真器，开源）**：

```javascript
{
  name: 'renode_simulate',
  description: '用 Renode 仿真固件',
  async run(args, ctx) {
    // spawn renode --disable-product-text --exec "i @build/firmware.elf; start"
    // 解析 UART 输出返回给 AI
  }
}
```

**方案 B — Wokwi（在线仿真，API 驱动）**：

Wokwi 提供 REST API，可以创建仿真、上传代码、读取串口输出、截图。

```javascript
{
  name: 'wokwi_run',
  description: '在 Wokwi 上运行 Arduino 代码并返回结果',
  async run(args, ctx) {
    const https = require('https');
    // POST https://wokwi.com/api/... → 返回串口输出 + 状态
  }
}
```

**优势**：零硬件依赖，CI 友好，AI 可以反复迭代验证。

---

## 方案 6：IoT 协议工具集

**场景**：MQTT / Modbus / CAN 总线通信调试

| 工具 | 实现 |
|------|------|
| `mqtt_pub` | 发布 MQTT 消息（spawn `mosquitto_pub` 或 Node mqtt 库） |
| `mqtt_sub` | 订阅并采集 N 条消息 |
| `modbus_read` | Modbus RTU/TCP 寄存器读取 |
| `modbus_write` | 写寄存器 |
| `can_sniff` | CAN 总线抓包（spawn `candump`） |
| `parse_can` | 解析 DBC 文件，将原始 CAN 帧翻译为信号值 |

---

## 优先级建议

| 优先级 | 方案 | 理由 |
|--------|------|------|
| ⭐⭐⭐ | 方案 4 (Arduino/PlatformIO) | 用户基数最大，CLI 成熟，1 个 plugin.json + index.js 就能跑 |
| ⭐⭐ | 方案 2 (编译验证闭环) | 直接发挥 ReAct 循环——AI 写代码→编译→修错→再编译 |
| ⭐⭐ | 方案 1 (串口通信) | 基础设施，但需处理 native module 兼容性 |
| ⭐ | 方案 3/5/6 | 偏专业领域，按需扩展 |

**最小可行路径**：先做方案 4，一个 `arduino-dev` 插件，贡献 tools（compile/upload/monitor）+ system prompt + slash commands，复制 `low-altitude` 插件结构改造。
