// PlatformIO 集成开发插件 —— 工具集
// Tool 接口签名见 src/main/tools.ts: Tool { name; description; parameters; readOnly?; run(args, ctx) }
// ctx.cwd = 当前会话工作目录; ctx.confirm(cmd) 让用户确认 shell 命令。
//
// 工具列表:
//   1. pio_check     — 检测 PlatformIO CLI 是否安装 + 版本信息
//   2. pio_init      — 初始化 PlatformIO 项目(生成 platformio.ini + 目录结构)
//   3. pio_compile   — 编译项目(读取 platformio.ini 配置)
//   4. pio_upload    — 编译 + 烧录到设备
//   5. pio_monitor   — 串口监控(采样 N 秒输出)
//   6. pio_lib       — 库管理(搜索/安装/列表)
//
// 与 arduino-dev 的关键差异:
//   - arduino-cli 每次编译需传 --fqbn;PIO 读 platformio.ini 配置,编译只需 pio run
//   - PIO 支持多环境([env:xxx]),可用 -e 选择
//   - PIO 项目结构固定: src/main.cpp + platformio.ini + lib/ + include/
//   - PIO 支持更多框架(Arduino/ESP-IDF/STM32Cube/FreeRTOS 等)

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── 辅助:shell 执行 ──────────────────────────────────────
function shellExec(command, cwd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stdout: stdout || '', stderr: stderr || '', code: err.code || -1 });
      } else {
        resolve({ ok: true, stdout, stderr, code: 0 });
      }
    });
  });
}

// ── 辅助:检测 pio 是否可用 ────────────────────────────────
async function checkPio(ctx) {
  const cmd = process.platform === 'win32' ? 'pio --version' : 'pio --version';
  const r = await shellExec(cmd, ctx.cwd, 10000);
  if (!r.ok) {
    return {
      available: false,
      hint: 'PlatformIO CLI 未安装。安装方式:\n  pip install platformio\n  或通过 VSCode PlatformIO 扩展自带的 CLI\n  Windows: ~\\.platformio\\penv\\Scripts\\pio.exe',
    };
  }
  return { available: true, version: r.stdout.trim() };
}

// ── 辅助:检测是否 Windows ─────────────────────────────────
const isWin = process.platform === 'win32';

// ── 工具 1: 检测 PlatformIO 环境 ──────────────────────────
// Tool 1: pio_check — verify PlatformIO CLI is installed and show version.
const pioCheck = {
  name: 'pio_check',
  description: '检测 PlatformIO CLI 是否已安装并返回版本信息。如果未安装,给出安装指引。',
  parameters: {
    type: 'object',
    properties: {},
  },
  readOnly: true,
  async run(_args, ctx) {
    const pio = await checkPio(ctx);
    const lines = ['🔧 PlatformIO 环境检测:\n'];

    if (pio.available) {
      lines.push(`✅ 已安装: ${pio.version}`);
      lines.push('\n💡 常用命令:');
      lines.push('  pio project init --board <board_id>  # 初始化项目');
      lines.push('  pio run                              # 编译');
      lines.push('  pio run -t upload                    # 烧录');
      lines.push('  pio device monitor                   # 串口监控');
      lines.push('  pio pkg search <keyword>             # 搜索库');
    } else {
      lines.push('❌ PlatformIO CLI 未安装\n');
      lines.push(pio.hint);
    }

    return lines.join('\n');
  },
};

// ── 工具 2: 初始化 PlatformIO 项目 ────────────────────────
// Tool 2: pio_init — initialize a PlatformIO project with board + framework.
const pioInit = {
  name: 'pio_init',
  description: '初始化 PlatformIO 项目。生成 platformio.ini + src/main.cpp + lib/ + include/ 标准目录结构。支持指定开发板 ID 和框架。',
  parameters: {
    type: 'object',
    properties: {
      board: {
        type: 'string',
        description: 'PlatformIO 板子 ID,如 esp32-s3-devkitc-1 / esp32-c3-devkitm-1 / nodemcu-32s / nucleo_f401re',
      },
      framework: {
        type: 'string',
        description: '框架: arduino(默认) / espidf / stm32cube / freertos',
      },
      project_dir: {
        type: 'string',
        description: '项目目录(默认当前工作目录)',
      },
      project_name: {
        type: 'string',
        description: '项目名称(用于生成的 main.cpp 注释头)',
      },
    },
    required: ['board'],
  },
  readOnly: false,
  async run(args, ctx) {
    const pio = await checkPio(ctx);
    if (!pio.available) return `❌ PlatformIO CLI 未安装\n\n${pio.hint}`;

    const board = args.board;
    const framework = args.framework || 'arduino';
    const projDir = args.project_dir || ctx.cwd;
    const projName = args.project_name || path.basename(projDir);

    await ctx.confirm(`初始化 PlatformIO 项目:\n  板子: ${board}\n  框架: ${framework}\n  目录: ${projDir}`);

    // pio project init --board <board>
    const initCmd = `pio project init --board ${board} -d "${projDir}"`;
    const r = await shellExec(initCmd, ctx.cwd, 30000);

    if (!r.ok) {
      return `❌ 项目初始化失败:\n${r.stderr || r.stdout}\n\n可能原因: 板子 ID 不正确,用 \`pio boards\` 查看支持的板子。`;
    }

    // 写入 main.cpp 骨架(如果不存在)
    const srcDir = path.join(projDir, 'src');
    const mainFile = path.join(srcDir, 'main.cpp');
    if (!fs.existsSync(mainFile)) {
      const skeleton = `/*
 * ${projName}
 * Board: ${board}
 * Framework: ${framework}
 * Created: ${new Date().toISOString().slice(0, 10)}
 */

#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("[${projName}] Boot OK");
  // TODO: 初始化代码 / Initialization
}

void loop() {
  // TODO: 主循环 / Main loop
  delay(1000);
}
`;
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(mainFile, skeleton);
    }

    // 更新 platformio.ini 加入 framework(默认生成的可能没有)
    const iniPath = path.join(projDir, 'platformio.ini');
    if (fs.existsSync(iniPath)) {
      let ini = fs.readFileSync(iniPath, 'utf8');
      // 确保有 framework = 指定
      if (!/framework\s*=/.test(ini)) {
        ini = ini.replace(/(\[env:[^\]]+\]\n)/g, `$1framework = ${framework}\n`);
        fs.writeFileSync(iniPath, ini);
      }
    }

    const lines = [
      `✅ PlatformIO 项目已初始化`,
      ``,
      `📋 项目信息:`,
      `  板子: ${board}`,
      `  框架: ${framework}`,
      `  目录: ${projDir}`,
      ``,
      `📁 项目结构:`,
      `  ${projDir}/`,
      `  ├── platformio.ini   # 项目配置`,
      `  ├── src/main.cpp      # 主程序`,
      `  ├── lib/              # 项目本地库`,
      `  ├── include/          # 头文件`,
      `  └── test/             # 单元测试`,
      ``,
      `🔄 下一步: 使用 pio_compile 编译项目`,
    ];

    return lines.join('\n');
  },
};

// ── 工具 3: 编译项目 ──────────────────────────────────────
// Tool 3: pio_compile — build the PlatformIO project.
const pioCompile = {
  name: 'pio_compile',
  description: '编译 PlatformIO 项目。自动读取 platformio.ini 配置。支持指定环境(多 env 配置)。',
  parameters: {
    type: 'object',
    properties: {
      environment: {
        type: 'string',
        description: '指定编译的 environment(platformio.ini 中 [env:xxx])。不填则编译默认环境。',
      },
      project_dir: {
        type: 'string',
        description: '项目目录(默认当前工作目录)',
      },
    },
  },
  readOnly: false,
  async run(args, ctx) {
    const pio = await checkPio(ctx);
    if (!pio.available) return `❌ PlatformIO CLI 未安装\n\n${pio.hint}`;

    const projDir = args.project_dir || ctx.cwd;
    const envFlag = args.environment ? `-e ${args.environment}` : '';

    // 检查 platformio.ini 是否存在
    const iniPath = path.join(projDir, 'platformio.ini');
    if (!fs.existsSync(iniPath)) {
      return `❌ 未找到 platformio.ini\n目录 ${projDir} 不是 PlatformIO 项目。\n用 pio_init 先初始化项目。`;
    }

    await ctx.confirm(`编译 PlatformIO 项目:\n  目录: ${projDir}\n  环境: ${args.environment || '默认'}`);

    const cmd = `pio run ${envFlag} -d "${projDir}"`;
    const r = await shellExec(cmd, ctx.cwd, 300000); // 5 分钟超时,首次编译会下载工具链

    // 解析编译结果
    const output = r.stdout + r.stderr;
    const lines = [];

    if (r.ok && /(SUCCESS|Memory Usage|RAM:|Flash:)/i.test(output)) {
      lines.push('✅ 编译成功\n');

      // 提取内存使用
      const ramMatch = output.match(/RAM:\s+([\d.]+%\s+used)/i);
      const flashMatch = output.match(/Flash:\s+([\d.]+%\s+used)/i);
      if (ramMatch) lines.push(`  RAM: ${ramMatch[1]}`);
      if (flashMatch) lines.push(`  Flash: ${flashMatch[1]}`);
    } else if (!r.ok) {
      lines.push('❌ 编译失败\n');

      // 提取错误行
      const errors = output.split('\n')
        .filter((l) => /error:|Error\d+|fatal:|FAILED/i.test(l))
        .slice(0, 15);
      if (errors.length > 0) {
        lines.push('错误信息:');
        errors.forEach((e) => lines.push(`  ${e.trim()}`));
      } else {
        lines.push(output.split('\n').slice(-20).join('\n'));
      }

      lines.push('\n💡 常见原因:');
      lines.push('  - 首次编译需下载工具链(可能超时,重试一次)');
      lines.push('  - 库未安装:检查 platformio.ini 的 lib_deps');
      lines.push('  - 板子不支持:确认 board ID 正确');
    }

    return lines.join('\n');
  },
};

// ── 工具 4: 编译 + 烧录 ──────────────────────────────────
// Tool 4: pio_upload — compile and upload firmware to device.
const pioUpload = {
  name: 'pio_upload',
  description: '编译并烧录固件到设备。自动编译 + 通过串口烧录。',
  parameters: {
    type: 'object',
    properties: {
      environment: {
        type: 'string',
        description: '指定 environment(多 env 场景)',
      },
      project_dir: {
        type: 'string',
        description: '项目目录(默认当前工作目录)',
      },
      upload_port: {
        type: 'string',
        description: '指定烧录端口(覆盖 platformio.ini 中的 upload_port)。如 COM3 / /dev/ttyUSB0',
      },
    },
  },
  readOnly: false,
  async run(args, ctx) {
    const pio = await checkPio(ctx);
    if (!pio.available) return `❌ PlatformIO CLI 未安装\n\n${pio.hint}`;

    const projDir = args.project_dir || ctx.cwd;
    const envFlag = args.environment ? `-e ${args.environment}` : '';
    const portFlag = args.upload_port ? `--upload-port ${args.upload_port}` : '';

    const iniPath = path.join(projDir, 'platformio.ini');
    if (!fs.existsSync(iniPath)) {
      return `❌ 未找到 platformio.ini\n目录 ${projDir} 不是 PlatformIO 项目。`;
    }

    await ctx.confirm(`编译 + 烧录:\n  目录: ${projDir}\n  环境: ${args.environment || '默认'}\n  端口: ${args.upload_port || '自动检测'}`);

    const cmd = `pio run -t upload ${envFlag} ${portFlag} -d "${projDir}"`;
    const r = await shellExec(cmd, ctx.cwd, 300000);

    const output = r.stdout + r.stderr;
    const lines = [];

    if (r.ok && /(Writing at|Hash of data|SUCCESS|Uploading|Writing|encrypting)/i.test(output)) {
      lines.push('✅ 烧录成功\n');
      // 提取写入进度
      const writeMatch = output.match(/Writing at 0x[\dA-Fa-f]+.*?\((\d+)%\)/g);
      if (writeMatch) {
        const last = writeMatch[writeMatch.length - 1];
        lines.push(`  ${last.trim()}`);
      }
      lines.push('\n💡 用 pio_monitor 查看串口输出');
    } else if (!r.ok) {
      lines.push('❌ 烧录失败\n');
      const errors = output.split('\n')
        .filter((l) => /error|failed|FAIL|cannot|refused|not found|timeout/i.test(l))
        .slice(0, 10);
      if (errors.length > 0) {
        errors.forEach((e) => lines.push(`  ${e.trim()}`));
      } else {
        lines.push(output.split('\n').slice(-15).join('\n'));
      }
      lines.push('\n💡 排查:');
      lines.push('  1. 设备是否已连接(用 pio device list 查看)');
      lines.push('  2. 端口是否被占用(关闭其他串口监视器)');
      lines.push('  3. BOOT 按钮是否需要按住(ESP32 手动烧录模式)');
    }

    return lines.join('\n');
  },
};

// ── 工具 5: 串口监控 ──────────────────────────────────────
// Tool 5: pio_monitor — sample serial output for N seconds.
const pioMonitor = {
  name: 'pio_monitor',
  description: '采样设备串口输出(指定秒数)。使用 PlatformIO 的 device monitor,自动读取 platformio.ini 中的 monitor_speed 和 monitor_port。',
  parameters: {
    type: 'object',
    properties: {
      duration: {
        type: 'number',
        description: '采样时长(秒,默认 10,最大 30)',
      },
      port: {
        type: 'string',
        description: '指定串口端口(覆盖配置)。如 COM3 / /dev/ttyUSB0',
      },
      baudrate: {
        type: 'number',
        description: '波特率(覆盖配置,默认 115200)',
      },
      project_dir: {
        type: 'string',
        description: '项目目录(默认当前工作目录)',
      },
    },
  },
  readOnly: false,
  async run(args, ctx) {
    const pio = await checkPio(ctx);
    if (!pio.available) return `❌ PlatformIO CLI 未安装\n\n${pio.hint}`;

    const projDir = args.project_dir || ctx.cwd;
    const duration = Math.min(Math.max(Number(args.duration) || 10, 1), 30);
    const portFlag = args.port ? `-p ${args.port}` : '';
    const baudFlag = args.baudrate ? `-b ${args.baudrate}` : '';

    await ctx.confirm(`串口监控:\n  时长: ${duration}s\n  端口: ${args.port || '自动'}\n  波特率: ${args.baudrate || '自动'}`);

    // pio device monitor 是持续运行的, 必须 timeout 杀掉。
    // Windows 没有 `timeout` 命令的管道模式, 用 PowerShell 控制生命周期。
    // macOS/Linux: timeout + cat 管道。
    const cmd = process.platform === 'win32'
      ? `powershell -NoProfile -Command "$p = Start-Process -NoNewWindow -PassThru -FilePath pio -ArgumentList 'device','monitor','${portFlag}','${baudFlag}','-d','${projDir.replace(/\\/g, '/')}'; Start-Sleep -Seconds ${duration}; Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue"`
      : `timeout ${duration} pio device monitor ${portFlag} ${baudFlag} -d "${projDir}" 2>&1 || true`;

    const r = await shellExec(cmd, ctx.cwd, (duration + 5) * 1000);

    const lines = [`📡 串口监控 (${duration}s):\n`];
    const output = (r.stdout || '').trim();
    if (output) {
      lines.push(output);
    } else {
      lines.push('(无输出 — 设备可能未发送数据,检查波特率和 monitor_speed 配置)');
    }

    return lines.join('\n');
  },
};

// ── 工具 6: 库管理 ────────────────────────────────────────
// Tool 6: pio_lib — search, install, or list libraries.
const pioLib = {
  name: 'pio_lib',
  description: 'PlatformIO 库管理:搜索、安装、列出已装库。安装时会自动写入 platformio.ini 的 lib_deps。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'install', 'list'],
        description: '操作类型: search=搜索库, install=安装库, list=列出已安装库',
      },
      name: {
        type: 'string',
        description: '库名(search/install 时必填)。如 "Adafruit BME280" / "bme280"',
      },
      project_dir: {
        type: 'string',
        description: '项目目录(install 时写入 lib_deps,默认当前工作目录)',
      },
    },
    required: ['action'],
  },
  readOnly: false,
  async run(args, ctx) {
    const pio = await checkPio(ctx);
    if (!pio.available) return `❌ PlatformIO CLI 未安装\n\n${pio.hint}`;

    const action = args.action;
    const name = args.name || '';
    const projDir = args.project_dir || ctx.cwd;

    if (action === 'search') {
      if (!name) return '❌ 请提供要搜索的库名';
      const r = await shellExec(`pio pkg search --library "${name}"`, ctx.cwd, 30000);
      if (!r.ok) return `❌ 搜索失败:\n${r.stderr}`;
      // 截取前 40 行避免过长
      const lines = r.stdout.split('\n').slice(0, 40);
      return `🔍 搜索 "${name}":\n\n${lines.join('\n')}`;
    }

    if (action === 'install') {
      if (!name) return '❌ 请提供要安装的库名';
      await ctx.confirm(`安装库: ${name}\n写入 ${projDir}/platformio.ini 的 lib_deps`);

      const r = await shellExec(`pio pkg install --library "${name}" -d "${projDir}"`, ctx.cwd, 60000);
      if (!r.ok) {
        return `❌ 安装失败:\n${r.stderr || r.stdout}\n\n可能原因: 库名不正确(用 search 先查找)`;
      }
      return `✅ 库 "${name}" 已安装并写入 lib_deps`;
    }

    if (action === 'list') {
      const r = await shellExec(`pio pkg list -d "${projDir}"`, ctx.cwd, 15000);
      if (!r.ok) return `❌ 列表失败:\n${r.stderr}`;
      return `📦 已安装的库:\n\n${r.stdout}`;
    }

    return `❌ 未知操作: ${action}`;
  },
};

// ── 导出 ────────────────────────────────────────────────────
module.exports = {
  tools: [pioCheck, pioInit, pioCompile, pioUpload, pioMonitor, pioLib],
};
