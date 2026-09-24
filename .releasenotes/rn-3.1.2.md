**发布日期：** 2026-08-18(自 v3.1.1 起 5 commits)

### 🐛 滚动六连修
- 贴底目标偏小到不了底(clampedBottom 改量末元素真实底边)/流式上下抖动(三贴底点统一)/滚动条乱跳(程序滚动绕过 onScroll 状态机)/回答后大片空白(钳制到真实末尾)/切频道 idle 历史补全顶飞视口/发送后停在旧 scrollHeight(恢复 content-visibility 后二次贴底)
- 切频道总是跳到最新消息底部(移除滚动位置记忆)
- CI:Pages paths 过滤器补 xml/txt(修 sitemap push 不触发部署)

---

**English**

- Six scroll fixes: bottom target measured from the real last element edge; three snap points unified on clampedBottom; programmatic scrolling bypasses the onScroll state machine; blank space after answers clamped away; idle history backfill no longer yanks the viewport; second snap after content-visibility restore
- Switching channels always jumps to the latest message (scroll memory removed)
- CI: Pages path filter extended to xml/txt (sitemap pushes now deploy)

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.1.1...v3.1.2
