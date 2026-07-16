// 低空经济行业插件 —— 工具集
// Tool 接口签名见 src/main/tools.ts: Tool { name; description; parameters; readOnly?; run(args, ctx) }
// ctx.cwd = 当前会话工作目录; ctx.confirm(cmd) 让用户确认 shell 命令。
//
// 工具列表:
//   1. weather_brief    — 航空气象简报(风/能见度/降水/云底高)
//   2. airspace_check   — 低空空域/限飞区查询
//   3. flight_plan      — 航线规划(调本地航线规划 CLI 或内置估算)
//   4. compliance_check — 法规合规检查(机型/场景/空域 vs 当前法规库)
//
// ponytail: 外部 API 端点(气象/空管)用占位 URL + 环境变量,实际部署时替换为真实服务地址。
//           无网络时优雅降级 —— 返回提示信息而非崩溃(野外巡检场景刚需)。
//           所有工具均为 readOnly=true(只查不改),写操作(生成航点文件等)交给 Agent 用 write_file 完成。

const { exec } = require('child_process');
const https = require('https');
const http = require('http');

// ── 辅助:HTTP GET (Promise 封装, 带超时) ──────────────────────
// Low-altitude economy plugin — utility: HTTP GET with timeout.
function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.on('error', reject);
  });
}

// ── 辅助:坐标校验 ──────────────────────────────────────────
// 纬度 [-90, 90], 经度 [-180, 180]。
function validLat(v) { const n = Number(v); return !isNaN(n) && n >= -90 && n <= 90; }
function validLon(v) { const n = Number(v); return !isNaN(n) && n >= -180 && n <= 180; }

// ── 辅助:shell 执行 (带超时, 供 flight_plan 调本地 CLI) ──────
function shellExec(command, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (err.message || '').slice(0, 300), stdout, stderr });
      else resolve({ ok: true, stdout, stderr });
    });
  });
}

// ── 工具 1: 航空气象简报 ─────────────────────────────────────
// Tool 1: Aviation weather brief — fetches weather data for a coordinate + optional time window.
// 数据源优先级: 环境变量 LOWALT_WEATHER_API > Open-Meteo (免费, 无需 key) > 降级提示。
// 返回: 风速/风向、能见度、降水、云底高、温度 —— 飞行决策关键指标。
const weatherBrief = {
  name: 'weather_brief',
  description: '获取指定坐标的航空气象简报(风速、风向、能见度、降水概率、云底高、温度)。用于飞行前天气评估。输入纬度和经度,可选未来小时数(默认 12 小时预报)。',
  parameters: {
    type: 'object',
    properties: {
      lat: { type: 'number', description: '纬度 (-90 ~ 90)' },
      lon: { type: 'number', description: '经度 (-180 ~ 180)' },
      hours: { type: 'number', description: '预报时长(小时, 默认 12, 最大 48)' },
    },
    required: ['lat', 'lon'],
  },
  readOnly: true,
  async run(args) {
    const lat = Number(args.lat);
    const lon = Number(args.lon);
    if (!validLat(lat) || !validLon(lon)) {
      return '坐标无效: 纬度需在 [-90, 90], 经度需在 [-180, 180]。';
    }
    const hours = Math.min(Math.max(Number(args.hours) || 12, 1), 48);

    // 优先走自定义气象 API (企业部署可能有自己的气象服务)
    // Custom weather API takes priority (enterprise deployments may have their own service).
    const customApi = process.env.LOWALT_WEATHER_API;
    if (customApi) {
      try {
        const url = `${customApi}?lat=${lat}&lon=${lon}&hours=${hours}`;
        const res = await httpGet(url);
        if (res.status === 200 && res.body) {
          return `📡 [自定义气象源] (${lat}, ${lon}) 未来 ${hours}h:\n${res.body.slice(0, 2000)}`;
        }
      } catch (e) {
        // 自定义源挂了 → 降级到 Open-Meteo
        console.warn('[weather_brief] 自定义气象源不可用, 降级到 Open-Meteo:', e.message);
      }
    }

    // 降级: Open-Meteo 免费API (无需 key, 适合 demo / 开发)
    // Fallback: Open-Meteo free API (no key required, good for demo / dev).
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&hourly=windspeed_10m,winddirection_10m,visibility,precipitation_probability,cloudbase,temperature_2m` +
        `&forecast_hours=${hours}&timezone=auto`;
      const res = await httpGet(url);
      if (res.status !== 200) return `气象数据获取失败 (HTTP ${res.status})。`;
      const data = JSON.parse(res.body);
      const h = data.hourly || {};
      const times = (h.time || []).slice(0, hours);
      const wind = (h.windspeed_10m || []).slice(0, hours);
      const wdir = (h.winddirection_10m || []).slice(0, hours);
      const vis = (h.visibility || []).slice(0, hours);
      const precip = (h.precipitation_probability || []).slice(0, hours);
      const cloudbase = (h.cloudbase || []).slice(0, hours);
      const temp = (h.temperature_2m || []).slice(0, hours);

      // 构建逐小时简报, 标注风险项
      // Build hourly brief, flag risk items.
      const lines = [];
      lines.push(`🌤️ 航空气象简报 (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
      lines.push(`时区: ${data.timezone_abbreviation || 'local'} | 未来 ${hours} 小时\n`);

      for (let i = 0; i < times.length; i++) {
        const risk = [];
        if (wind[i] != null && wind[i] > 10.8) risk.push('⚠️大风');       // ≥6级风 (10.8 m/s)
        if (vis[i] != null && vis[i] < 3000) risk.push('⚠️低能见度');      // <3km 影响目视飞行
        if (precip[i] != null && precip[i] > 70) risk.push('⚠️高降水概率'); // >70%
        const flag = risk.length ? ` [${risk.join(', ')}]` : '';
        lines.push(
          `${times[i]} | 风 ${wind[i] != null ? wind[i].toFixed(1) + ' m/s' : 'N/A'}` +
          ` ${wdir[i] != null ? wdir[i].toFixed(0) + '°' : ''}` +
          ` | 能见度 ${vis[i] != null ? (vis[i] / 1000).toFixed(1) + ' km' : 'N/A'}` +
          ` | 降水 ${precip[i] != null ? precip[i] + '%' : 'N/A'}` +
          ` | 云底 ${cloudbase[i] != null ? cloudbase[i].toFixed(0) + ' m' : 'N/A'}` +
          ` | 温度 ${temp[i] != null ? temp[i].toFixed(0) + '°C' : 'N/A'}${flag}`
        );
      }

      // 总结: 找出风险时段
      // Summary: identify risk time windows.
      const riskHours = lines.filter((l) => l.includes('⚠️'));
      if (riskHours.length > 0) {
        lines.push(`\n⚠️ 共 ${riskHours.length} 个时段存在飞行风险, 建议避开。`);
      } else {
        lines.push('\n✅ 未来时段气象条件良好, 适宜飞行。');
      }

      return lines.join('\n');
    } catch (e) {
      return `气象数据获取失败: ${e.message || e}\n(离线模式下请手动查询当地气象信息)`;
    }
  },
};

// ── 工具 2: 低空空域/限飞区查询 ───────────────────────────────
// Tool 2: Airspace / restricted zone check — queries whether a coordinate + altitude is in a restricted area.
// 数据源: 环境变量 LOWALT_AIRSPACE_API (企业空管平台) > 内置常见限飞规则 > 提示手动查询。
// 返回: 空域类型、限飞状态、高度限制、注意事项。
const airspaceCheck = {
  name: 'airspace_check',
  description: '查询指定坐标和高度的低空空域状态(是否在限飞区、管制区、临时禁飞区)。输入纬度、经度和计划飞行高度(米),返回空域类型和飞行许可建议。',
  parameters: {
    type: 'object',
    properties: {
      lat: { type: 'number', description: '纬度 (-90 ~ 90)' },
      lon: { type: 'number', description: '经度 (-180 ~ 180)' },
      altitude: { type: 'number', description: '计划飞行高度 (米, 真高 AGL)' },
    },
    required: ['lat', 'lon', 'altitude'],
  },
  readOnly: true,
  async run(args) {
    const lat = Number(args.lat);
    const lon = Number(args.lon);
    const alt = Number(args.altitude);
    if (!validLat(lat) || !validLon(lon)) {
      return '坐标无效: 纬度需在 [-90, 90], 经度需在 [-180, 180]。';
    }
    if (isNaN(alt) || alt < 0 || alt > 6000) {
      return '高度无效: 请输入 0~6000 米之间的真高 (AGL)。';
    }

    // 优先走企业空管平台 API
    // Enterprise UTM platform API takes priority.
    const customApi = process.env.LOWALT_AIRSPACE_API;
    if (customApi) {
      try {
        const url = `${customApi}?lat=${lat}&lon=${lon}&altitude=${alt}`;
        const res = await httpGet(url);
        if (res.status === 200 && res.body) {
          return `🛩️ [空管平台] (${lat}, ${lon}) 高度 ${alt}m:\n${res.body.slice(0, 2000)}`;
        }
      } catch (e) {
        console.warn('[airspace_check] 空管平台不可用, 降级到本地规则:', e.message);
      }
    }

    // 降级: 基于通用规则的静态判断 (中国低空空域分类参考)
    // Fallback: static rules based on China low-altitude airspace classification.
    // 真高 120m 以下 = G 类(非管制空域, 适航条件可飞)
    // 真高 120-300m = 部分需报备
    // 真高 300-6000m = 管制空域, 需审批
    const lines = [];
    lines.push(`🛩️ 空域初步评估 (${lat.toFixed(4)}, ${lon.toFixed(4)}) 高度 ${alt}m AGL`);
    lines.push('(⚠️ 基于通用规则估算, 非实时数据。请以当地空管部门通告为准。)\n');

    // 空域分类 (基于中国《低空空域管理使用规定》框架)
    if (alt <= 120) {
      lines.push('📂 空域类型: G 类 (非管制空域, 真高 120m 以下)');
      lines.push('✅ 一般情况: 微型/轻型无人机可飞行');
      lines.push('⚠️ 注意: 仍需避让机场净空区、军事禁区、核设施等敏感区域');
    } else if (alt <= 300) {
      lines.push('📂 空域类型: W2 (部分报告空域, 真高 120-300m)');
      lines.push('🔶 需要提前向当地空管部门报备飞行计划');
      lines.push('⚠️ 小型无人机需持证操作 (UTC/AOPA)');
    } else if (alt <= 1000) {
      lines.push('📂 空域类型: C/D 类过渡 (真高 300-1000m)');
      lines.push('🔴 管制空域: 必须提前申请并获得空管许可');
      lines.push('📋 需提交: 飞行计划、操作员资质、保险证明、机型适航文件');
    } else {
      lines.push('📂 空域类型: C 类 (真高 1000m+)');
      lines.push('🔴 严格管制空域: 必须获得民航/军航空管审批');
      lines.push('⚠️ 通常仅限有人驾驶航空器, 无人机需特殊许可');
    }

    lines.push('');
    lines.push('📌 建议操作:');
    lines.push('  1. 查询当地最新 NOTAM (航行通告)');
    lines.push('  2. 确认是否在机场净空保护区内');
    lines.push('  3. 通过 UTMISS (无人机云系统) 或当地空管申报飞行计划');

    return lines.join('\n');
  },
};

// ── 工具 3: 航线规划 ─────────────────────────────────────────
// Tool 3: Flight route planning — estimates distance, flight time, battery requirement.
// 如果本机装了航线规划 CLI (如 MAVLink waypoint planner), 通过 shell 调用;否则用内置估算。
const flightPlan = {
  name: 'flight_plan',
  description: '规划飞行航线:输入起降点和途经点(纬度/经度),计算总航程、预估飞行时间、电量需求。可选指定无人机型号和巡航速度。如本机有航线规划 CLI,自动调用生成航点文件。',
  parameters: {
    type: 'object',
    properties: {
      waypoints: {
        type: 'array',
        description: '航点列表, 每项含 lat 和 lon。至少 2 个点(起飞、降落)。',
        items: {
          type: 'object',
          properties: {
            lat: { type: 'number', description: '纬度' },
            lon: { type: 'number', description: '经度' },
            name: { type: 'string', description: '航点名称(可选)' },
          },
          required: ['lat', 'lon'],
        },
      },
      droneType: { type: 'string', description: '无人机型号 (可选, 默认 "generic-multirotor")' },
      cruiseSpeed: { type: 'number', description: '巡航速度 m/s (可选, 默认 15)' },
      batteryCapacity: { type: 'number', description: '电池容量 mAh (可选, 默认 5000)' },
    },
    required: ['waypoints'],
  },
  readOnly: true,
  async run(args, ctx) {
    const wps = args.waypoints;
    if (!Array.isArray(wps) || wps.length < 2) {
      return '航点至少需要 2 个(起飞点和降落点)。';
    }
    for (const wp of wps) {
      if (!validLat(wp.lat) || !validLon(wp.lon)) {
        return `航点坐标无效: lat=${wp.lat}, lon=${wp.lon}`;
      }
    }

    const speed = Math.max(1, Number(args.cruiseSpeed) || 15); // m/s
    const battery = Math.max(100, Number(args.batteryCapacity) || 5000); // mAh
    const droneType = String(args.droneType || 'generic-multirotor');

    // 尝试调用本机航线规划 CLI (如果装了的话)
    // Try local flight planner CLI if installed.
    const plannerCmd = process.env.LOWALT_FLIGHT_PLANNER;
    if (plannerCmd && ctx && ctx.cwd) {
      const wpJson = JSON.stringify(wps);
      const result = await shellExec(`${plannerCmd} '${wpJson}'`, ctx.cwd);
      if (result.ok) {
        return `📋 [CLI 规划结果]\n${result.stdout.slice(0, 2000)}`;
      }
      // CLI 失败 → 降级到内置估算
      console.warn('[flight_plan] CLI 不可用, 降级到内置估算:', result.error);
    }

    // 内置估算: Haversine 公式算逐段距离
    // Built-in estimation: Haversine formula for segment distances.
    function haversine(lat1, lon1, lat2, lon2) {
      const R = 6371000; // 地球半径(米)
      const toRad = (d) => (d * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return Math.round(2 * R * Math.asin(Math.sqrt(a)));
    }

    // 计算逐段距离
    let totalDist = 0;
    const segments = [];
    for (let i = 0; i < wps.length - 1; i++) {
      const d = haversine(wps[i].lat, wps[i].lon, wps[i + 1].lat, wps[i + 1].lon);
      totalDist += d;
      segments.push({
        from: wps[i].name || `WP${i + 1}`,
        to: wps[i + 1].name || `WP${i + 2}`,
        dist: d,
      });
    }

    // 飞行时间 (秒) = 距离 / 速度
    const flightTime = Math.round(totalDist / speed);
    // 电量估算: 经验公式 — 巡航功耗 ~ 0.15 mAh/m (四旋翼典型值)
    // 多加 30% 安全余量 + 返航预留
    const estPowerPerMeter = droneType.includes('fixed-wing') ? 0.05 : 0.15; // 固定翼更省电
    const requiredCapacity = Math.round(totalDist * estPowerPerMeter * 1.3); // mAh, 含 30% 余量
    const batteryOk = requiredCapacity <= battery * 0.8; // 只用 80% 电量(留 20% 安全)

    // 格式化时间
    const fmtTime = (sec) => {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m > 0 ? `${m}分${s}秒` : `${s}秒`;
    };

    const lines = [];
    lines.push(`📋 航线规划报告 (${droneType})`);
    lines.push(`巡航速度: ${speed} m/s | 电池: ${battery} mAh\n`);
    lines.push('航段明细:');
    segments.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.from} → ${s.to}: ${s.dist} m`);
    });
    lines.push(`\n总航程: ${(totalDist / 1000).toFixed(2)} km`);
    lines.push(`预估飞行时间: ${fmtTime(flightTime)}`);
    lines.push(`预估耗电: ${requiredCapacity} mAh (含 30% 安全余量)`);
    lines.push(`电池状态: ${batteryOk ? '✅ 电量充足' : '🔴 电量不足! 需更换大容量电池或缩短航线'}`);

    if (!batteryOk) {
      lines.push('\n⚠️ 建议:');
      lines.push(`  - 需要至少 ${Math.ceil(requiredCapacity / 0.8)} mAh 的电池`);
      lines.push('  - 或减少航点 / 降低巡航速度以节省电量');
      lines.push('  - 建议设置中途换电站');
    }

    // 输出航点 CSV (方便导入地面站软件)
    lines.push('\n📎 航点 CSV (可复制保存为 .csv 导入地面站):');
    lines.push('latitude,longitude,name');
    wps.forEach((wp, i) => {
      lines.push(`${wp.lat},${wp.lon},${wp.name || `WP${i + 1}`}`);
    });

    return lines.join('\n');
  },
};

// ── 工具 4: 法规合规检查 ─────────────────────────────────────
// Tool 4: Regulatory compliance check — checks a flight scenario against known regulations.
// 基于内置法规知识库做初步筛查, 生成检查清单。实际审批以民航局为准。
const complianceCheck = {
  name: 'compliance_check',
  description: '飞行法规合规检查:根据飞行场景(巡检/物流/航拍等)、无人机类别、飞行区域和高度,检查是否满足法规要求。返回合规检查清单和需要办理的手续。基于中国民航局无人机管理法规框架。',
  parameters: {
    type: 'object',
    properties: {
      scenario: {
        type: 'string',
        description: '飞行场景: inspect(巡检) / logistics(物流) / photography(航拍) / agriculture(植保) / mapping(测绘) / emergency(应急救援)',
      },
      droneCategory: {
        type: 'string',
        description: '无人机类别: micro(微型 <250g) / light(轻型 <4kg) / small(小型 4-15kg) / medium(中型 15-116kg) / large(大型 >116kg) / evtol(载人)',
      },
      flightArea: {
        type: 'string',
        description: '飞行区域类型: uncontrolled(非管制区) / controlled(管制区) / airport(机场附近) / urban(城市上空) / rural(郊区/农村) / border(边境)',
      },
      altitude: { type: 'number', description: '飞行高度(米, 真高 AGL)' },
      bvlos: { type: 'boolean', description: '是否超视距飞行 (BVLOS), 默认 false' },
    },
    required: ['scenario', 'droneCategory', 'flightArea'],
  },
  readOnly: true,
  async run(args) {
    const scenario = String(args.scenario || '').toLowerCase();
    const droneCat = String(args.droneCategory || '').toLowerCase();
    const area = String(args.flightArea || '').toLowerCase();
    const alt = Number(args.altitude) || 0;
    const bvlos = Boolean(args.bvlos);

    const checks = [];
    const warnings = [];
    const required = []; // 需要办理的手续

    // ── 无人机实名登记 ──
    checks.push({ item: '无人机实名登记', status: droneCat === 'micro' ? 'optional' : 'required' });
    if (droneCat !== 'micro') required.push('✅ 在民航局无人机实名登记系统完成登记');

    // ── 操作员资质 ──
    if (droneCat === 'micro' || droneCat === 'light') {
      checks.push({ item: '操作员执照', status: 'optional', note: '微型/轻型可在绿区免证飞行' });
    } else {
      checks.push({ item: '操作员执照', status: 'required' });
      required.push('✅ 操作员需持有相应等级的无人机驾驶执照 (UTC/AOPA/CAAC)');
    }

    // ── 超视距 (BVLOS) ──
    if (bvlos) {
      checks.push({ item: '超视距飞行许可', status: 'required' });
      required.push('✅ 超视距飞行需申请特殊许可, 并具备 C2 链路能力');
      warnings.push('⚠️ 超视距飞行风险较高, 需完善的风险评估报告');
    } else {
      checks.push({ item: '视距内飞行', status: 'pass' });
    }

    // ── 空域管制 ──
    if (area === 'airport') {
      checks.push({ item: '机场净空区', status: 'forbidden' });
      warnings.push('🔴 机场净空保护区内严禁未经批准的飞行!');
      required.push('✅ 如确需在机场附近飞行, 须提前向民航空管部门申请特别许可');
    } else if (area === 'controlled') {
      checks.push({ item: '管制空域飞行许可', status: 'required' });
      required.push('✅ 须提前申请空域使用许可 (飞行计划申请)');
    } else if (area === 'urban') {
      checks.push({ item: '城市上空飞行', status: 'caution' });
      warnings.push('⚠️ 城市上空飞行需特别注意地面人员安全, 建议购买第三方责任险');
    } else if (area === 'border') {
      checks.push({ item: '边境区域', status: 'forbidden' });
      warnings.push('🔴 边境区域飞行涉及国家安全, 须获得特别审批!');
    } else {
      checks.push({ item: '空域类型', status: 'pass', note: '非管制空域, 符合条件可飞行' });
    }

    // ── 高度检查 ──
    if (alt > 120) {
      checks.push({ item: '飞行高度 (>120m)', status: 'required' });
      required.push(`✅ 真高 ${alt}m 超过 120m, 需申报飞行计划`);
    } else if (alt > 0) {
      checks.push({ item: `飞行高度 (${alt}m)`, status: 'pass' });
    }

    // ── 场景特有要求 ──
    if (scenario === 'logistics') {
      checks.push({ item: '物流运营资质', status: 'required' });
      required.push('✅ 无人机物流运营需取得《通用航空企业经营许可证》');
      required.push('✅ 运营人需具备无人机物流运行合格证');
    } else if (scenario === 'agriculture') {
      checks.push({ item: '农药喷洒资质', status: 'required' });
      required.push('✅ 植保作业人员需持植保无人机操作证');
    } else if (scenario === 'emergency') {
      checks.push({ item: '应急救援特殊通道', status: 'expedited' });
      required.push('✅ 应急救援可走绿色审批通道, 但事后需补办手续');
    } else if (scenario === 'evtoll' || droneCat === 'evtol') {
      checks.push({ item: 'eVTOL 适航认证', status: 'required' });
      required.push('✅ eVTOL 需取得型号合格证 (TC) + 适航证 (AC)');
      required.push('✅ 驾驶员需持有相应等级的飞行执照');
      warnings.push('⚠️ eVTOL 载人飞行属高门槛领域, 审批周期长');
    }

    // ── 保险 ──
    if (droneCat === 'small' || droneCat === 'medium' || droneCat === 'large' || droneCat === 'evtol') {
      checks.push({ item: '第三方责任险', status: 'required' });
      required.push('✅ 小型以上无人机必须投保第三方责任险');
    }

    // ── 输出报告 ──
    const lines = [];
    const scenarioNames = {
      inspect: '巡检', logistics: '物流', photography: '航拍',
      agriculture: '植保', mapping: '测绘', emergency: '应急救援',
    };
    lines.push(`📋 法规合规检查报告`);
    lines.push(`场景: ${scenarioNames[scenario] || scenario} | 机型: ${droneCat} | 区域: ${area} | 高度: ${alt || '未指定'}m | 超视距: ${bvlos ? '是' : '否'}\n`);

    lines.push('检查项:');
    const statusIcon = { pass: '✅', required: '🔶', optional: '⚪', forbidden: '🔴', caution: '⚠️', expedited: '🟡' };
    for (const c of checks) {
      const icon = statusIcon[c.status] || '❓';
      let line = `  ${icon} ${c.item}: ${c.status}`;
      if (c.note) line += ` (${c.note})`;
      lines.push(line);
    }

    if (warnings.length > 0) {
      lines.push('\n⚠️ 风险提示:');
      warnings.forEach((w) => lines.push(`  ${w}`));
    }

    if (required.length > 0) {
      lines.push('\n📝 需办理手续:');
      required.forEach((r) => lines.push(`  ${r}`));
    } else {
      lines.push('\n✅ 未发现强制手续要求, 符合免申即飞条件。');
    }

    lines.push('\n⚠️ 以上为基于通用法规的初步筛查, 实际飞行请以当地空管部门和民航局最新规定为准。');
    lines.push('📎 参考: CCAR-92《无人驾驶航空器飞行管理暂行条例》');

    return lines.join('\n');
  },
};

// ── 导出 ────────────────────────────────────────────────────
module.exports = {
  tools: [weatherBrief, airspaceCheck, flightPlan, complianceCheck],
};
