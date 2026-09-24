**发布日期：** 2026-08-31(自 v3.4.0 起 3 commits)

### 🐛 Direct 截图误判根治(GLM 400 [1214])
- agent read_file/grep 读到 AgentLoop.ts 里 `__IMAGE_BASE64__:` 字面量时,indexOf 误判为截图,把剩余 JS 源码拼进 data: URL 发给 GLM → 400 且每次重试复发,DirectEngine 卡死
- **parseScreenshotResult()** — payload 必须纯 base64 且 ≥100 字符才认定截图;5 处判定点统一走它;畸形 data: URL 直接丢弃

### 🔧 CI
- release notes 抽取 ReferenceError 根治 — TAG 裸用于 node -e

---

**English**

- Root-caused the GLM 400 [1214] screenshot misdetection: file tools reading the literal `__IMAGE_BASE64__:` marker in source made the engine splice JS code into a data: URL, failing every retry. **parseScreenshotResult()** now requires pure base64 ≥100 chars, applied at all 5 detection points; malformed data: URLs are dropped
- CI: fixed the release-notes extraction ReferenceError (bare TAG in node -e)

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.4.0...v3.4.1
