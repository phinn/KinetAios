// Arduino / ESP32 / STM32duino 硬件开发插件 —— 工具集
// Tool 接口签名见 src/main/tools.ts: Tool { name; description; parameters; readOnly?; run(args, ctx) }
// ctx.cwd = 当前会话工作目录; ctx.confirm(cmd) 让用户确认 shell 命令。
//
// 工具列表:
//   1. board_list      — 列出已安装的开发板核心 + 已连接设备
//   2. arduino_compile — 编译指定开发板的项目
//   3. arduino_upload  — 编译并烧录到设备
//   4. serial_monitor  — 读取串口输出(N 秒采样)
//   5. lib_search      — 搜索 Arduino 库
//   6. lib_install     — 安装 Arduino 库 / 开发板核心
//
// 所有 CLI 操作通过 child_process spawn 外部 arduino-cli,零 native 依赖。
// compile / upload 调用前会 ctx.confirm() 让用户确认命令行。

const { exec } = require('child_process');

// ── 辅助:shell 执行 (带超时) ──────────────────────────────
// Utility: exec with timeout, returns { ok, stdout, stderr, code }.
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

// ── 辅助:检测 arduino-cli 是否可用 ────────────────────────
// Check if arduino-cli is installed and accessible.
async function checkCli() {
  const r = await shellExec('arduino-cli version', undefined, 10000);
  if (!r.ok) {
    return {
      available: false,
      hint: 'arduino-cli 未安装或不在 PATH 中。\n' +
            '安装方法:\n' +
            '  Windows: winget install Arduino.arduino-cli\n' +
            '  macOS:   brew install arduino-cli\n' +
            '  Linux:   curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh\n' +
            '安装后重启 KinetAios 使新的 PATH 生效。',
    };
  }
  return { available: true, version: r.stdout.trim() };
}

// ── 工具 1: 列出开发板 + 已连接设备 ─────────────────────────
// Tool 1: board_list — list installed cores and detected serial devices.
const boardList = {
  name: 'board_list',
  description: '列出已安装的 Arduino 开发板核心(boards)和当前连接的串口设备。用于查看可用板型和端口。无需参数。',
  parameters: {
    type: 'object',
    properties: {},
  },
  readOnly: true,
  async run() {
    const cli = await checkCli();
    if (!cli.available) return cli.hint;

    // 并行查核心列表 + 串口列表
    const [cores, ports] = await Promise.all([
      shellExec('arduino-cli board listall', undefined, 15000),
      shellExec('arduino-cli board list', undefined, 15000),
    ]);

    const lines = [];
    lines.push('📋 开发板核心列表:');
    if (cores.ok && cores.stdout.trim()) {
      lines.push(cores.stdout.trim());
    } else {
      lines.push('  (未安装任何核心,使用 lib_install 安装,例如:esp32:esp32)');
    }

    lines.push('');
    lines.push('🔌 已连接设备:');
    if (ports.ok && ports.stdout.trim()) {
      // arduino-cli board list 输出表格,过滤表头和空行
      lines.push(ports.stdout.trim());
    } else {
      lines.push('  (未检测到串口设备)');
      if (ports.stderr) lines.push(`  ${ports.stderr.trim()}`);
    }

    return lines.join('\n');
  },
};

// ── 工具 2: 编译项目 ──────────────────────────────────────
// Tool 2: arduino_compile — compile a sketch for a specific board FQBN.
const arduinoCompile = {
  name: 'arduino_compile',
  description: '编译 Arduino / ESP32 项目。指定开发板 FQBN 和项目目录,返回编译结果(含错误信息)。编译失败时返回编译器错误,便于 AI 分析修错。',
  parameters: {
    type: 'object',
    properties: {
      fqbn: {
        type: 'string',
        description: '开发板 FQBN (Fully Qualified Board Name),如 esp32:esp32:esp32s3、esp32:esp32:esp32、arduino:avr:uno、arduino:samd:nano_33_iot',
      },
      sketch_dir: {
        type: 'string',
        description: '项目目录路径(含 .ino 文件的目录)。留空则用当前工作目录。',
      },
    },
    required: ['fqbn'],
  },
  readOnly: false,
  async run(args, ctx) {
    const cli = await checkCli();
    if (!cli.available) return cli.hint;

    const fqbn = args.fqbn;
    const sketchDir = args.sketch_dir || ctx.cwd;

    const cmd = `arduino-cli compile --fqbn ${fqbn} --warnings default "${sketchDir}"`;
    await ctx.confirm(`即将执行编译:\n  ${cmd}`);

    const r = await shellExec(cmd, ctx.cwd, 180000); // 编译可能较慢,3 分钟超时

    if (r.ok) {
      // 提取关键信息:Flash/RAM 使用量
      const flashMatch = r.stdout.match(/Sketch uses ([\d.]+).*?bytes.*?(\d+)%/s);
      const ramMatch = r.stdout.match(/Global variables use ([\d.]+).*?bytes.*?(\d+)%/s);
      const lines = ['✅ 编译成功!\n'];
      if (flashMatch) lines.push(`📦 Flash: ${flashMatch[1]} bytes (${flashMatch[2]}%)`);
      if (ramMatch) lines.push(`💾 RAM:   ${ramMatch[1]} bytes (${ramMatch[2]}%)`);
      lines.push(`\n完整输出:\n${r.stdout.trim().slice(-500)}`);
      return lines.join('\n');
    } else {
      // 编译失败 —— 返回错误信息让 AI 分析
      const lines = ['❌ 编译失败!\n'];
      // 提取错误行(通常含 "error:")
      const errorLines = (r.stderr + r.stdout).split('\n').filter((l) => /error:/i.test(l));
      if (errorLines.length > 0) {
        lines.push('错误摘要:');
        errorLines.slice(0, 10).forEach((l) => lines.push(`  ${l.trim()}`));
        lines.push('');
      }
      // 附完整输出(截断,避免太长)
      const full = (r.stderr + r.stdout).trim();
      lines.push(`完整输出(末尾 1500 字符):\n${full.slice(-1500)}`);
      return lines.join('\n');
    }
  },
};

// ── 工具 3: 编译并烧录 ────────────────────────────────────
// Tool 3: arduino_upload — compile and upload firmware to a device via serial port.
const arduinoUpload = {
  name: 'arduino_upload',
  description: '编译并烧录固件到开发板。指定 FQBN、串口端口和项目目录,自动编译后上传。烧录前需用户确认命令。',
  parameters: {
    type: 'object',
    properties: {
      fqbn: {
        type: 'string',
        description: '开发板 FQBN,如 esp32:esp32:esp32s3',
      },
      port: {
        type: 'string',
        description: '串口端口,如 COM3 (Windows) 或 /dev/ttyUSB0 (Linux/macOS)',
      },
      sketch_dir: {
        type: 'string',
        description: '项目目录路径。留空则用当前工作目录。',
      },
      baudrate: {
        type: 'number',
        description: '上传波特率(ESP32 默认 921600,Arduino AVR 默认 115200)',
      },
    },
    required: ['fqbn', 'port'],
  },
  readOnly: false,
  async run(args, ctx) {
    const cli = await checkCli();
    if (!cli.available) return cli.hint;

    const fqbn = args.fqbn;
    const port = args.port;
    const sketchDir = args.sketch_dir || ctx.cwd;
    const baud = args.baudrate || 921600;

    const cmd = `arduino-cli compile --fqbn ${fqbn} -u -p ${port} -b ${fqbn} --upload-baudrate ${baud} "${sketchDir}"`;
    await ctx.confirm(`即将编译并烧录固件:\n  ${cmd}`);

    const r = await shellExec(cmd, ctx.cwd, 300000); // 编译+烧录,5 分钟超时

    if (r.ok) {
      // 检查是否实际烧录成功(输出含 "Writing at" 或 "Hash of data verified" 等)
      const verified = /verified|Hash of data|Wrote|Uploading/si.test(r.stdout);
      const lines = ['✅ 编译并烧录成功!\n'];
      if (verified) {
        lines.push('设备已成功写入固件,可以打开串口监控器查看运行输出。');
      } else {
        lines.push('⚠️ 命令执行完成,但未检测到烧录成功标志,请检查输出确认:');
      }
      lines.push(`\n输出:\n${(r.stdout + r.stderr).trim().slice(-800)}`);
      return lines.join('\n');
    } else {
      const lines = ['❌ 烧录失败!\n'];
      const errorLines = (r.stderr + r.stdout).split('\n').filter((l) => /error|failed|fail|cannot|refused/i.test(l));
      if (errorLines.length > 0) {
        lines.push('错误摘要:');
        errorLines.slice(0, 10).forEach((l) => lines.push(`  ${l.trim()}`));
        lines.push('');
      }
      lines.push(`完整输出(末尾 1500 字符):\n${(r.stderr + r.stdout).trim().slice(-1500)}`);
      return lines.join('\n');
    }
  },
};

// ── 工具 4: 串口监控 ──────────────────────────────────────
// Tool 4: serial_monitor — sample serial output for N seconds.
// 不用 arduino-cli monitor(它是阻塞的),改用一次性读取方式:
// Windows: PowerShell 读串口 N 秒; macOS/Linux: timeout + cat
const serialMonitor = {
  name: 'serial_monitor',
  description: '读取串口输出(采样指定秒数)。用于查看设备运行日志、调试串口输出。需指定端口和采样时长(默认 5 秒)。默认波特率 115200。',
  parameters: {
    type: 'object',
    properties: {
      port: {
        type: 'string',
        description: '串口端口,如 COM3 / /dev/ttyUSB0',
      },
      baudrate: {
        type: 'number',
        description: '波特率(默认 115200)',
      },
      duration: {
        type: 'number',
        description: '采样时长(秒, 默认 5, 最大 30)',
      },
    },
    required: ['port'],
  },
  readOnly: false,
  async run(args, ctx) {
    const port = args.port;
    const baud = args.baudrate || 115200;
    const duration = Math.min(Math.max(Number(args.duration) || 5, 1), 30);

    // 跨平台串口读取:Windows 用 PowerShell,其它用 timeout+stty+cat
    const isWin = process.platform === 'win32';
    let cmd;

    if (isWin) {
      // PowerShell: 打开串口读 N 秒
      cmd = `powershell -Command "$port = New-Object System.IO.Ports.SerialPort '${port}',${baud}; $port.Open(); Start-Sleep -Seconds ${duration}; $port.ReadExisting(); $port.Close()"`;
    } else {
      // macOS / Linux: stty 设置波特率,timeout 读
      cmd = `stty -f ${port} ${baud} raw -echo; timeout ${duration} cat ${port} || true`;
    }

    // 串口监控不需要确认(只读操作),但跨平台命令可能有风险,加 confirm
    await ctx.confirm(`即将读取串口 ${port} @${baud} baud,持续 ${duration} 秒`);

    const r = await shellExec(cmd, ctx.cwd, (duration + 5) * 1000);

    if (r.ok || r.code === 124) {
      // timeout 命令正常退出码是 124
      const output = (r.stdout || '').trim();
      if (output) {
        return `📡 串口 ${port} @${baud} baud — 采样 ${duration}s:\n\n${output}`;
      } else {
        return `📡 串口 ${port} @${baud} baud — 采样 ${duration}s,无输出。\n可能原因:\n  1. 设备未输出数据(检查固件是否有 Serial.print)\n  2. 波特率不匹配\n  3. 串口被其他程序占用`;
      }
    } else {
      return `❌ 读取串口失败: ${(r.stderr || r.stdout || '').trim()}\n请检查端口名和设备连接。`;
    }
  },
};

// ── 工具 5: 搜索 Arduino 库 ───────────────────────────────
// Tool 5: lib_search — search Arduino Library Manager.
const libSearch = {
  name: 'lib_search',
  description: '在 Arduino Library Manager 中搜索库。返回库名、作者、版本、简介。用于查找可用的第三方库。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词,如 "DHT"、"WiFi"、"MQTT"、"servo"',
      },
    },
    required: ['query'],
  },
  readOnly: true,
  async run(args) {
    const cli = await checkCli();
    if (!cli.available) return cli.hint;

    const r = await shellExec(`arduino-cli lib search "${args.query}"`, undefined, 15000);

    if (r.ok && r.stdout.trim()) {
      return `🔍 搜索 "${args.query}" 的结果:\n\n${r.stdout.trim()}`;
    } else {
      return `未找到匹配 "${args.query}" 的库,或搜索失败:\n${(r.stderr || '').trim()}`;
    }
  },
};

// ── 工具 6: 安装库 / 开发板核心 ───────────────────────────
// Tool 6: lib_install — install an Arduino library or board core.
const libInstall = {
  name: 'lib_install',
  description: '安装 Arduino 库(如 "DHT sensor library")或开发板核心 URL(如 "esp32:esp32")。安装前需用户确认。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '库名或核心标识,如 "DHT sensor library" 或 "esp32:esp32"',
      },
    },
    required: ['name'],
  },
  readOnly: false,
  async run(args, ctx) {
    const cli = await checkCli();
    if (!cli.available) return cli.hint;

    // 判断是库还是核心:含 ":" 的视为核心(esp32:esp32),否则视为库
    const isCore = args.name.includes(':');
    const cmd = isCore
      ? `arduino-cli core install "${args.name}"`
      : `arduino-cli lib install "${args.name}"`;

    await ctx.confirm(`即将安装 ${isCore ? '开发板核心' : '库'}:\n  ${cmd}`);

    const r = await shellExec(cmd, ctx.cwd, 300000); // 下载安装可能较慢

    if (r.ok) {
      return `✅ 安装成功: ${args.name}\n\n${r.stdout.trim().slice(-500)}`;
    } else {
      return `❌ 安装失败: ${args.name}\n${(r.stderr || r.stdout || '').trim().slice(-500)}`;
    }
  },
};

// ── 导出 ────────────────────────────────────────────────────
module.exports = {
  tools: [boardList, arduinoCompile, arduinoUpload, serialMonitor, libSearch, libInstall],
};
