# Multimodal Feature Audit

> Audit date: 2025-07  
> Scope: KinetAios Win (Electron + TypeScript)  
> Key files: `app.ts`, `AgentLoop.ts`, `glm.ts`, `main.ts`, `TaskManager.ts`, `engines.ts`

---

## ✅ Fully Implemented

| Feature | Description |
|---|---|
| **📷 Region Screenshot** | `btn-capture` → `desktopCapturer` (main process, preferred) with `getDisplayMedia` (renderer) fallback → fullscreen overlay with drag-to-select → Canvas crop → base64 PNG → added to `imageAttachments`. Supports ESC cancel, real-time selection size display, and corner highlighting. |
| **🖼️ Image Attachment Upload** | File picker / drag-drop for `png/jpg/gif/webp/bmp` → `FileReader.readAsDataURL` → base64 data URL → thumbnail chip preview → 10 MB limit. Attachments can be removed individually. |
| **👁️ Vision Message Construction (Direct Engine)** | `AgentLoop.ts` parses `\x00IMAGES[...]\x00` marker → converts to `ContentPart[]` (`text` + `image_url`) → sent to GLM API. Marker injection occurs in `TaskManager.send()` during prompt assembly. |
| **🔄 Anthropic Format Conversion** | `glm.ts` converts OpenAI-format `image_url` to Anthropic format `{ type: 'image', source: { type: 'base64', media_type, data } }`. Supports both data URLs and remote URLs as sources. |
| **🗂️ Persistence Cleanup** | `dropTransient()` converts `ContentPart[]` back to plain text before storing in `directHistory`, preventing base64 from bloating the SQLite database. Only the `text` portion survives cleanup. |
| **🎤 Speech-to-Text (STT)** | `MediaRecorder` recording (prefers `audio/webm`, falls back to `audio/mp4` on Safari) → chunked base64 encoding → IPC → main process POST `/audio/transcriptions` (whisper-1 model) → transcribed text inserted into composer. Includes recording state visual feedback (red pulse) and short-recording filter (<0.3 s ignored). |
| **🔊 Text-to-Speech (TTS)** | `speechSynthesis` system-level TTS with a 🔊 button on every AI reply. Auto-switches between Chinese (zh-CN) / English (en-US) / Japanese (ja-JP) / Traditional Chinese (zh-TW). Strips markdown noise (code blocks → "(code)", links → plain text, removes `#*_>` symbols). Clicking the same message again cancels playback. |
| **🎯 Visual Inspector** | DOM element selection when previewing web pages in the files panel → collects `outerHTML` + `computedStyle` + DOM path → assembles prompt for AI analysis. Reuses the screenshot overlay's fullscreen mask + crosshair pattern. |

---

## ⚠️ Limitations & Constraints

| Item | Status | Detail |
|---|---|---|
| **Direct-engine-only vision** | By design | The `\x00IMAGES` marker is only parsed in `AgentLoop.ts` (Direct engine). Claude Code / Codex are CLI spawns — the base64 image data is passed as-is into the text prompt (no error, but the model cannot see the image). |
| **No vision for CLI engines** | Architectural | CLI engines pass prompts via `stdin`, which does not support `image_url` content parts. Claude Code uses `--input-format stream-json` but currently does not transmit image blocks. |
| **Images not persisted** | Intentional | Base64 is too large for SQLite (a single image can be MB-scale). `dropTransient` converts back to plain text. Reopening a historical session will not show previously sent images — only text content survives. |
| **STT requires internet** | `ponytail` | Calls OpenAI-compatible `/audio/transcriptions` API. Code comment marks future path: "could switch to whisper.cpp for offline use." |
| **TTS truncated at 2000 chars** | `ponytail` | `slice(0, 2000)` — only the first half of long replies is read aloud. Browser `speechSynthesis` itself has length limits; this truncation is preventive. |
| **@-file reference is text-only** | Text only | `resolveAtFiles` reads only text files; binary files are skipped by extension. Code comment: `// Supporting images would require multimodal messages — marked TODO`. |

---

## 🔗 Data Flow (Image Input)

```
User Action              Renderer                IPC/Main               Engine/API
──────────────────────────────────────────────────────────────────────────────────────
Screenshot/Drag/Pick  →  imageAttachments[]   →  text += \x00IMAGES[...]  →  send(text)
                                                                       ↓
                                                             AgentLoop.runAgentLoop()
                                                                       ↓
                                                             Parse marker → ContentPart[]
                                                                       ↓
                                                             glm.ts → Anthropic image source
                                                                       ↓
                                                             POST /messages → GLM Vision API
                                                                       ↓
                                                             dropTransient() cleans base64 before persist
```

### Key Code Paths

| Step | File | Function |
|---|---|---|
| Screenshot capture | `app.ts` | `captureBtn.onclick` → `pickRegionOverlay()` |
| Image upload | `app.ts` | `addFiles()` → `fileToDataUrl()` |
| Attachment render | `app.ts` | `renderAttach()` |
| Inject marker on send | `app.ts` | `send()` — `text += \x00IMAGES[...]` |
| Parse marker to ContentPart[] | `AgentLoop.ts` | `buildMessages()` → `\x00IMAGES\x00` regex |
| Anthropic format conversion | `glm.ts` | `streamAnthropic()` — `image_url` → `image.source` |
| Persistence cleanup | `AgentLoop.ts` | `dropTransient()` |

---

## 📊 Feature Matrix

| Feature | Direct | Claude Code | Codex |
|---|:---:|:---:|:---:|
| Image input | ✅ | ❌ | ❌ |
| Vision API call | ✅ | ❌ | ❌ |
| Speech-to-text (STT) | ✅ | ✅ | ✅ |
| Text-to-speech (TTS) | ✅ | ✅ | ✅ |
| Screenshot tool | ✅ | ✅ | ✅ |
| Visual Inspector | ✅ | ✅ | ✅ |
| Image persistence | ❌ | ❌ | ❌ |

> Note: STT/TTS/Screenshot/Inspector are renderer-layer features, engine-agnostic — available across all three engines.

---

## 🚀 Future Improvements

| Priority | Improvement | Detail |
|---|---|---|
| 🔴 High | Claude Code image support | Claude `--input-format stream-json` supports image content blocks — could inject at spawn time. Requires research into the CLI's multimodal input format. |
| 🟡 Medium | Optional image persistence | Store base64 in a separate `attachments` table or filesystem (`userData/images/`), linked by turn, with size/time-based cleanup. |
| 🟡 Medium | Offline STT (whisper.cpp) | Replace API call with local whisper.cpp to eliminate network dependency and latency. |
| 🟢 Low | TTS long-text segmentation | Remove the 2000-char truncation; split by paragraphs and chain-play using `speechSynthesis.onend`. |
| 🟢 Low | @-file reference for images | `resolveAtFiles` detects image extensions and routes through `ContentPart[]` instead of skipping. |
| 🟢 Low | Codex image support | Pending Codex CLI multimodal input support. |
