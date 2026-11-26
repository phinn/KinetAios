(function () {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();
  var warn = style.getPropertyValue('--warn').trim();
  var mono = "'JetBrains Mono', ui-monospace, monospace";
  var body = "'Instrument Sans', -apple-system, sans-serif";

  var tooltipBase = {
    backgroundColor: bg2,
    borderColor: rule,
    borderWidth: 1,
    textStyle: { color: ink, fontSize: 12, fontFamily: body },
    appendToBody: true,
    extraCssText: 'border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);'
  };

  var axisLabel = { color: muted, fontSize: 11, fontFamily: mono };
  var splitLine = { lineStyle: { color: rule, type: 'dashed', opacity: 0.55 } };

  /* ---------------- data ---------------- */
  var days = ['11-12','11-13','11-14','11-15','11-16','11-17','11-18','11-19','11-20','11-21','11-22','11-23','11-24','11-25'];
  var views = [12,7,7,18,44,27,17,17,5,22,5,8,10,6];
  var viewUniq = [4,5,3,15,21,17,13,4,5,13,3,6,5,5];
  var clones = [62,13,42,58,173,61,20,57,177,84,40,44,39,36];
  var cloneUniq = [32,8,13,32,3,30,14,24,71,44,22,16,19,20];

  /* ---------------- 1. daily traffic ---------------- */
  var c1 = echarts.init(document.getElementById('chart-daily'), null, { renderer: 'svg' });
  c1.setOption({
    animation: false,
    grid: { left: 48, right: 48, top: 34, bottom: 34 },
    tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'shadow' } }, tooltipBase),
    legend: {
      data: ['克隆次数', '页面浏览次数'],
      top: 0, right: 0, itemWidth: 10, itemHeight: 10,
      textStyle: { color: muted, fontSize: 11, fontFamily: body }
    },
    xAxis: {
      type: 'category',
      data: days,
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false },
      axisLabel: axisLabel
    },
    yAxis: [
      {
        type: 'value', name: '克隆', nameTextStyle: { color: muted, fontSize: 10, fontFamily: mono },
        axisLabel: axisLabel, splitLine: splitLine, axisLine: { show: false }
      },
      {
        type: 'value', name: '浏览', nameTextStyle: { color: muted, fontSize: 10, fontFamily: mono },
        axisLabel: axisLabel, splitLine: { show: false }, axisLine: { show: false }
      }
    ],
    series: [
      {
        name: '克隆次数', type: 'bar', data: clones, barWidth: '46%',
        itemStyle: { color: accent2 + 'cc', borderRadius: [3, 3, 0, 0] },
        emphasis: { itemStyle: { color: accent2 } }
      },
      {
        name: '页面浏览次数', type: 'line', yAxisIndex: 1, data: views, smooth: true,
        symbol: 'circle', symbolSize: 6,
        lineStyle: { color: accent, width: 2.2 },
        itemStyle: { color: accent, borderColor: bg2, borderWidth: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: accent + '33' },
            { offset: 1, color: accent + '00' }
          ])
        }
      }
    ]
  });

  /* ---------------- 2. uniques ---------------- */
  var c2 = echarts.init(document.getElementById('chart-uniques'), null, { renderer: 'svg' });
  c2.setOption({
    animation: false,
    grid: { left: 44, right: 24, top: 34, bottom: 34 },
    tooltip: Object.assign({ trigger: 'axis' }, tooltipBase),
    legend: {
      data: ['独立访客（浏览）', '独立克隆源'],
      top: 0, right: 0, itemWidth: 10, itemHeight: 10,
      textStyle: { color: muted, fontSize: 11, fontFamily: body }
    },
    xAxis: {
      type: 'category', data: days,
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false },
      axisLabel: axisLabel
    },
    yAxis: { type: 'value', axisLabel: axisLabel, splitLine: splitLine, axisLine: { show: false } },
    series: [
      {
        name: '独立访客（浏览）', type: 'line', data: viewUniq, smooth: true,
        symbol: 'circle', symbolSize: 5,
        lineStyle: { color: accent, width: 2 },
        itemStyle: { color: accent, borderColor: bg2, borderWidth: 2 }
      },
      {
        name: '独立克隆源', type: 'line', data: cloneUniq, smooth: true,
        symbol: 'circle', symbolSize: 5,
        lineStyle: { color: accent2, width: 2, type: 'dashed' },
        itemStyle: { color: accent2, borderColor: bg2, borderWidth: 2 }
      }
    ]
  });

  /* ---------------- 3. referrers ---------------- */
  var refNames = ['github.com', 'phinn.github.io', 'youtube.com', 'Google', 'claude.ai', 'techrobinhood.com'];
  var refCounts = [9, 7, 5, 2, 1, 1];
  var c3 = echarts.init(document.getElementById('chart-referrers'), null, { renderer: 'svg' });
  c3.setOption({
    animation: false,
    grid: { left: 8, right: 40, top: 12, bottom: 12, containLabel: true },
    tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'shadow' } }, tooltipBase),
    xAxis: { type: 'value', axisLabel: axisLabel, splitLine: splitLine, axisLine: { show: false } },
    yAxis: {
      type: 'category', data: refNames.slice().reverse(),
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: ink, fontSize: 11.5, fontFamily: mono }
    },
    series: [{
      type: 'bar', data: refCounts.slice().reverse(),
      barWidth: '52%',
      itemStyle: {
        borderRadius: [0, 3, 3, 0],
        color: function (p) {
          return p.dataIndex === refCounts.length - 1 ? accent : accent + '66';
        }
      },
      label: {
        show: true, position: 'right', color: muted,
        fontSize: 11, fontFamily: mono
      }
    }]
  });

  /* ---------------- 4. popular paths ---------------- */
  var pathNames = [
    '/phinn/KinetAios (Overview)',
    '/graphs/traffic',
    '/releases/tag/v4.2.2',
    '/wiki/Voice-Chat',
    '/issues',
    '/pulse',
    '/releases/tag/v4.2.3',
    '/releases',
    '/releases/tag/v4.2.5',
    '/releases/tag/v4.2.1'
  ];
  var pathCounts = [97, 17, 11, 8, 6, 6, 5, 4, 4, 3];
  var c4 = echarts.init(document.getElementById('chart-paths'), null, { renderer: 'svg' });
  c4.setOption({
    animation: false,
    grid: { left: 8, right: 44, top: 12, bottom: 12, containLabel: true },
    tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'shadow' } }, tooltipBase),
    xAxis: { type: 'value', axisLabel: axisLabel, splitLine: splitLine, axisLine: { show: false } },
    yAxis: {
      type: 'category', data: pathNames.slice().reverse(),
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 11, fontFamily: mono }
    },
    series: [{
      type: 'bar', data: pathCounts.slice().reverse(),
      barWidth: '56%',
      itemStyle: {
        borderRadius: [0, 3, 3, 0],
        color: function (p) {
          return p.dataIndex === pathCounts.length - 1 ? accent : accent + '55';
        }
      },
      label: { show: true, position: 'right', color: muted, fontSize: 11, fontFamily: mono }
    }]
  });

  /* ---------------- 5. platform donut ---------------- */
  var c5 = echarts.init(document.getElementById('chart-platform'), null, { renderer: 'svg' });
  c5.setOption({
    animation: false,
    tooltip: Object.assign({
      trigger: 'item',
      formatter: function (p) { return p.name + '：' + p.value + ' 次（' + p.percent + '%）'; }
    }, tooltipBase),
    legend: {
      bottom: 0, itemWidth: 10, itemHeight: 10,
      textStyle: { color: muted, fontSize: 12, fontFamily: body },
      formatter: function (name) {
        var map = { 'macOS (.dmg)': '308 次', 'Windows (.exe)': '246 次' };
        return name + '  ' + (map[name] || '');
      }
    },
    title: {
      text: '554',
      subtext: '次下载',
      left: 'center',
      top: '37%',
      textAlign: 'center',
      textStyle: { color: ink, fontSize: 30, fontWeight: 'bold', fontFamily: mono },
      subtextStyle: { color: muted, fontSize: 11, fontFamily: body, letterSpacing: 2 },
      itemGap: 4
    },
    series: [{
      type: 'pie',
      radius: ['54%', '72%'],
      center: ['50%', '46%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: bg2, borderWidth: 3 },
      label: { show: false },
      labelLine: { show: false },
      data: [
        { value: 308, name: 'macOS (.dmg)', itemStyle: { color: accent } },
        { value: 246, name: 'Windows (.exe)', itemStyle: { color: accent2 } }
      ]
    }]
  });

  /* ---------------- 6. top releases ---------------- */
  var relNames = ['v4.0.3', 'v3.9.4', 'v4.2.0', 'v4.2.2', 'v3.9.0', 'v4.0.0', 'v4.0.7', 'v4.0.6'];
  var relDl = [34, 24, 15, 14, 13, 10, 9, 9];
  var c6 = echarts.init(document.getElementById('chart-releases'), null, { renderer: 'svg' });
  c6.setOption({
    animation: false,
    grid: { left: 8, right: 40, top: 12, bottom: 12, containLabel: true },
    tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'shadow' } }, tooltipBase),
    xAxis: { type: 'value', axisLabel: axisLabel, splitLine: splitLine, axisLine: { show: false } },
    yAxis: {
      type: 'category', data: relNames.slice().reverse(),
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: ink, fontSize: 11.5, fontFamily: mono }
    },
    series: [{
      type: 'bar', data: relDl.slice().reverse(),
      barWidth: '52%',
      itemStyle: {
        borderRadius: [0, 3, 3, 0],
        color: function (p) { return p.dataIndex === relDl.length - 1 ? accent : accent2 + '77'; }
      },
      label: { show: true, position: 'right', color: muted, fontSize: 11, fontFamily: mono }
    }]
  });

  /* ---------------- 7. weekly commits ---------------- */
  var weeks = ['第1周','第2周','第3周','第4周','第5周','第6周','第7周','第8周'];
  var commits = [1, 50, 42, 31, 75, 99, 25, 47];
  var c7 = echarts.init(document.getElementById('chart-commits'), null, { renderer: 'svg' });
  c7.setOption({
    animation: false,
    grid: { left: 48, right: 62, top: 26, bottom: 34 },
    tooltip: Object.assign({
      trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: function (p) { return p[0].axisValue + '：' + p[0].value + ' 次提交'; }
    }, tooltipBase),
    xAxis: {
      type: 'category', data: weeks,
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false },
      axisLabel: axisLabel
    },
    yAxis: { type: 'value', axisLabel: axisLabel, splitLine: splitLine, axisLine: { show: false } },
    series: [{
      type: 'bar', data: commits, barWidth: '44%',
      itemStyle: {
        borderRadius: [4, 4, 0, 0],
        color: function (p) {
          return p.value >= 75 ? accent : accent + '66';
        }
      },
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: warn, type: 'dashed', width: 1 },
        label: { color: warn, fontSize: 10, fontFamily: mono, formatter: '周均 46' },
        data: [{ yAxis: 46 }]
      }
    }]
  });

  /* ---------------- resize ---------------- */
  var charts = [c1, c2, c3, c4, c5, c6, c7];
  window.addEventListener('resize', function () {
    charts.forEach(function (c) { c.resize(); });
  });
})();
