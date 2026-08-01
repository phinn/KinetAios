---
name: mqtt-debug
description: MQTT 一站式调试 —— 发布消息 + 订阅监听 + 连接排查
---

用户需要调试 MQTT 通信:

1. 先调用 `mqtt_check` 确认 mosquitto-clients 已安装
2. 根据用户需求:
   - **发布测试消息**: 调用 `mqtt_pub`,需要 broker 地址、topic、消息内容
   - **订阅监听**: 调用 `mqtt_sub`,需要 broker 地址、topic、监听时长
3. 典型调试流程:
   - 先 `mqtt_sub` 订阅 topic 开始监听
   - 再 `mqtt_pub` 发布一条测试消息
   - 确认订阅端收到消息

公共测试 broker:
- test.mosquitto.org:1883
- broker.emqx.io:1883

提醒用户安全注意事项:
- 公共 broker 不适合生产环境
- 生产环境需要用户名/密码 + TLS
