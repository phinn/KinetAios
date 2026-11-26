// 子任务模型路由:覆盖顺序(env > settings > 会话 > 默认)与可解释性。
import { assert, test, run } from './harness';
import { resolveModelRoute } from '../../src/main/model-router';

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('四类能力各自可覆盖,环境变量优先级最高', () => {
  withEnv('KINET_MODEL_VISION', 'vision-x', () => {
    const d = resolveModelRoute({ capability: 'vision', settings: { modelRouting: { vision: 'from-settings' } }, convModel: 'conv', baseModel: 'base' });
    assert.equal(d.model, 'vision-x');
    assert.equal(d.source, 'env');
    assert.ok(d.reason.includes('KINET_MODEL_VISION'));
  });
  withEnv('KINET_MODEL_SUMMARIZE', undefined, () => {
    const d = resolveModelRoute({ capability: 'summarize', settings: { modelRouting: { summarize: 'cheap' } }, convModel: 'conv', baseModel: 'base' });
    assert.equal(d.model, 'cheap');
    assert.equal(d.source, 'settings');
  });
});

test('没有覆盖时跟随会话模型,再回退默认;空配置返回 unset', () => {
  withEnv('KINET_MODEL_PLAN', undefined, () => {
    const conv = resolveModelRoute({ capability: 'plan', settings: { modelRouting: {} }, convModel: 'conv-model', baseModel: 'base' });
    assert.equal(conv.model, 'conv-model');
    assert.equal(conv.source, 'conversation');

    const def = resolveModelRoute({ capability: 'exec', settings: {}, baseModel: 'base' });
    assert.equal(def.model, 'base');
    assert.equal(def.source, 'default');

    const none = resolveModelRoute({ capability: 'vision', settings: {} });
    assert.equal(none.model, '');
    assert.equal(none.source, 'unset');
    assert.ok(none.reason.length > 0);
  });
});

test('空白字符串不算配置(避免设置里误输入空格就切模型)', () => {
  withEnv('KINET_MODEL_EXEC', undefined, () => {
    const d = resolveModelRoute({ capability: 'exec', settings: { modelRouting: { exec: '   ' } }, convModel: '   ', baseModel: 'base' });
    assert.equal(d.model, 'base');
    assert.equal(d.source, 'default');
  });
});

run();
