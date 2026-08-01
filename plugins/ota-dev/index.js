// OTA 固件升级插件 —— 工具集
// OTA firmware update tools — code generation, partition table, architecture planning.
//
// 工具列表:
//   1. ota_generate   — 生成 HTTP/HTTPS OTA 完整代码
//   2. ota_partition  — 生成 OTA 分区表 CSV + 编译参数
//   3. ota_plan       — OTA 架构方案设计(分区/版本/回滚/安全)
//
// 设计原则: 纯代码生成,不依赖外部 CLI,不执行烧录。

const { exec } = require('child_process');

// ── 工具 1: ota_generate ─────────────────────────────────
// Tool 1: ota_generate — generate OTA firmware update code.
const otaGenerate = {
  name: 'ota_generate',
  description: '生成 ESP32/ESP8266 OTA 固件更新代码。支持 HTTP/HTTPS OTA、进度显示、错误处理、版本检查。可选 WebUpdater 内置上传页面。',
  parameters: {
    type: 'object',
    properties: {
      board: {
        type: 'string',
        enum: ['esp32', 'esp8266'],
        description: '目标芯片',
      },
      mode: {
        type: 'string',
        enum: ['http', 'https', 'webupdater'],
        description: 'http=HTTP 下载 OTA; https=HTTPS 安全 OTA; webupdater=内置 Web 页面上传',
      },
      firmware_url: {
        type: 'string',
        description: '固件下载 URL (http/https 模式需要, 如 "http://192.168.1.100:8080/firmware.bin")',
      },
      current_version: {
        type: 'string',
        description: '当前固件版本号(如 "1.0.0")',
      },
    },
    required: ['board', 'mode'],
  },
  readOnly: false,
  async run(args) {
    const board = args.board || 'esp32';
    const mode = args.mode || 'http';
    const url = args.firmware_url || 'http://192.168.1.100/firmware.bin';
    const version = args.current_version || '1.0.0';

    const lines = [`## OTA 固件升级代码 (${board.toUpperCase()} — ${mode.toUpperCase()})\n`];

    if (board === 'esp32') {
      if (mode === 'http' || mode === 'https') {
        lines.push('```cpp');
        lines.push(`/*`);
        lines.push(` * ESP32 ${mode.toUpperCase()} OTA Firmware Update`);
        lines.push(` * 当前版本: ${version}`);
        lines.push(` * 库依赖: WiFi.h + HTTPClient.h + Update.h`);
        lines.push(` */`);
        lines.push('');
        lines.push(`#include <WiFi.h>`);
        lines.push(`#include <HTTPClient.h>`);
        lines.push(`#include <Update.h>`);
        lines.push('');
        lines.push(`const char* WIFI_SSID = "YOUR_SSID";`);
        lines.push(`const char* WIFI_PASS = "YOUR_PASSWORD";`);
        lines.push(`const String FIRMWARE_URL = "${url}";`);
        lines.push(`const String CURRENT_VERSION = "${version}";`);
        lines.push('');
        lines.push(`void checkAndUpdate() {`);
        lines.push(`  Serial.println("检查固件更新...");`);
        lines.push(`  HTTPClient http;`);
        lines.push(`  http.begin(FIRMWARE_URL);`);
        lines.push(`  int httpCode = http.GET();`);
        lines.push('');
        lines.push(`  if (httpCode != 200) {`);
        lines.push(`    Serial.printf("下载失败: HTTP %d\\n", httpCode);`);
        lines.push(`    http.end();`);
        lines.push(`    return;`);
        lines.push(`  }`);
        lines.push('');
        lines.push(`  int totalSize = http.getSize();`);
        lines.push(`  Serial.printf("固件大小: %d bytes\\n", totalSize);`);
        lines.push('');
        lines.push(`  if (!Update.begin(totalSize)) {`);
        lines.push(`    Serial.println("OTA begin 失败: " + String(Update.errorString()));`);
        lines.push(`    http.end();`);
        lines.push(`    return;`);
        lines.push(`  }`);
        lines.push('');
        lines.push(`  // 流式写入`);
        lines.push(`  WiFiClient* stream = http.getStreamPtr();`);
        lines.push(`  size_t written = 0;`);
        lines.push(`  uint8_t buf[1024];`);
        lines.push(`  while (http.connected() && written < totalSize) {`);
        lines.push(`    size_t avail = stream->available();`);
        lines.push(`    if (avail) {`);
        lines.push(`      int read = stream->readBytes(buf, min((size_t)avail, sizeof(buf)));`);
        lines.push(`      written += Update.write(buf, read);`);
        lines.push(`      Serial.printf("进度: %d%%\\r", (int)(written * 100 / totalSize));`);
        lines.push(`    }`);
        lines.push(`    delay(1);`);
        lines.push(`  }`);
        lines.push(`  Serial.println();`);
        lines.push('');
        lines.push(`  if (written == totalSize) {`);
        lines.push(`    Serial.println("写入完成");`);
        lines.push(`    if (Update.end()) {`);
        lines.push(`      Serial.println("OTA 成功! 重启中...");`);
        lines.push(`      delay(1000);`);
        lines.push(`      ESP.restart();`);
        lines.push(`    } else {`);
        lines.push(`      Serial.println("OTA 结束失败: " + String(Update.errorString()));`);
        lines.push(`    }`);
        lines.push(`  } else {`);
        lines.push(`    Serial.printf("写入不完整: %d/%d\\n", written, totalSize);`);
        lines.push(`    Update.abort();`);
        lines.push(`  }`);
        lines.push(`  http.end();`);
        lines.push(`}`);
        lines.push('');
        lines.push(`void setup() {`);
        lines.push(`  Serial.begin(115200);`);
        lines.push(`  WiFi.begin(WIFI_SSID, WIFI_PASS);`);
        lines.push(`  while (WiFi.status() != WL_CONNECTED) {`);
        lines.push(`    delay(500); Serial.print(".");`);
        lines.push(`  }`);
        lines.push(`  Serial.println("\\nWiFi 已连接: " + WiFi.localIP().toString());`);
        lines.push(`  checkAndUpdate(); // 启动时检查`);
        lines.push(`}`);
        lines.push('');
        lines.push(`void loop() {`);
        lines.push(`  // 每 1 小时检查一次更新`);
        lines.push(`  static unsigned long lastCheck = 0;`);
        lines.push(`  if (millis() - lastCheck > 3600000) {`);
        lines.push(`    lastCheck = millis();`);
        lines.push(`    checkAndUpdate();`);
        lines.push(`  }`);
        lines.push(`}`);
        lines.push('```');
      }

      if (mode === 'https') {
        lines.push('');
        lines.push('### HTTPS 证书配置');
        lines.push('');
        lines.push('> HTTPS OTA 需要额外配置证书:');
        lines.push('>');
        lines.push('> ```cpp');
        lines.push('> // 方案1: 跳过证书验证(仅开发用!)');
        lines.push('> http.begin(FIRMWARE_URL); // HTTPS 自动使用 root CA');
        lines.push('> // 如需自定义证书:');
        lines.push('> // http.begin(url, root_ca); // 传入 PEM 格式 root CA');
        lines.push('> ```');
        lines.push('');
        lines.push('> ⚠️ 生产环境务必使用有效证书 + root CA 验证!');
      }

      if (mode === 'webupdater') {
        lines.push('```cpp');
        lines.push(`/*`);
        lines.push(` * ESP32 WebUpdater — 内置固件上传页面`);
        lines.push(` */`);
        lines.push('');
        lines.push(`#include <WiFi.h>`);
        lines.push(`#include <WebServer.h>`);
        lines.push(`#include <Update.h>`);
        lines.push('');
        lines.push(`const char* ssid = "YOUR_SSID";`);
        lines.push(`const char* password = "YOUR_PASSWORD";`);
        lines.push('');
        lines.push(`WebServer server(80);`);
        lines.push('');
        lines.push(`const char* updatePage = R"rawliteral(`);
        lines.push(`<!DOCTYPE html><html><head><title>OTA Update</title></head>`);
        lines.push(`<body><h1>ESP32 Firmware Update</h1>`);
        lines.push(`<form method='POST' action='/update' enctype='multipart/form-data'>`);
        lines.push(`<input type='file' name='update'><br><br>`);
        lines.push(`<input type='submit' value='Upload & Flash'>`);
        lines.push(`</form></body></html>)rawliteral";`);
        lines.push('');
        lines.push(`void handleUpdate() { server.send(200, "text/html", updatePage); }`);
        lines.push('');
        lines.push(`void handleDoUpdate() {`);
        lines.push(`  size_t fsize = 0;`);
        lines.push(`  HTTPUpload& upload = server.upload();`);
        lines.push(`  if (upload.status == UPLOAD_FILE_START) {`);
        lines.push(`    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) Update.printError(Serial);`);
        lines.push(`  } else if (upload.status == UPLOAD_FILE_WRITE) {`);
        lines.push(`    if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {`);
        lines.push(`      Update.printError(Serial);`);
        lines.push(`    }`);
        lines.push(`  } else if (upload.status == UPLOAD_FILE_END) {`);
        lines.push(`    if (Update.end(true)) {`);
        lines.push(`      server.send(200, "text/plain", "OK. Rebooting...");`);
        lines.push(`      delay(500); ESP.restart();`);
        lines.push(`    } else Update.printError(Serial);`);
        lines.push(`  }`);
        lines.push(`}`);
        lines.push('');
        lines.push(`void setup() {`);
        lines.push(`  Serial.begin(115200);`);
        lines.push(`  WiFi.begin(ssid, password);`);
        lines.push(`  while (WiFi.status() != WL_CONNECTED) { delay(500); }`);
        lines.push(`  Serial.println("IP: " + WiFi.localIP().toString());`);
        lines.push(`  server.on("/", HTTP_GET, handleUpdate);`);
        lines.push(`  server.on("/update", HTTP_POST, []() { server.send(200); }, handleDoUpdate);`);
        lines.push(`  server.begin();`);
        lines.push(`}`);
        lines.push('');
        lines.push(`void loop() { server.handleClient(); }`);
        lines.push('```');
        lines.push('');
        lines.push(`> 使用方法: 浏览器访问 \`http://<ESP32_IP>/\` → 选择 .bin 固件 → 上传`);
      }
    } else {
      // ESP8266
      lines.push('```cpp');
      lines.push(`/*`);
      lines.push(` * ESP8266 ${mode.toUpperCase()} OTA Firmware Update`);
      lines.push(` * 库: ESP8266HTTPClient + ESP8266httpUpdate (内置)`);
      lines.push(` */`);
      lines.push('');
      lines.push(`#include <ESP8266WiFi.h>`);
      lines.push(`#include <ESP8266HTTPClient.h>`);
      lines.push(`#include <ESP8266httpUpdate.h>`);
      lines.push('');
      lines.push(`const char* ssid = "YOUR_SSID";`);
      lines.push(`const char* password = "YOUR_PASSWORD";`);
      lines.push(`const String firmwareUrl = "${url}";`);
      lines.push('');
      lines.push(`void checkUpdate() {`);
      lines.push(`  WiFiClient client;`);
      lines.push(`  t_httpUpdate_return ret = ESPhttpUpdate.update(client, firmwareUrl);`);
      lines.push(`  switch (ret) {`);
      lines.push(`    case HTTP_UPDATE_FAILED:`);
      lines.push(`      Serial.printf("更新失败: %d\\n", ESPhttpUpdate.getLastError());`);
      lines.push(`      break;`);
      lines.push(`    case HTTP_UPDATE_NO_UPDATES:`);
      lines.push(`      Serial.println("无新版本");`);
      lines.push(`      break;`);
      lines.push(`    case HTTP_UPDATE_OK:`);
      lines.push(`      Serial.println("更新成功! 重启中...");`);
      lines.push(`      break;`);
      lines.push(`  }`);
      lines.push(`}`);
      lines.push('');
      lines.push(`void setup() {`);
      lines.push(`  Serial.begin(115200);`);
      lines.push(`  WiFi.begin(ssid, password);`);
      lines.push(`  while (WiFi.status() != WL_CONNECTED) delay(500);`);
      lines.push(`  checkUpdate();`);
      lines.push(`}`);
      lines.push('');
      lines.push(`void loop() {}`);
      lines.push('```');
    }

    lines.push('');
    lines.push(`### 关键依赖`);
    lines.push('');
    if (board === 'esp32') {
      lines.push(`- 分区表: 需要 OTA 分区方案(用 ota_partition 工具生成)`);
      lines.push(`- 编译: arduino-cli compile --board esp32:esp32:esp32 \\`);
      lines.push(`    --build-property partition.default.csv \\`);
      lines.push(`    --build-property upload.flash_size=4MB`);
    } else {
      lines.push(`- 开发板: "Generic ESP8266 Module"`);
      lines.push(`- Flash Size: 至少 1MB (选 "1M (FS:64KB OTA:~499KB)")`);
    }

    return lines.join('\n');
  },
};

// ── 工具 2: ota_partition ─────────────────────────────────
// Tool 2: ota_partition — generate OTA partition table CSV.
const otaPartition = {
  name: 'ota_partition',
  description: '生成 ESP32 OTA 分区表 CSV 文件。支持 4MB/8MB/16MB Flash,可选择自定义 SPIFFS/LittleFS 大小。',
  parameters: {
    type: 'object',
    properties: {
      flash_size: {
        type: 'string',
        enum: ['4MB', '8MB', '16MB'],
        description: 'Flash 总大小',
      },
      app_size: {
        type: 'string',
        description: '每个 OTA app 分区大小(如 1.5MB, 3MB)。默认自动计算',
      },
      spiffs_size: {
        type: 'string',
        description: '文件系统分区大小(如 0.5MB, 1MB)。默认 0.5MB',
      },
    },
  },
  readOnly: true,
  async run(args) {
    const flash = args.flash_size || '4MB';
    const flashKB = { '4MB': 4096, '8MB': 8192, '16MB': 16384 }[flash];
    const spiffsKB = args.spiffs_size
      ? Math.round(parseFloat(args.spiffs_size) * 1024)
      : 512;

    // 预分配: nvs(20KB) + otadata(8KB) + app_init(20KB) ≈ 48KB
    const overheadKB = 60;
    const availableKB = flashKB - overheadKB - spiffsKB;
    const appKB = args.app_size
      ? Math.round(parseFloat(args.app_size) * 1024)
      : Math.floor(availableKB / 2 * 0.95); // 5% 安全余量

    const lines = [
      `## ESP32 OTA 分区表 (${flash} Flash)\n`,
      ``,
      `### partitions_ota.csv`,
      ``,
      '```csv',
      `# Name,   Type, SubType,  Offset,   Size,    Flags`,
      `# Note: if you change the partition sizes, also update the app size limits`,
      `nvs,      data, nvs,      0x9000,   0x4000,`,
      `otadata,  data, ota,      0xd000,   0x2000,`,
      `app0,     app,  ota_0,    0x10000,  ${(appKB * 1024).toString(16).toUpperCase().padStart(6, '0')},`,
      `app1,     app,  ota_1,    ,         ${(appKB * 1024).toString(16).toUpperCase().padStart(6, '0')},`,
      `spiffs,   data, spiffs,   ,         ${(spiffsKB * 1024).toString(16).toUpperCase().padStart(6, '0')},`,
      '```',
      ``,
      `### 分区布局图`,
      ``,
      `| 分区名 | 类型 | 偏移 | 大小 | 说明 |`,
      `|--------|------|------|------|------|`,
      `| nvs | data/nvs | 0x9000 | 16KB | 非易失性存储(WiFi 凭据等) |`,
      `| otadata | data/ota | 0xD000 | 8KB | OTA 分区选择数据 |`,
      `| app0 | app/ota_0 | 0x10000 | ${(appKB / 1024).toFixed(1)}MB | OTA 分区 A |`,
      `| app1 | app/ota_1 | 自动 | ${(appKB / 1024).toFixed(1)}MB | OTA 分区 B |`,
      `| spiffs | data/spiffs | 自动 | ${(spiffsKB / 1024).toFixed(1)}MB | 文件系统 |`,
      ``,
      `### 编译参数`,
      ``,
      `**Arduino IDE:**`,
      `  Tools → Partition Scheme → "Custom" → 选择 partitions_ota.csv`,
      ``,
      `**arduino-cli:**`,
      '```bash',
      `arduino-cli compile --board esp32:esp32:esp32 \\`,
      `  --build-property "build.partitions=partitions_ota.csv" \\`,
      `  --build-property "upload.flash_size=${flash}"`,
      '```',
      ``,
      `**PlatformIO:**`,
      '```ini',
      `board_build.partitions = partitions_ota.csv`,
      `board_build.flash_size = ${flash}`,
      '```',
      ``,
      `> ⚠️ 分区表更改后需完全擦除 Flash 再重新烧录:`,
      `> \`esptool.py erase_flash && esptool.py write_flash 0x10000 firmware.bin\``,
    ];

    return lines.join('\n');
  },
};

// ── 工具 3: ota_plan ─────────────────────────────────────
// Tool 3: ota_plan — OTA architecture design.
const otaPlan = {
  name: 'ota_plan',
  description: 'OTA 架构方案设计。根据设备数量、网络环境、安全需求,设计完整的 OTA 体系:分区方案、版本管理、回滚机制、安全策略。',
  parameters: {
    type: 'object',
    properties: {
      device_count: {
        type: 'number',
        description: '设备数量级: 1=少量(<100), 2=中等(100-1000), 3=大量(>1000)',
      },
      network: {
        type: 'string',
        enum: ['wifi', 'ethernet', 'cellular', 'lorawan'],
        description: '主要网络类型',
      },
      security: {
        type: 'string',
        enum: ['none', 'basic', 'high'],
        description: '安全级别: none=无; basic=HTTPS+签名; high=Secure Boot+Flash Encryption',
      },
      rollback: {
        type: 'boolean',
        description: '是否需要自动回滚(固件启动失败自动恢复旧版本)',
      },
    },
    required: ['device_count', 'network'],
  },
  readOnly: true,
  async run(args) {
    const devCount = args.device_count || 1;
    const network = args.network || 'wifi';
    const security = args.security || 'basic';
    const rollback = args.rollback !== false; // 默认 true

    const lines = [
      `## 📐 OTA 架构方案\n`,
      ``,
      `### 需求分析`,
      ``,
      `| 维度 | 选择 | 影响 |`,
      `|------|------|------|`,
      `| 设备规模 | ${devCount === 1 ? '少量 (<100)' : devCount === 2 ? '中等 (100-1000)' : '大量 (>1000)'} | ${devCount === 3 ? '需要 OTA 服务器+分批推送+断点续传' : devCount === 2 ? '需要 OTA 服务器+灰度发布' : '简单 HTTP 服务器即可'} |`,
      `| 网络 | ${network} | ${network === 'lorawan' ? '带宽极有限, 需差分升级' : network === 'cellular' ? '注意流量成本, 推荐差分升级' : '带宽充足, 全量 OTA 即可'} |`,
      `| 安全 | ${security} | ${security === 'high' ? 'Secure Boot + Flash Encryption + 固件签名' : security === 'basic' ? 'HTTPS + 固件签名验证' : '仅 HTTP, 仅适合开发'} |`,
      `| 回滚 | ${rollback ? '✅ 需要自动回滚' : '❌ 不需要'} | ${rollback ? 'ESP-IDF 支持, Arduino 需手动实现' : ''} |`,
      ``,
    ];

    // 方案组件
    lines.push(`### 架构组件\n`);
    lines.push(`\`\`\``);
    lines.push(`┌─────────────┐     HTTPS      ┌──────────────────┐`);
    lines.push(`│  OTA Server │ ◄────────────► │   设备 (ESP32)    │`);
    lines.push(`│             │                │                  │`);
    if (devCount >= 2) {
      lines.push(`│ • 版本管理  │                │ • 检查更新       │`);
      lines.push(`│ • 固件存储  │                │ • 下载固件       │`);
    }
    if (devCount >= 3) {
      lines.push(`│ • 灰度发布  │                │ • 校验签名       │`);
      lines.push(`│ • 分批推送  │                │ • 双区写入       │`);
    }
    if (security !== 'none') {
      lines.push(`│ • 签名验证  │                │ • 双区写入       │`);
    }
    if (rollback) {
      lines.push(`│ • 回滚支持  │                │ • 启动确认       │`);
    }
    lines.push(`└─────────────┘                └──────────────────┘`);
    lines.push(`\`\`\`\n`);

    // 版本管理
    lines.push(`### 版本管理方案\n`);
    lines.push(`- 版本号格式: \`MAJOR.MINOR.PATCH\` (语义化版本)`);
    lines.push(`- 设备上报: \`{ "device_id": "xxx", "current_version": "${'1.0.0'}", "chip": "esp32" }\``);
    lines.push(`- 服务器响应: \`{ "version": "1.1.0", "url": "https://...", "md5": "...", "changelog": "..." }\``);
    lines.push(`- 设备只在 \`new_version > current_version\` 时下载\n`);

    // 回滚机制
    if (rollback) {
      lines.push(`### 回滚机制 (ESP-IDF)\n`);
      lines.push(`\`\`\``);
      lines.push(`启动流程:`);
      lines.push(`  1. Bootloader 读 otadata → 选择 OTA 分区`);
      lines.push(`  2. 新固件启动后进入 "pending verify" 状态`);
      lines.push(`  3. 应用层确认正常 → esp_ota_mark_app_valid_cancel_rollback()`);
      lines.push(`  4. 如果启动后 watchdog 超时/panic → 自动标记 invalid`);
      lines.push(`  5. 下次启动 → 回滚到旧分区`);
      lines.push(`\`\`\``);
      lines.push(``);
      lines.push(`> 配置: \`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y\``);
      lines.push(`> 等待窗口: 默认 60 秒内必须确认, 否则视为失败\n`);
    }

    // 安全方案
    if (security === 'high') {
      lines.push(`### 高安全方案\n`);
      lines.push(`1. **Secure Boot V2**: RSA-PSS 签名验证, 防止未授权固件`);
      lines.push(`2. **Flash Encryption**: AES-XTS 加密 Flash 内容`);
      lines.push(`3. **固件签名**: 服务器用私钥签名, 设备用公钥验证`);
      lines.push(`4. **证书绑定**: HTTPS 客户端证书互信\n`);
      lines.push(`> ⚠️ Secure Boot 熔丝一旦烧写不可逆! 先充分测试再启用!`);
    } else if (security === 'basic') {
      lines.push(`### 基础安全方案\n`);
      lines.push(`1. **HTTPS**: 使用 TLS 加密传输`);
      lines.push(`2. **MD5/SHA256 校验**: 下载后验证完整性`);
      lines.push(`3. **版本号防回退**: 不接受低于当前版本的固件\n`);
    }

    // 网络优化
    if (network === 'lorawan' || network === 'cellular') {
      lines.push(`### 低带宽优化\n`);
      lines.push(`- **差分升级 (delta OTA)**: 使用 bsdiff/xdelta, 仅传输差异部分`);
      lines.push(`- 差分大小通常为全量的 5-20%`);
      lines.push(`- 实现: 设备端需要 diffpatch 库 + 备份当前固件\n`);
    }

    // 实现清单
    lines.push(`### 实现清单\n`);
    const checklist = [
      [security !== 'none', 'HTTPS 服务器 + 有效证书'],
      [security === 'high', 'Secure Boot 配置 + 密钥生成'],
      [rollback, 'ESP-IDF 回滚配置 + 应用层确认逻辑'],
      [devCount >= 2, 'OTA 服务器 API (版本检查 + 固件下载)'],
      [devCount >= 3, '灰度发布机制 (按比例推送)'],
      [network === 'lorawan' || network === 'cellular', '差分升级方案'],
      [true, '双 OTA 分区表 (ota_partition 工具)'],
      [true, 'OTA 代码 (ota_generate 工具)'],
      [true, '串口日志 + 错误恢复'],
    ];
    for (const [needed, item] of checklist) {
      if (needed) lines.push(`- [ ] ${item}`);
    }

    return lines.join('\n');
  },
};

// ── 导出 ────────────────────────────────────────────────────
module.exports = {
  tools: [otaGenerate, otaPartition, otaPlan],
};
