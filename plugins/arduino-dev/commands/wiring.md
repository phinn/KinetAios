---
name: wiring
description: 生成接线方案 —— 根据传感器/外设和开发板型号,输出引脚连接表 + 注意事项
---

你现在要帮用户设计接线方案。请按以下步骤操作:

## 1. 确认硬件信息

向用户确认:
- 开发板型号(ESP32 / ESP32-S3 / Arduino Uno 等)
- 要连接的外设/传感器列表(型号)
- 是否有特殊需求(如使用 I2C、SPI、特定波特率)

## 2. 引脚分配原则

按以下规则分配引脚:

1. **优先使用专用总线引脚**: I2C(SDA/SCL)、SPI(MOSI/MISO/SCK/CS)、UART(TX/RX)
2. **ESP32 注意事项**:
   - GPIO 6-11: Flash 占用,不可用
   - GPIO 34-39: 只能输入(无上拉电阻)
   - ADC2(GPIO 0/2/4/12-15/25-27): WiFi 开启时不可用
   - 推荐: ADC1(GPIO 32-39)做模拟读取
3. **Arduino Uno**: A0-A5 可做模拟输入, D0/D1 被 Serial 占用

## 3. 输出接线表

用 Markdown 表格:

| 外设引脚 | 开发板引脚 | 说明 |
|---------|-----------|------|
| VCC | 3.3V | 供电(注意电压匹配) |
| GND | GND | 共地 |
| SDA | GPIO 21 | I2C 数据线 |
| SCL | GPIO 22 | I2C 时钟线 |

## 4. 电源注意事项

- 标明每个外设的供电电压(3.3V / 5V)
- 舵机/电机等大电流设备必须独立供电
- 所有设备共地(GND 连接在一起)

## 5. 对应代码

给出引脚定义的代码片段(对应接线表):

```cpp
// 引脚定义 / Pin definitions
#define SENSOR_SDA   21
#define SENSOR_SCL   22
#define LED_PIN      2
#define BUTTON_PIN   0
```
