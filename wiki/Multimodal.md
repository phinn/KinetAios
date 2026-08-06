> 🌐 Language: **English** | [中文](Multimodal.zh-CN.md)

# Multimodal (Image + Voice + Screenshot)

Direct engine supports multimodal input: **images**, **voice transcription**, and **region screenshots**.

## Image input

📎 button in the composer (or drag-drop / paste):

- Select one or more images (PNG / JPG / GIF / WebP).
- Large images are sent as-is (no client-side resize — `ponytail:` MVP).
- Images are injected into the prompt as a special marker: `\x00IMAGES[{name, dataUrl}]\x00`.
- The Direct engine's `AgentLoop` parses this marker and converts to **OpenAI `image_url` content parts** (for OpenAI-compatible providers) or **Anthropic base64 `image` blocks** (for Anthropic).
- `dropTransient()` strips base64 data before persisting to `directHistory` — keeps SQLite small.

```
User types: "What's wrong with this UI?"
           + attaches screenshot.png
           ↓
Prompt sent: "What's wrong with this UI?\x00IMAGES[{"name":"screenshot.png","dataUrl":"data:image/png;base64,..."}]\x00"
           ↓
Provider receives: [{type:"text", text:"What's wrong with this UI?"},
                    {type:"image_url", image_url:{url:"data:image/png;base64,..."}}]
```

## Voice input (Whisper transcription)

🎤 button in the composer:

1. Click → starts recording (browser MediaRecorder API).
2. Click again → stops → audio encoded as base64.
3. Sent to **OpenAI Whisper API** (`whisper-1` model) for transcription.
4. Transcribed text fills the composer input.
5. Requires an OpenAI-compatible endpoint (Whisper is OpenAI-only).

> **For realtime voice conversation** (bidirectional, natural TTS, Agent tool execution), see [[Voice-Chat]].

**TTS (Text-to-Speech)**:

- Answers can be read aloud via the system `speechSynthesis` API.
- Auto-detects language (Chinese vs English) from the text.
- Strips markdown before reading (code blocks, links, formatting).
- 2000-character limit per utterance.

## Screenshot

📸 button in the chat area:

1. Click → a full-screen overlay appears (semi-transparent dark layer).
2. Drag to select a rectangular region.
3. Release → the selected region is cropped from the screen capture.
4. Cropped image is injected into the prompt as an image attachment.
5. If selection is < 5px in either dimension, the screenshot is auto-cancelled (treat as a click, not a drag).

The overlay uses mouse events bound to `document` (not the overlay element) to prevent listener leaks and ensure mouseup is captured even outside the overlay.

## Platform notes

- Image multimodal requires a provider that supports vision (GLM-4V, GPT-4o, Claude 3.5, etc.).
- Voice transcription requires `whisper-1` model access on the configured endpoint.
- Screenshots use Electron's desktopCapturer + canvas cropping.
- Claude Code and Codex engines do **not** support in-app multimodal — use their native capabilities instead.

## Key source files

- `src/main/AgentLoop.ts` — `\x00IMAGES[...]\x00` marker parsing → ContentPart[]
- `src/main/glm.ts` — `image_url` (OpenAI) ↔ base64 `image` (Anthropic) conversion; `dropTransient()`
- `src/renderer/app.ts` — `wireVoice()` (recording + Whisper), `wireScreenshot()` (overlay + crop), file attachment handling
