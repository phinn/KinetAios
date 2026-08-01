// 串口/设备通信调试插件 —— 工具集
// Tool 接口签名见 src/main/tools.ts: Tool { name; description; parameters; readOnly?; run(args, ctx) }
// ctx.cwd = 当前会话工作目录; ctx.confirm(cmd) 让用户确认 shell 命令。
//
// 工具列表:
//   1. serial_scan   — 扫描可用串口 + USB 设备列表
//   2. serial_send   — 向串口发送数据(文本或十六进制),可选等待响应
//   3. serial_query  — AT 指令一问一答(发送命令 → 读响应 → 返回)
//   4. serial_session — 打开串口持续读 N 秒,期间可发多条命令(交互式采样)
//
// 设计原则: 零 native 依赖,全部通过 child_process 调用系统工具实现。
//   Windows: PowerShell System.IO.Ports.SerialPort
//   macOS/Linux: stty + cat / echo
//
// 与 arduino-dev 插件的关系:
//   arduino-dev.serial_monitor = 只读采样(看设备输出)
//   serial-comm.serial_send    = 主动发数据到设备
//   serial-comm.serial_query   = AT 指令交互(一问一答)
//   serial-comm.serial_session = 持续会话(多发多收)

const { exec } = require('child_process');

// ── 辅助:shell 执行 ──────────────────────────────────────
// Utility: exec with timeout.
function shellExec(command, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 2 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stdout: stdout || '', stderr: stderr || '', code: err.code || -1 });
      } else {
        resolve({ ok: true, stdout, stderr, code: 0 });
      }
    });
  });
}

// ── 辅助:检测是否 Windows ─────────────────────────────────
const isWin = process.platform === 'win32';

// ── 辅助:十六进制字符串 ↔ 原始字节 ────────────────────────
// "48656C6C6F" → "Hello"  /  "Hello" → "48656C6C6F"
function hexToBytes(hex) {
  const clean = hex.replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    return null; // 无效 hex
  }
  return Buffer.from(clean, 'hex');
}

function bytesToHex(buf) {
  return buf.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase();
}

function strToHex(str) {
  return Buffer.from(str, 'utf8').toString('hex').match(/.{1,2}/g).join(' ').toUpperCase();
}

// ── 辅助:跨平台发送+读取串口 ──────────────────────────────
// 核心思路:
//   Windows: PowerShell 打开 SerialPort → 写入 → ReadExisting → 关闭
//   macOS/Linux: stty 配置 → echo 写入 → timeout 读 cat
//
// 因为 child_process 是一次性命令,每次调用都打开/关闭串口,
// 不保持持久连接(保持连接需要长进程 + stream,留给 panel 交互式视图)。

// ── 构造 PowerShell 串口脚本 ───────────────────────────────
// Build PowerShell script for serial port send + read.
function buildPwshScript(port, baud, data, readMs, lineEnding) {
  // lineEnding: crlf(默认) / cr(AT模式) / lf(raw)
  const ending = lineEnding === 'cr' ? '`r' : lineEnding === 'lf' ? '`n' : '`r`n';
  // 转义 PowerShell 字符串中的特殊字符
  const escapedData = data.replace(/'/g, "''").replace(/\r/g, '').replace(/\n/g, '');
  return [
    `try {`,
    `  $port = New-Object System.IO.Ports.SerialPort '${port}',${baud},None,8,one`,
    `  $port.ReadTimeout = ${readMs}`,
    `  $port.Open()`,
    `  Start-Sleep -Milliseconds 100`,
    `  $port.Write('${escapedData}' + '${ending}')`,
    `  Start-Sleep -Milliseconds ${readMs}`,
    `  $output = ""`,
    `  try { while ($port.BytesToRead -gt 0) { $output += $port.ReadExisting(); Start-Sleep -Milliseconds 50 } } catch {}`,
    `  $port.Close()`,
    `  Write-Output $output`,
    `} catch {`,
    `  Write-Output "ERROR: " + $_.Exception.Message`,
    `}`,
  ].join('; ');
}

// ── 构造 Unix 串口脚本 ─────────────────────────────────────
// Build bash script for serial send + read on macOS/Linux.
function buildUnixScript(port, baud, data, readSec, lineEnding) {
  const ending = lineEnding === 'cr' ? '\\r' : lineEnding === 'lf' ? '\\n' : '\\r\\n';
  // stty 配置串口参数 → 用 printf 发送(支持转义)→ timeout cat 读
  return [
    `stty -f ${port} ${baud} cs8 -cstopb -parenb -ixon -ixoff raw -echo 2>/dev/null || stty -F ${port} ${baud} cs8 -cstopb -parenb -ixon -ixoff raw -echo 2>/dev/null`,
    `(printf '${data.replace(/'/g, "'\\''")}${ending}' > ${port} &)`,
    `timeout ${readSec} cat ${port} 2>/dev/null || true`,
  ].join(' && ');
}

// ── 工具 1: 扫描串口 + USB 设备 ────────────────────────────
// Tool 1: serial_scan — list available serial ports and USB devices.
const serialScan = {
  name: 'serial_scan',
  description: '扫描当前可用的串口设备列表。Windows 返回 COM 端口列表,macOS/Linux 返回 /dev/tty* 设备列表。同时检测 USB 设备信息(VID/PID)。无需参数。',
  parameters: {
    type: 'object',
    properties: {},
  },
  readOnly: true,
  async run() {
    let cmd, label;
    if (isWin) {
      // PowerShell 查 COM 端口 + USB 设备
      cmd = `powershell -Command "Get-WmiObject Win32_SerialPort | Select-Object DeviceID,Description | Format-Table -AutoSize; Get-WmiObject Win32_PnPEntity | Where-Object { $_.Name -match 'COM\\\\d+' } | Select-Object Name | Format-Table -AutoSize"`;
      label = 'Windows';
    } else if (process.platform === 'darwin') {
      cmd = `ls -la /dev/cu.* /dev/tty.* 2>/dev/null; echo '---USB---'; system_profiler SPUSBDataType 2>/dev/null | grep -A3 -i 'serial\\|UART\\|CP210\\|CH340\\|FT232\\|USB-to' || true`;
      label = 'macOS';
    } else {
      cmd = `ls -la /dev/ttyUSB* /dev/ttyACM* /dev/ttyS* 2>/dev/null; echo '---USB---'; lsusb 2>/dev/null || ls -la /sys/bus/usb/devices/*/product 2>/dev/null | head -20 || true`;
      label = 'Linux';
    }

    const r = await shellExec(cmd, undefined, 15000);

    const lines = [`📡 串口设备扫描 (${label}):\n`];
    if (r.ok && r.stdout.trim()) {
      lines.push(r.stdout.trim());
    } else {
      lines.push('未检测到串口设备。');
      if (r.stderr.trim()) lines.push(`\n错误: ${r.stderr.trim()}`);
    }

    // 额外提示
    lines.push('\n💡 提示:');
    lines.push('  - CH340/CP2102/FT232 是常见 USB 转串口芯片');
    lines.push('  - macOS 驱动: 需安装 CH340/CP210x 驱动才能识别 /dev/cu.*');
    lines.push('  - Linux 权限: 需 user 在 dialout 组 (sudo usermod -aG dialout $USER)');

    return lines.join('\n');
  },
};

// ── 工具 2: 发送数据到串口 ─────────────────────────────────
// Tool 2: serial_send — send data (text or hex) to a serial port, optionally read response.
const serialSend = {
  name: 'serial_send',
  description: '向串口发送数据并可选等待响应。支持文本模式和十六进制模式。用于发送命令到 MCU、触发设备动作、配置传感器寄存器等。',
  parameters: {
    type: 'object',
    properties: {
      port: {
        type: 'string',
        description: '串口端口,如 COM3 / /dev/cu.SLAB_USBtoUART / /dev/ttyUSB0',
      },
      data: {
        type: 'string',
        description: '要发送的数据(文本模式直接发送;hex 模式填十六进制字符串如 "AT\\r\\n" 或 "FF 01 02")',
      },
      baudrate: {
        type: 'number',
        description: '波特率(默认 115200)',
      },
      hex_mode: {
        type: 'boolean',
        description: '是否以十六进制发送。true 时 data 字段按 hex 解析(如 "FF01A2")。默认 false。',
      },
      wait_response: {
        type: 'boolean',
        description: '是否等待设备响应(默认 true)。false 时只发不读。',
      },
      response_timeout: {
        type: 'number',
        description: '等待响应超时(毫秒,默认 2000)',
      },
      line_ending: {
        type: 'string',
        enum: ['crlf', 'cr', 'lf', 'none'],
        description: '行尾: crlf=\\r\\n(默认), cr=\\r(AT指令常用), lf=\\n, none=不加',
      },
    },
    required: ['port', 'data'],
  },
  readOnly: false,
  async run(args, ctx) {
    const port = args.port;
    const baud = args.baudrate || 115200;
    const hexMode = args.hex_mode || false;
    const waitResponse = args.wait_response !== false; // 默认 true
    const timeout = Math.min(args.response_timeout || 2000, 10000);
    const lineEnding = args.line_ending || 'crlf';

    // hex 模式校验
    let sendData = args.data;
    if (hexMode) {
      const bytes = hexToBytes(args.data);
      if (!bytes) {
        return `❌ 无效的十六进制数据: "${args.data}"\n请确保只含 0-9/A-F/a-f 且偶数位(如 "FF01A2")。`;
      }
      sendData = bytes.toString('latin1'); // 转为原始字节字符串用于发送
    }

    // 构造命令
    let cmd;
    if (isWin) {
      const readMs = waitResponse ? timeout : 100;
      const pwsh = buildPwshScript(port, baud, sendData, readMs, lineEnding === 'crlf' ? 'crlf' : lineEnding === 'cr' ? 'cr' : 'lf');
      cmd = `powershell -NoProfile -Command "${pwsh.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
    } else {
      const readSec = Math.ceil((waitResponse ? timeout : 200) / 1000);
      const unixEnding = lineEnding === 'crlf' ? '\\r\\n' : lineEnding === 'cr' ? '\\r' : lineEnding === 'lf' ? '\\n' : '';
      const unixScript = buildUnixScript(port, baud, hexMode ? args.data : sendData, readSec, lineEnding === 'crlf' ? 'crlf' : lineEnding === 'cr' ? 'cr' : 'lf');
      cmd = unixScript;
    }

    await ctx.confirm(`即将向 ${port} @${baud} baud 发送数据:\n  ${hexMode ? '[HEX] ' + bytesToHex(hexToBytes(args.data) || Buffer.alloc(0)) : JSON.stringify(sendData).slice(0, 100)}\n  等待响应: ${waitResponse ? timeout + 'ms' : '否'}`);

    const r = await shellExec(cmd, ctx.cwd, timeout + 5000);

    if (!waitResponse) {
      return `✅ 数据已发送到 ${port} (未等待响应)`;
    }

    const output = (r.stdout || '').trim();
    const errorMatch = output.match(/^ERROR:\s*(.+)/);

    if (errorMatch) {
      return `❌ 串口操作失败: ${errorMatch[1]}\n可能原因: 端口被占用 / 设备未连接 / 波特率不匹配`;
    }

    // 格式化输出
    const lines = [`📤 发送 ${hexMode ? '[HEX] ' + bytesToHex(hexToBytes(args.data) || Buffer.alloc(0)) : JSON.stringify(args.data).slice(0, 80)} → ${port} @${baud}\n`];

    if (output) {
      lines.push(`📥 响应 (${output.length} bytes):`);
      // 如果输出含不可打印字符,同时显示 hex
      const buf = Buffer.from(output, 'utf8');
      const hasUnprintable = buf.some((b) => (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09) || b > 0x7e);
      if (hasUnprintable || hexMode) {
        lines.push(`  HEX: ${bytesToHex(buf)}`);
        lines.push(`  ASCII: ${output.replace(/[^\x20-\x7e]/g, '.')}`);
      } else {
        lines.push(output);
      }
    } else {
      lines.push('📥 无响应(设备可能未回复,检查波特率/接线/固件逻辑)');
    }

    return lines.join('\n');
  },
};

// ── 工具 3: AT 指令一问一答 ───────────────────────────────
// Tool 3: serial_query — AT command interaction (send → wait → return response).
const serialQuery = {
  name: 'serial_query',
  description: '向设备发送 AT 指令并获取响应。自动添加 \\r 行尾(AT 协议标准),等待响应并返回。用于配置 WiFi 模块(ESP-AT)、蓝牙模块、4G/LoRa 模块等 AT 控制设备。',
  parameters: {
    type: 'object',
    properties: {
      port: {
        type: 'string',
        description: '串口端口',
      },
      command: {
        type: 'string',
        description: 'AT 指令,如 "AT"、"AT+GMR"、"AT+CWLAP"、"AT+CWJAP=\\"SSID\\",\\"password\\""',
      },
      baudrate: {
        type: 'number',
        description: '波特率(AT 设备通常 115200 或 9600,默认 115200)',
      },
      timeout: {
        type: 'number',
        description: '等待响应超时(毫秒,默认 3000,复杂指令如扫描 WiFi 可设 10000)',
      },
    },
    required: ['port', 'command'],
  },
  readOnly: false,
  async run(args, ctx) {
    const port = args.port;
    const baud = args.baudrate || 115200;
    const timeout = Math.min(args.timeout || 3000, 15000);
    const command = args.command;

    // AT 指令需要 \r 结尾
    let cmd;
    if (isWin) {
      const pwsh = buildPwshScript(port, baud, command, timeout, 'cr');
      cmd = `powershell -NoProfile -Command "${pwsh.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
    } else {
      cmd = buildUnixScript(port, baud, command, Math.ceil(timeout / 1000), 'cr');
    }

    await ctx.confirm(`AT 指令交互:\n  端口: ${port} @${baud}\n  命令: ${command}`);

    const r = await shellExec(cmd, ctx.cwd, timeout + 5000);
    const output = (r.stdout || '').trim();

    // 解析 AT 响应
    const lines = [`📟 AT 指令: ${command}\n  端口: ${port} @${baud}\n`];

    if (!output) {
      lines.push('❌ 无响应。可能原因:');
      lines.push('  1. 设备不支持 AT 指令模式(ESP32 需烧录 AT 固件)');
      lines.push('  2. 波特率不匹配(尝试 9600)');
      lines.push('  3. TX/RX 接反');
      lines.push('  4. 串口被其他程序占用');
      return lines.join('\n');
    }

    // 检查 AT 响应状态
    const hasOK = /\bOK\b/i.test(output);
    const hasError = /\bERROR\b/i.test(output);
    const hasFail = /\bFAIL\b/i.test(output);

    lines.push('📥 响应:');
    lines.push(output);

    if (hasOK) {
      lines.push('\n✅ 设备返回 OK — 指令执行成功');
    } else if (hasError) {
      lines.push('\n❌ 设备返回 ERROR — 指令执行失败(检查参数格式)');
    } else if (hasFail) {
      lines.push('\n⚠️ 设备返回 FAIL — 操作失败(如 WiFi 连接失败)');
    }

    return lines.join('\n');
  },
};

// ── 工具 4: 串口会话(持续采样 + 多命令) ─────────────────
// Tool 4: serial_session — open port for N seconds, send multiple commands, collect all output.
// 与 arduino-dev.serial_monitor 的区别: 这个工具可以在采样期间发送多条命令。
const serialSession = {
  name: 'serial_session',
  description: '打开串口持续采样指定时长(默认 10 秒),期间可发送多条命令。用于交互式调试 —— 先发命令再观察响应,或持续监控设备输出。返回采样期间所有串口数据。',
  parameters: {
    type: 'object',
    properties: {
      port: {
        type: 'string',
        description: '串口端口',
      },
      baudrate: {
        type: 'number',
        description: '波特率(默认 115200)',
      },
      duration: {
        type: 'number',
        description: '采样时长(秒,默认 10,最大 30)',
      },
      commands: {
        type: 'string',
        description: '在采样期间发送的命令列表(多条用 \\n 分隔)。可选,不填则只读不写。',
      },
      line_ending: {
        type: 'string',
        enum: ['crlf', 'cr', 'lf', 'none'],
        description: '行尾(默认 crlf)',
      },
    },
    required: ['port'],
  },
  readOnly: false,
  async run(args, ctx) {
    const port = args.port;
    const baud = args.baudrate || 115200;
    const duration = Math.min(Math.max(Number(args.duration) || 10, 1), 30);
    const commands = (args.commands || '').split('\n').filter((l) => l.trim());
    const lineEnding = args.line_ending || 'crlf';

    // 构造脚本: 打开串口 → 发每条命令(间隔 1s)→ 持续读到结束
    let cmd;
    const endingStr = lineEnding === 'crlf' ? '\r\n' : lineEnding === 'cr' ? '\r' : lineEnding === 'lf' ? '\n' : '';

    if (isWin) {
      // PowerShell: 打开串口 → 顺序发命令(每秒一条) → 持续读 → 关闭
      // 不用 Start-Job: Job 在独立 runspace 中 $port 变量不存在。
      // 用主线程顺序 Write + Sleep, 每条命令后读一下输出。
      const pwshLines = [
        `try {`,
        `  $port = New-Object System.IO.Ports.SerialPort '${port}',${baud},None,8,one`,
        `  $port.Open()`,
        `  $output = ""`,
      ];

      if (commands.length > 0) {
        // 先在 duration 的前 N 秒每秒发一条命令, 每次发完读一波响应
        commands.forEach((c, i) => {
          const escaped = c.replace(/'/g, "''").replace(/"/g, '');
          const le = lineEnding === 'cr' ? '`r' : lineEnding === 'lf' ? '`n' : '`r`n';
          pwshLines.push(
            `  Start-Sleep -Milliseconds 500`,
            `  $port.Write('${escaped}' + '${le}')`,
            `  Start-Sleep -Milliseconds 800`,
            `  if ($port.BytesToRead -gt 0) { $output += $port.ReadExisting() }`,
          );
        });
        // 剩余时间持续读
        const remainingMs = Math.max(duration * 1000 - commands.length * 1300, 0);
        pwshLines.push(
          `  $endTime = (Get-Date).AddMilliseconds(${remainingMs})`,
          `  while ((Get-Date) -lt $endTime) {`,
          `    if ($port.BytesToRead -gt 0) { $output += $port.ReadExisting() }`,
          `    Start-Sleep -Milliseconds 100`,
          `  }`,
        );
      } else {
        // 只读模式: 持续读 duration 秒
        pwshLines.push(
          `  $endTime = (Get-Date).AddSeconds(${duration})`,
          `  while ((Get-Date) -lt $endTime) {`,
          `    if ($port.BytesToRead -gt 0) { $output += $port.ReadExisting() }`,
          `    Start-Sleep -Milliseconds 100`,
          `  }`,
        );
      }

      pwshLines.push(
        `  $port.Close()`,
        `  Write-Output $output`,
        `} catch { Write-Output "ERROR: " + $_.Exception.Message }`,
      );
      const pwsh = pwshLines.join('\n');
      cmd = `powershell -NoProfile -Command "${pwsh.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
    } else {
      // macOS/Linux: 后台发命令 + 前台 cat 持续读
      const sendBg = commands.length > 0
        ? commands.map((c, i) => {
            const delay = (i + 1);
            const escaped = c.replace(/'/g, "'\\''");
            const le = lineEnding === 'crlf' ? '\\r\\n' : lineEnding === 'cr' ? '\\r' : lineEnding === 'lf' ? '\\n' : '';
            return `(sleep ${delay} && printf '${escaped}${le}' > ${port} &)`;
          }).join('; ')
        : '';
      const sttyCmd = `stty -f ${port} ${baud} cs8 -cstopb -parenb raw -echo 2>/dev/null || stty -F ${port} ${baud} cs8 -cstopb -parenb raw -echo 2>/dev/null`;
      cmd = `${sttyCmd} && ${sendBg} ${sendBg ? '&&' : ''} timeout ${duration} cat ${port} 2>/dev/null || true`;
    }

    await ctx.confirm(`串口会话: ${port} @${baud}, 持续 ${duration}s${commands.length > 0 ? `, 发送 ${commands.length} 条命令` : ' (只读)'}`);

    const r = await shellExec(cmd, ctx.cwd, (duration + 5) * 1000);
    const output = (r.stdout || '').trim();

    const lines = [`📡 串口会话: ${port} @${baud} — ${duration}s\n`];

    if (commands.length > 0) {
      lines.push(`📤 已发送 ${commands.length} 条命令:`);
      commands.forEach((c, i) => lines.push(`  [${i + 1}] ${c}`));
      lines.push('');
    }

    if (output) {
      lines.push(`📥 采样输出 (${output.length} bytes):`);
      lines.push(output);
    } else {
      lines.push('📥 采样期间无输出');
    }

    return lines.join('\n');
  },
};

// ── 导出 ────────────────────────────────────────────────────
module.exports = {
  tools: [serialScan, serialSend, serialQuery, serialSession],
};
