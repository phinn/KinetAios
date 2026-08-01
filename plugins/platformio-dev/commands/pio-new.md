---
name: pio-new
description: 创建 PlatformIO 项目 —— 选板子 + 配框架 + 生成骨架 + 首次编译
---

你现在要帮用户创建一个新的 PlatformIO 项目。请按以下步骤操作:

## 1. 确认项目信息

向用户确认:
- 目标开发板(如 ESP32-S3 / ESP32-C3 / STM32 F401RE)
- 框架(Arduino / ESP-IDF / STM32Cube)
- 项目名称和功能描述

## 2. 检查环境

使用 `pio_check` 确认 PlatformIO CLI 已安装。如果未安装,给出安装指引。

## 3. 初始化项目

使用 `pio_init` 初始化项目,传入 board ID 和 framework。

## 4. 生成功能代码

根据用户需求在 `src/main.cpp` 中编写功能代码:
- 引入需要的库(用 `pio_lib` 的 install 动作安装)
- 编写 setup() 和 loop()
- 加入串口调试输出

## 5. 配置 platformio.ini

确保 platformio.ini 包含:
- monitor_speed 和 upload_speed
- lib_deps(如果用了外部库)
- build_flags(如需要)

## 6. 首次编译

使用 `pio_compile` 编译。首次编译会下载工具链,耐心等待。
如果失败,分析错误并修正。

给出项目结构概览和烧录指引。
