---
name: ota-setup
description: OTA 全流程搭建 —— 分区表 + OTA 代码 + 架构设计
---

用户需要为 ESP32/ESP8266 搭建 OTA 固件升级能力:

1. **架构设计**: 调用 `ota_plan` 设计 OTA 方案
   - 询问设备数量级、网络类型、安全级别
2. **分区表**: 调用 `ota_partition` 生成 OTA 分区表
   - 确认 Flash 大小(4MB/8MB/16MB)
3. **OTA 代码**: 调用 `ota_generate` 生成升级代码
   - 确认芯片(ESP32/ESP8266)
   - 确认模式(HTTP/HTTPS/WebUpdater)
   - HTTP/HTTPS 需要固件服务器 URL

提醒用户:
- 分区表更改后需完全擦除 Flash 再重新烧录
- 生产环境建议 HTTPS + 固件签名
- 首次使用建议先用 WebUpdater 模式测试
