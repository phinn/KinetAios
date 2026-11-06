// 协议↔Base URL 联动映射测试:智谱/阿里 Token Plan 双向,共用-URL provider 不误伤,未知 URL 不动。
// 背景:用户在设置/配置档弹窗切协议时 URL 不跟着换,请求打到错误端点 404。
import { assert, test, run } from './harness';
import {
  swapBaseUrlForProtocol,
  isProtoBaseMismatch,
  detectProvider,
  ALIYUN_TOKEN_PLAN_ANTHROPIC,
  ALIYUN_TOKEN_PLAN_OPENAI,
} from '../../src/shared/providerEndpoints';

// ── 智谱(国内站 open.bigmodel.cn) ──
test('智谱 openai→anthropic:/api/paas/v4 换成 /api/anthropic', () => {
  assert.equal(
    swapBaseUrlForProtocol('https://open.bigmodel.cn/api/paas/v4', 'anthropic'),
    'https://open.bigmodel.cn/api/anthropic',
  );
});

test('智谱 anthropic→openai:/api/anthropic 换成 /api/paas/v4', () => {
  assert.equal(
    swapBaseUrlForProtocol('https://open.bigmodel.cn/api/anthropic', 'openai'),
    'https://open.bigmodel.cn/api/paas/v4',
  );
});

test('同形态重复切换(paas/v4→openai / anthropic→anthropic)返回 null 不动', () => {
  assert.equal(swapBaseUrlForProtocol('https://open.bigmodel.cn/api/paas/v4', 'openai'), null);
  assert.equal(swapBaseUrlForProtocol('https://open.bigmodel.cn/api/anthropic', 'anthropic'), null);
});

test('尾部斜杠容忍:paas/v4/ 也能识别换转', () => {
  assert.equal(
    swapBaseUrlForProtocol('https://open.bigmodel.cn/api/paas/v4/', 'anthropic'),
    'https://open.bigmodel.cn/api/anthropic',
  );
});

// ── 阿里 Token Plan(双协议官方端点,来自 token-plan-personal-quick-start.md) ──
test('阿里 anthropic→openai:apps/anthropic 换成 compatible-mode/v1', () => {
  assert.equal(
    swapBaseUrlForProtocol(ALIYUN_TOKEN_PLAN_ANTHROPIC, 'openai'),
    ALIYUN_TOKEN_PLAN_OPENAI,
  );
});

test('阿里 openai→anthropic:compatible-mode/v1 换成 apps/anthropic', () => {
  assert.equal(
    swapBaseUrlForProtocol(ALIYUN_TOKEN_PLAN_OPENAI, 'anthropic'),
    ALIYUN_TOKEN_PLAN_ANTHROPIC,
  );
});

test('阿里同形态重复切换返回 null 不动', () => {
  assert.equal(swapBaseUrlForProtocol(ALIYUN_TOKEN_PLAN_ANTHROPIC, 'anthropic'), null);
  assert.equal(swapBaseUrlForProtocol(ALIYUN_TOKEN_PLAN_OPENAI, 'openai'), null);
});

// ── 共用 URL 的 provider 与未知 URL:一律不动 ──
test('其它 provider(DeepSeek/Ollama/z.ai)两协议共用 URL:双向返回 null', () => {
  assert.equal(swapBaseUrlForProtocol('https://api.deepseek.com', 'anthropic'), null);
  assert.equal(swapBaseUrlForProtocol('https://api.deepseek.com', 'openai'), null);
  assert.equal(swapBaseUrlForProtocol('http://localhost:11434/v1', 'anthropic'), null);
  assert.equal(swapBaseUrlForProtocol('https://api.z.ai/api/paas/v4', 'anthropic'), null);
});

test('isProtoBaseMismatch:paas/v4 配 anthropic = 错配;各家正确组合 = 正常', () => {
  assert.equal(isProtoBaseMismatch('https://open.bigmodel.cn/api/paas/v4', 'anthropic'), true);
  assert.equal(isProtoBaseMismatch('https://open.bigmodel.cn/api/anthropic', 'anthropic'), false);
  assert.equal(isProtoBaseMismatch(ALIYUN_TOKEN_PLAN_ANTHROPIC, 'anthropic'), false);
  assert.equal(isProtoBaseMismatch(ALIYUN_TOKEN_PLAN_OPENAI, 'openai'), false);
  assert.equal(isProtoBaseMismatch('https://api.deepseek.com', 'openai'), false);
});

// ── detectProvider:provider 推断(经济段分流/余额路由共用)──
test('detectProvider:阿里 Token Plan(host 通配任意 region)识别', () => {
  assert.equal(detectProvider('https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic'), 'aliyun-token-plan');
  assert.equal(detectProvider('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'), 'aliyun-token-plan');
  assert.equal(detectProvider('https://token-plan.us-east-1.maas.aliyuncs.com/apps/anthropic'), 'aliyun-token-plan');
});

test('detectProvider:智谱(bigmodel.cn / 国际站 z.ai)识别', () => {
  assert.equal(detectProvider('https://open.bigmodel.cn/api/paas/v4'), 'zhipu');
  assert.equal(detectProvider('https://open.bigmodel.cn/api/anthropic'), 'zhipu');
  assert.equal(detectProvider('https://api.z.ai/api/paas/v4'), 'zhipu');
});

test('detectProvider:其它(DeepSeek/Ollama/空)落 generic', () => {
  assert.equal(detectProvider('https://api.deepseek.com'), 'generic');
  assert.equal(detectProvider('http://localhost:11434/v1'), 'generic');
  assert.equal(detectProvider(''), 'generic');
});

void run();
