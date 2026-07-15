// Runtime config, persisted to a JSON file in userData. Port of Swift AppSettings.
import path from 'node:path';
import fs from 'node:fs';
import { app, safeStorage } from 'electron';
import type { AppSettings, ConfigSnapshot, EmbedSnapshot } from '../shared/types';

// Defaults match the macOS app: GLM 智谱 openai-compatible endpoint.
const DEFAULTS: AppSettings = {
  apiKey: '',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-5.2',
  apiProtocol: 'openai',
  reasoning: 'none',
  approval: 'always',
  sandbox: 'workspaceWrite',
  planMode: false,
  enableCliEngines: false,
  priceInPerMTok: 0.07, // GLM ¥0.5/1M in ≈ $0.07
  priceOutPerMTok: 0.21, // GLM ¥1.5/1M out ≈ $0.21
  presetId: 'glm',
  lang: 'zh-CN',
  theme: 'dark',
  // Embedding 接口默认值:留空 = 跟随主接口,model 默认 embedding-3(GLM 智谱)。
  embedBaseURL: '',
  embedApiKey: '',
  embedModel: 'embedding-3',
  budget: { enabled: false, perSessionLimit: 0, dailyLimit: 0 },
  maxTurns: 50,            // Direct 引擎单轮最大 ReAct 循环数(默认 50;0 = 无限)
  closeBehavior: 'minimize', // 窗口关闭行为:quit 退出 / minimize 最小化到任务栏 / tray 最小化到托盘
  // 多机协作:默认关闭 MCP Server;端口 18109;token 空 = 不鉴权(仅局域网内信任环境用)。
  localMcpServer: { enabled: false, port: 18109, token: '' },
  // 远程 MCP server 列表默认为空(用户在设置里添加其它机器)。
  remoteMcpServers: [],
};

let cache: AppSettings | null = null;

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function getSettings(): AppSettings {
  if (cache) return cache;
  try {
    const s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) } as AppSettings;
    // 旧明文 key 不以 @enc: 开头 → 按原样用(向后兼容);加密的解回明文进内存。
    const decryptIfEnc = (v: string): string => {
      if (typeof v === 'string' && v.startsWith('@enc:') && safeStorage.isEncryptionAvailable()) {
        try { return safeStorage.decryptString(Buffer.from(v.slice(5), 'base64')); } catch { return v; }
      }
      return v;
    };
    s.apiKey = decryptIfEnc(s.apiKey);
    s.embedApiKey = decryptIfEnc(s.embedApiKey);
    cache = s;
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function saveSettings(s: AppSettings): void {
  cache = { ...s };
  // apiKey / embedApiKey 用系统密钥加密(mac Keychain / Win DPAPI / Linux libsecret)再落盘,不再明文。
  // safeStorage 不可用(极少数环境)时回退明文。
  const toWrite: AppSettings = { ...s };
  if (s.apiKey && safeStorage.isEncryptionAvailable()) {
    toWrite.apiKey = '@enc:' + safeStorage.encryptString(s.apiKey).toString('base64');
  }
  if (s.embedApiKey && safeStorage.isEncryptionAvailable()) {
    toWrite.embedApiKey = '@enc:' + safeStorage.encryptString(s.embedApiKey).toString('base64');
  }
  fs.writeFileSync(file(), JSON.stringify(toWrite, null, 2));
}

// Snapshot for one request — reads live settings so a settings change takes effect next task.
export function snapshot(): ConfigSnapshot {
  const s = getSettings();
  return {
    baseURL: s.baseURL,
    model: s.model,
    apiKey: s.apiKey,
    apiProtocol: s.apiProtocol,
    reasoning: s.reasoning,
  };
}

// Embedding 接口快照:优先用 embedBaseURL/embedApiKey;空则回退主接口配置。
// model 优先 embedModel,默认 embedding-3。Ollama 走 nomic-embed-text。
export function embedSnapshot(): EmbedSnapshot {
  const s = getSettings();
  const baseURL = s.embedBaseURL || s.baseURL;
  const apiKey = s.embedApiKey || s.apiKey;
  let model = s.embedModel || 'embedding-3';
  if (baseURL.includes('localhost:11434')) model = 'nomic-embed-text';
  return { baseURL, apiKey, model };
}
