// 逻辑分析仪插件 —— 工具集
// Logic analyzer tools — sigrok-cli integration.
//
// 工具列表:
//   1. sigrok_check    — 检测 sigrok-cli 安装状态
//   2. sigrok_capture   — 配置并执行信号捕获
//   3. sigrok_decode    — 对已捕获数据执行协议解码
//   4. sigrok_list_hw   — 列出支持的硬件和协议解码器
//
// 依赖: sigrok-cli (Windows/macOS/Linux 均可从 sigrok.org 下载)

const { exec } = require('child_process');

const isWin = process.platform === 'win32';

function shellExec(command, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stdout: stdout || '', stderr: stderr || '', code: err.code || -1 });
      } else {
        resolve({ ok: true, stdout, stderr, code: 0 });
      }
    });
  });
}

// ── 工具 1: sigrok_check ──────────────────────────────────
// Tool 1: sigrok_check — detect sigrok-cli installation.
const sigrokCheck = {
  name: 'sigrok_check',
  description: '检测 sigrok-cli 是否已安装,返回版本号和驱动信息。未安装时给出安装指引。',
  parameters: { type: 'object', properties: {} },
  readOnly: true,
  async run(_args, ctx) {
    const r = await shellExec('sigrok-cli --version 2>&1', ctx.cwd, 10000);
    if (!r.ok) {
      return [
        '❌ sigrok-cli 未安装或不在 PATH 中',
        '',
        '## 安装指引',
        '',
        '### Windows',
        '1. 下载: https://sigrok.org/wiki/Windows',
        '2. 运行 sigrok-cliInstaller-*.exe',
        '3. 安装后重启终端, 确保 sigrok-cli 在 PATH',
        '',
        '### macOS',
        '```bash',
        'brew install sigrok-cli',
        '```',
        '',
        '### Linux',
        '```bash',
        'sudo apt install sigrok-cli   # Debian/Ubuntu',
        'sudo pacman -S sigrok-cli     # Arch',
        '```',
      ].join('\n');
    }
    return `✅ sigrok-cli 已安装:\n\n${r.stdout}`;
  },
};

// ── 工具 2: sigrok_capture ────────────────────────────────
// Tool 2: sigrok_capture — configure and execute signal capture.
const sigrokCapture = {
  name: 'sigrok_capture',
  description: '配置并执行信号捕获。指定硬件驱动、采样率、通道数、样本数/时长、触发条件,执行后保存为 .sr 文件。',
  parameters: {
    type: 'object',
    properties: {
      driver: {
        type: 'string',
        description: '硬件驱动名(如 demo, fx2lafw, saleae logic16)。demo=虚拟驱动(无需硬件)',
      },
      samplerate: {
        type: 'string',
        description: '采样率(如 1MHz, 4MHz, 50MHz)。建议至少为信号速率的 4 倍',
      },
      channels: {
        type: 'string',
        description: '使用的通道(如 0,1,2,3 对应 D0-D3)',
      },
      samples: {
        type: 'number',
        description: '采样数量(与 time 二选一)。如 100000 = 10万样本',
      },
      time: {
        type: 'number',
        description: '采样时长(秒,与 samples 二选一)。如 2 = 捕获2秒',
      },
      trigger: {
        type: 'string',
        description: '触发条件(如 "0:r" = CH0 上升沿, "1:f" = CH1 下降沿, "2:l" = CH2 低电平)',
      },
      output: {
        type: 'string',
        description: '输出文件路径(默认 capture.sr)',
      },
    },
    required: ['driver'],
  },
  readOnly: false,
  async run(args, ctx) {
    const driver = args.driver || 'demo';
    const sr = args.samplerate || '1MHz';
    const ch = args.channels || '0';
    const output = args.output || 'capture.sr';

    let parts = [
      `sigrok-cli`,
      `-d ${driver}`,
      `--config samplerate=${sr}`,
      `--channels ${ch}`,
    ];

    if (args.samples) {
      parts.push(`--samples ${args.samples}`);
    } else if (args.time) {
      parts.push(`--time ${args.time}s`);
    } else {
      parts.push(`--samples 100000`); // 默认 10万
    }

    if (args.trigger) {
      parts.push(`--triggers ${args.trigger}`);
    }

    parts.push(`-o ${output}`);

    const cmd = parts.join(' ');

    await ctx.confirm(`sigrok 捕获:\n  驱动: ${driver}\n  采样率: ${sr}\n  通道: ${ch}\n  ${args.samples ? '样本数: ' + args.samples : args.time ? '时长: ' + args.time + 's' : '样本数: 100000(默认)'}\n  触发: ${args.trigger || '无'}\n  输出: ${output}`);

    const r = await shellExec(cmd, ctx.cwd, 30000);

    if (!r.ok && !r.stdout.includes('sr')) {
      return [
        `❌ 信号捕获失败`,
        ``,
        `命令: ${cmd}`,
        ``,
        `错误输出:`,
        r.stderr || r.stdout,
        ``,
        `常见问题:`,
        `1. 驱动不对 — 用 sigrok_list_hw 查看支持的硬件`,
        `2. 设备未连接 — 检查 USB`,
        `3. 权限不足(Linux) — sudo usermod -aG plugdev $USER`,
      ].join('\n');
    }

    const sizeInfo = require('fs').existsSync(output)
      ? `文件大小: ${(require('fs').statSync(output).size / 1024).toFixed(1)} KB`
      : '';

    return [
      `✅ 信号捕获完成`,
      ``,
      `  驱动: ${driver}`,
      `  采样率: ${sr}`,
      `  通道: ${ch}`,
      `  ${args.samples ? '样本数: ' + args.samples : args.time ? '时长: ' + args.time + 's' : '样本数: 100000'}`,
      `  触发: ${args.trigger || '无(立即触发)'}`,
      `  输出: ${output}${sizeInfo ? ' (' + sizeInfo + ')' : ''}`,
      ``,
      `下一步: 用 sigrok_decode 对捕获的数据执行协议解码`,
      ``,
      ...(r.stderr ? [r.stderr] : []),
    ].join('\n');
  },
};

// ── 工具 3: sigrok_decode ─────────────────────────────────
// Tool 3: sigrok_decode — protocol decode on captured data.
const sigrokDecode = {
  name: 'sigrok_decode',
  description: '对已捕获的信号数据(.sr 文件或 demo 模式)执行协议解码。支持 UART/I²C/SPI/1-Wire/WS2812/PWM 等协议。',
  parameters: {
    type: 'object',
    properties: {
      protocol: {
        type: 'string',
        enum: ['uart', 'i2c', 'spi', 'onewire', 'ws2812', 'pwm', 'can', ' Manchester', 'sduino'],
        description: '协议解码器名称',
      },
      input: {
        type: 'string',
        description: '输入文件路径(默认 capture.sr)。不填则用 demo 驱动生成虚拟信号',
      },
      options: {
        type: 'string',
        description: '协议特定选项。UART: "baudrate=115200"; I²C: 无需额外; SPI: "cs=polarity=0"',
      },
      channels: {
        type: 'string',
        description: '协议使用的通道映射。UART: "rx=0,tx=1"; I²C: "sda=0,scl=1"',
      },
    },
    required: ['protocol'],
  },
  readOnly: true,
  async run(args, ctx) {
    const proto = args.protocol;
    const input = args.input || 'capture.sr';
    const opts = args.options || '';
    const chMap = args.channels || '';

    // 构造协议选项
    let pdConfig = proto;
    if (opts) pdConfig += `:${opts}`;
    if (chMap) {
      const chParts = chMap.split(',').map(c => {
        const [role, num] = c.split('=').map(s => s.trim());
        return `${role}=${num}`;
      });
      if (chParts.length) pdConfig += ':' + chParts.join(':');
    }

    // 默认选项
    const defaultOpts = {
      uart: 'baudrate=115200',
      i2c: '',
      spi: 'cs_polarity=0',
      onewire: '',
      ws2812: '',
      pwm: '',
    };
    if (!opts && defaultOpts[proto]) {
      pdConfig = proto + (defaultOpts[proto] ? ':' + defaultOpts[proto] : '');
    }

    // 检查文件是否存在
    const fs = require('fs');
    const useDemo = !fs.existsSync(input);
    const inputArg = useDemo
      ? `-d demo --config samplerate=1MHz --samples 100000`
      : `-i ${input}`;

    const cmd = `sigrok-cli ${inputArg} -P ${pdConfig} 2>&1`;

    const r = await shellExec(cmd, ctx.cwd, 15000);

    if (!r.ok && !r.stdout.trim()) {
      return [
        `❌ 协议解码失败 (${proto})`,
        ``,
        `命令: ${cmd}`,
        ``,
        `错误:`,
        r.stderr || '未知错误',
        ``,
        `排查:`,
        `1. 采样率是否足够(≥信号速率×4)`,
        `2. 通道映射是否正确`,
        `3. UART: 确认波特率匹配`,
        `4. I²C: 确认 SDA/SCL 通道没有搞反`,
      ].join('\n');
    }

    const output = r.stdout.trim();

    return [
      `📋 协议解码结果 (${proto.toUpperCase()})`,
      ``,
      `  输入: ${useDemo ? 'demo 模式(虚拟信号)' : input}`,
      `  协议: ${proto}`,
      `  ${opts ? '选项: ' + opts : ''}`,
      ``,
      output || '(无解码数据)',
    ].join('\n');
  },
};

// ── 工具 4: sigrok_list_hw ────────────────────────────────
// Tool 4: sigrok_list_hw — list supported hardware and decoders.
const sigrokListHw = {
  name: 'sigrok_list_hw',
  description: '列出 sigrok 支持的硬件驱动和协议解码器。帮助用户选择正确的驱动名和协议名。',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['hw', 'proto', 'both'],
        description: 'hw=硬件驱动列表, proto=协议解码器列表, both=全部。默认 both',
      },
    },
  },
  readOnly: true,
  async run(args, ctx) {
    const type = args.type || 'both';
    const lines = ['📡 sigrok 支持列表\n'];

    if (type === 'hw' || type === 'both') {
      const r = await shellExec('sigrok-cli --list-supported 2>&1', ctx.cwd, 10000);
      if (r.ok) {
        const hwSection = r.stdout.split('\n').filter(l =>
          l.match(/^(demo|fx2lafw|saleae|ikalogic|zeroplus|usbdaq|HANTEK|hantek)/i)
        );
        lines.push('## 硬件驱动 (常用)');
        lines.push('');
        const commonHw = [
          ['demo', '虚拟驱动(无需硬件, 测试用)'],
          ['fx2lafw', 'FX2-based 逻辑分析仪 (Saleae Logic clone)'],
          ['saleae-logic16', 'Saleae Logic 16'],
          ['ikalogic-scanalogic2', 'IKALOGIC Scanalogic-2'],
          ['zeroplus-logic-cube', 'ZEROPLUS Logic Cube'],
          ['hantek-4032l', 'Hantek 4032L'],
        ];
        for (const [name, desc] of commonHw) {
          lines.push(`  ${name}: ${desc}`);
        }
        lines.push('');
      } else {
        lines.push('## 硬件驱动\n\n❌ 无法获取(sigurk-cli 未安装)\n');
      }
    }

    if (type === 'proto' || type === 'both') {
      lines.push('## 协议解码器 (常用)');
      lines.push('');
      const protos = [
        ['uart', 'UART 串口', '选项: baudrate=115200, rx=0, tx=1'],
        ['i2c', 'I²C 总线', '通道: sda=0, scl=1'],
        ['spi', 'SPI 总线', '选项: cpol=0, cpha=0, cs_polarity=0'],
        ['onewire', '1-Wire (DS18B20/DHT)', '无额外选项'],
        ['ws2812', 'WS2812 LED', '无额外选项'],
        ['pwm', 'PWM', '无额外选项'],
        ['can', 'CAN 总线', '选项: bitrate=500000'],
        ['nrf24', 'nRF24L01+', '选项: ce=2, csn=3'],
        ['sdcard', 'SD 卡 (SPI)', '通道: mosi=0, miso=1, clk=2, cs=3'],
        ['jtag', 'JTAG', '通道: tck, tms, tdi, tdo'],
        ['swd', 'SWD', '通道: swclk, swdio'],
      ];
      lines.push('| 协议 | 说明 | 配置 |');
      lines.push('|------|------|------|');
      for (const [name, desc, config] of protos) {
        lines.push(`| ${name} | ${desc} | ${config} |`);
      }
    }

    return lines.join('\n');
  },
};

// ── 导出 ────────────────────────────────────────────────────
module.exports = {
  tools: [sigrokCheck, sigrokCapture, sigrokDecode, sigrokListHw],
};
