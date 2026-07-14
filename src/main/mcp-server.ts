// MCP Server:把本机 KinetAios 的工具暴露为标准 MCP HTTP+SSE 服务,供其他机器的 KinetAios(或任意
// MCP 客户端)连接调用。这是"多机协作方案 1"的核心 —— 任何装了 KinetAios 的机器都可以:
//   1. 开启 MCP Server(本文件)→ 自己变成可被远程调用的工具节点
//   2. 在 settings 里配置 remote server(mcp.ts 的 SseClient)→ 把别的机器当工具用
//
// 协议:标准 MCP JSON-RPC 2.0。transport 用现代 MCP 推荐的 HTTP POST + SSE response stream。
//   - POST /mcp          → JSON-RPC request(带 Accept: text/event-stream 触发 SSE 流式响应)
//   - GET  /mcp          → SSE 长连接(可选,当前 ponytail 用 POST+stream 足够)
//   - DELETE /mcp        → 关闭 session
// 安全:绑定 0.0.0.0(局域网可达),端口可配。每个请求验 token(settings.localMcpServer.token)。
// ponytail: 单 session 模式(不做多 session 管理),不做 resources/prompts —— 只暴露 tools。
//           未来可加 SSE 长连接 keepalive + 多 session,先覆盖"另一台机器能调我的工具"。

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import type { Tool, ToolCtx } from './tools';
import { getBrand } from './brand';
import { runAgentLoop } from './AgentLoop';
import { currentProvider, type Provider } from './glm';
import { baseSystemPrompt } from './engines';
import { snapshot, getSettings } from './settings';
import { allTools } from './tools';
import type { AgentEvent, RemoteAgentEvent } from '../shared/types';

type McpJsonRpcRequest = {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
};

type McpJsonRpcResponse = {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
};

// ── 把内置 Tool[] 转成 MCP tools/list 返回格式 ──
function toolToMcp(t: Tool): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  };
}

// ── run_agent:远程节点调此工具 → 本机起完整 AgentLoop 执行任务 ──
// 这是"多机协作方案 A"的核心:不只是代理基础工具,而是在远程机器上跑一整个自主 Agent。
// 远程调用方只需传入 prompt,本机 Agent 会自主使用 shell/read_file/write_file 等工具完成任务并返回文本。
const RUN_AGENT_TOOL_MCP: Record<string, unknown> = {
  name: 'run_agent',
  description: '[远程 Agent] 在此机器上启动一个完整的自主 Agent 执行任务。Agent 拥有 shell/read_file/write_file/web_fetch 等全部工具,会自主推理-行动-观察直到完成。传入自然语言任务描述,返回 Agent 的最终文本结果。',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '要在此机器上执行的任务描述(自然语言)' },
      maxTurns: { type: 'number', description: '可选:最大 ReAct 循环轮数(默认用本机设置值)' },
    },
    required: ['prompt'],
  },
};

/** 远程 Agent 事件类型从 shared/types.ts 导入(主进程与 renderer 共享)。 */

const PROTOCOL_VERSION = '2024-11-05';

export class LocalMcpServer {
  private server: http.Server | null = null;
  private tools: Tool[] = [];
  private token: string = '';
  // 远程 Agent 事件回调:main.ts 注册后,转发到 dashboard 窗口显示远程任务进度。
  private onRemoteEvent: ((ev: RemoteAgentEvent) => void) | null = null;

  setTools(tools: Tool[]): void {
    this.tools = tools;
  }

  setToken(token: string): void {
    this.token = token;
  }

  /** main.ts 注册此回调,将远程 Agent 事件转发到 dashboard UI。 */
  setRemoteEventHandler(handler: ((ev: RemoteAgentEvent) => void) | null): void {
    this.onRemoteEvent = handler;
  }

  isRunning(): boolean {
    return this.server?.listening ?? false;
  }

  start(port: number, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.token = token;
      if (this.server?.listening) {
        resolve();
        return;
      }
      this.server = http.createServer((req, res) => this.handle(req, res));
      // run_agent 可能跑数分钟 → 关闭 Node 默认 2min 超时,改为 10 分钟。
      this.server.timeout = 10 * 60 * 1000;
      this.server.requestTimeout = 10 * 60 * 1000;
      this.server.headersTimeout = 10 * 60 * 1000;
      this.server.keepAliveTimeout = 30_000;
      this.server.on('error', (e) => {
        reject(e);
      });
      this.server.listen(port, '0.0.0.0', () => {
        console.log(`[mcp-server] 监听 0.0.0.0:${port}(token: ${token ? '已设' : '⚠️ 未设'})`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        console.log('[mcp-server] 已停止');
        resolve();
      });
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // CORS:允许任意来源(局域网内的 MCP 客户端)。
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Token 鉴权:Authorization: Bearer <token>
    if (this.token) {
      const auth = req.headers.authorization ?? '';
      const got = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (got !== this.token) {
        this.jsonRpc(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: '未授权:token 不匹配' } });
        return;
      }
    }

    const url = req.url ?? '/mcp';

    if (req.method === 'POST' && url.startsWith('/mcp')) {
      this.handleJsonRpc(req, res);
      return;
    }

    if (req.method === 'DELETE' && url.startsWith('/mcp')) {
      // ponytail: 单 session 模式,DELETE 只需确认。
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', result: {} }));
      return;
    }

    // GET /mcp → SSE 长连接(ponytail: 保持连接但不推通知;有 session 需求的客户端会连)
    if (req.method === 'GET' && url.startsWith('/mcp')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // 每 30s 发一个 ping comment 保活
      const timer = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(timer);
        }
      }, 30_000);
      req.on('close', () => clearInterval(timer));
      return;
    }

    // 健康检查
    if (url === '/' || url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: getBrand().productName, mcp: true }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  private handleJsonRpc(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      // 防 OOM: 限制 10MB
      if (body.length > 10 * 1024 * 1024) {
        req.destroy();
      }
    });
    req.on('end', () => {
      let msg: McpJsonRpcRequest;
      try {
        msg = JSON.parse(body);
      } catch {
        this.jsonRpc(res, 200, { jsonrpc: '2.0', error: { code: -32700, message: 'JSON 解析失败' } });
        return;
      }
      this.dispatch(msg)
        .then((result) => {
          // 检查客户端是否请求 SSE 流式响应(带 Accept: text/event-stream)。
          const wantsSse = (req.headers.accept ?? '').includes('text/event-stream');
          const resp: McpJsonRpcResponse = { jsonrpc: '2.0', id: msg.id, result };
          if (wantsSse) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write(`data: ${JSON.stringify(resp)}\n\n`);
            res.write('event: done\ndata: {}\n\n');
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(resp));
          }
        })
        .catch((err: Error) => {
          const resp: McpJsonRpcResponse = {
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: err.message },
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(resp));
        });
    });
  }

  // JSON-RPC method 路由:initialize / tools/list / tools/call / ping。
  private async dispatch(msg: McpJsonRpcRequest): Promise<unknown> {
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: getBrand().productName + ' MCP Server', version: '0.1.0' },
        };

      case 'notifications/initialized':
        // notification(无 id)→ 不返回 result
        return {};

      case 'ping':
        return {};

      case 'tools/list':
        // 多机协作核心:远程节点只暴露 run_agent 一个工具。
        // 不暴露细粒度工具(shell/read_file/...)——远程文件路径、cwd、上下文都在远程机器上,
        // 让本地 LLM 逐条调远程工具极不稳定且容易出错。正确做法是远程起完整 Agent 自主完成任务。
        return { tools: [RUN_AGENT_TOOL_MCP] };

      case 'tools/call': {
        const name = String((msg.params as any)?.name ?? '');
        const args = ((msg.params as any)?.arguments ?? {}) as Record<string, unknown>;

        // ── run_agent:在本机启动完整 AgentLoop ──
        if (name === 'run_agent') {
          try {
            const result = await this.runRemoteAgent(args);
            return { content: [{ type: 'text', text: result }], isError: false };
          } catch (e) {
            return { content: [{ type: 'text', text: `远程 Agent 执行失败: ${(e as Error).message}` }], isError: true };
          }
        }

        const tool = this.tools.find((t) => t.name === name);
        if (!tool) {
          return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true };
        }
        try {
          // 本地 MCP Server 暴露的工具,ToolCtx 用最小安全默认值:
          // cwd = 用户主目录(或 KINET_MCP_CWD 环境变量覆盖),无 confirm(允许自动执行)。
          // 安全边界靠 token(只有信任的机器能连)。
          const ctx: ToolCtx = {
            cwd: process.env.KINET_MCP_CWD || os.homedir(),
            confirm: async () => true,
          };
          const result = await tool.run(args, ctx);
          return { content: [{ type: 'text', text: result }], isError: false };
        } catch (e) {
          return { content: [{ type: 'text', text: `工具执行失败: ${(e as Error).message}` }], isError: true };
        }
      }

      default:
        throw new Error(`未知 method: ${msg.method}`);
    }
  }

  /**
   * 远程 Agent 执行:在本机启动一个完整的 AgentLoop(ReAct 循环 + 全部工具)。
   * 远程调用方传入 prompt,本机 Agent 自主完成,返回最终文本。
   * - 不含 dispatch_agent(防远程递归:远程 Agent 不应再派发子 agent 起更多远程调用)
   * - 不含 confirm(安全边界靠 token:只有信任的机器能连)
   * - 用本机的 API key / model / baseURL
   */
  private async runRemoteAgent(args: Record<string, unknown>): Promise<string> {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return '错误:缺少 prompt 参数';

    const s = getSettings();
    const base = snapshot();
    const snap = { ...base, model: s.model };
    const provider: Provider = currentProvider(snap);
    const ac = new AbortController();
    // 超时保护:默认 5 分钟,防止远程 Agent 无限运行。
    const timeoutMs = 5 * 60 * 1000;
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    // 远程 Agent 拥有完整工具(shell/read_file/write_file/...),但不包含 dispatch_agent(防递归)。
    const tools = allTools().filter((t) => t.name !== 'dispatch_agent');
    const ctx: ToolCtx = {
      cwd: process.env.KINET_MCP_CWD || os.homedir(),
      confirm: async () => true, // token 已验证 → 信任远程调用
      sandbox: s.sandbox,
      signal: ac.signal,
    };

    // 通知本机 UI:远程 Agent 开始工作。
    this.onRemoteEvent?.({ type: 'start', prompt: prompt.slice(0, 200) });

    try {
      const messages = await runAgentLoop({
        provider,
        tools,
        systemPrompt: baseSystemPrompt,
        snapshot: snap,
        userInput: prompt,
        history: [],
        ctx,
        signal: ac.signal,
        maxTurns: (args.maxTurns as number) || undefined, // undefined → 读 settings.maxTurns
        onEvent: (e: AgentEvent) => {
          // 转发到本机 dashboard,让用户看到远程 Agent 正在做什么。
          if (!this.onRemoteEvent) return;
          switch (e.type) {
            case 'token':
              this.onRemoteEvent({ type: 'token', text: e.text });
              break;
            case 'tool':
              this.onRemoteEvent({ type: 'tool', name: e.name });
              break;
            case 'status':
              this.onRemoteEvent({ type: 'status', text: e.text });
              break;
            case 'cost':
              this.onRemoteEvent({ type: 'cost', usd: e.usd, tokens: e.tokens });
              break;
            case 'error':
              this.onRemoteEvent({ type: 'error', message: e.message });
              break;
            case 'done':
              break; // done 在 finally 后单独发
          }
        },
      });
      const text = messages
        .filter((m) => m.role === 'assistant' && typeof m.content === 'string')
        .map((m) => m.content)
        .join('\n')
        .trim();
      const result = text || '(远程 Agent 无文本输出)';
      this.onRemoteEvent?.({ type: 'done', summary: result.slice(0, 500) });
      return result;
    } catch (e) {
      this.onRemoteEvent?.({ type: 'error', message: (e as Error).message });
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private jsonRpc(res: ServerResponse, status: number, body: McpJsonRpcResponse): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

export const localMcpServer = new LocalMcpServer();
