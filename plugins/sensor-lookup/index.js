// 传感器速查插件 —— 工具集
// Sensor lookup tools — pure built-in knowledge base, zero external dependencies.
//
// 工具列表:
//   1. sensor_info           — 查询单个传感器的接线/驱动/参数/示例代码
//   2. sensor_list           — 按类型列出可选传感器对比
//   3. sensor_driver_skeleton — 生成指定传感器的驱动代码骨架
//
// 设计原则: 纯内置知识库,不依赖任何外部 CLI 或 API。

// ── 传感器知识库 ──────────────────────────────────────────
// Sensor knowledge base — keyed by lowercase sensor name.
const SENSORS = {
  // ── 温湿度 ────────────────────────────────────────────
  'dht11': {
    name: 'DHT11', type: '温湿度传感器', interface: '1-Wire (单总线)',
    voltage: '3.3V-5V', accuracy: '温度±2℃, 湿度±5%RH',
    range: '温度 0-50℃, 湿度 20-90%RH',
    library: 'DHT sensor library (by Adafruit)', libSearch: 'DHT sensor library',
    address: '无(单总线)', sampleRate: '0.5Hz (每2秒一次, 不可更快)',
    pins: [
      ['VCC', '3.3V 或 5V'],
      ['DATA', '任意 GPIO + 4.7kΩ-10kΩ 上拉到 VCC'],
      ['GND', 'GND'],
    ],
    notes: [
      '采样间隔 ≥2 秒, 否则读取失败',
      'DHT11 精度不如 DHT22, 但价格便宜',
      '模块版自带电阻和电容, 可直接接线',
    ],
    code: `#include "DHT.h"
#define DHTPIN 2
#define DHTTYPE DHT11

DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(115200);
  dht.begin();
}

void loop() {
  delay(2000);
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) {
    Serial.println("读取失败!");
    return;
  }
  Serial.printf("温度: %.1f℃  湿度: %.1f%%\\n", t, h);
}`,
  },
  'dht22': {
    name: 'DHT22 (AM2302)', type: '温湿度传感器', interface: '1-Wire (单总线)',
    voltage: '3.3V-5V', accuracy: '温度±0.5℃, 湿度±2%RH',
    range: '温度 -40~80℃, 湿度 0-100%RH',
    library: 'DHT sensor library (by Adafruit)', libSearch: 'DHT sensor library',
    address: '无(单总线)', sampleRate: '0.5Hz (每2秒一次)',
    pins: [
      ['VCC', '3.3V 或 5V'],
      ['DATA', '任意 GPIO + 4.7kΩ-10kΩ 上拉到 VCC'],
      ['GND', 'GND'],
    ],
    notes: [
      '精度和量程优于 DHT11',
      '采样间隔 ≥2 秒',
      '裸芯片版(AM2302)自带电阻; 模块版可能需要外接上拉',
    ],
    code: `#include "DHT.h"
#define DHTPIN 2
#define DHTTYPE DHT22

DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(115200);
  dht.begin();
}

void loop() {
  delay(2000);
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) {
    Serial.println("读取失败!");
    return;
  }
  float hi = dht.computeHeatIndex(t, h, false);
  Serial.printf("温度: %.1f℃  湿度: %.1f%%  体感: %.1f℃\\n", t, h, hi);
}`,
  },
  'bme280': {
    name: 'BME280', type: '温湿度+气压传感器', interface: 'I²C / SPI',
    voltage: '3.3V', accuracy: '温度±1℃, 湿度±3%RH, 气压±1hPa',
    range: '温度 -40~85℃, 湿度 0-100%RH, 气压 300-1100hPa',
    library: 'Adafruit BME280 Library', libSearch: 'Adafruit BME280 Library',
    address: 'I²C: 0x76 (SDO→GND) 或 0x77 (SDO→VCC)', sampleRate: '最高 181Hz',
    pins: [
      ['VCC', '3.3V (不兼容 5V!)'],
      ['GND', 'GND'],
      ['SCL', 'SCL (ESP32: GPIO22, Arduino: A5)'],
      ['SDA', 'SDA (ESP32: GPIO21, Arduino: A4)'],
    ],
    notes: [
      'BME280 有湿度, BMP280 没有湿度, 容易混淆',
      'I²C 地址: SDO→GND=0x76, SDO→VCC=0x77',
      'CSB 接 VCC 选择 I²C 模式; 接低选 SPI',
      '需要 4.7kΩ I²C 上拉(多数模块自带)',
    ],
    code: `#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>

#define SEALEVELPRESSURE_HPA (1013.25)
Adafruit_BME280 bme; // I²C

void setup() {
  Serial.begin(115200);
  if (!bme.begin(0x76)) {  // 或 0x77
    Serial.println("找不到 BME280!");
    while (1);
  }
}

void loop() {
  Serial.printf("T=%.1f℃ H=%.1f%% P=%.1fhPa A=%.1fm\\n",
    bme.readTemperature(), bme.readHumidity(),
    bme.readPressure()/100.0F, bme.readAltitude(SEALEVELPRESSURE_HPA));
  delay(1000);
}`,
  },
  'bmp280': {
    name: 'BMP280', type: '气压+温度传感器(无湿度)', interface: 'I²C / SPI',
    voltage: '3.3V', accuracy: '温度±1℃, 气压±1hPa',
    range: '温度 -40~85℃, 气压 300-1100hPa',
    library: 'Adafruit BMP280 Library', libSearch: 'Adafruit BMP280 Library',
    address: 'I²C: 0x76 或 0x77', sampleRate: '最高 182Hz',
    pins: [
      ['VCC', '3.3V (不兼容 5V!)'],
      ['GND', 'GND'],
      ['SCL', 'SCL (ESP32: GPIO22)'],
      ['SDA', 'SDA (ESP32: GPIO21)'],
    ],
    notes: [
      'BMP280 没有湿度传感器, BME280 有',
      '适合做海拔/高度测量',
      'I²C 地址与 BME280 相同',
    ],
    code: `#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BMP280.h>

Adafruit_BMP280 bmp; // I²C

void setup() {
  Serial.begin(115200);
  if (!bmp.begin(0x76)) {
    Serial.println("找不到 BMP280!");
    while (1);
  }
}

void loop() {
  Serial.printf("T=%.1f℃ P=%.1fhPa A=%.1fm\\n",
    bmp.readTemperature(), bmp.readPressure()/100.0F, bmp.readAltitude(1013.25));
  delay(1000);
}`,
  },
  'ds18b20': {
    name: 'DS18B20', type: '温度传感器(防水)', interface: '1-Wire',
    voltage: '3.3V-5V', accuracy: '温度±0.5℃',
    range: '温度 -55~125℃',
    library: 'OneWire + DallasTemperature', libSearch: 'DallasTemperature',
    address: '每个芯片有唯一 64-bit ROM 地址', sampleRate: '750ms (12-bit 模式)',
    pins: [
      ['VCC', '3.3V 或 5V (或寄生供电模式)'],
      ['DATA', '任意 GPIO + 4.7kΩ 上拉到 VCC'],
      ['GND', 'GND'],
    ],
    notes: [
      '防水探头版适合液体温度测量',
      '一条总线上可挂多个 DS18B20(各自唯一地址)',
      '支持寄生供电(只用 DATA+GND, 不接 VCC)',
      '分辨率可配置: 9-bit(93ms) ~ 12-bit(750ms)',
    ],
    code: `#include <OneWire.h>
#include <DallasTemperature.h>

#define ONE_WIRE_BUS 2
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

void setup() {
  Serial.begin(115200);
  sensors.begin();
}

void loop() {
  sensors.requestTemperatures();
  int n = sensors.getDeviceCount();
  for (int i = 0; i < n; i++) {
    Serial.printf("传感器 %d: %.2f℃\\n", i, sensors.getTempCByIndex(i));
  }
  delay(1000);
}`,
  },
  'sht3x': {
    name: 'SHT30/SHT31 (SHT3x)', type: '高精度温湿度传感器', interface: 'I²C',
    voltage: '2.15V-5.5V', accuracy: '温度±0.2℃, 湿度±2%RH',
    range: '温度 -40~125℃, 湿度 0-100%RH',
    library: 'Adafruit SHT31 Library', libSearch: 'Adafruit SHT31',
    address: 'I²C: 0x44 (ADDR→GND) 或 0x45 (ADDR→VCC)', sampleRate: '最高 8Hz',
    pins: [
      ['VCC', '3.3V'],
      ['GND', 'GND'],
      ['SCL', 'SCL'],
      ['SDA', 'SDA'],
    ],
    notes: [
      '精度优于 DHT22, 接近 BME280',
      '响应速度快(8s 内稳定)',
      '内置加热器(可通过寄存器开关)',
    ],
    code: `#include <Adafruit_SHT31.h>
Adafruit_SHT31 sht31 = Adafruit_SHT31();

void setup() {
  Serial.begin(115200);
  if (!sht31.begin(0x44)) {
    Serial.println("找不到 SHT31!");
    while (1);
  }
}

void loop() {
  float t = sht31.readTemperature();
  float h = sht31.readHumidity();
  if (!isnan(t) && !isnan(h)) {
    Serial.printf("T=%.2f℃ H=%.2f%%\\n", t, h);
  }
  delay(1000);
}`,
  },
  // ── 运动/姿态 ──────────────────────────────────────────
  'mpu6050': {
    name: 'MPU6050', type: '六轴运动传感器(加速度+陀螺仪)', interface: 'I²C',
    voltage: '3.3V-5V (模块含 LDO)', accuracy: '加速度 ±0.5%, 陀螺仪 ±3%',
    range: '加速度 ±2g/±4g/±8g/±16g, 陀螺仪 ±250/±500/±1000/±2000°/s',
    library: 'Adafruit MPU6050', libSearch: 'Adafruit MPU6050',
    address: 'I²C: 0x68 (AD0→GND) 或 0x69 (AD0→VCC)', sampleRate: '最高 1kHz',
    pins: [
      ['VCC', '3.3V 或 5V'],
      ['GND', 'GND'],
      ['SCL', 'SCL'],
      ['SDA', 'SDA'],
      ['INT', '可选: 中断引脚, 接任意 GPIO'],
    ],
    notes: [
      'AD0 引脚决定 I²C 地址: GND=0x68, VCC=0x69',
      '内置 DMP (Digital Motion Processor), 可直接输出融合姿态',
      '配合磁力计 HMC5883L 可组成九轴',
      '存在 Wake-on-Motion 功能, 低功耗场景有用',
    ],
    code: `#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>

Adafruit_MPU6050 mpu;

void setup() {
  Serial.begin(115200);
  if (!mpu.begin()) {
    Serial.println("找不到 MPU6050!");
    while (1);
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
}

void loop() {
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);
  Serial.printf("Accel: %.1f,%.1f,%.1f m/s²  ",
    a.acceleration.x, a.acceleration.y, a.acceleration.z);
  Serial.printf("Gyro: %.1f,%.1f,%.1f rad/s\\n",
    g.gyro.x, g.gyro.y, g.gyro.z);
  delay(100);
}`,
  },
  // ── 光/显示 ────────────────────────────────────────────
  'ssd1306': {
    name: 'SSD1306 OLED', type: 'OLED 显示屏 (128x64/128x32)', interface: 'I²C / SPI',
    voltage: '3.3V-5V', accuracy: '—',
    range: '128x64 或 128x32 像素',
    library: 'Adafruit SSD1306 + Adafruit GFX', libSearch: 'Adafruit SSD1306',
    address: 'I²C: 0x3C (SA0→GND) 或 0x3D (SA0→VCC)', sampleRate: '—',
    pins: [
      ['VCC', '3.3V 或 5V'],
      ['GND', 'GND'],
      ['SCL', 'SCL'],
      ['SDA', 'SDA'],
    ],
    notes: [
      '128x64 最常见, 也有一半尺寸 128x32',
      'I²C 地址: 0x3C 或 0x3D, 注意模块标注',
      '需同时安装 Adafruit SSD1306 和 Adafruit GFX Library',
      '显示中文需额外字库 (u8g2 库更好)',
    ],
    code: `#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_W 128
#define SCREEN_H 64
#define OLED_ADDR 0x3C

Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, -1);

void setup() {
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(WHITE);
  display.setCursor(0, 0);
  display.println("Hello, OLED!");
  display.setTextSize(2);
  display.println("SSD1306");
  display.display();
}

void loop() {}`,
  },
  'bh1750': {
    name: 'BH1750', type: '光照度传感器', interface: 'I²C',
    voltage: '3.3V-5V', accuracy: '±20% (典型)',
    range: '1-65535 lux',
    library: 'BH1750 by Christopher Laws', libSearch: 'BH1750',
    address: 'I²C: 0x23 (ADDR→GND) 或 0x5C (ADDR→VCC)', sampleRate: '最高 120ms',
    pins: [
      ['VCC', '3.3V 或 5V'],
      ['GND', 'GND'],
      ['SCL', 'SCL'],
      ['SDA', 'SDA'],
    ],
    notes: [
      '光谱响应接近人眼(波长 360-720nm)',
      '比光敏电阻(LDR)精度高得多',
      '适合自动亮度调节、日照检测',
    ],
    code: `#include <Wire.h>
#include <BH1750.h>

BH1750 lightMeter;

void setup() {
  Serial.begin(115200);
  lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE);
  Serial.println("BH1750 ready");
}

void loop() {
  uint16_t lux = lightMeter.readLightLevel();
  Serial.printf("光照: %d lux\\n", lux);
  delay(500);
}`,
  },
  // ── 距离 ────────────────────────────────────────────────
  'hc-sr04': {
    name: 'HC-SR04', type: '超声波测距传感器', interface: 'GPIO (2-pin)',
    voltage: '5V (3.3V 可工作但信号回传需分压)', accuracy: '±3mm',
    range: '2cm - 400cm (4m)',
    library: 'NewPing (推荐) 或无库手写', libSearch: 'NewPing',
    address: '无(GPIO)', sampleRate: '最高 ~20Hz',
    pins: [
      ['VCC', '5V (3.3V 供电量程会缩短)'],
      ['TRIG', '任意 GPIO (触发输入)'],
      ['ECHO', '任意 GPIO (回波输出, 5V! 需分压到 3.3V)'],
      ['GND', 'GND'],
    ],
    notes: [
      'ECHO 输出 5V 电平! ESP32/STM32(3.3V) 需串联 1kΩ+2kΩ 分压',
      'TRIG 高电平 >10μs 触发测量',
      '距离 = 声速 × 时间 / 2 = 0.0343 × 脉冲宽度(μs) / 2 cm',
      '建议用 NewPing 库, 支持定时器非阻塞读取',
    ],
    code: `#define TRIG_PIN 5
#define ECHO_PIN 18

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
}

float getDistance() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long dur = pulseIn(ECHO_PIN, HIGH, 30000); // 30ms 超时
  if (dur == 0) return -1;
  return dur * 0.0343 / 2.0;
}

void loop() {
  float d = getDistance();
  if (d > 0) Serial.printf("距离: %.1f cm\\n", d);
  delay(200);
}`,
  },
  'vl53l0x': {
    name: 'VL53L0X', type: '激光 ToF 测距传感器', interface: 'I²C',
    voltage: '2.6V-3.5V', accuracy: '±3% (10cm-1m)',
    range: '30mm - 2000mm (2m)',
    library: 'Adafruit VL53L0X', libSearch: 'Adafruit VL53L0X',
    address: 'I²C: 0x29 (固定, 可通过 GPIO 多路复用)', sampleRate: '最高 50Hz',
    pins: [
      ['VCC', '3.3V (不可 5V!)'],
      ['GND', 'GND'],
      ['SCL', 'SCL'],
      ['SDA', 'SDA'],
      ['GPIO1/SHUT', '可选: 中断/关断引脚'],
    ],
    notes: [
      '基于 940nm 激光, 精度远超超声波',
      'I²C 地址固定 0x29, 多个传感器需用 SHUT 引脚逐个初始化改地址',
      '有高速模式(20Hz)和高精度模式(33ms)',
    ],
    code: `#include "Adafruit_VL53L0X.h"
Adafruit_VL53L0X lox = Adafruit_VL53L0X();

void setup() {
  Serial.begin(115200);
  if (!lox.begin()) {
    Serial.println("找不到 VL53L0X!");
    while (1);
  }
}

void loop() {
  VL53L0X_RangingMeasurementData_t measure;
  lox.rangingTest(&measure, false);
  if (measure.RangeStatus != 4) {
    Serial.printf("距离: %d mm\\n", measure.RangeMilliMeter);
  }
  delay(100);
}`,
  },
};

// ── 按类型分组的传感器列表 ────────────────────────────────
const SENSOR_CATEGORIES = {
  '温湿度': ['DHT11', 'DHT22', 'BME280', 'BMP280', 'DS18B20', 'SHT30/SHT31'],
  '运动/姿态': ['MPU6050', 'MPU9250', 'BNO055'],
  '距离': ['HC-SR04 (超声波)', 'VL53L0X (激光ToF)'],
  '光/显示': ['SSD1306 OLED', 'BH1750', 'TSL2561', 'ST7735 TFT'],
  '气体/环境': ['MQ-2', 'CCS811', 'SGP30', 'MQ-135'],
  '压力/称重': ['HX711 (称重)', 'MPX series'],
};

// ── 模糊匹配 ──────────────────────────────────────────────
// Fuzzy match sensor name against keys.
function matchSensor(query) {
  const q = query.toLowerCase().trim();
  if (SENSORS[q]) return q;
  // 模糊: 包含匹配
  for (const key of Object.keys(SENSORS)) {
    if (key.includes(q) || q.includes(key)) return key;
  }
  // 型号名匹配 (去掉空格/横线)
  const qClean = q.replace(/[-\s]/g, '');
  for (const key of Object.keys(SENSORS)) {
    if (key.replace(/[-\s]/g, '') === qClean) return key;
  }
  return null;
}

// ── 工具 1: sensor_info ──────────────────────────────────
// Tool 1: sensor_info — lookup sensor details.
const sensorInfo = {
  name: 'sensor_info',
  description: '查询传感器详细信息。输入型号(如 BME280/DHT22/MPU6050/SSD1306),返回接线表、驱动库、关键参数、注意事项和示例代码。',
  parameters: {
    type: 'object',
    properties: {
      model: {
        type: 'string',
        description: '传感器型号(如 "BME280", "DHT22", "MPU6050")',
      },
    },
    required: ['model'],
  },
  readOnly: true,
  async run(args) {
    const key = matchSensor(args.model || '');
    if (!key) {
      return [
        `❌ 未找到传感器 "${args.model}"`,
        ``,
        `## 当前知识库支持的传感器:`,
        ...Object.entries(SENSOR_CATEGORIES).map(([cat, list]) =>
          `**${cat}**: ${list.join(', ')}`),
        ``,
        `提示: 尝试用完整型号名(如 "BME280" 而非 "BME")`,
      ].join('\n');
    }

    const s = SENSORS[key];
    const lines = [
      `## ${s.name} — ${s.type}`,
      ``,
      `| 属性 | 值 |`,
      `|------|-----|`,
      `| 接口 | ${s.interface} |`,
      `| 电压 | ${s.voltage} |`,
      `| 精度 | ${s.accuracy} |`,
      `| 量程 | ${s.range} |`,
      `| 地址 | ${s.address} |`,
      `| 采样率 | ${s.sampleRate} |`,
      `| 推荐库 | ${s.library} |`,
      ``,
      `### 接线表`,
      ``,
      `| 引脚 | 连接 |`,
      `|------|------|`,
      ...s.pins.map(([p, d]) => `| ${p} | ${d} |`),
      ``,
      `### 注意事项`,
      ...s.notes.map(n => `- ${n}`),
      ``,
      `### 示例代码 (Arduino)`,
      ``,
      '```cpp',
      s.code,
      '```',
      ``,
      `> 安装库: 在 Arduino IDE 中搜索 "${s.libSearch}" 或使用 arduino-dev 插件的 lib_install 工具`,
    ];

    return lines.join('\n');
  },
};

// ── 工具 2: sensor_list ──────────────────────────────────
// Tool 2: sensor_list — list sensors by category for comparison.
const sensorList = {
  name: 'sensor_list',
  description: '按类型列出可选传感器,附关键参数对比。帮助选型。',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['温湿度', '运动/姿态', '距离', '光/显示', '气体/环境', '压力/称重', 'all'],
        description: '传感器类型。all=列出全部',
      },
    },
  },
  readOnly: true,
  async run(args) {
    const cat = args.category || 'all';
    const lines = ['📋 传感器选型参考表\n'];

    const cats = cat === 'all' ? Object.keys(SENSOR_CATEGORIES) : [cat];

    for (const c of cats) {
      const list = SENSOR_CATEGORIES[c];
      if (!list) {
        lines.push(`❌ 未知类型: ${c}`);
        continue;
      }
      lines.push(`## ${c}`);
      lines.push('');
      lines.push('| 型号 | 接口 | 精度 | 备注 |');
      lines.push('|------|------|------|------|');

      for (const name of list) {
        const key = matchSensor(name) || name.toLowerCase().split(' ')[0];
        const s = SENSORS[key];
        if (s) {
          lines.push(`| ${s.name} | ${s.interface} | ${s.accuracy} | ${s.voltage} |`);
        } else {
          lines.push(`| ${name} | — | — | (知识库待补充) |`);
        }
      }
      lines.push('');
    }

    lines.push('> 用 sensor_info 工具查看具体传感器的详细接线表和代码。');
    return lines.join('\n');
  },
};

// ── 工具 3: sensor_driver_skeleton ───────────────────────
// Tool 3: sensor_driver_skeleton — generate sensor driver code skeleton.
const sensorDriverSkeleton = {
  name: 'sensor_driver_skeleton',
  description: '生成指定传感器的完整驱动代码骨架(Arduino/ESP32)。包含初始化、读取、错误处理和串口输出。可选择生成 PlatformIO 格式(含 platformio.ini 配置)。',
  parameters: {
    type: 'object',
    properties: {
      model: {
        type: 'string',
        description: '传感器型号',
      },
      board: {
        type: 'string',
        description: '开发板型号(如 ESP32, Arduino Uno, ESP8266),影响引脚分配',
      },
      platformio: {
        type: 'boolean',
        description: '是否生成 PlatformIO 项目格式(含 platformio.ini)',
      },
    },
    required: ['model'],
  },
  readOnly: true,
  async run(args) {
    const key = matchSensor(args.model || '');
    if (!key) {
      return `❌ 未找到传感器 "${args.model}"。可用 sensor_list 查看支持的传感器列表。`;
    }

    const s = SENSORS[key];
    const board = args.board || 'ESP32';
    const pio = args.platformio || false;
    const lines = [];

    if (pio) {
      lines.push('## platformio.ini');
      lines.push('');
      lines.push('```ini');
      lines.push(`[env:${board.toLowerCase().replace(/\s+/g, '-')}]`);
      lines.push(`platform = ${board.toLowerCase().includes('esp32') ? 'espressif32' : 'atmelavr'}`);
      lines.push(`board = ${board.toLowerCase().includes('esp32') ? 'esp32dev' : 'uno'}`);
      lines.push(`framework = arduino`);
      lines.push(`monitor_speed = 115200`);
      lines.push(`lib_deps =`);
      // 从 library 提取依赖
      if (s.libSearch) {
        lines.push(`    ;; 在 Arduino IDE 或 pio lib search 搜索: ${s.libSearch}`);
      }
      lines.push('```');
      lines.push('');
      lines.push(`## src/main.cpp (${s.name})`);
      lines.push('');
    } else {
      lines.push(`## ${s.name}.ino`);
      lines.push('');
    }

    lines.push('```cpp');
    lines.push(`/*`);
    lines.push(` * ${s.name} — ${s.type}`);
    lines.push(` * 开发板: ${board}`);
    lines.push(` * 库: ${s.library}`);
    lines.push(` */`);
    lines.push('');
    lines.push(s.code);
    lines.push('```');
    lines.push('');
    lines.push(`> 接线: ${s.pins.map(p => `${p[0]}→${p[1]}`).join(', ')}`);
    lines.push(`> 注意: ${s.notes[0]}`);

    return lines.join('\n');
  },
};

// ── 导出 ────────────────────────────────────────────────────
module.exports = {
  tools: [sensorInfo, sensorList, sensorDriverSkeleton],
};
