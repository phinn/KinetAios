// 硬额度 429:识别「套餐/积分用尽」话术,不重试(重试只会白等 40s+);
// 瞬时 429 仍走重试/failover。
import { assert, test, run } from './harness';
import { isQuotaExhausted } from '../../src/main/glm';
import { isTransientError } from '../../src/main/AgentLoop';

test('识别额度耗尽文案(中/英)', () => {
  assert.ok(isQuotaExhausted('当前已达到 Token Plan 用量上限。为避免调用中断，请升级 Token Plan 套餐'));
  assert.ok(isQuotaExhausted('账户余额不足,请充值'));
  assert.ok(isQuotaExhausted('You have insufficient quota to complete this request'));
  assert.ok(isQuotaExhausted('insufficient credit balance'));
  assert.ok(!isQuotaExhausted('Too Many Requests, please retry later'));
  assert.ok(!isQuotaExhausted('rate limit exceeded, slow down'));
});

test('额度耗尽 429 不判为瞬时错误(不重试)', () => {
  const hardQuota = Object.assign(new Error('HTTP 429: 已达到 Token Plan 用量上限'), { code: 429, detail: '当前已达到 Token Plan 用量上限,请升级套餐' });
  assert.strictEqual(isTransientError(hardQuota), false);
  // 普通限流仍是瞬时错误
  const softRate = Object.assign(new Error('HTTP 429: Too Many Requests'), { code: 429, detail: 'too many requests' });
  assert.strictEqual(isTransientError(softRate), true);
  // 5xx 不受影响
  assert.strictEqual(isTransientError(Object.assign(new Error('HTTP 502'), { code: 502 })), true);
});

run();
