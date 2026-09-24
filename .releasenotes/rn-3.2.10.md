**发布日期：** 2026-08-25(自 v3.2.9 起 1 commit)

### 🔧 CI

- **CSC_NAME 去掉证书类型前缀** — electron-builder 要求 CSC_NAME 只含证书通用名,"Developer ID Application: xxx" 带类型前缀导致 macOS 签名找不到证书

---

**English**

- **CSC_NAME stripped of cert-type prefix** — electron-builder expects the bare common name; "Developer ID Application: …" kept macOS signing from finding the certificate

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.2.9...v3.2.10
