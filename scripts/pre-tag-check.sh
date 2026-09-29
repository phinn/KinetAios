#!/bin/bash
# pre-tag-check.sh — 打 release tag 前的机械校验(治"releasenote 每次漏英文段")
# 用法: bash scripts/pre-tag-check.sh 3.9.5
# 任何一项 FAIL 都必须修完才能 commit + tag。来源: v3.8.1~v3.9.3 连续 6 版漏 EN 段的教训。
set -u
VER="${1:?用法: pre-tag-check.sh <版本号,如 3.9.5>}"
fail=0
ok()   { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1"; fail=1; }

echo "== pre-tag-check v$VER =="

# 1. 版本号: package.json + package-lock.json(两处) + README 中英
grep -q "\"version\": \"$VER\"" package.json && ok "package.json = $VER" || bad "package.json ≠ $VER"
[ "$(grep -c "\"version\": \"$VER\"" package-lock.json)" -ge 2 ] && ok "package-lock.json 两处 = $VER" || bad "package-lock.json version ≠ $VER(应两处)"
grep -q "current: $VER" README.md && ok "README.md EN 版本号" || bad "README.md current ≠ $VER"
grep -q "当前 $VER" README.zh-CN.md && ok "README.zh-CN.md 版本号" || bad "README.zh-CN.md 当前 ≠ $VER"

# 2. 本次 releasenote 存在且双语
RN=".releasenotes/rn-$VER.md"
if [ ! -f "$RN" ]; then
  bad "缺 $RN"
else
  echo "  ✅ $RN 存在"
  head -1 "$RN" | grep -q "发布日期" && ok "中文正文在头部" || bad "rn 头部不是中文正文"
  grep -q '^\*\*English\*\*' "$RN" && ok "EN 段存在" || bad "漏 **English** 段!"
  grep -q "Full Changelog" "$RN" && ok "Full Changelog 链接" || bad "缺 Full Changelog"
fi

# 3. 回查: 本仓库全部历史 rn 都必须有 EN 段(防旧账复发)
missing=$(grep -L '^\*\*English\*\*' .releasenotes/rn-*.md 2>/dev/null)
if [ -z "$missing" ]; then
  ok "全部历史 rn 双语齐全"
else
  bad "以下 rn 漏 EN 段(先补再发): $(echo $missing | tr '\n' ' ')"
fi

# 4. package-lock 顶层 version 与 package.json 一致
LOCKV=$(python3 -c "import json;print(json.load(open('package-lock.json'))['version'])" 2>/dev/null)
[ "$LOCKV" = "$VER" ] && ok "package-lock 顶层 version = $VER" || bad "package-lock 顶层 version = ${LOCKV:-无} ≠ $VER"

echo "== $([ $fail -eq 0 ] && echo 'ALL PASS — 可以 commit + tag' || echo 'FAIL — 修完再发') =="
exit $fail
