**发布日期：** 2026-09-06(自 v3.5.6 起 2 commits)

### 🐛 Goal Failover 死代码根治
- 出错轮提前 break 导致 429 永不切链 — 修后 failover 真切;错误分类器补中文额度话术 + 429 一律判 quota

---

**English**

- **Goal failover dead code fixed**: an early break on error rounds meant 429s never switched the relay chain; now failover actually engages. Classifier also recognizes Chinese quota phrasing; 429 always classified as quota

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.5.6...v3.5.7
