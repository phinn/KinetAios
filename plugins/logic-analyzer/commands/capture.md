---
name: capture
description: 信号捕获 —— 配置 sigrok 采样参数并执行信号捕获,自动解码指定协议
---

用户需要用逻辑分析仪捕获和分析信号:

1. 先调用 `sigrok_check` 确认 sigrok-cli 已安装
2. 询问捕获参数:
   - 硬件驱动(默认 demo)
   - 采样率(建议为信号速率的 4 倍以上)
   - 通道数
   - 采样数量或时长
   - 触发条件(可选)
3. 调用 `sigrok_capture` 执行捕获
4. 捕获完成后,询问要解码的协议(UART/I²C/SPI 等)
5. 调用 `sigrok_decode` 执行协议解码

如果用户不确定参数,根据协议类型推荐默认值:
- UART 115200: 采样率 1MHz, 通道 0(rx)
- I²C 100kHz: 采样率 1MHz, 通道 0,1(sda,scl)
- SPI 1MHz: 采样率 4MHz, 通道 0-3(mosi,miso,clk,cs)
