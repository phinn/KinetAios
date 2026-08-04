// Runtime config, persisted to a JSON file in userData. Port of Swift AppSettings.
import path from 'node:path';
import fs from 'node:fs';
import { app, safeStorage } from 'electron';
import type { AppSettings, ConfigSnapshot, EmbedSnapshot, EngineKind } from '../shared/types';

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
  defaultEngine: 'direct' as EngineKind,
  priceInPerMTok: 0.07, // GLM ¥0.5/1M in ≈ $0.07
  priceOutPerMTok: 0.21, // GLM ¥1.5/1M out ≈ $0.21
  presetId: 'glm',
  lang: 'zh-CN',
  theme: 'dark',
  townStyle: 'classic', // 小镇视图风格:classic 经典等距小屋 / minecraft 我的世界方块风
  // 模型配置档:用户在设置页保存的多套完整 LLM 配置。空数组 = 只有全局默认。
  modelProfiles: [],
  activeProfileId: null,
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
  disabledPlugins: [], // 被禁用的插件 name 列表(空 = 全部启用)
  voiceAutoSend: false, // 语音实时输入默认关闭(开启后 Web Speech API 实时转写 + VAD 自动发送)
  hifiContextBudget: 200000, // 高保真模式上下文预算(默认 200K token,适配 GLM-5.2 的 1M 窗口)
  v2ModelWindow: 1_000_000,  // V2 引擎:模型上下文窗口大小(默认 1M = GLM-5.2;GLM-4.6 = 128000)
  v2BudgetRatio: 0.08,       // V2 引擎:预算占窗口比例(8% → 1M 窗口 = 80K trim/compact 预算)
  persona: '', // 替身画像:分析历史对话生成的用户风格描述(空 = 未生成)
  // 实时语音助手配置:默认关闭,AppID/Token 留空(wsUrl 预填火山引擎官方地址)。
  voiceChat: {
    appId: '',
    accessToken: '',
    wsUrl: 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue',
    voiceType: 'zh_female_vv_jupiter_bigtts',
    enable: false,
  },
  minimaxApiKey: '', // MiniMax 文生视频 API Key(留空 = 未配置)
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
    s.minimaxApiKey = decryptIfEnc(s.minimaxApiKey);
    // voiceChat.accessToken 也加密存储 / also encrypted at rest
    if (s.voiceChat) {
      s.voiceChat.accessToken = decryptIfEnc(s.voiceChat.accessToken);
    }
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
  if (s.minimaxApiKey && safeStorage.isEncryptionAvailable()) {
    toWrite.minimaxApiKey = '@enc:' + safeStorage.encryptString(s.minimaxApiKey).toString('base64');
  }
  // voiceChat.accessToken 加密 / encrypt voiceChat access token
  if (s.voiceChat?.accessToken && safeStorage.isEncryptionAvailable()) {
    toWrite.voiceChat = {
      ...s.voiceChat,
      accessToken: '@enc:' + safeStorage.encryptString(s.voiceChat.accessToken).toString('base64'),
    };
  }
  fs.writeFileSync(file(), JSON.stringify(toWrite, null, 2));
}

// Snapshot for one request — reads live settings so a settings change takes effect next task.
// If an active profile is set, use its config (lets the user switch providers per-conversation).
export function snapshot(profileId?: string | null): ConfigSnapshot {
  const s = getSettings();
  // 优先用指定 profileId(来自 conversation),其次用全局 activeProfileId,最后用全局默认。
  const pid = profileId ?? s.activeProfileId;
  const profile = pid ? s.modelProfiles.find((p) => p.id === pid) : null;
  if (profile) {
    return {
      baseURL: profile.baseURL,
      model: profile.model,
      apiKey: profile.apiKey,
      apiProtocol: profile.apiProtocol,
      reasoning: profile.reasoning,
    };
  }
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
