// 极简测试 harness:顺序执行、失败打印期望/实际、非 0 退出码。
// 用法:测试文件末尾 `await run();`。零依赖,配合 run-tests.js 的 esbuild bundle。
import assert from 'node:assert/strict';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];

export { assert };

export function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

export async function run(): Promise<void> {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${name}`);
      console.error(
        String((e as Error)?.message ?? e)
          .split('\n')
          .slice(0, 12)
          .map((l) => `       ${l}`)
          .join('\n'),
      );
    }
  }
  console.log(`  ── ${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exitCode = 1;
}
