---
name: ble-scan
description: BLE 设备发现 —— 扫描附近蓝牙设备并探索 GATT 服务
---

用户需要扫描和探索 BLE 设备:

1. 先调用 `ble_check` 确认 bleak 已安装
2. 调用 `ble_scan` 扫描附近 BLE 设备(默认 10 秒)
3. 扫描到目标设备后,询问用户要连接哪个设备地址
4. 调用 `ble_connect` 连接设备并列出所有 Service/Characteristic
5. 找到目标 UUID 后,询问用户要做什么操作:
   - 读取数据 → `ble_gatt` (action=read)
   - 写入数据 → `ble_gatt` (action=write)
   - 监听通知 → `ble_gatt` (action=notify)

常见 BLE UUID 提示:
- Nordic UART (NUS): 6e400001-... (ESP32 常用)
- NUS TX: 6e400002-... (设备发送)
- NUS RX: 6e400003-... (向设备写入)
