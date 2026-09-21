// 营销推广插件 —— 工具集
// Tool 接口签名见 src/main/tools.ts: Tool { name; description; parameters; readOnly?; run(args, ctx) }
// ctx.cwd = 当前会话工作目录; ctx.confirm(cmd) 本插件用不到(全部只读)。
//
// 工具列表:
//   1. market_search     — 搜索引擎检索(聚合查询入口, 为竞品/热度调研供数)
//   2. hn_search         — Hacker News 历史热度检索(Algolia API, 无需 key)
//   3. reddit_hot        — subreddit 热帖抓取(public JSON, 无需 key)
//   4. seo_audit         — 落地页 SEO 体检(meta/OG/结构化数据/标题层级/词频)
//   5. funnel_calc       — 漏斗/获客成本计算(CAC/LTV/转化率/回收期)
//   6. keyword_expand    — 关键词拓展(DDG 真实联想词 + 静态矩阵兜底)
//   7. appstore_lookup   — App Store 竞品查询(iTunes Search + 评论 RSS, 免 key)
//
// 设计原则:
//   - 全部 readOnly=true,只查不改;写落地页/写报告交给 Agent 用 write_file 完成。
//   - 外部请求失败优雅降级,返回可读的错误提示而非抛异常。
//   - reddit 用 public .json 端点,需要自定义 UA(否则 429)。

const https = require('https');

// ── 辅助:HTTP GET (Promise 封装, 带超时 + UA) ──────────────────
// 双协议: http:// 用 http 模块, https:// 用 https 模块(有些老站只有 http)。
// getOnce 单次请求;httpGet 包一层 429/503 退避重试(DDG/Reddit 限流是常态)。
function getOnce(url, timeoutMs, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? require('http') : https;
    const req = mod.get(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) KinetAios-MarketingKit/1.0', ...headers },
    }, (res) => {
      // 跟随一次重定向(reddit/hn 偶发 301)
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
        res.resume();
        const loc = new URL(res.headers.location, url).toString();
        getOnce(loc, timeoutMs, headers).then(resolve, reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.on('error', reject);
  });
}

function httpGet(url, timeoutMs = 20000, headers = {}, retries = 1) {
  const attempt = (left) => getOnce(url, timeoutMs, headers).then((res) => {
    // 429/503 限流: 等待后重试一次, 仍失败返回最后一次响应(调用方自己降级)
    if ((res.status === 429 || res.status === 503) && left > 0) {
      return new Promise((r) => setTimeout(r, 1500)).then(() => attempt(left - 1));
    }
    return res;
  });
  return attempt(retries);
}

// 安全的 JSON 解析(失败返回 null, 调用方降级)
function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// HTML 实体解码(seo_audit 用)
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'");
}

// ── 工具 1: 通用搜索入口 ──────────────────────────────────────
// Tool 1: market_search — general web search via DuckDuckGo HTML endpoint.
const marketSearch = {
  name: 'market_search',
  description: '搜索引擎检索(DuckDuckGo),返回标题/摘要/链接列表。营销调研入口:查竞品、查行业报告、查目标关键词的 SERP 格局。英文关键词效果最佳,中文可用。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      limit: { type: 'number', description: '返回条数(默认 8, 上限 15)' },
    },
    required: ['query'],
  },
  readOnly: true,
  async run(args) {
    const limit = Math.min(Math.max(args.limit ?? 8, 1), 15);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
    let res;
    try { res = await httpGet(url); } catch (e) {
      return `❌ 搜索请求失败: ${e.message}。可改用 web_search 工具重试。`;
    }
    // 解析 DDG html 结果页: result__a 为标题链接, result__snippet 为摘要
    const out = [];
    if (res.status !== 200) {
      try {
        const lite = await httpGet(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(args.query)}`);
        if (lite.status === 200) {
          const lre = /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
          let lm;
          while ((lm = lre.exec(lite.body)) && out.length < limit) {
            let href = lm[1];
            const uddg = href.match(/[?&]uddg=([^&]+)/);
            if (uddg) href = decodeURIComponent(uddg[1]);
            const title = decodeEntities(lm[2].replace(/<[^>]+>/g, '')).trim();
            if (title) out.push(`${out.length + 1}. ${title}\n   ${href}`);
          }
          if (out.length) return out.join('\n\n') + '\n\n(lite 端点, 无摘要)';
        }
      } catch { /* 兜底也挂就走下面统一报错 */ }
      return `❌ 搜索返回 HTTP ${res.status}(重试后仍限流)。可改用内置 web_search 工具。`;
    }

    // 解析 DDG html 结果页: result__a 为标题链接, result__snippet 为摘要
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(res.body)) && out.length < limit) {
      let href = m[1];
      // DDG 链接是 //duckduckgo.com/l/?uddg=<encoded> 形式, 解出真实 URL
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) href = decodeURIComponent(uddg[1]);
      const title = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim();
      const snippet = decodeEntities(m[3].replace(/<[^>]+>/g, '')).trim();
      if (title) out.push(`${out.length + 1}. ${title}\n   ${href}\n   ${snippet}`);
    }
    if (!out.length) return `没有解析到结果(DDG 页面结构可能变化或被限流)。请改用内置 web_search 工具。`;
    return `🔍 「${args.query}」搜索结果 (前 ${out.length} 条):\n\n${out.join('\n\n')}`;
  },
};

// ── 工具 2: Hacker News 热度检索 ─────────────────────────────
// Tool 2: hn_search — Algolia HN Search API (public, no key).
const hnSearch = {
  name: 'hn_search',
  description: '检索 Hacker News 上的历史讨论热度(标题/分数/评论数/链接),用于:验证选题在 HN 是否被验证过、研究竞品当年怎么发的、找目标受众的真实讨论。可选时间过滤和标签过滤。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词(英文效果最佳)' },
      tag: { type: 'string', description: '过滤标签: story(默认)/ask_hn/show_hn/author_xxx 等' },
      days: { type: 'number', description: '只看最近 N 天(不填=不限,适合查常青话题)' },
      limit: { type: 'number', description: '返回条数(默认 10, 上限 20)' },
    },
    required: ['query'],
  },
  readOnly: true,
  async run(args) {
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 20);
    const params = new URLSearchParams({
      query: args.query,
      tags: args.tag || 'story',
      hitsPerPage: String(limit),
    });
    if (args.days && args.days > 0) {
      const end = Math.floor(Date.now() / 1000);
      params.set('numericFilters', `created_at_i>${end - args.days * 86400}`);
    }
    const res = await httpGet(`https://hn.algolia.com/api/v1/search?${params}`);
    if (res.status !== 200) return `❌ HN API 返回 HTTP ${res.status}`;
    const data = tryJson(res.body);
    if (!data || !Array.isArray(data.hits)) return '❌ HN API 返回格式异常';
    if (!data.hits.length) return `HN 上没有找到「${args.query}」相关讨论(可换个英文关键词试试)。`;

    const lines = data.hits.map((h, i) => {
      const date = h.created_at ? h.created_at.slice(0, 10) : '?';
      const link = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
      return `${i + 1}. 【${h.points ?? 0}分/${h.num_comments ?? 0}评】${h.title} (${date})\n   ${link}\n   讨论: https://news.ycombinator.com/item?id=${h.objectID}`;
    });
    return `📰 HN「${args.query}」相关讨论 (按相关度, 前 ${lines.length} 条):\n\n${lines.join('\n\n')}`;
  },
};

// ── 工具 3: Reddit 热帖 ──────────────────────────────────────
// Tool 3: reddit_hot — public subreddit JSON (no auth).
const redditHot = {
  name: 'reddit_hot',
  description: '抓取指定 subreddit 的帖子:不传 query 抓当前热帖;传 query 则全量搜索该社区历史帖(配合 t=year 可挖老帖)。用于:监听社区在讨论什么、发现痛点原声(voice of customer)、按关键词挖竞品怨念帖(如搜 "frustrating / switched away / wish")。',
  parameters: {
    type: 'object',
    properties: {
      subreddit: { type: 'string', description: 'subreddit 名,不带 r/ 前缀(如 SaaS, selfhosted, productivity)' },
      query: { type: 'string', description: '可选:搜索词(在此社区内全量搜索,不限热帖)。挖痛点示例: "frustrating"、"annoying"、"wish there was"、"alternative to X"' },
      t: { type: 'string', description: '搜索时间范围: hour/day/week/month/year/all(默认 year;仅 query 模式生效)' },
      sort: { type: 'string', description: '排序: hot(默认)/new/top/rising;top 在 query 模式下=按相关性+热度权重' },
      limit: { type: 'number', description: '返回条数(默认 10, 上限 20)' },
    },
    required: ['subreddit'],
  },
  readOnly: true,
  async run(args) {
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 20);
    const sort = ['hot', 'new', 'top', 'rising'].includes(args.sort) ? args.sort : 'hot';
    const sub = String(args.subreddit).replace(/^r\//, '').trim();
    const tRange = ['hour', 'day', 'week', 'month', 'year', 'all'].includes(args.t) ? args.t : 'year';
    // 两种模式: 热帖列表(/hot.json) 与 社区内搜索(/search.json?restrict_sr=1)
    const url = args.query
      ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json?q=${encodeURIComponent(args.query)}&restrict_sr=1&sort=${sort}&t=${tRange}&limit=${limit}`
      : `https://www.reddit.com/r/${encodeURIComponent(sub)}/${sort}.json?limit=${limit}`;
    const res = await httpGet(url);
    if (res.status === 403 || res.status === 429) return `❌ Reddit 拒绝了请求 (HTTP ${res.status}, 可能被限流)。稍后重试或换社区。`;
    if (res.status === 404) return `❌ 找不到 subreddit「${sub}」,检查拼写。`;
    if (res.status !== 200) return `❌ Reddit 返回 HTTP ${res.status}`;
    const data = tryJson(res.body);
    const posts = data?.data?.children?.map((c) => c.data) ?? [];
    if (!posts.length) return args.query
      ? `「r/${sub}」内没搜到含「${args.query}」的帖子。换个关键词(更短/更通用)或扩大 t 范围到 all。`
      : `「r/${sub}」没有取到帖子(社区可能不存在或为空)。`;

    const lines = posts.map((p, i) => {
      const self = p.selftext ? '\n   摘要: ' + p.selftext.replace(/\s+/g, ' ').slice(0, 180) : '';
      const age = p.created_utc ? `\n   发帖: ${new Date(p.created_utc * 1000).toISOString().slice(0, 10)}` : '';
      return `${i + 1}. 【${p.score ?? 0}分/${p.num_comments ?? 0}评】${p.title}\n   https://www.reddit.com${p.permalink}${self}${age}`;
    });
    const head = args.query
      ? `🔎 r/${sub} 内搜「${args.query}」(范围 ${tRange}, 排序 ${sort}) — ${posts.length} 条:`
      : `🔥 r/${sub} (${sort}) 热帖 前 ${lines.length} 条:`;
    return `${head}\n\n${lines.join('\n\n')}`;
  },
};

// ── 工具 4: 落地页 SEO 体检 ──────────────────────────────────
// Tool 4: seo_audit — fetch a landing page, report meta/OG/schema/headings/keyword density.
const seoAudit = {
  name: 'seo_audit',
  description: '落地页 SEO 体检:抓取页面,报告 title/description 长度、OG/Twitter 卡片、结构化数据(JSON-LD)、H1-H3 层级、图片 alt 缺失数、词频 top(粗略关键词密度)。用于发布前自查或对照竞品落地页找差距。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '落地页 URL(含 http/https)' },
      keyword: { type: 'string', description: '可选:目标关键词,报告中标注其出现次数和位置' },
    },
    required: ['url'],
  },
  readOnly: true,
  async run(args) {
    let url = args.url.trim();
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    let res;
    try { res = await httpGet(url, 25000); } catch (e) {
      return `❌ 抓取失败: ${e.message}`;
    }
    if (res.status !== 200) return `❌ 页面返回 HTTP ${res.status}`;
    const html = res.body;

    const findings = [];
    const warn = (ok, good, bad) => findings.push(`  ${ok ? '✅' : '⚠️'} ${ok ? good : bad}`);

    // title
    const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleM ? decodeEntities(titleM[1]).trim() : '';
    findings.push(`📄 Title (${title.length}字符): ${title || '(缺失!)'}`);
    warn(title.length >= 15 && title.length <= 65, '长度合适', '建议 15-65 字符(SERP 截断阈值)');

    // meta description
    const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
    const desc = descM ? decodeEntities(descM[1]).trim() : '';
    findings.push(`📝 Description (${desc.length}字符): ${desc || '(缺失!)'}`);
    warn(desc.length >= 70 && desc.length <= 165, '长度合适', '建议 70-165 字符');

    // OG / Twitter
    const og = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']*)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:${prop}["']`, 'i'));
      return m ? m[1] : null;
    };
    const ogTitle = og('title'), ogDesc = og('description'), ogImg = og('image');
    findings.push(`🌐 OG 卡片: title=${ogTitle ? '✅' : '⚠️缺失'} description=${ogDesc ? '✅' : '⚠️缺失'} image=${ogImg ? '✅' : '⚠️缺失'}${ogImg ? ` (${ogImg.slice(0, 80)})` : ''}`);
    const twCard = html.match(/<meta[^>]+name=["']twitter:card["'][^>]+content=["']([^"']*)["']/i);
    findings.push(`🐦 Twitter card: ${twCard ? twCard[1] : '⚠️ 缺失(社交分享无预览卡)'}`);

    // canonical + viewport + lang
    const canon = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i);
    findings.push(`🔗 Canonical: ${canon ? canon[1] : '⚠️ 缺失'}`);
    warn(!!canon, '', '');
    findings.pop(); // canonical 只报告不打分
    const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
    warn(viewport, 'viewport 声明存在(移动端适配)', 'viewport 缺失 —— 移动端适配成疑');
    const langM = html.match(/<html[^>]*lang=["']([^"']*)["']/i);
    findings.push(`🗣️ lang: ${langM ? langM[1] : '⚠️ 未声明'}`);

    // 标题层级
    const headings = { h1: [], h2: [], h3: [] };
    for (const tag of ['h1', 'h2', 'h3']) {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
      let m;
      while ((m = re.exec(html)) && headings[tag].length < 12) {
        headings[tag].push(decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim().slice(0, 90));
      }
    }
    findings.push(`\n🧱 标题层级:`);
    findings.push(`  H1 ×${headings.h1.length}${headings.h1.length !== 1 ? ' ⚠️(应恰好 1 个)' : ' ✅'}${headings.h1.length ? ': ' + headings.h1.join(' | ') : ''}`);
    findings.push(`  H2 ×${headings.h2.length}: ${headings.h2.slice(0, 8).join(' / ') || '(无)'}`);
    findings.push(`  H3 ×${headings.h3.length}: ${headings.h3.slice(0, 6).join(' / ') || '(无)'}`);

    // 结构化数据
    const ldCount = (html.match(/application\/ld\+json/gi) || []).length;
    findings.push(`\n📦 JSON-LD 结构化数据: ${ldCount > 0 ? `✅ ${ldCount} 段` : '⚠️ 无(搜索结果富摘要机会)'}`);

    // 图片 alt
    const imgs = html.match(/<img[^>]*>/gi) || [];
    const noAlt = imgs.filter((t) => !/alt\s*=/i.test(t)).length;
    findings.push(`🖼️ 图片 ${imgs.length} 张, 缺 alt ${noAlt} 张${noAlt > 0 ? ' ⚠️' : ' ✅'}`);

    // ── 深化项: 正文词数 / 链接 / 页面体积 / robots / sitemap ──
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    const bodyWords = (text.match(/[a-zA-Z\u4e00-\u9fff]+/g) || []).length;
    findings.push(`📏 正文词数: ${bodyWords}${bodyWords < 300 ? ' ⚠️ 薄内容(<300), 排名难撑' : bodyWords > 2500 ? '(长文, ✅ 深度信号)' : ' ✅'}`);

    const linkTags = html.match(/<a[^>]+href=/gi) || [];
    const origin = new URL(url).origin;
    let internal = 0;
    for (const tag of linkTags) {
      // tag 形如 <a class=x href="/path"; href 可能是最后一个属性, 从 tag 串里取值
      const href = tag.match(/href\s*=\s*["']?([^"'\s>]+)["']?/i)?.[1] || '';
      if (href.startsWith('/') || href.startsWith(origin)
        || (!/^https?:\/\//.test(href) && !href.startsWith('//') && !href.startsWith('#') && !href.startsWith('mailto:'))) internal++;
    }
    findings.push(`🔗 链接: 内链 ~${internal} / 总 ${linkTags.length}${internal === 0 ? ' ⚠️ 零内链(爬虫无法继续抓)' : ''}`);

    const scripts = (html.match(/<script/gi) || []).length;
    const kb = Math.round(Buffer.byteLength(html) / 1024);
    findings.push(`📦 HTML ${kb}KB / ${scripts} 个 script 标签${scripts > 30 ? ' ⚠️ 偏多(渲染依赖重, 爬虫预算信号)' : ''}`);

    // robots.txt / sitemap.xml 可达性(同域, 只报告不打分)
    const robotsRes = await httpGet(origin + '/robots.txt', 8000).catch(() => null);
    const robotsOk = robotsRes && robotsRes.status === 200 && !/^\s*<!doctype/i.test(robotsRes.body);
    const sitemapHit = robotsOk ? /sitemap:/i.test(robotsRes.body) : false;
    const sitemapRes = sitemapHit ? null : await httpGet(origin + '/sitemap.xml', 8000).catch(() => null);
    const sitemapOk = sitemapHit || (sitemapRes && sitemapRes.status === 200 && /<(urlset|sitemapindex)/i.test(sitemapRes.body));
    findings.push(`🤖 robots.txt: ${robotsOk ? '✅ 存在' : '⚠️ 缺失/不可达'} | sitemap.xml: ${sitemapOk ? '✅ 存在' : '⚠️ 缺失(收录速度受影响)'}`);

    // 词频(复用上面的正文 text, 粗略分词)
    const words = text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || [];
    const stop = new Set('the a an and or but for with without to from of in on at by is are was were be been being this that these those it its as your you our we they their can will not have has had do does did if then so no yes all any more most other some such only own same than too very just also get got make made new now one two per via use used using'.split(' '));
    const freq = {};
    for (const w of words) if (!stop.has(w) && w.length >= 3) freq[w] = (freq[w] || 0) + 1;
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12);
    findings.push(`\n📊 词频 Top${top.length} (正文, 粗略关键词密度):`);
    for (const [w, n] of top) findings.push(`  ${w}: ${n}次`);

    if (args.keyword) {
      const kw = String(args.keyword).toLowerCase();
      const cnt = kw.split(/\s+/).length === 1
        ? (freq[kw] || 0)
        : (text.toLowerCase().match(new RegExp(kw.replace(/\s+/g, '\\s+'), 'g')) || []).length;
      const inTitle = title.toLowerCase().includes(kw);
      const inDesc = desc.toLowerCase().includes(kw);
      const inH1 = headings.h1.some((h) => h.toLowerCase().includes(kw));
      findings.push(`\n🎯 目标词「${args.keyword}」: 正文${cnt}次 | title ${inTitle ? '✅' : '⚠️'} | description ${inDesc ? '✅' : '⚠️'} | H1 ${inH1 ? '✅' : '⚠️'}`);
    }

    return `🔍 SEO 体检: ${url}\n\n${findings.join('\n')}`;
  },
};

// ── 工具 5: 漏斗/获客成本计算 ────────────────────────────────
// Tool 5: funnel_calc — funnel / CAC / LTV / payback math.
const funnelCalc = {
  name: 'funnel_calc',
  description: '营销漏斗与单位经济模型计算:给定曝光→点击→注册→付费各环节转化率(或直接给各层数量),算出每层转化率、CAC、LTV、LTV/CAC 比和回收期。也可反推:给定目标新增付费数,倒推每层需要的流量。',
  parameters: {
    type: 'object',
    properties: {
      impressions: { type: 'number', description: '曝光量(与 ctr 二选一填法:给 ctr 或直接给每层数量)' },
      clicks: { type: 'number', description: '点击量(留空则用 impressions×ctr)' },
      ctr: { type: 'number', description: '点击率 %,如 2.5' },
      signups: { type: 'number', description: '注册/试用数(留空则用 clicks×signupRate)' },
      signupRate: { type: 'number', description: '点击→注册转化率 %' },
      paid: { type: 'number', description: '付费转化数(留空则用 signups×paidRate)' },
      paidRate: { type: 'number', description: '注册→付费转化率 %' },
      spend: { type: 'number', description: '总营销花费(¥/$),用于算 CAC' },
      arpu: { type: 'number', description: '每用户平均收入(月),用于算 LTV' },
      churnRate: { type: 'number', description: '月流失率 %,LTV = arpu/churn' },
      targetPaid: { type: 'number', description: '反推模式:目标新增付费数,倒推各层所需流量' },
    },
    required: [],
  },
  readOnly: true,
  async run(args) {
    const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    const pct = (v) => (v == null ? null : v / 100);
    const fmt = (v, d = 0) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: d }));

    // ── 反推模式 ──
    if (n(args.targetPaid) != null) {
      const paid = args.targetPaid;
      const pr = pct(n(args.paidRate)) ?? 0.03;   // 行业经验兜底: 注册→付费 3%
      const sr = pct(n(args.signupRate)) ?? 0.08; // 点击→注册 8%
      const cr = pct(n(args.ctr)) ?? 0.02;        // 曝光→点击 2%
      const signups = paid / pr, clicks = signups / sr, impressions = clicks / cr;
      return `🎯 反推漏斗: 目标新增付费 ${fmt(paid)}\n\n` +
        `按假设转化率(可覆盖): CTR ${(cr * 100).toFixed(1)}% → 注册率 ${(sr * 100).toFixed(1)}% → 付费率 ${(pr * 100).toFixed(1)}%\n\n` +
        `需要曝光 ≈ ${fmt(impressions)}\n需要点击 ≈ ${fmt(clicks)}\n需要注册/试用 ≈ ${fmt(signups)}\n` +
        (n(args.spend) != null ? `\n若 spend=${fmt(args.spend)}, 则 CPM≈${fmt(args.spend / impressions * 1000, 2)}, 每付费获客成本≈${fmt(args.spend / paid, 2)}` : '');
    }

    // ── 正推漏斗 ──
    let imp = n(args.impressions), clicks = n(args.clicks), signups = n(args.signups), paid = n(args.paid);
    const cr_ = pct(n(args.ctr)), sr = pct(n(args.signupRate)), pr = pct(n(args.paidRate));
    if (imp == null && clicks != null && cr_) imp = clicks / cr_;
    if (clicks == null && imp != null && cr_) clicks = imp * cr_;
    if (signups == null && clicks != null && sr) signups = clicks * sr;
    if (paid == null && signups != null && pr) paid = signups * pr;
    if (clicks == null && signups == null && paid == null) return '❌ 至少提供一层 数量或转化率(如 impressions+ctr, signups, paid)。';

    const lines = ['📊 漏斗测算:'];
    if (imp != null) lines.push(`  曝光     ${fmt(imp)}`);
    if (imp != null && clicks != null) lines.push(`  ↓ CTR ${fmt(clicks / imp * 100, 2)}%${cr_ && Math.abs(clicks / imp - cr_) > 1e-9 ? '' : ''}`);
    if (clicks != null) lines.push(`  点击     ${fmt(clicks)}`);
    if (clicks != null && signups != null) lines.push(`  ↓ 注册率 ${fmt(signups / clicks * 100, 2)}%`);
    if (signups != null) lines.push(`  注册/试用 ${fmt(signups)}`);
    if (signups != null && paid != null) lines.push(`  ↓ 付费率 ${fmt(paid / signups * 100, 2)}%`);
    if (paid != null) lines.push(`  付费     ${fmt(paid)}`);

    if (n(args.spend) != null && paid != null) {
      const cac = args.spend / paid;
      lines.push(`\n💰 CAC (每付费获客成本): ${fmt(cac, 2)}`);
      const churn = pct(n(args.churnRate));
      if (n(args.arpu) != null) {
        const ltv = churn && churn > 0 ? args.arpu / churn : args.arpu * 12; // 无 churn 按 12 个月粗算
        lines.push(`💎 LTV: ${fmt(ltv, 2)} ${churn ? '(arpu÷月churn)' : '(⚠️未给 churnRate, 按 12 个月粗算)'}`);
        lines.push(`⚖️ LTV/CAC = ${fmt(ltv / cac, 2)} ${(ltv / cac >= 3 ? '✅ 健康(≥3)' : '⚠️ 低于 3, 增长越快亏越快')}`);
        const months = cac / args.arpu;
        lines.push(`⏳ 回收期: ${fmt(months, 1)} 个月${churn && months > (1 / churn) ? ' ⚠️ 超过平均用户生命周期!' : ''}`);
      }
    } else if (n(args.arpu) != null || n(args.churnRate) != null) {
      lines.push('\nℹ️ 补充 spend 和 paid 可算 CAC/LTV。');
    }
    return lines.join('\n');
  },
};

// ── 工具 6: 关键词拓展 ──────────────────────────────────────
// Tool 6: keyword_expand — keyword matrix generator.
const keywordExpand = {
  name: 'keyword_expand',
  description: '关键词拓展:输入核心词(可多个)。默认先拉 DuckDuckGo 真实搜索联想词(免 key autocomplete,反映真实用户输入),再叠加本地修饰词矩阵/长尾模式/问句。联想词拉取失败自动降级为纯静态矩阵。用于 SEO 选题、内容日历、投放词包。',
  parameters: {
    type: 'object',
    properties: {
      seeds: { type: 'string', description: '核心词,逗号分隔(如 "ai note app, voice memo transcript")' },
      lang: { type: 'string', description: '输出语言: en(默认)/zh' },
      includeQuestions: { type: 'boolean', description: '是否生成问句长尾(默认 true)' },
      live: { type: 'boolean', description: '是否拉真实联想词(默认 true;false=纯静态矩阵)' },
    },
    required: ['seeds'],
  },
  readOnly: true,
  async run(args) {
    const seeds = String(args.seeds).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (!seeds.length) return '❌ 请至少给一个核心词。';
    const zh = args.lang === 'zh';

    const modifiers = zh
      ? ['推荐', '排行', '对比', '怎么选', '哪个好', '免费', '开源', '价格', '教程', '入门', '替代', 'vs', '2026', '新手', '评测', '值得买吗', '下载', '安全吗']
      : ['best', 'top 10', 'vs', 'alternative', 'open source', 'free', 'pricing', 'review', 'tutorial', 'for beginners', '2026', 'how to choose', 'comparison', 'for mac', 'for windows', 'for teams', 'self-hosted'];
    const patterns = zh
      ? [`最好的${'{s}'}`, `${'{s}'}怎么用`, `${'{s}'}值得买吗`, `免费${'{s}'}`, `${'{s}'}替代品`, `${'{s}'}和竞品对比`]
      : [`best {s} 2026`, `how to use {s}`, `{s} alternatives`, `free {s}`, `{s} vs`, `is {s} worth it`];
    const questions = zh
      ? [`为什么需要${'{s}'}?`, `${'{s}'}安全吗?`, `${'{s}'}适合团队用吗?`, `${'{s}'}和人工比效率差多少?`]
      : [`why use {s}?`, `is {s} safe?`, `{s} vs hiring`, `does {s} work offline?`];

    const matrix = [];
    for (const s of seeds) for (const m of modifiers) matrix.push(`${s} ${m}`);
    const pats = seeds.flatMap((s) => patterns.map((p) => p.replace('{s}', s)));
    const qs = args.includeQuestions === false ? [] : seeds.flatMap((s) => questions.map((q) => q.replace('{s}', s)));

    // 真实联想词: DDG autocomplete 免 key 接口, 每个核心词拉一次(失败静默降级)
    let liveLines = '';
    if (args.live !== false) {
      const live = {};
      for (const s of seeds) {
        try {
          const r = await httpGet(`https://duckduckgo.com/ac/?q=${encodeURIComponent(s)}&type=list`, 8000);
          const arr = tryJson(r.body);
          // type=list 返回 [query, [suggestions...]]; 另一格式 [{phrase}] 也兼容
          let sugg = [];
          if (Array.isArray(arr) && Array.isArray(arr[1])) sugg = arr[1];
          else if (Array.isArray(arr)) sugg = arr.map((x) => (typeof x === 'object' ? x.phrase : x)).filter(Boolean);
          live[s] = sugg.filter((x) => x.toLowerCase() !== s.toLowerCase()).slice(0, 8);
        } catch { live[s] = []; }
      }
      const got = Object.values(live).filter((a) => a.length).length;
      if (got > 0) {
        liveLines = `【🎯 DDG 真实联想词 (${got}/${seeds.length} 个核心词拿到, 反映真实用户输入)】\n` +
          seeds.map((s) => `  ${s} → ${live[s].length ? live[s].join(' | ') : '(无联想)'}`).join('\n') +
          '\n\n💡 联想词=用户实际在搜的词, 优先做选题和 title; 下面静态矩阵用于补充投放词包。\n\n';
      } else {
        liveLines = `【⚠️ 联想词拉取失败(网络/限流), 已降级为纯静态矩阵】\n\n`;
      }
    }

    return `🔑 关键词拓展 (核心词 ${seeds.length} 个):\n\n` +
      liveLines +
      `【组合矩阵 ${matrix.length} 个】\n${matrix.join(', ')}\n\n` +
      `【长尾模式 ${pats.length} 个】\n${pats.join('\n')}\n\n` +
      (qs.length ? `【问句长尾 ${qs.length} 个(FAQ/Reddit 选题)】\n${qs.join('\n')}\n\n` : '') +
      `💡 建议: 真实联想词用于内容选题与 title; 组合矩阵用于投放词包分档出价;长尾模式用于博客选题;问句用于 FAQ schema 和社区回答。`;
  },
};

// ── 工具 7: App Store 竞品查询 ──────────────────────────────
// Tool 7: appstore_lookup — iTunes Search API + customer reviews RSS (public, no key).
const appstoreLookup = {
  name: 'appstore_lookup',
  description: '查询 App Store 竞品信息(免 key):按名称/关键词搜 App(拿评分/评分人数/版本/定价/开发者),或按 app id 拉最近用户评论(真实原声,含标题/评分/版本)。ASO 竞争分析、竞品评论挖掘入口。支持所有国家的 iTunes 商店。',
  parameters: {
    type: 'object',
    properties: {
      term: { type: 'string', description: '搜索词(App 名称或关键词,如 "AI note"、"obsidian")。与 appId 二选一' },
      appId: { type: 'string', description: 'App 数字 id(如 6814033986)。传了则直接查这个 App 的详情' },
      country: { type: 'string', description: '商店国家代码(默认 us;cn=中国)。注意评分/排名因区而异' },
      reviews: { type: 'boolean', description: '是否同时拉最近用户评论(默认 true;appId 模式和搜索深查都生效)' },
      reviewPages: { type: 'number', description: '评论页数(每页约10条,默认1,最大5;挖痛点建议 2-3 页)' },
      entity: { type: 'string', description: '搜索实体: software(默认)/macSoftware/iPhone 等不填则不限' },
    },
  },
  readOnly: true,
  async run(args) {
    const country = (args.country || 'us').toLowerCase();
    if (!args.term && !args.appId) return '❌ 传 term(搜索词)或 appId(App 数字 id)之一。';

    let app = null;
    let viaSearch = false;
    if (args.appId) {
      const res = await httpGet(`https://itunes.apple.com/lookup?id=${encodeURIComponent(args.appId)}&country=${country}`);
      if (res.status !== 200) return `❌ iTunes lookup HTTP ${res.status}`;
      const data = tryJson(res.body);
      app = data?.results?.[0] ?? null;
      if (!app) return `❌ id ${args.appId} 在 ${country} 区没查到(下架/区域锁定/id 错误都可能)。`;
    } else {
      const entity = args.entity ? `&entity=${encodeURIComponent(args.entity)}` : '&entity=software';
      const res = await httpGet(`https://itunes.apple.com/search?term=${encodeURIComponent(args.term)}&country=${country}&limit=8${entity}`);
      if (res.status !== 200) return `❌ iTunes search HTTP ${res.status}`;
      const data = tryJson(res.body);
      const results = data?.results ?? [];
      if (!results.length) return `「${args.term}」在 ${country} 区没搜到 App。换英文关键词试试。`;
      // 汇总列表 + 取首个做深查
      const list = results.map((r, i) => `${i + 1}. ${r.trackName} — ⭐${(r.averageUserRating ?? 0).toFixed(1)}(${r.userRatingCount ?? 0}评) id=${r.trackId}${r.formattedPrice ? ' ' + r.formattedPrice : ''}`).join('\n');
      app = results[0];
      viaSearch = true;
      var searchList = `\n📋 「${args.term}」${country} 区搜索结果 ${results.length} 个(取第 1 个做深查, 需要别的传 appId):\n${list}\n\n`;
    }

    const appLine = [
      `📱 ${app.trackName} (${country} 区)`,
      `开发者: ${app.artistName} | 分类: ${app.primaryGenreName ?? '—'}`,
      `评分: ⭐ ${(app.averageUserRating ?? 0).toFixed(2)} / 5(共 ${app.userRatingCount ?? 0} 人评)`,
      `定价: ${app.formattedPrice ?? '—'} | 内购: ${app.hasIAP ?? false}`,
      `当前版本: ${app.version ?? '—'}(${(app.currentVersionReleaseDate || '').slice(0, 10)}) | 最近更新: ${(app.releaseNotes || '').replace(/\s+/g, ' ').slice(0, 100) || '—'}`,
      `链接: ${app.trackViewUrl ?? '—'}`,
      `简介: ${(app.description || '').replace(/\s+/g, ' ').slice(0, 200)}…`,
    ].join('\n');

    // 评论 RSS: 每区每 App 最多 500 条(10页), 按 page 取最新若干
    let reviewsOut = '';
    if (args.reviews !== false && app.trackId) {
      const pages = Math.min(Math.max(args.reviewPages ?? 1, 1), 5);
      const revs = [];
      for (let p = 1; p <= pages; p++) {
        try {
          const rr = await httpGet(`https://itunes.apple.com/${country}/rss/customerreviews/page=${p}/id=${app.trackId}/sortby=mostrecent/json`, 12000);
          if (rr.status !== 200) break; // 403/429/超页 → 停止翻页
          const rd = tryJson(rr.body);
          const entries = rd?.feed?.entry ?? [];
          const flat = Array.isArray(entries) ? entries : (entries ? [entries] : []);
          if (!flat.length || !flat[0]['im:rating']) break; // 无更多评论
          for (const e of flat) {
            if (!e['im:rating']) continue;
            revs.push({
              rating: e['im:rating'].label ?? '?',
              title: e.title?.label ?? '',
              body: (e.content?.label ?? '').replace(/\s+/g, ' '),
              ver: e['im:version']?.label ?? '?',
            });
          }
        } catch { break; }
      }
      if (revs.length) {
        // 低分(≤3★)排前 —— 挖痛点场景低分原声比五星灌水值钱
        revs.sort((a, b) => (parseInt(a.rating) || 5) - (parseInt(b.rating) || 5));
        const show = revs.slice(0, 15);
        reviewsOut = `\n\n💬 用户评论 ${revs.length} 条(低分优先, 挖痛点用):\n` + show.map((e, i) => {
          return `${i + 1}. [${e.rating}★ v${e.ver}] ${e.title} — ${e.body.slice(0, 150)}`;
        }).join('\n');
      } else {
        reviewsOut = '\n\n💬 该 App 在此区暂无评论(或评论 RSS 被限流)。';
      }
    }

    return (viaSearch ? searchList : '') + appLine + reviewsOut;
  },
};

// ── 导出 ──────────────────────────────────────────────────
module.exports = {
  tools: [marketSearch, hnSearch, redditHot, seoAudit, funnelCalc, keywordExpand, appstoreLookup],
};
