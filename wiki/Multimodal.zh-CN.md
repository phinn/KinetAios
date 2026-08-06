> 🌐 Language: [English](Multimodal.md) | **中文**

# 多模态(图片 + 语音 + 截图)

Direct 引擎支持多模态输入:**图片**、**语音转写**和**区域截图**。

## 图片输入

输入框 📎 按钮(或拖放 / 粘贴):

- 选一张或多张图片(PNG / JPG / GIF / WebP)。
- 大图片原样发送(客户端不做缩放 —— `ponytail:` MVP)。
- 图片以特殊标记注入 prompt:`\x00IMAGES[{name, dataUrl}]\x00`。
- Direct 引擎的 `AgentLoop` 解析此标记,转为 **OpenAI `image_url` content parts**(OpenAI 兼容 provider)或 **Anthropic base64 `image` blocks**(Anthropic)。
- `dropTransient()` 在持久化到 `directHistory` 前剥离 base64 数据 —— 保持 SQLite 小体积。

```
用户输入:"这个 UI 有什么问题?"
        + 附加 screenshot.png
           ↓
发送 prompt:"这个 UI 有什么问题?\x00IMAGES[{"name":"screenshot.png","dataUrl":"data:image/png;base64,..."}]\x00"
           ↓
Provider 收到:[{type:"text", text:"这个 UI 有什么问题?"},
               {type:"image_url", image_url:{url:"data:image/png;base64,..."}}]
```

## 语音输入(Whisper 转写)

输入框 🎤 按钮:

1. 点击 → 开始录音(browser MediaRecorder API)。
2. 再点 → 停止 → 音频编码为 base64。
3. 发送到 **OpenAI Whisper API**(`whisper-1` 模型)转写。
4. 转写文本填入输入框。
5. 需要 OpenAI 兼容端点(Whisper 是 OpenAI 专有)。

> **实时语音对话**(双向、自然 TTS、Agent 工具执行)请看 [[Voice-Chat]]。

**TTS(文本转语音)**:

- 回答可通过系统 `speechSynthesis` API 朗读。
- 从文本自动检测语言(中文 vs 英文)。
- 朗读前剥离 markdown(代码块、链接、格式)。
- 每次朗读 2000 字截断。

## 截图

聊天区 📸 按钮:

1. 点击 → 全屏 overlay 出现(半透明深色层)。
2. 拖拽选择矩形区域。
3. 释放 → 选区从屏幕截图中裁剪。
4. 裁剪的图片作为附件注入 prompt。
5. 如果选区任一维度 < 5px,截图自动取消(视为点击而非拖拽)。

overlay 的鼠标事件绑定到 `document`(不是 overlay 元素),防止监听器泄漏并确保 overlay 外的 mouseup 也能捕获。

## 平台说明

- 图片多模态需要支持 vision 的 provider(GLM-4V、GPT-4o、Claude 3.5 等)。
- 语音转写需要在配置的端点上有 `whisper-1` 模型访问权限。
- 截图使用 Electron 的 desktopCapturer + canvas 裁剪。
- Claude Code 和 Codex 引擎**不支持**应用内多模态 —— 用它们各自的原生能力。

## 关键源文件

- `src/main/AgentLoop.ts` —— `\x00IMAGES[...]\x00` 标记解析 → ContentPart[]
- `src/main/glm.ts` —— `image_url`(OpenAI)↔ base64 `image`(Anthropic)转换;`dropTransient()`
- `src/renderer/app.ts` —— `wireVoice()`(录音 + Whisper)、`wireScreenshot()`(overlay + 裁剪)、文件附件处理
