---
name: at-debug
description: AT 指令交互式调试 —— 逐步发送 AT 命令配置 WiFi/蓝牙/4G 模块
---

你现在要帮用户通过 AT 指令调试通信模块(ESP-AT / WiFi / 蓝牙 / 4G / LoRa)。请按以下步骤操作:

## 1. 确认设备信息

向用户确认:
- 模块类型(ESP8266-AT / ESP32-AT / HC-05 / SIM800 等)
- 串口端口(如不确定,先用 `serial_scan` 扫描)
- 波特率(默认 115200,不确定时试 9600)

## 2. 基础通信测试

使用 `serial_query` 发送 `AT`,确认设备返回 OK:
- ✅ 返回 OK → 通信正常,继续配置
- ❌ 无响应 → 按以下顺序排查:
  1. TX/RX 是否交叉连接
  2. 波特率是否正确(尝试 115200 → 9600)
  3. 模块是否需要 EN/BOOT 拉高
  4. 供电是否充足(3.3V, 峰值电流 >300mA)

## 3. 设备信息

发送 `AT+GMR` 获取固件版本。

## 4. 按场景配置

根据用户需求逐步配置:

### WiFi 模块场景
```
AT+CWMODE=1          # Station 模式
AT+CWLAP             # 扫描附近 WiFi
AT+CWJAP="SSID","密码"  # 连接
AT+CIFSR             # 查 IP
```

### 蓝牙模块 (HC-05) 场景
```
AT+VERSION           # 查版本
AT+NAME=MyDevice     # 改名称
AT+PSWD=1234         # 改配对密码
```

### TCP 通信场景
```
AT+CIPSTART="TCP","api.example.com",80
AT+CIPSEND=10        # 发送 10 字节
> (输入数据)
AT+CIPCLOSE          # 关闭连接
```

## 5. 每步验证

每条 AT 命令都通过 `serial_query` 单独发送,确认响应后再执行下一步。
遇到 ERROR 时分析可能原因并给出修正方案。

## 6. 生成配置记录

将所有成功的 AT 命令整理成一份配置脚本,用户可保存复用。
