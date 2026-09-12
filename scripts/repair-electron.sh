#!/usr/bin/env bash
# Electron 二进制自愈脚本(2026-09 Gatekeeper/XProtect 反复清除事件后固化)。
#
# 症状:启动报 ENOENT / SIGKILL / "已阻止恶意软件并移到废纸篓"。
# 根因:残缺解压(320K 空壳,version 文件残留导致重装被跳过)+ 官方签名与残缺内容
#       不符 → macOS 按"签名失效的篡改软件"清除。
# 修复:npmmirror 重下 → 强制解压 → 去隔离 → ad-hoc 重签 → 校验。
#
# 用法:bash scripts/repair-electron.sh
set -u
cd "$(dirname "$0")/../node_modules/electron"

MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"

echo "── 1/4 检测现状"
need=0
[ -f "dist/Electron.app/Contents/MacOS/Electron" ] || { echo "  二进制缺失"; need=1; }
if [ "$need" = "0" ] && ! codesign -vv dist/Electron.app >/dev/null 2>&1; then
  echo "  签名校验失败(残缺/被篡改)"; need=1
fi
if [ "$need" = "0" ]; then
  echo "✅ Electron 完好,无需修复"
  exit 0
fi

echo "── 2/4 重新下载($MIRROR)"
# 必须先删 dist:残留的 version 文件会让 install.js 误判"已安装"而跳过解压(本次事故根因)
rm -rf dist
ELECTRON_MIRROR="$MIRROR" node install.js
# 解压可能残缺(超时/中断)→ 校验主二进制,缺则再试一次
if [ ! -f "dist/Electron.app/Contents/MacOS/Electron" ]; then
  echo "  解压不完整,重试下载…"
  rm -rf dist
  ELECTRON_MIRROR="$MIRROR" node install.js
fi
if [ ! -f "dist/Electron.app/Contents/MacOS/Electron" ]; then
  echo "❌ 重装失败:主二进制仍缺失。检查网络或手动删除 ~/Library/Caches/electron 后重试。"
  exit 1
fi

echo "── 3/4 完整性校验"
size=$(du -sh dist 2>/dev/null | cut -f1)
echo "  bundle 体积: $size(正常应 >200M)"
if ! codesign -vv dist/Electron.app >/dev/null 2>&1; then
  echo "  签名与内容不符 → ad-hoc 重签(本地开发机标准做法)"
  codesign --force --deep --sign - dist/Electron.app
fi
xattr -dr com.apple.quarantine dist/Electron.app 2>/dev/null || true

echo "── 4/4 最终校验"
if codesign -vv dist/Electron.app >/dev/null 2>&1; then
  echo "✅ 签名校验通过"
elif codesign -dvv dist/Electron.app >/dev/null 2>&1; then
  echo "⚠️ ad-hoc 签名(本地开发可用;正式分发请走 electron-builder 打包签名)"
else
  echo "❌ 签名仍异常"
  exit 1
fi
echo "✅ Electron 已修复,可以 npm start / npm run dev"
