// 蓝牙 BLE 调试插件 —— 工具集
// Bluetooth BLE debug tools — scan, connect, GATT read/write/notify.
//
// 工具列表:
//   1. ble_check    — 检测 bleak (Python BLE 库) 是否已安装
//   2. ble_scan     — 扫描 BLE 设备广播包
//   3. ble_connect  — 连接设备并列出所有 Service/Characteristic
//   4. ble_gatt     — 读/写 GATT 特征, 或订阅 Notify
//
// 依赖: Python3 + bleak (pip install bleak)
//   macOS 额外需要: 授予终端蓝牙权限
//   Linux 额外需要: bluez + bluetoothd 服务运行
//   Windows: 原生支持 Bluetooth LE

const { exec } = require('child_process');

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

// ── 检查 bleak ───────────────────────────────────────────
async function checkBleak(ctx) {
  const r = await shellExec('python3 -c "import bleak; print(bleak.__version__)" 2>&1 || python -c "import bleak; print(bleak.__version__)" 2>&1', ctx.cwd, 5000);
  if (!r.ok || r.stdout.includes('No module')) {
    return {
      available: false,
      hint: 'bleak 未安装。安装: pip install bleak',
      platformNotes: [
        'macOS: 需授予终端/iTerm 蓝牙权限(系统偏好→安全与隐私→蓝牙)',
        'Linux: 需安装 bluez (sudo apt install bluez) 并运行 bluetoothd',
        'Windows: Windows 10+ 原生支持 BLE',
      ],
    };
  }
  return { available: true, version: r.stdout.trim() };
}

// ── 生成 Python BLE 扫描脚本 ──────────────────────────────
function genScanScript(duration) {
  return `
import asyncio
from bleak import BleakScanner

async def scan():
    print("扫描 BLE 设备 (%d 秒)..." % ${duration})
    devices = await BleakScanner.discover(timeout=${duration})
    if not devices:
        print("RESULT: 未发现设备")
        return
    print("FOUND: %d 个设备" % len(devices))
    for d in devices:
        name = d.name or "(unknown)"
        print("  %s | %s | RSSI=%d" % (d.address, name, d.rssi))

asyncio.run(scan())
`;
}

// ── 生成 Python BLE 连接脚本 ──────────────────────────────
function genConnectScript(address) {
  return `
import asyncio
from bleak import BleakClient

async def explore(address):
    print("连接设备: %s ..." % address)
    async with BleakClient(address, timeout=10.0) as client:
        print("CONNECTED: MTU=%d" % client.mtu_size)
        svcs = await client.get_services()
        print("SERVICES: %d" % len(svcs))
        for svc in svcs:
            print("  Service: %s (%s)" % (svc.uuid, svc.description or ""))
            for ch in svc.characteristics:
                props = ",".join(ch.properties)
                print("    Char: %s [%s]" % (ch.uuid, props))
                for desc in ch.descriptors:
                    print("      Desc: %s" % desc.uuid)

asyncio.run(explore("${address}"))
`;
}

// ── 生成 Python GATT 操作脚本 ─────────────────────────────
function genGattScript(address, uuid, action, value) {
  if (action === 'read') {
    return `
import asyncio
from bleak import BleakClient

async def read_char(address, uuid):
    async with BleakClient(address, timeout=10.0) as client:
        data = await client.read_gatt_char(uuid)
        print("READ: %s" % " ".join("%02X" % b for b in data))
        try:
            text = data.decode('utf-8')
            print("TEXT: %s" % text)
        except:
            pass

asyncio.run(read_char("${address}", "${uuid}"))
`;
  }
  if (action === 'write') {
    const writeValue = Buffer.from(value || '').toString('hex');
    return `
import asyncio
from bleak import BleakClient

async def write_char(address, uuid, hex_data):
    data = bytes.fromhex(hex_data)
    async with BleakClient(address, timeout=10.0) as client:
        await client.write_gatt_char(uuid, data, response=True)
        print("WRITE_OK: wrote %d bytes" % len(data))

asyncio.run(write_char("${address}", "${uuid}", "${writeValue}"))
`;
  }
  if (action === 'notify') {
    return `
import asyncio
from bleak import BleakClient

async def listen_notify(address, uuid, duration):
    async def callback(sender, data):
        print("NOTIFY from %s: %s" % (sender, " ".join("%02X" % b for b in data)))
        try:
            print("  TEXT: %s" % data.decode('utf-8'))
        except:
            pass

    async with BleakClient(address, timeout=10.0) as client:
        await client.start_notify(uuid, callback)
        print("LISTENING: %d 秒..." % duration)
        await asyncio.sleep(duration)
        await client.stop_notify(uuid)
        print("STOPPED")

asyncio.run(listen_notify("${address}", "${uuid}", ${value || 10}))
`;
  }
  return 'print("ERROR: unknown action")';
}

// ── 工具 1: ble_check ────────────────────────────────────
// Tool 1: ble_check — detect bleak installation.
const bleCheck = {
  name: 'ble_check',
  description: '检测 bleak (Python BLE 库) 是否已安装,返回版本和平台蓝牙状态。',
  parameters: { type: 'object', properties: {} },
  readOnly: true,
  async run(_args, ctx) {
    const bleak = await checkBleak(ctx);
    if (!bleak.available) {
      const lines = [
        '❌ bleak 未安装',
        '',
        '## 安装',
        '```bash',
        'pip install bleak',
        '```',
        '',
        '## 平台要求',
      ];
      for (const note of bleak.platformNotes) {
        lines.push(`- ${note}`);
      }
      return lines.join('\n');
    }
    return `✅ bleak 已安装 (v${bleak.version})\n\n蓝牙 BLE 调试就绪。`;
  },
};

// ── 工具 2: ble_scan ─────────────────────────────────────
// Tool 2: ble_scan — scan BLE devices.
const bleScan = {
  name: 'ble_scan',
  description: '扫描附近 BLE 设备的广播包。列出设备名、MAC 地址、RSSI 信号强度。默认扫描 10 秒。',
  parameters: {
    type: 'object',
    properties: {
      duration: {
        type: 'number',
        description: '扫描时长(秒,默认 10,最大 30)',
      },
    },
  },
  readOnly: true,
  async run(args, ctx) {
    const bleak = await checkBleak(ctx);
    if (!bleak.available) {
      return `❌ bleak 未安装\n\n${bleak.hint}`;
    }

    const duration = Math.min(Math.max(args.duration || 10, 3), 30);

    const script = genScanScript(duration);
    const tmpFile = require('path').join(ctx.cwd, `_ble_scan_${Date.now()}.py`);
    require('fs').writeFileSync(tmpFile, script);

    const r = await shellExec(`python3 "${tmpFile}" 2>&1 || python "${tmpFile}" 2>&1`, ctx.cwd, (duration + 10) * 1000);

    try { require('fs').unlinkSync(tmpFile); } catch (_) {}

    const lines = [
      `📡 BLE 设备扫描 (${duration}s)\n`,
    ];

    if (r.stdout.includes('FOUND:')) {
      lines.push(r.stdout);
      lines.push('');
      lines.push('> 用 ble_connect 连接设备并探索 GATT 服务');
    } else if (r.stdout.includes('未发现')) {
      lines.push('未发现 BLE 设备。');
      lines.push('');
      lines.push('排查:');
      lines.push('- 设备是否在广播? (确认 BLE 设备已开启)');
      lines.push('- 距离是否太远? (BLE 有效距离约 10m)');
      lines.push('- 2.4GHz 干扰? (WiFi 同频段, 尝试关闭 WiFi)');
    } else {
      lines.push(r.stdout || r.stderr || '扫描失败');
    }

    return lines.join('\n');
  },
};

// ── 工具 3: ble_connect ──────────────────────────────────
// Tool 3: ble_connect — connect to a device and list GATT services.
const bleConnect = {
  name: 'ble_connect',
  description: '连接指定 BLE 设备,列出所有 GATT Service 和 Characteristic(UUID + 属性)。帮助找到正确的特征 UUID 用于后续读写。',
  parameters: {
    type: 'object',
    properties: {
      address: {
        type: 'string',
        description: '设备 MAC 地址(如 "00:11:22:33:44:55") 或 UUID(macOS)',
      },
    },
    required: ['address'],
  },
  readOnly: true,
  async run(args, ctx) {
    const bleak = await checkBleak(ctx);
    if (!bleak.available) {
      return `❌ bleak 未安装\n\n${bleak.hint}`;
    }

    const script = genConnectScript(args.address);
    const tmpFile = require('path').join(ctx.cwd, `_ble_connect_${Date.now()}.py`);
    require('fs').writeFileSync(tmpFile, script);

    const r = await shellExec(`python3 "${tmpFile}" 2>&1 || python "${tmpFile}" 2>&1`, ctx.cwd, 20000);

    try { require('fs').unlinkSync(tmpFile); } catch (_) {}

    const lines = [`🔗 BLE 设备连接: ${args.address}\n`];

    if (r.stdout.includes('CONNECTED:')) {
      lines.push(r.stdout);
      lines.push('');
      lines.push('> 找到目标 Characteristic UUID 后,用 ble_gatt 读取或写入');
    } else {
      lines.push(r.stdout || r.stderr || '连接失败');
      lines.push('');
      lines.push('排查:');
      lines.push('- 设备是否在线且未被其他客户端连接?');
      lines.push('- 地址是否正确? (macOS 使用 UUID 而非 MAC)');
      lines.push('- 设备是否在广播?');
    }

    return lines.join('\n');
  },
};

// ── 工具 4: ble_gatt ─────────────────────────────────────
// Tool 4: ble_gatt — GATT read/write/notify.
const bleGatt = {
  name: 'ble_gatt',
  description: 'GATT 特征操作:读取(read)、写入(write)或订阅通知(notify)。需要设备地址和特征 UUID。',
  parameters: {
    type: 'object',
    properties: {
      address: {
        type: 'string',
        description: '设备 MAC 地址或 UUID',
      },
      uuid: {
        type: 'string',
        description: 'Characteristic UUID (如 "6e400002-b5a3-f393-e0a9-e50e24dcca9e")',
      },
      action: {
        type: 'string',
        enum: ['read', 'write', 'notify'],
        description: '操作类型: read=读取; write=写入; notify=订阅通知',
      },
      value: {
        type: 'string',
        description: 'write 模式: 要写入的数据(文本); notify 模式: 监听时长(秒,默认 10)',
      },
    },
    required: ['address', 'uuid', 'action'],
  },
  readOnly: false,
  async run(args, ctx) {
    const bleak = await checkBleak(ctx);
    if (!bleak.available) {
      return `❌ bleak 未安装\n\n${bleak.hint}`;
    }

    const action = args.action;
    const address = args.address;
    const uuid = args.uuid;
    const value = args.value;

    if (action === 'write') {
      await ctx.confirm(`BLE 写入:\n  设备: ${address}\n  UUID: ${uuid}\n  数据: "${value}"`);
    }

    const script = genGattScript(address, uuid, action, action === 'notify' ? value || 10 : value);
    const tmpFile = require('path').join(ctx.cwd, `_ble_gatt_${Date.now()}.py`);
    require('fs').writeFileSync(tmpFile, script);

    const timeout = action === 'notify' ? (parseInt(value) || 10) * 1000 + 15000 : 20000;
    const r = await shellExec(`python3 "${tmpFile}" 2>&1 || python "${tmpFile}" 2>&1`, ctx.cwd, timeout);

    try { require('fs').unlinkSync(tmpFile); } catch (_) {}

    const actionNames = { read: '📖 读取', write: '✍️ 写入', notify: '🔔 通知监听' };
    const lines = [
      `${actionNames[action]} — GATT 操作\n`,
      `  设备: ${address}`,
      `  UUID: ${uuid}`,
      `  操作: ${action}\n`,
    ];

    if (action === 'read' && r.stdout.includes('READ:')) {
      lines.push('✅ 读取成功:');
      lines.push(r.stdout);
    } else if (action === 'write' && r.stdout.includes('WRITE_OK')) {
      lines.push('✅ 写入成功');
    } else if (action === 'notify' && r.stdout.includes('LISTENING')) {
      lines.push('✅ 通知监听结果:');
      lines.push(r.stdout);
    } else {
      lines.push(r.stdout || r.stderr || '操作失败');
    }

    return lines.join('\n');
  },
};

// ── 导出 ────────────────────────────────────────────────────
module.exports = {
  tools: [bleCheck, bleScan, bleConnect, bleGatt],
};
