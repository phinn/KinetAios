// 独立 Files & Preview 窗口的入口脚本。共享逻辑在 files-pane.ts。
// app.ts(主窗口的内联文件 tab)同样 import 自 files-pane.ts。
import { mountFilesPane } from './files-pane';
import type { KinetAPI } from '../shared/types';
import { t } from '../shared/i18n';

declare global {
  interface Window {
    kinet: KinetAPI;
  }
}

(async () => {
  const [settings, brand] = await Promise.all([window.kinet.getSettings(), window.kinet.getBrand()]);
  document.title = `${brand.productName} · ${t(settings.lang, 'files.title')}`;
  mountFilesPane(document.body, settings.lang);
})();
