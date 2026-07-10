// MCP (Model Context Protocol) 客户端:扫描配置 → stdio 连接 → 工具发现 → 接入 Direct 引擎。
// 让 Direct 引擎能用上系统里配置的 MCP 服务(Claude Code / Codex Desktop / Codex TOML),像内置工具一样调用。
// ponytail: 只做 stdio transport + JSON/TOML 配置扫描。SSE/HTTP transport、MCP resources/prompts、
// 项目级 .mcp.json(需按 cwd 重连)都标 TODO —— 先覆盖最常见的 stdio 全局 server。
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Tool } from './tools';
import { getBrand } from './brand';

type McpSource = 'claude' | 'codex' | 'desktop';
type McpServerConfig = {
  name: string;
  source: McpSource;
  command: string;
  args: string[];
  env: Record<string, string>;
};

// MARK: 配置扫描

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // 缺失 / 损坏 → 跳过该来源
  }
}

// 从一个 mcpServers map({ name: {type?, command, args, env?} })提取 stdio server。
function fromMap(map: Record<string, any> | undefined, source: McpSource): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(map || {})) {
    if (!raw?.command) continue;
    if (raw.type && raw.type !== 'stdio') continue; // ponytail: SSE/HTTP → TODO
    out.push({ name, source, command: raw.command, args: Array.isArray(raw.args) ? raw.args.map(String) : [], env: raw.env || {} });
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

// MARK: stdio JSON-RPC 客户端(MCP 消息以换行分隔的一条条 JSON)

type McpTool = { name: string; description?: string; inputSchema?: any };

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
      let obj: any;
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

// MARK: 注册表 —— 发现 + 渐进连接 + 聚合工具 + 生命周期

class McpRegistry {
  private clients: StdioClient[] = [];
  private connecting: Promise<void> | null = null;

  // 后台连接所有 server,每连好一个就加入(失败静默跳过)。幂等。
  connectAll(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const configs = discoverServers();
      const made = configs.map((cfg) => new StdioClient(cfg));
      await Promise.allSettled(
        made.map(async (c) => {
          await c.ready;
          if (c.tools.length) {
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

  // 给 UI 列出已连服务 + 工具名(mcp 按钮弹菜单用 —— 可见性)。
  snapshot(): Array<{ source: string; name: string; tools: string[] }> {
    return this.clients.filter((c) => c.alive).map((c) => ({ source: c.cfg.source, name: c.cfg.name, tools: c.tools.map((t) => t.name) }));
  }

  dispose(): void {
    this.clients.forEach((c) => c.dispose());
    this.clients = [];
  }
}

export const mcp = new McpRegistry();
