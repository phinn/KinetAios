// Runtime config, persisted to a JSON file in userData. Port of Swift AppSettings.
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
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
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) } as AppSettings;
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function saveSettings(s: AppSettings): void {
  cache = { ...s };
  // ponytail: apiKey stored in plaintext JSON. Fine for a local single-user dev tool;
  // move to Windows Credential Manager (CredRead/CredWrite) before any real distribution.
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
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
