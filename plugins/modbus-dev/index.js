// Modbus 通信调试插件 —— 工具集
// Modbus communication debug tools — RTU/TCP scan, read, write, CRC.
//
// 工具列表:
//   1. modbus_scan   — 扫描 Modbus 从站(RTU 串口 / TCP 网络)
//   2. modbus_read   — 读寄存器(保持/输入/线圈/离散)
//   3. modbus_write  — 写寄存器(单个/多个/线圈)
//   4. modbus_crc    — CRC-16 校验计算
//
// 依赖: Python3 + pymodbus (pip install pymodbus)
//   或者: modbus-cli / mosquitto-clients 等

const { exec } = require('child_process');
const isWin = process.platform === 'win32';

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

// ── 检查 pymodbus ─────────────────────────────────────────
async function checkPymodbus(ctx) {
  const r = await shellExec('python3 -c "import pymodbus; print(pymodbus.__version__)" 2>&1 || python -c "import pymodbus; print(pymodbus.__version__)" 2>&1', ctx.cwd, 5000);
  if (!r.ok || r.stdout.includes('No module')) {
    return {
      available: false,
      hint: 'pymodbus 未安装。安装: pip install pymodbus',
    };
  }
  return { available: true, version: r.stdout.trim() };
}

// ── CRC-16/Modbus 计算 ───────────────────────────────────
// CRC-16/MODBUS: polynomial=0xA001, init=0xFFFF, low byte first.
function crc16Modbus(data) {
  let crc = 0xFFFF;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

// ── 生成 pymodbus Python 脚本 ────────────────────────────
function genScanScript(mode, port, baudrate, startAddr, endAddr, timeout) {
  if (mode === 'rtu') {
    return `
import sys
from pymodbus.client import ModbusSerialClient

client = ModbusSerialClient('${port}', baudrate=${baudrate}, timeout=${timeout / 1000})
if not client.connect():
    print("ERROR: 无法打开串口 ${port}")
    sys.exit(1)

found = []
for addr in range(${startAddr}, ${endAddr + 1}):
    try:
        rr = client.read_holding_registers(address=0, count=1, slave=addr)
        if rr is not None and not getattr(rr, 'isError', lambda: False)():
            found.append(addr)
            print(f"  发现从站 {addr}")
    except Exception:
        pass

client.close()
print(f"\\n扫描完成: {len(found)} 个从站在线")
if found:
    print("地址: " + ", ".join(str(a) for a in found))
`;
  }
  // TCP 模式
  return `
import sys
from pymodbus.client import ModbusTcpClient

host = '${port}'  # TCP host
client = ModbusTcpClient(host, timeout=${timeout / 1000})
if not client.connect():
    print("ERROR: 无法连接到 " + host)
    sys.exit(1)

found = []
for unit_id in range(${startAddr}, ${endAddr + 1}):
    try:
        rr = client.read_holding_registers(address=0, count=1, slave=unit_id)
        if rr is not None and not getattr(rr, 'isError', lambda: False)():
            found.append(unit_id)
            print(f"  发现单元 ID {unit_id}")
    except Exception:
        pass

client.close()
print(f"\\n扫描完成: {len(found)} 个单元在线")
if found:
    print("ID: " + ", ".join(str(a) for a in found))
`;
}

// ── 工具 1: modbus_scan ──────────────────────────────────
// Tool 1: modbus_scan — scan Modbus slaves (RTU/TCP).
const modbusScan = {
  name: 'modbus_scan',
  description: '扫描 Modbus 从站地址(RTU 串口或 TCP 网络)。逐个地址探测,列出在线设备。',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['rtu', 'tcp'],
        description: 'rtu=串口 RTU 模式; tcp=以太网 TCP 模式',
      },
      port: {
        type: 'string',
        description: 'RTU: 串口端口(如 COM3); TCP: IP 地址(如 192.168.1.100)',
      },
      baudrate: {
        type: 'number',
        description: 'RTU 波特率(默认 9600)',
      },
      range_start: {
        type: 'number',
        description: '扫描起始地址(默认 1)',
      },
      range_end: {
        type: 'number',
        description: '扫描结束地址(默认 247)',
      },
      timeout: {
        type: 'number',
        description: '每个地址超时(毫秒, 默认 500)',
      },
    },
    required: ['mode', 'port'],
  },
  readOnly: false,
  async run(args, ctx) {
    const pymodbus = await checkPymodbus(ctx);
    if (!pymodbus.available) {
      return `❌ pymodbus 未安装\n\n${pymodbus.hint}\n\n或使用替代方案:\n  - Windows: ModScan / Modbus Poll 软件\n  - Linux: mbpoll (apt install mbpoll)`;
    }

    const mode = args.mode || 'rtu';
    const port = args.port;
    const baud = args.baudrate || 9600;
    const start = args.range_start || 1;
    const end = Math.min(args.range_end || 247, 247);
    const timeout = args.timeout || 500;

    const scanTimeout = (end - start + 1) * (timeout / 1000) + 10;

    await ctx.confirm(`Modbus ${mode.toUpperCase()} 扫描:\n  ${mode === 'rtu' ? '端口: ' + port + ' @' + baud : '主机: ' + port}\n  地址范围: ${start}-${end}\n  超时: ${timeout}ms/地址\n  预计耗时: ~${Math.ceil(scanTimeout)}s`);

    const script = genScanScript(mode, port, baud, start, end, timeout);
    const tmpFile = require('path').join(ctx.cwd, `_modbus_scan_${Date.now()}.py`);
    require('fs').writeFileSync(tmpFile, script);

    const r = await shellExec(`python3 "${tmpFile}" 2>&1 || python "${tmpFile}" 2>&1`, ctx.cwd, scanTimeout * 1000);

    // 清理临时文件
    try { require('fs').unlinkSync(tmpFile); } catch (_) {}

    if (!r.ok) {
      return `❌ Modbus 扫描失败\n\n输出:\n${r.stdout || r.stderr}`;
    }

    return `📡 Modbus ${mode.toUpperCase()} 扫描结果\n\n${r.stdout}`;
  },
};

// ── 工具 2: modbus_read ──────────────────────────────────
// Tool 2: modbus_read — read registers.
const modbusRead = {
  name: 'modbus_read',
  description: '读取 Modbus 寄存器。支持功能码 0x01(线圈), 0x02(离散输入), 0x03(保持寄存器), 0x04(输入寄存器)。',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['rtu', 'tcp'], description: 'rtu 或 tcp' },
      port: { type: 'string', description: 'RTU: 串口; TCP: IP 地址' },
      unit_id: { type: 'number', description: '从站地址(1-247)' },
      function_code: { type: 'number', description: '功能码: 1=线圈, 2=离散输入, 3=保持寄存器, 4=输入寄存器。默认 3' },
      address: { type: 'number', description: '起始寄存器地址' },
      count: { type: 'number', description: '读取数量(默认 1)' },
      baudrate: { type: 'number', description: 'RTU 波特率(默认 9600)' },
    },
    required: ['mode', 'port', 'unit_id', 'address'],
  },
  readOnly: true,
  async run(args, ctx) {
    const pymodbus = await checkPymodbus(ctx);
    if (!pymodbus.available) {
      return `❌ pymodbus 未安装\n\n${pymodbus.hint}`;
    }

    const mode = args.mode || 'rtu';
    const port = args.port;
    const unitId = args.unit_id;
    const fc = args.function_code || 3;
    const addr = args.address;
    const count = args.count || 1;
    const baud = args.baudrate || 9600;

    const fcMap = { 1: 'coils', 2: 'discrete_inputs', 3: 'holding', 4: 'input' };
    const fcName = fcMap[fc] || 'holding';

    const script = mode === 'rtu' ? `
from pymodbus.client import ModbusSerialClient
c = ModbusSerialClient('${port}', baudrate=${baud}, timeout=1.0)
c.connect()
${fc === 1 ? `r = c.read_coils(address=${addr}, count=${count}, slave=${unitId})` :
      fc === 2 ? `r = c.read_discrete_inputs(address=${addr}, count=${count}, slave=${unitId})` :
      fc === 3 ? `r = c.read_holding_registers(address=${addr}, count=${count}, slave=${unitId})` :
      `r = c.read_input_registers(address=${addr}, count=${count}, slave=${unitId})`}
` : `
from pymodbus.client import ModbusTcpClient
c = ModbusTcpClient('${port}', timeout=2.0)
c.connect()
${fc === 1 ? `r = c.read_coils(address=${addr}, count=${count}, slave=${unitId})` :
      fc === 2 ? `r = c.read_discrete_inputs(address=${addr}, count=${count}, slave=${unitId})` :
      fc === 3 ? `r = c.read_holding_registers(address=${addr}, count=${count}, slave=${unitId})` :
      `r = c.read_input_registers(address=${addr}, count=${count}, slave=${unitId})`}
`;

    const fullScript = script + `
if r is None:
    print("ERROR: 无响应(从站离线或地址错误)")
elif hasattr(r, 'isError') and r.isError():
    print("EXCEPTION: " + str(r))
else:
    vals = r.bits if ${fc <= 2} else r.registers
    print("VALUES: " + str(list(vals[:${count}])))
c.close()
`;

    const tmpFile = require('path').join(ctx.cwd, `_modbus_read_${Date.now()}.py`);
    require('fs').writeFileSync(tmpFile, fullScript);

    const r = await shellExec(`python3 "${tmpFile}" 2>&1 || python "${tmpFile}" 2>&1`, ctx.cwd, 10000);

    try { require('fs').unlinkSync(tmpFile); } catch (_) {}

    const output = r.stdout.trim();
    const lines = [
      `📖 Modbus 读取 (${mode.toUpperCase()})`,
      ``,
      `  从站: ${unitId}`,
      `  功能码: 0x0${fc} (${fcName})`,
      `  地址: ${addr}`,
      `  数量: ${count}`,
      ``,
    ];

    if (output.includes('VALUES:')) {
      const valsStr = output.match(/VALUES:\s*(.+)/)?.[1] || '';
      const values = JSON.parse(valsStr.replace(/'/g, '"'));
      lines.push(`✅ 读取成功:`);
      lines.push(`  值: ${values.join(', ')}`);
      if (fc === 3 || fc === 4) {
        lines.push(`  十六进制: ${values.map(v => '0x' + v.toString(16).toUpperCase().padStart(4, '0')).join(', ')}`);
      }
    } else if (output.includes('EXCEPTION')) {
      lines.push(`⚠️ 从站返回异常码: ${output.match(/EXCEPTION:\s*(.+)/)?.[1] || ''}`);
    } else if (output.includes('ERROR')) {
      lines.push(`❌ ${output}`);
    } else {
      lines.push(r.stdout || r.stderr || '无输出');
    }

    return lines.join('\n');
  },
};

// ── 工具 3: modbus_write ─────────────────────────────────
// Tool 3: modbus_write — write registers/coils.
const modbusWrite = {
  name: 'modbus_write',
  description: '写入 Modbus 寄存器。支持功能码 0x05(写单个线圈), 0x06(写单个寄存器), 0x10(写多个寄存器)。',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['rtu', 'tcp'], description: 'rtu 或 tcp' },
      port: { type: 'string', description: 'RTU: 串口; TCP: IP 地址' },
      unit_id: { type: 'number', description: '从站地址(1-247)' },
      function_code: { type: 'number', description: '功能码: 5=写单个线圈, 6=写单个寄存器, 16=写多个寄存器。默认 6' },
      address: { type: 'number', description: '寄存器地址' },
      value: { type: 'string', description: '写入值。单个=一个数; 多个=逗号分隔(如 "1,2,3")' },
      baudrate: { type: 'number', description: 'RTU 波特率(默认 9600)' },
    },
    required: ['mode', 'port', 'unit_id', 'address', 'value'],
  },
  readOnly: false,
  async run(args, ctx) {
    const pymodbus = await checkPymodbus(ctx);
    if (!pymodbus.available) {
      return `❌ pymodbus 未安装\n\n${pymodbus.hint}`;
    }

    const mode = args.mode || 'rtu';
    const port = args.port;
    const unitId = args.unit_id;
    const fc = args.function_code || 6;
    const addr = args.address;
    const valStr = args.value;
    const baud = args.baudrate || 9600;

    await ctx.confirm(`⚠️ Modbus 写入 (${mode.toUpperCase()})\n  从站: ${unitId}\n  功能码: 0x0${fc}\n  地址: ${addr}\n  值: ${valStr}\n\n确认写入操作可能影响设备状态!`);

    const values = valStr.split(',').map(s => parseInt(s.trim()));

    let writeLine;
    if (fc === 5) {
      writeLine = `c.write_coil(address=${addr}, value=${values[0] !== 0}, slave=${unitId})`;
    } else if (fc === 6) {
      writeLine = `c.write_register(address=${addr}, value=${values[0]}, slave=${unitId})`;
    } else {
      writeLine = `c.write_registers(address=${addr}, values=${JSON.stringify(values)}, slave=${unitId})`;
    }

    const connectLine = mode === 'rtu'
      ? `c = ModbusSerialClient('${port}', baudrate=${baud}, timeout=1.0)`
      : `c = ModbusTcpClient('${port}', timeout=2.0)`;

    const script = `
from pymodbus.client import ${mode === 'rtu' ? 'ModbusSerialClient' : 'ModbusTcpClient'}
${connectLine}
c.connect()
r = ${writeLine}
if r is None:
    print("ERROR: 无响应")
elif hasattr(r, 'isError') and r.isError():
    print("EXCEPTION: " + str(r))
else:
    print("OK: 写入成功")
c.close()
`;

    const tmpFile = require('path').join(ctx.cwd, `_modbus_write_${Date.now()}.py`);
    require('fs').writeFileSync(tmpFile, script);

    const r = await shellExec(`python3 "${tmpFile}" 2>&1 || python "${tmpFile}" 2>&1`, ctx.cwd, 10000);

    try { require('fs').unlinkSync(tmpFile); } catch (_) {}

    const output = r.stdout.trim();
    const lines = [
      `✍️ Modbus 写入 (${mode.toUpperCase()})`,
      ``,
      `  从站: ${unitId} | 功能码: 0x0${fc} | 地址: ${addr} | 值: ${valStr}`,
      ``,
    ];

    if (output.includes('OK')) {
      lines.push(`✅ 写入成功`);
    } else if (output.includes('EXCEPTION')) {
      lines.push(`⚠️ 从站返回异常: ${output.match(/EXCEPTION:\s*(.+)/)?.[1] || ''}`);
    } else {
      lines.push(`❌ ${output || r.stderr || '写入失败'}`);
    }

    return lines.join('\n');
  },
};

// ── 工具 4: modbus_crc ───────────────────────────────────
// Tool 4: modbus_crc — CRC-16/MODBUS calculation.
const modbusCrc = {
  name: 'modbus_crc',
  description: '计算或验证 Modbus RTU CRC-16 校验。输入十六进制帧(如 "010300000001"),返回 CRC 值和完整帧。',
  parameters: {
    type: 'object',
    properties: {
      hex_frame: {
        type: 'string',
        description: '十六进制帧数据(不含 CRC),如 "010300000001"',
      },
      verify: {
        type: 'boolean',
        description: '验证模式: true=输入帧已含 CRC,验证是否正确',
      },
    },
    required: ['hex_frame'],
  },
  readOnly: true,
  async run(args) {
    const hex = (args.hex_frame || '').replace(/\s+/g, '');
    const verify = args.verify || false;

    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
      return `❌ 无效的十六进制数据: "${args.hex_frame}"\n请确保只含 0-9/A-F/a-f 且偶数位。`;
    }

    const data = Buffer.from(hex, 'hex');

    if (verify) {
      // 验证模式: 最后 2 字节是 CRC
      if (data.length < 3) {
        return `❌ 验证模式需要至少 3 字节(1 数据 + 2 CRC),当前 ${data.length} 字节`;
      }
      const payload = data.slice(0, -2);
      const receivedCrc = data.readUInt16LE(data.length - 2);
      const computedCrc = crc16Modbus(payload);

      const match = receivedCrc === computedCrc;
      return [
        `🔍 CRC-16 验证`,
        ``,
        `  数据: ${payload.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase()}`,
        `  接收 CRC: 0x${receivedCrc.toString(16).toUpperCase().padStart(4, '0')} (${receivedCrc})`,
        `  计算 CRC: 0x${computedCrc.toString(16).toUpperCase().padStart(4, '0')} (${computedCrc})`,
        `  ${match ? '✅ CRC 正确' : '❌ CRC 不匹配!'}`,
      ].join('\n');
    }

    // 计算模式
    const crc = crc16Modbus(data);
    const crcLo = crc & 0xFF;
    const crcHi = (crc >> 8) & 0xFF;
    const fullFrame = Buffer.concat([data, Buffer.from([crcLo, crcHi])]);

    return [
      `🧮 CRC-16/MODBUS 计算`,
      ``,
      `  输入: ${data.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase()}`,
      `  CRC: 0x${crc.toString(16).toUpperCase().padStart(4, '0')}`,
      `  低字节(先发): 0x${crcLo.toString(16).toUpperCase().padStart(2, '0')}`,
      `  高字节(后发): 0x${crcHi.toString(16).toUpperCase().padStart(2, '0')}`,
      ``,
      `  完整帧: ${fullFrame.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase()}`,
      ``,
      `> Modbus RTU CRC: 多项式 0xA001, 初始值 0xFFFF, 低字节在前`,
    ].join('\n');
  },
};

// ── 导出 ────────────────────────────────────────────────────
module.exports = {
  tools: [modbusScan, modbusRead, modbusWrite, modbusCrc],
};
