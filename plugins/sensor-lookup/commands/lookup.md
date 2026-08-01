---
name: lookup
description: 传感器速查 —— 输入型号,一键获取接线表 + 驱动库 + 示例代码
---

用户需要查询传感器信息。请引导:

1. 询问传感器型号(如 "BME280", "DHT22", "MPU6050")
2. 调用 `sensor_info` 工具查询详细信息
3. 如果用户不确定型号,先用 `sensor_list` 按类型(温湿度/距离/姿态等)列出可选传感器
4. 查到后,如果用户需要完整项目代码,调用 `sensor_driver_skeleton` 生成驱动骨架

输出时注意:
- 接线表用 Markdown 表格
- 示例代码标注语言(cpp/Arduino)
- 特别标注电压兼容性警告(3.3V vs 5V)
