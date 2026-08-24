// afterSign 公证钩子 — electron-builder 打完 dmg 后自动调 notarytool 公证 + staple
// afterSign hook — notarize via notarytool then staple.
// 用法: package.json build.mac.afterSign 指向本文件; CI 里提供
//   APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID 环境变量。
const { notarize } = require('@electron/notarize');

module.exports = async function (context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('⚠️ 缺少 APPLE_ID/APPLE_APP_PASSWORD/APPLE_TEAM_ID,跳过公证(本地开发构建)');
    return;
  }

  console.log(`🔒 Notarizing ${appPath} ...`);
  await notarize({
    tool: 'notarytool',
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });
  console.log('✅ Notarization submitted & accepted');

  // staple — 让离线机器也能通过 Gatekeeper
  const { execSync } = require('child_process');
  console.log(execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' }) || '');
  console.log('📎 Stapled');
};
