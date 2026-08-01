---
name: scope-view
description: 波形分析 —— 从串口采集 ADC 数据,分析频率/幅值/噪声/占空比
---

用户需要对 ADC 采样数据进行波形分析:

1. 请用户提供 ADC 采样数据(逗号或空格分隔的数值序列)
2. 询问参考电压(ESP32=3.3V, Arduino=5V)和分辨率(ESP32=12bit, Arduino=10bit)
3. 如果知道采样率,也请提供(用于计算频率)
4. 调用 `scope_diag` 工具执行分析

如果用户没有数据,提示如何采集:
- 写一个简单的 Arduino 程序用 analogRead() 采样并以逗号分隔输出到串口
- 用 serial_monitor 或 serial_session 采集串口数据
