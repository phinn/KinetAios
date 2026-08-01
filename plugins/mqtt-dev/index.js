// MQTT 通信调试插件 —— 工具集
// MQTT communication debug tools — publish, subscribe, broker check.
//
// 工具列表:
//   1. mqtt_check  — 检测 mosquitto-clients 是否已安装
//   2. mqtt_pub    — 向指定 topic 发布消息
//   3. mqtt_sub    — 订阅 topic, 持续监听 N 秒
//
// 依赖: mosquitto-clients (mosquitto_pub / mosquitto_sub)
//   Windows: 从 mosquitto.org 下载安装
//   macOS: brew install mosquitto
//   Linux: apt install mosquitto-clients

const { exec } = require('child_process');
const isWin = process.platform === 'win32';

function shellExec(command, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 2 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stdout: stdout || '', stderr: stderr || '', code: err.code || -1 });
      } else {
        resolve({ ok: true, stdout, stderr, code: 0 });
      }
    });
  });
}

// ── 检查 mosquitto-clients ────────────────────────────────
async function checkMosquitto(ctx) {
  const r = await shellExec('mosquitto_pub --help 2>&1 | head -1', ctx.cwd, 5000);
  if (!r.ok && !r.stdout.includes('mosquitto_pub')) {
    return {
      available: false,
      hint: [
        'mosquitto-clients 未安装',
        '',
        '## 安装',
        '### macOS',
        '```bash',
        'brew install mosquitto',
        '```',
        '### Linux',
        '```bash',
        'sudo apt install mosquitto-clients',
        '```',
        '### Windows',
        '从 https://mosquitto.org/download/ 下载安装',
        '安装后将安装目录(如 C:\\\\Program Files\\\\mosquitto\\\\)加入 PATH',
      ].join('\n'),
    };
  }
  return { available: true };
}

// ── 工具 1: mqtt_check ───────────────────────────────────
// Tool 1: mqtt_check — detect mosquitto-clients.
const mqttCheck = {
  name: 'mqtt_check',
  description: '检测 mosquitto-clients 是否已安装。未安装时给出安装指引。',
  parameters: { type: 'object', properties: {} },
  readOnly: true,
  async run(_args, ctx) {
    const mq = await checkMosquitto(ctx);
    if (!mq.available) {
      return `❌ ${mq.hint}`;
    }
    return `✅ mosquitto-clients 已安装\n\n可以使用 mqtt_pub 和 mqtt_sub 工具调试 MQTT 通信。`;
  },
};

// ── 工具 2: mqtt_pub ─────────────────────────────────────
// Tool 2: mqtt_pub — publish MQTT message.
const mqttPub = {
  name: 'mqtt_pub',
  description: '向 MQTT broker 发布消息。支持 QoS 0/1/2、retained 消息、用户名密码认证。',
  parameters: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        description: 'broker 地址(如 test.mosquitto.org, 192.168.1.100, localhost)',
      },
      port: {
        type: 'number',
        description: '端口号(默认 1883, TLS=8883)',
      },
      topic: {
        type: 'string',
        description: '发布主题(如 home/sensor/temp)',
      },
      message: {
        type: 'string',
        description: '消息内容',
      },
      qos: {
        type: 'number',
        description: 'QoS 级别: 0=最多一次, 1=至少一次, 2=恰好一次。默认 0',
      },
      retain: {
        type: 'boolean',
        description: '是否为 retained 消息(broker 保存最后一条)',
      },
      username: {
        type: 'string',
        description: '用户名(可选)',
      },
      password: {
        type: 'string',
        description: '密码(可选)',
      },
    },
    required: ['host', 'topic', 'message'],
  },
  readOnly: false,
  async run(args, ctx) {
    const mq = await checkMosquitto(ctx);
    if (!mq.available) {
      return `❌ ${mq.hint}`;
    }

    const host = args.host;
    const port = args.port || 1883;
    const topic = args.topic;
    const message = args.message;
    const qos = args.qos || 0;
    const retain = args.retain || false;

    const parts = [
      'mosquitto_pub',
      `-h ${host}`,
      `-p ${port}`,
      `-t "${topic}"`,
      `-m "${message.replace(/"/g, '\\"')}"`,
      `-q ${qos}`,
    ];

    if (retain) parts.push('-r');
    if (args.username) parts.push(`-u "${args.username}"`);
    if (args.password) parts.push(`-P "${args.password}"`);

    const cmd = parts.join(' ');

    await ctx.confirm(`MQTT 发布:\n  Broker: ${host}:${port}\n  Topic: ${topic}\n  Message: ${message}\n  QoS: ${qos}${retain ? ' (retained)' : ''}`);

    const r = await shellExec(cmd, ctx.cwd, 10000);

    if (!r.ok) {
      return [
        `❌ MQTT 发布失败`,
        ``,
        `Broker: ${host}:${port}`,
        `Topic: ${topic}`,
        ``,
        `错误:`,
        r.stderr || '连接超时或被拒绝',
        ``,
        `排查:`,
        `1. Broker 是否在线? ping ${host}`,
        `2. 端口 ${port} 是否开放?`,
        `3. 认证信息是否正确?`,
      ].join('\n');
    }

    return [
      `✅ MQTT 消息已发布`,
      ``,
      `  Broker: ${host}:${port}`,
      `  Topic: ${topic}`,
      `  Message: ${message}`,
      `  QoS: ${qos}${retain ? ' (retained)' : ''}`,
    ].join('\n');
  },
};

// ── 工具 3: mqtt_sub ─────────────────────────────────────
// Tool 3: mqtt_sub — subscribe to MQTT topic.
const mqttSub = {
  name: 'mqtt_sub',
  description: '订阅 MQTT topic,持续监听指定秒数内收到的消息。支持通配符(+/#)、QoS、认证。',
  parameters: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        description: 'broker 地址',
      },
      port: {
        type: 'number',
        description: '端口号(默认 1883)',
      },
      topic: {
        type: 'string',
        description: '订阅主题(支持通配符: home/+/temp, home/#)',
      },
      duration: {
        type: 'number',
        description: '监听时长(秒,默认 10,最大 30)',
      },
      qos: {
        type: 'number',
        description: 'QoS 级别,默认 0',
      },
      username: {
        type: 'string',
        description: '用户名(可选)',
      },
      password: {
        type: 'string',
        description: '密码(可选)',
      },
    },
    required: ['host', 'topic'],
  },
  readOnly: true,
  async run(args, ctx) {
    const mq = await checkMosquitto(ctx);
    if (!mq.available) {
      return `❌ ${mq.hint}`;
    }

    const host = args.host;
    const port = args.port || 1883;
    const topic = args.topic;
    const duration = Math.min(Math.max(args.duration || 10, 1), 30);
    const qos = args.qos || 0;

    const parts = [
      'mosquitto_sub',
      `-h ${host}`,
      `-p ${port}`,
      `-t "${topic}"`,
      `-q ${qos}`,
      '-C 100', // 最多收 100 条就退出
      '-v',     // verbose (显示 topic)
    ];

    if (args.username) parts.push(`-u "${args.username}"`);
    if (args.password) parts.push(`-P "${args.password}"`);

    const baseCmd = parts.join(' ');

    // Windows: 用 PowerShell 控制超时
    // Unix: 用 timeout 命令
    const cmd = isWin
      ? `powershell -NoProfile -Command "$p = Start-Process -NoNewWindow -PassThru -FilePath mosquitto_sub -ArgumentList '-h','${host}','-p','${port}','-t','${topic}','-q','${qos}','-v','-C','100'; Start-Sleep -Seconds ${duration}; Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue"`
      : `timeout ${duration} ${baseCmd} 2>&1 || true`;

    const r = await shellExec(cmd, ctx.cwd, (duration + 5) * 1000);

    const lines = [
      `📬 MQTT 订阅 (${duration}s)\n`,
      `  Broker: ${host}:${port}`,
      `  Topic: ${topic}`,
      `  QoS: ${qos}\n`,
    ];

    const output = (r.stdout || '').trim();
    if (output) {
      lines.push(`📥 收到消息:`);
      lines.push(output);
    } else {
      lines.push('📭 监听期间未收到消息');
      lines.push('');
      lines.push('排查:');
      lines.push('- 发布者是否在线? 是否使用了正确的 topic?');
      lines.push('- 通配符是否正确? (+ 匹配单层, # 匹配多层)');
      lines.push('- retained 消息: 加 -R 参数可以排除 retained');
    }

    return lines.join('\n');
  },
};

// ── 导出 ────────────────────────────────────────────────────
module.exports = {
  tools: [mqttCheck, mqttPub, mqttSub],
};
