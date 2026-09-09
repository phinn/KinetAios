// 测试用 electron shim —— esbuild --alias:electron= 指到本文件,
// 让 store.ts 等主进程模块在纯 node 下可运行(better-sqlite3 保持 external,用真实原生模块)。
// 每个测试进程拿到独立 tmp 目录 → 测试间零串库。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// KINET_TEST_USERDATA 环境变量可显式指定(调试用);缺省每进程独立 mkdtemp。
let dir: string | null = null;
export const app = {
  getPath(name: string): string {
    if (name !== 'userData') throw new Error(`[test-shim] 未实现的 getPath: ${name}`);
    if (process.env.KINET_TEST_USERDATA) return process.env.KINET_TEST_USERDATA;
    if (!dir) dir = mkdtempSync(join(tmpdir(), 'kinet-test-'));
    return dir;
  },
};

// settings.ts 的 API key 加密:测试环境声明不可用 → 明文直存,闭环足够。
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (s: string): Buffer => Buffer.from(s),
  decryptString: (b: Buffer): string => b.toString(),
};

// computer-use.ts 等模块的 bundle 时引用;测试不触达运行时行为,给空桩。
export const BrowserWindow = class StubBrowserWindow {};
export const screen = { getPrimaryDisplay: () => ({ size: { width: 0, height: 0 }, workArea: { width: 0, height: 0 } }) };
export const desktopCapturer = { getSources: async (): Promise<unknown[]> => [] };

export default { app, safeStorage };
