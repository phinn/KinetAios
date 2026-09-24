**发布日期：** 2026-08-26(自 v3.3.0 起 8 commits)

### 🦙 Ollama 并发根治
- **同模型请求串行化** — 多频道并发触发 Ollama 重复加载 runner 挤爆 VRAM
- **并发闸升级为可配信号量** — 对齐服务端 OLLAMA_NUM_PARALLEL;num_ctx 可配并联动提示;信号量 detach 闭包 TS2349 修复

### 🐛 修复
- MD 编辑器选中态视觉错位(::selection 显式覆盖全局规则)
- CI:Release body 从 RELEASE_NOTES.md 抽取 tag 段落(发版 note 自动化首次尝试)

---

**English**

- **Ollama concurrency fixed**: same-model requests serialize (parallel channels were reloading runners and blowing VRAM); the gate became a configurable semaphore aligned with OLLAMA_NUM_PARALLEL; num_ctx configurable with linked hints; TS2349 semaphore detach fix
- Markdown editor selection styling fixed (::selection override)
- CI: release body now extracts the tag section from RELEASE_NOTES.md (first automation attempt)

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.3.0...v3.3.1
