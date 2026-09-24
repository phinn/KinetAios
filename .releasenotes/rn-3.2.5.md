**发布日期：** 2026-08-21(自 v3.2.4 起 4 commits)

### 🩺 可观测性 & 修复
- **内存哨兵** — 60s 采样 main/各窗口 jsHeap 写 mem-watch.log,爆内存可回溯增长曲线
- userData 目录名固定 KinetAios — 与 brand.json productName 解耦,改名不再换数据目录
- win/mac icon 指向渐变 K — package.json 仍指旧 icon.png,exe 图标一直是老版

---

**English**

- **Memory sentinel**: samples main/window jsHeap every 60s into mem-watch.log so growth curves can be traced after a blowup
- userData directory pinned to KinetAios — decoupled from brand.json productName (renames no longer move the data dir)
- win/mac icons now point at the gradient-K icon (package.json still referenced the old icon.png)

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v3.2.4...v3.2.5
