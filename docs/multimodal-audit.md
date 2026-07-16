# 多模态功能全景审查 / Multimodal Feature Audit

> 审查日期 / Audit date: 2025-07  
> 审查范围 / Scope: KinetAios Win (Electron + TypeScript)  
> 涉及文件 / Files: `app.ts`, `AgentLoop.ts`, `glm.ts`, `main.ts`, `TaskManager.ts`, `engines.ts`

---

## ✅ 已完整实现 / Fully Implemented

| 功能 / Feature | 说明 / Description |
|---|---|
| **📷 区域截图 / Region Screenshot** | `btn-capture` → `desktopCapturer`（主进程优先），回退 `getDisplayMedia`（renderer）→ 全屏 overlay 拖拽选区 → Canvas 裁剪 → base64 PNG → 加入 `imageAttachments`。支持 ESC 取消、选区尺寸实时显示、四角高亮标记。 |
| **🖼️ 图片附件上传 / Image Attachment Upload** | 文件选择 / 拖放 `png/jpg/gif/webp/bmp` → `FileReader.readAsDataURL` → base64 data URL → 缩略图 chip 预览 → 10 MB 上限。附件栏支持单击移除。 |
| **👁️ Vision 消息构造（Direct 引擎）/ Vision Message Construction (Direct Engine)** | `AgentLoop.ts` 解析 `\x00IMAGES[...]\x00` 标记 → 转 `ContentPart[]`（`text` + `image_url`），发送给 GLM API。标记注入发生在 `TaskManager.send()` 组装 prompt 时。 |
| **🔄 Anthropic 格式转换 / Anthropic Format Conversion** | `glm.ts` 将 OpenAI 格式的 `image_url` 转为 Anthropic 格式 `{ type: 'image', source: { type: 'base64', media_type, data } }`。同时支持 data URL 和远程 URL 两种来源。 |
| **🗂️ 持久化清理 / Persistence Cleanup** | `dropTransient()` 在存入 `directHistory` 前把 `ContentPart[]` 转回纯文本，避免 base64 膨胀 SQLite 数据库。清理后消息只保留 `text` 部分。 |
| **🎤 语音输入（STT）/ Speech-to-Text** | `MediaRecorder` 录音（优先 `audio/webm`，Safari 回退 `audio/mp4`）→ base64 分块编码 → IPC → main 进程 POST `/audio/transcriptions`（whisper-1 模型）→ 文字填入 composer。支持录音状态视觉反馈（红色脉动）、短录音过滤（<0.3 s 忽略）。 |
| **🔊 语音朗读（TTS）/ Text-to-Speech** | `speechSynthesis` 系统级 TTS，每条 AI 回复挂 🔊 按钮。支持中（zh-CN）/英（en-US）/日（ja-JP）/繁体（zh-TW）语言自动切换。strip markdown 噪声（代码块→"(code)"、链接→纯文本、去除 `#*_>` 符号）。再次点击同一条正在朗读的消息可取消。 |
| **🎯 Visual Inspector** | 文件面板预览网页时圈选 DOM 元素 → 收集 `outerHTML` + `computedStyle` + DOM path → 组装 prompt 给 AI 分析。复用截图 overlay 的全屏遮罩 + crosshair 模式。 |

---

## ⚠️ 限制与约束 / Limitations & Constraints

| 项目 / Item | 现状 / Status | 说明 / Detail |
|---|---|---|
| **仅 Direct 引擎支持图片 / Direct-engine-only vision** | 设计如此 / By design | `\x00IMAGES` 标记只在 `AgentLoop.ts`（Direct 引擎）中解析为 `ContentPart[]`。Claude Code / Codex 是 CLI spawn，图片 base64 会原样传进 text prompt（不报错但模型看不到图片）。 |
| **Claude/Codex 无 vision / No vision for CLI engines** | 架构限制 / Architectural | CLI 引擎通过 `stdin` 传 prompt，不支持 `image_url` content parts。Claude Code 走 `--input-format stream-json` 但当前未传图片。 |
| **图片不持久化 / Images not persisted** | 故意设计 / Intentional | base64 太大不存 SQLite（单张可达 MB 级），`dropTransient` 转回纯文本。重新打开历史会话看不到之前的图片，仅保留文字内容。 |
| **STT 依赖联网 / STT requires internet** | `ponytail` | 需调 OpenAI-compatible `/audio/transcriptions` API。代码注释标记了"后续可换 whisper.cpp 离线"。 |
| **TTS 截断 2000 字 / TTS truncated at 2000 chars** | `ponytail` | `slice(0, 2000)`，长回复只朗读前半段。浏览器 `speechSynthesis` 本身也有长度限制，此截断是预防性的。 |
| **@文件引用不支持图片 / @-file ref is text-only** | 纯文本 / Text only | `resolveAtFiles` 只读文本文件，二进制按扩展名跳过。代码注释：`// 要支持图片得走多模态消息，标 TODO`。 |

---

## 🔗 数据流（图片输入）/ Data Flow (Image Input)

```
用户操作                   Renderer                 IPC/Main               Engine/API
───────────────────────────────────────────────────────────────────────────────────────
截图/拖放/选图片  →  imageAttachments[]     →  text += \x00IMAGES[...]\x00  →  send(text)
                                                                         ↓
                                                               AgentLoop.runAgentLoop()
                                                                         ↓
                                                               解析标记 → ContentPart[]
                                                                         ↓
                                                               glm.ts → Anthropic image source
                                                                         ↓
                                                               POST /messages → GLM Vision API
                                                                         ↓
                                                               持久化前 dropTransient() 清理 base64
```

### 关键代码路径 / Key Code Paths

| 步骤 / Step | 文件 / File | 函数 / Function |
|---|---|---|
| 截图采集 / Screenshot capture | `app.ts` | `captureBtn.onclick` → `pickRegionOverlay()` |
| 图片上传 / Image upload | `app.ts` | `addFiles()` → `fileToDataUrl()` |
| 附件渲染 / Attachment render | `app.ts` | `renderAttach()` |
| 发送时注入标记 / Inject marker on send | `app.ts` | `send()` — `text += \x00IMAGES[...]` |
| 标记解析为 ContentPart[] / Parse marker | `AgentLoop.ts` | `buildMessages()` → `\x00IMAGES\x00` regex |
| Anthropic 格式转换 / Anthropic conversion | `glm.ts` | `streamAnthropic()` — `image_url` → `image.source` |
| 持久化清理 / Persistence cleanup | `AgentLoop.ts` | `dropTransient()` |

---

## 📊 功能矩阵 / Feature Matrix

| 功能 / Feature | Direct | Claude Code | Codex |
|---|:---:|:---:|:---:|
| 图片输入 / Image input | ✅ | ❌ | ❌ |
| Vision API 调用 / Vision API call | ✅ | ❌ | ❌ |
| STT 语音输入 / Speech-to-text | ✅ | ✅ | ✅ |
| TTS 语音朗读 / Text-to-speech | ✅ | ✅ | ✅ |
| 截图工具 / Screenshot tool | ✅ | ✅ | ✅ |
| Visual Inspector | ✅ | ✅ | ✅ |
| 图片持久化 / Image persistence | ❌ | ❌ | ❌ |

> 注：STT/TTS/截图/Inspector 是 renderer 层功能，与引擎无关，三引擎均可用。  
> Note: STT/TTS/Screenshot/Inspector are renderer-layer features, engine-agnostic — available across all three engines.

---

## 🚀 未来改进方向 / Future Improvements

| 优先级 / Priority | 改进 / Improvement | 说明 / Detail |
|---|---|---|
| 🔴 高 / High | Claude Code 图片支持 | Claude `--input-format stream-json` 支持 image content block，可在 spawn 时注入。需研究 CLI 的多模态输入格式。 |
| 🟡 中 / Medium | 图片持久化（可选） | 考虑将 base64 存到单独的 `attachments` 表或文件系统（`userData/images/`），按 turn 关联，按大小/时间清理。 |
| 🟡 中 / Medium | 离线 STT（whisper.cpp） | 替换 API 调用为本地 whisper.cpp，消除联网依赖和延迟。 |
| 🟢 低 / Low | TTS 长文本分段 | 移除 2000 字截断，按段落分段朗读，利用 `speechSynthesis.onend` 链式播放。 |
| 🟢 低 / Low | @文件引用支持图片 | `resolveAtFiles` 检测图片扩展名时自动走 `ContentPart[]` 路径而非跳过。 |
| 🟢 低 / Low | Codex 图片支持 | 需 Codex CLI 支持多模态输入后跟进。 |
