// Runtime config, persisted to a JSON file in userData. Port of Swift AppSettings.
import path from 'node:path';
import fs from 'node:fs';
import { app, safeStorage } from 'electron';
import type { AppSettings, ConfigSnapshot } from '../shared/types';

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
    if (typeof s.apiKey === 'string' && s.apiKey.startsWith('@enc:') && safeStorage.isEncryptionAvailable()) {
      try {
        s.apiKey = safeStorage.decryptString(Buffer.from(s.apiKey.slice(5), 'base64'));
      } catch {
        /* 解密失败留原值 */
      }
    }
    cache = s;
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function saveSettings(s: AppSettings): void {
  cache = { ...s };
  // apiKey 用系统密钥加密(mac Keychain / Win DPAPI / Linux libsecret)再落盘,不再明文。
  // safeStorage 不可用(极少数环境)时回退明文。
  const toWrite: AppSettings = { ...s };
  if (s.apiKey && safeStorage.isEncryptionAvailable()) {
    toWrite.apiKey = '@enc:' + safeStorage.encryptString(s.apiKey).toString('base64');
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
