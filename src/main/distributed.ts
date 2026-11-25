// 分布式任务派发 —— 把一段任务交给另一台机器上的 KinetAios 执行,结果回传本机。
//
// 传输复用已有的 remote MCP 节点(settings.mcpServers 里 type=remote 且指向对方 /mcp 的条目):
// 对方跑着本地 MCP Server,暴露 run_agent(完整 AgentLoop + 工具)。本模块只做三件事:
//   ① 节点选择(名字容错 + 离线/歧义/不存在给出可读原因)
//   ② 参数整形(prompt / cwd / maxTurns)
//   ③ 取消传播(用户 abort 时尽快返回,不阻塞本机 turn)
// 真正的长任务建议走 JobManager.submitRemoteAgent 提交成后台 Job,避免占住同步 turn。
/** remote MCP 节点摘要(与 McpRegistry.remoteSnapshot 的结构兼容,不反向依赖它)。 */
export type RemoteNodeInfo = { name: string; online: boolean; toolCount?: number };

export type NodePick = { ok: true; name: string } | { ok: false; error: string };

/** 把节点列表渲染成一行可读文案(错误提示用)。 */
export function formatNodeList(nodes: RemoteNodeInfo[]): string {
  if (!nodes.length) return '无';
  return nodes.map((n) => `${n.name}${n.online ? '' : '(离线)'}`).join(', ');
}

/**
 * 按名字挑节点。容错顺序:全名(忽略大小写) → 唯一子串匹配。
 * 歧义/离线/不存在都返回可执行的中文错误,而不是抛网络异常。
 */
export function pickNode(nodes: RemoteNodeInfo[], wanted: string): NodePick {
  const q = String(wanted ?? '').trim();
  if (!nodes.length) {
    return { ok: false, error: '本机没有已配置的远程节点。先在「设置 → MCP」添加 remote 节点(填对方 KinetAios 的 /mcp 地址与 token),再派发。' };
  }
  if (!q) return { ok: false, error: `缺少 node 参数。可选节点: ${formatNodeList(nodes)}` };

  const lower = q.toLowerCase();
  let match = nodes.find((n) => n.name.toLowerCase() === lower);
  if (!match) {
    const hits = nodes.filter((n) => n.name.toLowerCase().includes(lower));
    if (hits.length > 1) {
      return { ok: false, error: `节点名「${q}」不唯一,匹配到: ${hits.map((n) => n.name).join(', ')}。请写全名。` };
    }
    match = hits[0];
  }
  if (!match) return { ok: false, error: `没有名为「${q}」的远程节点。可选节点: ${formatNodeList(nodes)}` };
  if (!match.online) return { ok: false, error: `远程节点「${match.name}」当前离线(检查对方应用与 MCP Server 是否在跑)。` };
  return { ok: true, name: match.name };
}

/** Job 标题:节点名一眼可见,长 prompt 截断,避免 Job 面板被一行撑爆。 */
export function remoteJobTitle(node: string, prompt: string): string {
  return `[@${node}] ${String(prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}`;
}

export type RemoteCallOpts = {
  node: string;
  prompt: string;
  /** 对方机器上的工作目录;必须落在对方声明的授权根内,否则对方 server 直接拒绝 */
  cwd?: string;
  maxTurns?: number;
  signal?: AbortSignal;
};

/**
 * 同步派发一次:选节点 → 调 run_agent → 返回对方 Agent 的最终文本。
 * 取消语义:abort 后本函数尽快返回,但对方 Agent 可能仍跑完(协议无远端取消)。
 * 分钟级任务请用 JobManager.submitRemoteAgent(不占本机 turn)。
 */
export async function callRemoteAgent(opts: RemoteCallOpts): Promise<string> {
  const prompt = String(opts.prompt ?? '').trim();
  if (!prompt) throw new Error('缺少 prompt 参数');
  if (opts.signal?.aborted) throw new Error('用户取消');

  const { mcp } = await import('./mcp');
  const nodes = await mcp.remoteSnapshot(800);
  const pick = pickNode(nodes, opts.node);
  if (!pick.ok) throw new Error(pick.error);

  const args: Record<string, unknown> = { prompt: prompt.slice(0, 20_000) };
  if (opts.cwd) args.cwd = opts.cwd;
  if (opts.maxTurns && opts.maxTurns > 0) args.maxTurns = Math.min(opts.maxTurns, 50);

  const call = mcp.callRemote(pick.name, 'run_agent', args);
  if (!opts.signal) return call;

  const signal = opts.signal;
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('用户取消(远端任务可能仍在执行)'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([call, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
