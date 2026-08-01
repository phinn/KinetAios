// 硬件诊断插件 —— 工具集
// Hardware diagnostics tools — I²C scan, GPIO read, power check, scope analysis.
//
// 工具列表:
//   1. i2c_scan     — I²C 总线扫描(通过串口注入 Arduino/ESP32 扫描脚本)
//   2. gpio_read    — 读 GPIO 电平(通过串口注入脚本)
//   3. power_check  — 供电/功耗分析(计算+建议)
//   4. scope_diag   — 示波器诊断(分析串口采集的 ADC 数据)
//
// 设计原则: 不依赖外部 CLI,通过 arduino-cli upload 注入诊断脚本到开发板,
//           或直接用 serial-comm 的串口通信能力间接操作。

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

// ── 辅助: 生成 Arduino I²C 扫描脚本 ──────────────────────
// Generate Arduino I²C scanner sketch for injection.
function genI2cScannerCode() {
  return `#include <Wire.h>
void setup() {
  Wire.begin();
  Serial.begin(115200);
  Serial.println("I2C Scanner starting...");
}
void loop() {
  byte count = 0;
  Serial.println("Scanning...");
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    byte status = Wire.endTransmission();
    if (status == 0) {
      Serial.print("Found at 0x");
      if (addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
      count++;
    }
  }
  Serial.print("Total: ");
  Serial.print(count);
  Serial.println(" device(s)");
  delay(5000);
}`;
}

// ── 辅助: 生成 GPIO 读取脚本 ──────────────────────────────
// Generate Arduino GPIO reader sketch.
function genGpioReaderCode(pin) {
  return `void setup() {
  Serial.begin(115200);
  pinMode(${pin}, INPUT_PULLUP);
}
void loop() {
  int val = digitalRead(${pin});
  int adc = analogRead(A0);
  Serial.print("GPIO${pin}=");
  Serial.print(val == HIGH ? "HIGH" : "LOW");
  Serial.print(" ADC0=");
  Serial.println(adc);
  delay(500);
}`;
}

// ── 工具 1: i2c_scan ──────────────────────────────────────
// Tool 1: i2c_scan — scan I²C bus via serial port (inject Arduino sketch) or system i2cdetect.
const i2cScan = {
  name: 'i2c_scan',
  description: '扫描 I²C 总线设备地址。两种模式:(1) 通过串口注入扫描脚本到 Arduino/ESP32;(2) Linux 系统使用 i2cdetect。返回所有应答设备的 7-bit 地址。',
  parameters: {
    type: 'object',
    properties: {
      port: {
        type: 'string',
        description: '串口端口(如 COM3 / /dev/cu.usbserial-*)，用于注入扫描脚本到开发板。不填则用 i2cdetect。',
      },
      method: {
        type: 'string',
        enum: ['inject', 'system'],
        description: 'inject=通过串口注入 Arduino 扫描脚本; system=使用系统 i2cdetect (仅 Linux)。默认 inject',
      },
    },
  },
  readOnly: false,
  async run(args, ctx) {
    const method = args.method || (args.port ? 'inject' : 'system');

    if (method === 'system') {
      // Linux: 使用 i2cdetect
      const bus = args.port || '1'; // 默认 i2c-1
      const cmd = `i2cdetect -y ${bus} 2>&1`;
      const r = await shellExec(cmd, ctx.cwd, 10000);
      if (!r.ok) {
        return `❌ i2cdetect 执行失败\n\n可能原因:\n1. 非 Linux 系统(此模式仅 Linux 可用)\n2. i2c-tools 未安装: \`sudo apt install i2c-tools\`\n3. 权限不足: \`sudo usermod -aG i2c $USER\`\n\n错误输出:\n${r.stderr || r.stdout}`;
      }
      return `✅ I²C 总线扫描 (i2c-${bus}):\n\n${r.stdout}`;
    }

    // inject 模式: 提示用户上传扫描脚本
    const code = genI2cScannerCode();
    return [
      '📋 I²C 扫描方案 — 请将以下代码上传到开发板:',
      '',
      '```cpp',
      code,
      '```',
      '',
      '上传步骤:',
      `1. 用 arduino-dev 的 arduino_upload 工具,或 Arduino IDE 上传上述代码到 ${args.port || '开发板'}`,
      `2. 上传后用 serial_monitor 或 serial-comm 的 serial_session 监听 ${args.port || '端口'} @115200`,
      '3. 设备会每 5 秒扫描一次 I²C 总线并输出结果',
      '',
      '常见地址速查:',
      '  0x20-0x27  PCF8574 (I/O 扩展)',
      '  0x3C/0x3D   SSD1306 OLED',
      '  0x68/0x69   MPU6050 / DS1307',
      '  0x76/0x77   BME280 / BMP280',
      '  0x40        INA219 / PCA9685',
      '  0x48-0x4B   ADS1115 / PCF8591',
    ].join('\n');
  },
};

// ── 工具 2: gpio_read ─────────────────────────────────────
// Tool 2: gpio_read — read GPIO pin state via serial port injection.
const gpioRead = {
  name: 'gpio_read',
  description: '读取指定 GPIO 引脚的电平状态。生成 Arduino 读取脚本,通过串口注入到开发板。返回 HIGH/LOW + ADC 值。',
  parameters: {
    type: 'object',
    properties: {
      pin: {
        type: 'number',
        description: 'GPIO 引脚号(如 2, 4, 13…)',
      },
      port: {
        type: 'string',
        description: '串口端口(如 COM3 / /dev/cu.*),用于上传脚本后监听输出',
      },
    },
    required: ['pin'],
  },
  readOnly: false,
  async run(args) {
    const pin = args.pin;
    const code = genGpioReaderCode(pin);
    return [
      `📋 GPIO ${pin} 读取方案 — 请将以下代码上传到开发板:`,
      '',
      '```cpp',
      code,
      '```',
      '',
      `上传后监听 ${args.port || '串口'} @115200,输出格式:`,
      `  GPIO${pin}=HIGH/LOW  ADC0=0-1023`,
      '',
      '提示:',
      '  - INPUT_PULLUP 模式: 未连接读 HIGH, 接 GND 读 LOW',
      '  - ADC0 读取 A0 模拟值(0-1023 对应 0-3.3V/5V)',
      `  - ESP32 GPIO${pin} 注意是否为 strapping pin(影响 Boot)`,
    ].join('\n');
  },
};

// ── 工具 3: power_check ───────────────────────────────────
// Tool 3: power_check — power consumption analysis and LDO recommendation.
const powerCheck = {
  name: 'power_check',
  description: '供电/功耗分析。输入设备类型和数量,计算总功耗,检查 LDO 电流余量,给出去耦电容建议。',
  parameters: {
    type: 'object',
    properties: {
      mcu: {
        type: 'string',
        description: '主控芯片型号(如 ESP32, ESP8266, STM32F103, Arduino Uno)',
      },
      peripherals: {
        type: 'string',
        description: '外设列表,逗号分隔(如 "BME280, SSD1306 OLED, HC-SR04, 2x LED")',
      },
      supply: {
        type: 'string',
        description: '供电方式(如 USB 5V/500mA, 18650 3.7V, 12V 适配器)',
      },
      ldo: {
        type: 'string',
        description: '使用的 LDO 型号(如 AMS1117-3.3, HT7333, MCP1700)',
      },
    },
    required: ['mcu'],
  },
  readOnly: true,
  async run(args) {
    const mcu = args.mcu || '未知';
    const periphStr = args.peripherals || '无';
    const supply = args.supply || '未指定';
    const ldo = args.ldo || '未指定';

    // 功耗数据库 (典型值 mA)
    const mcuPower = {
      'esp32': { active: 240, wifi_tx: 500, deep_sleep: 0.01 },
      'esp8266': { active: 80, wifi_tx: 170, deep_sleep: 0.02 },
      'stm32f103': { active: 36, stop: 0.5 },
      'arduino uno': { active: 45, power: 50 },
    };

    const periphPower = {
      'bme280': 3.6, 'bmp280': 2.7, 'dht22': 1.5, 'dht11': 1.0,
      'ssd1306': 12, 'oled': 12, 'st7735': 30, 'ili9341': 50,
      'hc-sr04': 15, 'mpu6050': 3.9, 'ws2812': 60, 'led': 20,
      'servo': 200, 'motor': 300, 'relais': 70, 'wifi': 170,
    };

    const ldoMap = {
      'ams1117-3.3': { imax: 1000, dropout: 1100, note: '低压差能力差, >500mA 发热严重' },
      'ht7333': { imax: 250, dropout: 90, note: '低功耗, 但仅 250mA' },
      'mcp1700': { imax: 250, dropout: 178, note: '低功耗, 250mA' },
      'rt9013': { imax: 500, dropout: 200, note: '500mA, 性价比好' },
      'lt1763': { imax: 500, dropout: 300, note: '低噪声 500mA' },
    };

    // 查 MCU 功耗
    const mcuKey = mcu.toLowerCase();
    const mcuData = mcuPower[mcuKey] || { active: 100, wifi_tx: 300, deep_sleep: 0.5, note: '估算值' };

    // 查外设功耗
    const periphs = periphStr.toLowerCase().split(/[,，]/).map(s => s.trim()).filter(Boolean);
    let periphTotal = 0;
    const periphDetails = [];
    for (const p of periphs) {
      let found = false;
      for (const [key, val] of Object.entries(periphPower)) {
        if (p.includes(key)) {
          periphTotal += val;
          periphDetails.push(`${p}: ~${val}mA`);
          found = true;
          break;
        }
      }
      if (!found) {
        periphDetails.push(`${p}: 未知(估 ~10mA)`);
        periphTotal += 10;
      }
    }

    const mcuActive = mcuData.active + (mcuKey.includes('esp') ? mcuData.wifi_tx : 0);
    const totalTypical = mcuActive + periphTotal;
    const totalPeak = totalTypical * 1.3; // 30% 峰值余量

    // LDO 检查
    const ldoKey = ldo.toLowerCase().replace(/\s+/g, '');
    const ldoData = ldoMap[ldoKey] || { imax: 500, dropout: 500, note: '未知型号, 保守估算' };

    const ldoOk = totalPeak <= ldoData.imax;
    const ldoUtilization = (totalPeak / ldoData.imax * 100).toFixed(0);

    const lines = [
      `⚡ 供电/功耗分析报告`,
      ``,
      `## 功耗估算`,
      ``,
      `| 项目 | 电流 (mA) |`,
      `|------|-----------|`,
      `${mcu} (Active${mcuKey.includes('esp') ? '+WiFi' : ''}) | ${mcuActive} |`,
    ];

    for (const d of periphDetails) {
      const [name, current] = d.split(':');
      lines.push(`${name.trim()} | ${current.trim()} |`);
    }

    lines.push(`**总计(典型)** | **${totalTypical.toFixed(0)} mA** |`);
    lines.push(`**总计(峰值 ×1.3)** | **${totalPeak.toFixed(0)} mA** |`);
    lines.push(``);
    lines.push(`## LDO 分析 (${ldo})`);
    lines.push(``);
    lines.push(`- 最大输出: ${ldoData.imax} mA`);
    lines.push(`- 压差: ${ldoData.dropout} mV`);
    lines.push(`- 当前利用率: ${ldoUtilization}% (${totalPeak.toFixed(0)}/${ldoData.imax}mA)`);
    lines.push(`- ${ldoOk ? '✅ 余量充足' : '⚠️ 超载风险! 建议换更大电流的 LDO 或 DC-DC'}`);
    lines.push(`- 备注: ${ldoData.note}`);
    lines.push(``);
    lines.push(`## 去耦电容建议`);
    lines.push(``);
    lines.push(`- 每个芯片 VCC 旁: **100nF (0.1μF)** 陶瓷电容(就近放置)`);
    lines.push(`- 电源输入端: **10μF~47μF** 电解/钽电容`);
    lines.push(`- WiFi 射频前端: **1μF + 10pF** (ESP32 特有)`);
    lines.push(``);
    lines.push(`## 供电方案: ${supply}`);
    lines.push(``);

    if (supply.includes('usb') && supply.includes('500')) {
      if (totalPeak > 450) {
        lines.push(`⚠️ USB 500mA 限流可能不够! ESP32 WiFi 峰值 ~500mA。`);
        lines.push(`建议: 使用独立 5V 适配器(≥1A)或电池供电。`);
      } else {
        lines.push(`✅ USB 500mA 应该够用(峰值 ${totalPeak.toFixed(0)}mA < 450mA 安全线)。`);
      }
    } else if (supply.includes('18650') || supply.includes('battery') || supply.includes('电池')) {
      lines.push(`💡 锂电池标称 3.7V, 满电 4.2V。直接接 ESP32 需注意:`);
      lines.push(`  - AMS1117 输入耐压 ≤15V 但压差大时发热严重`);
      lines.push(`  - 推荐 DC-DC 降压(MP1584/MP2315)效率 >90%`);
      lines.push(`  - 续航估算: 2000mAh 电池 / ${totalTypical.toFixed(0)}mA ≈ ${(2000 / totalTypical).toFixed(1)} 小时`);
    } else if (supply.includes('12v')) {
      lines.push(`⚠️ 12V → 3.3V 压差 8.7V, LDO 效率仅 ${((3.3 / 12) * 100).toFixed(0)}%, 大量发热!`);
      lines.push(`强烈建议用 DC-DC 降压(MP1584 等) → 5V → 再 LDO → 3.3V。`);
    }

    return lines.join('\n');
  },
};

// ── 工具 4: scope_diag ────────────────────────────────────
// Tool 4: scope_diag — analyze ADC sample data captured from serial port.
const scopeDiag = {
  name: 'scope_diag',
  description: '示波器诊断。分析从串口采集的 ADC 波形数据(逗号/空格分隔的数值序列),计算 Vpp/频率/占空比/噪声,给出信号质量评估。',
  parameters: {
    type: 'object',
    properties: {
      data: {
        type: 'string',
        description: 'ADC 采样数据序列,逗号或空格分隔(如 "512,513,510,1023,1022,511,512...")',
      },
      vref: {
        type: 'number',
        description: 'ADC 参考电压(ESP32=3.3, Arduino Uno=5.0),默认 3.3',
      },
      resolution: {
        type: 'number',
        description: 'ADC 分辨率位数(ESP32=12bit=4096, Arduino=10bit=1024),默认 12',
      },
      sample_rate: {
        type: 'number',
        description: '采样率 (Hz),用于计算频率。如 10000 = 10kHz',
      },
    },
    required: ['data'],
  },
  readOnly: true,
  async run(args) {
    const raw = args.data || '';
    const vref = args.vref || 3.3;
    const resBits = args.resolution || 12;
    const maxVal = Math.pow(2, resBits) - 1;
    const sampleRate = args.sample_rate || 0;

    // 解析数据
    const samples = raw.split(/[,，\s]+/).map(Number).filter(n => !isNaN(n) && n >= 0 && n <= maxVal);

    if (samples.length < 4) {
      return `❌ 有效采样点不足 (${samples.length}/4),无法分析。\n请提供至少 4 个数值。`;
    }

    // 基本统计
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;

    // 转电压
    const minV = (min / maxVal * vref).toFixed(3);
    const maxV = (max / maxVal * vref).toFixed(3);
    const avgV = (avg / maxVal * vref).toFixed(3);
    const vpp = ((max - min) / maxVal * vref).toFixed(3);

    // 噪声评估 (标准差)
    const variance = samples.reduce((sum, s) => sum + Math.pow(s - avg, 2), 0) / samples.length;
    const stddev = Math.sqrt(variance);
    const noiseMv = (stddev / maxVal * vref * 1000).toFixed(1);

    // 频率估算 (需要采样率)
    let freqInfo = '(需指定采样率)';
    let dutyInfo = '';
    if (sampleRate > 0) {
      // 过零检测法估算频率
      const midline = avg;
      let crossings = 0;
      let firstCross = -1, lastCross = -1;
      for (let i = 1; i < samples.length; i++) {
        if (samples[i - 1] < midline && samples[i] >= midline) {
          crossings++;
          if (firstCross < 0) firstCross = i;
          lastCross = i;
        }
      }
      if (crossings >= 2) {
        const period = (lastCross - firstCross) / (crossings - 1) / sampleRate;
        const freq = 1 / period;
        freqInfo = `${freq.toFixed(1)} Hz (周期 ${period.toFixed(4)}s, ${crossings} 次过零)`;

        // 占空比 (高电平时间占比)
        let highCount = 0;
        for (const s of samples) {
          if (s > midline) highCount++;
        }
        dutyInfo = `\n  占空比: ${((highCount / samples.length) * 100).toFixed(1)}%`;
      }
    }

    // 信号质量评估
    const snr = avg > 0 ? (20 * Math.log10(avg / (stddev || 0.1))).toFixed(1) : 'N/A';
    const quality = stddev < 3 ? '✅ 信号干净' : stddev < 10 ? '⚠️ 有轻微噪声' : '❌ 噪声严重';
    const dynamicRange = ((max - min) / maxVal * 100).toFixed(1);

    const lines = [
      `📊 ADC 波形分析 (${samples.length} 个采样点, ${resBits}-bit, Vref=${vref}V)`,
      ``,
      `## 幅度统计`,
      ``,
      `| 指标 | ADC 值 | 电压 |`,
      `|------|--------|------|`,
      `| 最小值 | ${min} | ${minV}V |`,
      `| 最大值 | ${max} | ${maxV}V |`,
      `| 平均值 | ${avg.toFixed(1)} | ${avgV}V |`,
      `| 峰峰值 (Vpp) | ${max - min} | ${vpp}V |`,
      ``,
      `## 频率特性`,
      `  频率: ${freqInfo}${dutyInfo}`,
      ``,
      `## 信号质量`,
      `  噪声 (σ): ${noiseMv} mV`,
      `  SNR: ${snr} dB`,
      `  动态范围: ${dynamicRange}% of FS`,
      `  评估: ${quality}`,
      ``,
    ];

    // 建议
    lines.push(`## 建议`);
    if (stddev > 10) {
      lines.push(`- 🔧 噪声严重, 建议加 **0.1μF 去耦电容** 到 ADC 输入`);
      lines.push(`- 🔧 多次采样取平均(oversampling): 读 N 次取均值可提升有效位数`);
      lines.push(`- 🔧 检查电源: 开关电源噪声大, 换 LDO 或加 LC 滤波`);
    }
    if (dynamicRange < 20) {
      lines.push(`- ⚠️ 动态范围仅 ${dynamicRange}%, 信号太弱或偏置不当`);
      lines.push(`- 考虑加运放放大信号, 或调整偏置电压到 Vref/2`);
    }
    if (stddev < 3 && dynamicRange > 50) {
      lines.push(`- ✅ 信号质量良好, 可直接用于测量。`);
    }

    return lines.join('\n');
  },
};

// ── 导出 ────────────────────────────────────────────────────
module.exports = {
  tools: [i2cScan, gpioRead, powerCheck, scopeDiag],
};
