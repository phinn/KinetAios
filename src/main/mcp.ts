// MCP (Model Context Protocol) 客户端:扫描配置 → stdio / SSE 连接 → 工具发现 → 接入 Direct 引擎。
// 让 Direct 引擎能用上系统里配置的 MCP 服务(Claude Code / Codex Desktop / Codex TOML),像内置工具一样调用。
// 支持 stdio(本地子进程)和 SSE/HTTP(远程 MCP server,包括另一台机器上的 KinetAios)两种 transport。
// ponytail: MCP resources/prompts、项目级 .mcp.json(需按 cwd 重连)标 TODO —— 先覆盖 stdio + SSE 全局 server。
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import type { Tool } from './tools';
import { getBrand } from './brand';

type McpSource = 'claude' | 'codex' | 'desktop' | 'remote';
type McpServerConfig = {
  name: string;
  source: McpSource;
  command: string;       // stdio: 可执行文件路径;SSE: 远程 URL(http://host:port/mcp)
  args: string[];
  env: Record<string, string>;
  // SSE transport 专用:
  type?: 'stdio' | 'sse';     // 'sse' = 远程 HTTP/SSE server;省略 = stdio
  token?: string;             // SSE: Authorization Bearer token
};

// MARK: 配置扫描

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // 缺失 / 损坏 → 跳过该来源
  }
}

// 从一个 mcpServers map({ name: {type?, command/url, args, env?, token?} })提取 server。
// 支持两种 transport:type='sse' → SSE(远程);省略或 'stdio' → stdio(本地子进程)。
function fromMap(map: Record<string, any> | undefined, source: McpSource): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(map || {})) {
    const type = raw?.type === 'sse' ? 'sse' : 'stdio';
    if (type === 'sse') {
      // SSE: command 字段存 URL(http://host:port/mcp);token 存鉴权 Bearer。
      const url = raw?.url || raw?.command;
      if (!url) continue;
      out.push({ name, source, type: 'sse', command: url, args: [], env: {}, token: raw?.token || '' });
    } else {
      if (!raw?.command) continue;
      out.push({ name, source, type: 'stdio', command: raw.command, args: Array.isArray(raw.args) ? raw.args.map(String) : [], env: raw.env || {} });
    }
  }
  return out;
}

// ~/.codex/config.toml 的最小 TOML 解析(只取 [mcp_servers.*])。无 TOML 库 —— 只解析需要的形状:
// [mcp_servers.NAME] / command= / args=[] / [mcp_servers.NAME.env] 下的 key="val"。
function fromCodexToml(file: string): McpServerConfig[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const servers: McpServerConfig[] = [];
  let cur: { name: string; command: string; args: string[]; env: Record<string, string> } | null = null;
  let mode: 'root' | 'env' = 'root';
  const flush = (): void => {
    if (cur && cur.command) servers.push({ name: cur.name, source: 'codex', command: cur.command, args: cur.args, env: cur.env });
    cur = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let m = line.match(/^\[mcp_servers\.([^\].]+)\.env\]$/);
    if (m) {
      mode = 'env';
      continue;
    }
    m = line.match(/^\[mcp_servers\.([^\].]+)\]$/);
    if (m) {
      flush();
      cur = { name: m[1], command: '', args: [], env: {} };
      mode = 'root';
      continue;
    }
    if (line.startsWith('[')) {
      flush();
      mode = 'root';
      continue;
    } // 其它表头 → 退出当前 server
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv || !cur) continue;
    const [, k, v] = kv;
    if (mode === 'env') cur.env[k] = parseTomlStr(v);
    else if (k === 'command') cur.command = parseTomlStr(v);
    else if (k === 'args') {
      try {
        cur.args = (JSON.parse(v.replace(/'/g, '"')) as unknown[]).map(String);
      } catch {
        /* 留空数组 */
      }
    }
  }
  flush();
  return servers;
}

function parseTomlStr(v: string): string {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

// 扫描所有 MCP 配置来源,合并 + 同名去重(claude > desktop > codex)。
export function discoverServers(): McpServerConfig[] {
  const home = os.homedir();
  const out: McpServerConfig[] = [];
  const cj = readJson(path.join(home, '.claude.json'));
  if (cj?.mcpServers) out.push(...fromMap(cj.mcpServers, 'claude'));
  const desk =
    process.platform === 'win32'
      ? path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
      : path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  out.push(...fromMap(readJson(desk)?.mcpServers, 'desktop'));
  out.push(...fromCodexToml(path.join(home, '.codex', 'config.toml')));
  const seen = new Set<string>();
  return out.filter((s) => s.command && !seen.has(s.name) && seen.add(s.name));
}

// MARK: SSE/HTTP 客户端(连接远程 MCP server —— 如另一台机器上的 KinetAios MCP Server)
// MCP Streamable HTTP transport:POST JSON-RPC 到 server endpoint,响应是单条 JSON 或 SSE 流。

type McpTool = { name: string; description?: string; inputSchema?: any };

class SseClient {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  alive = true;
  readonly tools: McpTool[] = [];
  readonly ready: Promise<void>;
  private initialized = false;

  constructor(readonly cfg: McpServerConfig) {
    this.ready = this.connect();
  }

  private get url(): URL {
    return new URL(this.cfg.command); // command 字段存完整 URL
  }

  private getHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.cfg.token) h.Authorization = `Bearer ${this.cfg.token}`;
    return h;
  }

  // 发一条 JSON-RPC 请求,解析响应(支持纯 JSON 和 SSE 两种返回格式)。
  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const opts = {
        method: 'POST',
        hostname: this.url.hostname,
        port: this.url.port || (this.url.protocol === 'https:' ? '443' : '80'),
        path: this.url.pathname + this.url.search,
        headers: { ...this.getHeaders(), 'Content-Length': Buffer.byteLength(body) },
      };
      const lib = this.url.protocol === 'https:' ? https : http;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SSE MCP ${method} 超时(${timeoutMs}ms)`));
      }, timeoutMs);

      const req = lib.request(opts, (resp) => {
        if (resp.statusCode && resp.statusCode >= 400) {
          clearTimeout(timer);
          let errBody = '';
          resp.on('data', (d) => (errBody += d));
          resp.on('end', () => reject(new Error(`HTTP ${resp.statusCode}: ${errBody.slice(0, 500)}`)));
          return;
        }
        const ct = resp.headers['content-type'] ?? '';
        let raw = '';
        resp.on('data', (d) => (raw += d));
        resp.on('end', () => {
          clearTimeout(timer);
          try {
            if (ct.includes('text/event-stream')) {
              // SSE: 从 data: 行提取 JSON
              for (const line of raw.split('\n')) {
                const m = line.match(/^data:\s*(.+)/);
                if (m) {
                  const obj = JSON.parse(m[1]);
                  if (obj.error) reject(new Error(obj.error.message ?? 'MCP error'));
                  else resolve(obj.result);
                  return;
                }
              }
              reject(new Error('SSE 响应无 data 行'));
            } else {
              // 纯 JSON
              const obj = JSON.parse(raw);
              if (obj.error) reject(new Error(obj.error.message ?? 'MCP error'));
              else resolve(obj.result);
            }
          } catch (e) {
            reject(new Error(`SSE MCP 响应解析失败: ${(e as Error).message}`));
          }
        });
      });
      req.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`SSE MCP 连接失败: ${e.message}`));
      });
      req.write(body);
      req.end();
    });
  }

  private async connect(): Promise<void> {
    try {
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: getBrand().productName, version: '0.1.0' },
      }, 15_000);
      // notifications/initialized 是 notification(无 id),用 fire-and-forget POST。
      this.initialized = true;
      const res = await this.request('tools/list', {}, 15_000);
      this.tools.length = 0;
      this.tools.push(...(res?.tools ?? []));
    } catch (e) {
      console.error(`[mcp/${this.cfg.name}] SSE 连接失败:`, (e as Error)?.message);
      this.alive = false;
    }
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    // 如果已标记失效,先尝试重连(不重连就直接放弃会导致永久死亡)。
    if (!this.alive) {
      if (!this.reconnecting) await this.reconnect();
      if (!this.alive) return `MCP server 不可用(重连失败): ${this.cfg.name}`;
    }
    try {
      // run_agent 可能跑数分钟 → 超时放到 10 分钟。
      const timeout = name === 'run_agent' ? 10 * 60 * 1000 : 120_000;
      const res = await this.request('tools/call', { name, arguments: args }, timeout);
      const text = (res?.content ?? []).map((c: any) => (c?.type === 'text' ? c.text : JSON.stringify(c))).join('\n').trim();
      return res?.isError ? `MCP 工具报错: ${text}` : text || '(无输出)';
    } catch (e) {
      // 不永久死亡 —— 尝试重连一次,如果连上了就还能用。
      const msg = (e as Error).message;
      console.warn(`[mcp/${this.cfg.name}] call ${name} 失败,尝试重连: ${msg}`);
      this.alive = false;
      // 后台重连(不阻塞当前调用返回错误文本)。
      void this.reconnect();
      return `MCP 远程调用失败: ${msg}`;
    }
  }

  /** 后台重连:重新 initialize + tools/list,成功后恢复 alive。 */
  private reconnecting = false;
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: getBrand().productName, version: '0.1.0' },
      }, 10_000);
      const res = await this.request('tools/list', {}, 10_000);
      this.tools.length = 0;
      this.tools.push(...(res?.tools ?? []));
      this.alive = true;
      console.log(`[mcp/${this.cfg.name}] 重连成功,${this.tools.length} 个工具可用`);
    } catch {
      console.warn(`[mcp/${this.cfg.name}] 重连失败,将在下次调用时重试`);
      // 保持 alive=false,下次 call 直接返回错误,但 reconnect 会在 dispose 前持续尝试。
    } finally {
      this.reconnecting = false;
    }
  }

  dispose(): void {
    this.alive = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('MCP 连接关闭'));
    }
    this.pending.clear();
  }
}

// MARK: stdio JSON-RPC 客户端(MCP 消息以换行分隔的一条条 JSON)

class StdioClient {
  private child: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buf = '';
  private everConnected = false; // initialize 成功过(exit 才值得重连)
  private reconnectCount = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  readonly tools: McpTool[] = [];
  readonly ready: Promise<void>;
  alive = true; // false = 进程已死且放弃重连(directTools / snapshot 跳过)

  constructor(readonly cfg: McpServerConfig) {
    this.ready = this.start();
  }

  private start(): Promise<void> {
    return new Promise<void>((resolveReady) => {
      const opts: SpawnOptions = { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...this.cfg.env } };
      try {
        this.child = spawn(this.cfg.command, this.cfg.args, opts);
      } catch {
        this.alive = false; // spawn 同步抛 → 连不上,不重连
        resolveReady();
        return;
      }
      this.child.stdout?.on('data', (d) => this.onData(d));
      this.child.stderr?.on('data', (d) => console.error(`[mcp/${this.cfg.name}]`, d.toString().trimEnd()));
      this.child.on('error', () => this.handleExit());
      this.child.on('exit', () => this.handleExit());
      this.initialize().then(
        () => {
          this.everConnected = true; // 连上过 → 之后意外退出值得重连
          this.reconnectCount = 0;
          this.alive = true; // 重连成功,恢复工具暴露
          resolveReady();
        },
        (e) => {
          console.error(`[mcp/${this.cfg.name}] 连接失败:`, (e as Error)?.message);
          this.alive = false; // initialize 失败 → 配置/握手问题,不重连
          this.dispose();
          resolveReady();
        },
      );
    });
  }

  // 进程退出:曾连上过就延迟重连(最多 5 次),否则放弃。
  private handleExit(): void {
    this.failAll();
    this.child = null;
    if (this.everConnected && this.alive && this.reconnectCount < 5) {
      this.reconnectCount++;
      this.alive = false; // 重连期间不暴露失效工具(start 成功后会设回 true)
      console.log(`[mcp/${this.cfg.name}] 进程退出,3s 后重连(${this.reconnectCount}/5)…`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.start();
      }, 3000);
    } else {
      this.alive = false;
    }
  }

  private onData(d: Buffer | string): void {
    this.buf += d.toString();
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '').trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let obj: Record<string, any>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // 半行 / 非 JSON → 丢
      }
      if (obj.id != null && this.pending.has(obj.id)) {
        const p = this.pending.get(obj.id)!;
        this.pending.delete(obj.id);
        if (obj.error) p.reject(new Error(obj.error?.message ?? 'MCP error'));
        else p.resolve(obj.result);
      }
      // 无 id 的 notification / server→client 请求一律忽略(Direct 不需要)
    }
  }

  private send(method: string, params: unknown, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin?.writable) return reject(new Error('MCP stdin 不可写'));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private async initialize(): Promise<void> {
    await this.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: getBrand().productName, version: '0.1.0' } }, 15_000);
    this.notify('notifications/initialized', {});
    const res = await this.send('tools/list', {}, 15_000);
    this.tools.length = 0; // 重连时先清,避免旧工具残留/重复
    this.tools.push(...(res?.tools ?? []));
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.send('tools/call', { name, arguments: args }, 60_000);
    const text = (res?.content ?? []).map((c: any) => (c?.type === 'text' ? c.text : JSON.stringify(c))).join('\n').trim();
    return res?.isError ? `MCP 工具报错: ${text}` : text || '(无输出)';
  }

  private failAll(): void {
    for (const p of this.pending.values()) p.reject(new Error('MCP 连接断开'));
    this.pending.clear();
  }

  dispose(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.alive = false;
    this.failAll();
    try {
      this.child?.kill();
    } catch {
      /* 已退出 */
    }
    this.child = null;
  }
}

// MARK: 统一客户端接口(stdio + SSE 都实现这套)

interface McpClient {
  readonly cfg: McpServerConfig;
  readonly tools: McpTool[];
  readonly ready: Promise<void>;
  alive: boolean;
  call(name: string, args: Record<string, unknown>): Promise<string>;
  dispose(): void;
}

// MARK: 注册表 —— 发现 + 渐进连接 + 聚合工具 + 生命周期

class McpRegistry {
  private clients: McpClient[] = [];
  private connecting: Promise<void> | null = null;
  // 额外的远程 server 配置(来自 settings.remoteMcpServers,运行时可动态增减)。
  private extraConfigs: McpServerConfig[] = [];

  // 设置/更新远程 SSE server 列表(从 settings.remoteMcpServers 加载)。每次调用会重建连接。
  setRemoteServers(servers: Array<{ name: string; url: string; token?: string }>): void {
    // 先 dispose 旧的 remote client
    this.clients = this.clients.filter((c) => {
      if (c.cfg.source === 'remote') {
        c.dispose();
        return false;
      }
      return true;
    });
    this.extraConfigs = servers
      .filter((s) => s.url)
      .map((s) => ({ name: s.name, source: 'remote' as McpSource, type: 'sse' as const, command: s.url, args: [], env: {}, token: s.token || '' }));
    // 触发重连
    this.connecting = null;
    void this.connectAll(true);
  }

  // 后台连接所有 server,每连好一个就加入(失败静默跳过)。幂等;forceRemote=true 跳过 stdio 只连 remote。
  connectAll(forceRemote = false): Promise<void> {
    if (this.connecting && !forceRemote) return this.connecting;
    this.connecting = (async () => {
      const configs = forceRemote ? this.extraConfigs : [...discoverServers(), ...this.extraConfigs];
      const made: McpClient[] = configs.map((cfg) => {
        if (cfg.type === 'sse') return new SseClient(cfg);
        return new StdioClient(cfg);
      });
      await Promise.allSettled(
        made.map(async (c) => {
          await c.ready;
          // 连上就加入(alive=true 且完成握手);即使工具列表为空也保留,UI 展示为"在线、0 工具"。
          if (c.alive) {
            this.clients.push(c);
            console.log(`[mcp] 已连 ${c.cfg.source}/${c.cfg.name}: ${c.tools.length} 个工具`);
          }
        }),
      );
    })();
    return this.connecting;
  }

  // 所有已连 server 的工具,转成 Direct 的 Tool[](带 mcp__server__tool 前缀防撞名)。
  // waitMs > 0 时最多等这么久让连接完成,再返回当前已就绪的(首轮能尽快用上)。
  async directTools(waitMs = 0): Promise<Tool[]> {
    if (waitMs > 0 && this.connecting) {
      await Promise.race([this.connecting, new Promise((r) => setTimeout(r, waitMs))]).catch(() => {});
    }
    const out: Tool[] = [];
    for (const c of this.clients) {
      if (!c.alive) continue; // 失效(进程死且放弃重连)→ 不暴露工具
      for (const t of c.tools) {
        out.push({
          name: `mcp__${c.cfg.name}__${t.name}`,
          description: `[MCP:${c.cfg.source}/${c.cfg.name}] ${t.description ?? ''}`,
          parameters: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
          run: (args) => c.call(t.name, args),
        });
      }
    }
    return out;
  }

  // 给 UI 列出已连服务 + 工具名(mcp 按钮弹菜单用 —— 可见性)。source 保留 'remote' 标识远程节点。
  snapshot(): Array<{ source: string; name: string; tools: string[] }> {
    return this.clients.filter((c) => c.alive).map((c) => ({ source: c.cfg.source, name: c.cfg.name, tools: c.tools.map((t) => t.name) }));
  }

  // 给 Town UI 用的远程节点信息(等连接完成后返回最新状态) / Remote node info for Town UI
  async remoteSnapshot(waitMs = 3000): Promise<Array<{ name: string; online: boolean; toolCount: number }>> {
    // 等连接完成(最多 waitMs 毫秒) / Wait for connection to finish (max waitMs)
    if (this.connecting) {
      await Promise.race([this.connecting, new Promise((r) => setTimeout(r, waitMs))]).catch(() => {});
    }
    return this.clients
      .filter((c) => c.cfg.source === 'remote')
      .map((c) => ({ name: c.cfg.name, online: c.alive, toolCount: c.tools.length }));
  }

  // 在指定远程节点上调用 run_agent / Call run_agent on a named remote node
  async callRemote(serverName: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const client = this.clients.find((c) => c.cfg.source === 'remote' && c.cfg.name === serverName);
    if (!client) throw new Error(`远程节点「${serverName}」未连接`);
    if (!client.alive) throw new Error(`远程节点「${serverName}」已断开`);
    return client.call(tool, args);
  }

  dispose(): void {
    this.clients.forEach((c) => c.dispose());
    this.clients = [];
  }
}

export const mcp = new McpRegistry();
