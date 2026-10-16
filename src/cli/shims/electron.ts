// CLI 打包用 electron shim —— esbuild --alias:electron= 指到本文件,
// 让 main 进程核心模块(store/settings/AgentLoop 等)在纯 Node 下运行。
// 与 scripts/test/shims/electron.ts 的区别:userData 固定指向桌面版同款目录,
// CLI 与桌面 GUI 共享同一个记忆库/设置(API key 已在桌面版配过的话 CLI 直接可用)。
// CLI 运行在无窗口环境,safeStorage 声明不可用 → settings 回退明文存取(向后兼容)。
import { join } from 'node:path';
import { homedir } from 'node:os';

// %APPDATA%\KinetAios(windows)/ ~/Library/Application Support/KinetAios (mac)
// 与 Electron app.setName('KinetAios') 后的 userData 完全一致。
const ud = join(
  process.env.APPDATA ||
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')),
  'KinetAios'
);

// plugins.ts 打包分支用 process.resourcesPath(Electron 全局)。
// CLI 无该变量 → 定义为 userData 下的占位目录,让 join() 不炸、readdir 找不到目录自然走空。
if (!('resourcesPath' in process)) {
  Object.defineProperty(process, 'resourcesPath', {
    value: ud,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

export const app = {
  isPackaged: true, // CLI 产物没有源码 plugins/ 目录,按打包语义扫 userData
  getPath(name: string): string {
    switch (name) {
      case 'exe':
        return process.execPath;
      case 'userData':
        return ud;
      case 'appData': // brand.ts 用
        return process.env.APPDATA || (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : join(homedir(), '.config'));
      default:
        return ud;
    }
  },
};

// 无窗口环境:safeStorage 不可用 → settings.ts 走明文回退(与桌面版旧数据兼容:
// 桌面版加密过的 key,CLI 读出来是密文 Buffer toString,会失效 —— 用户在 CLI 里
// 重设一次 apiKey 即可;明文新写的 key 桌面版也能读)。
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (s: string): Buffer => Buffer.from(s),
  decryptString: (b: Buffer): string => b.toString(),
};

// bundle 兼容桩(computer-use 等模块编译期引用,CLI 不触达其运行时)
export const BrowserWindow = class StubBrowserWindow {};
export const screen = { getPrimaryDisplay: () => ({ size: { width: 0, height: 0 }, workArea: { width: 0, height: 0 } }) };
export const desktopCapturer = { getSources: async (): Promise<unknown[]> => [] };

export default { app, safeStorage };
