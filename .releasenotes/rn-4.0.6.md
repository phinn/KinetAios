**发布日期:** 2026-11-03(自 v4.0.5 起 9 commits)

> 4.0.6 是「减法与修复」版本:composer 常驻控件 13→11(截图双钮收进「更多工具」菜单)、侧栏可拖拽调宽(200–420px 夹取)、宽屏阅读列 880→1120px。修三处真实 bug:已发消息重启后回填残留、composer 卡片视觉长期缺失(first-child 结构回归)、agent Chrome 打不开本地文件(裸路径被强加 https:// 前缀)。

### ✂️ Composer 减负

- **截图双钮收进「更多工具」菜单**:主工具栏删除 btn-capture/btn-capture-hide,置顶两项进 ⋯ 菜单(复用 vision.capture i18n key,四语);常驻控件 13→11,composer 一行更清爽。
- **回形针图标修复**:btn-attach 的 SVG 换回标准 paperclip 路径。
- **voice/persona/profile 按钮**:维持 js-hidden 按需显示,不再挤占常驻宽度。

### 📐 宽屏与侧栏

- **阅读列 880→1120px**:turn 卡与 composer 卡同步放宽,512px 窗口(main 区 1248px)两侧留白 184→64px,宽屏不再空旷;窄窗口不受影响(max-width 特性)。
- **侧栏拖拽调宽**:#sb-resizer 3px 热区 + pointer capture,200–420px 夹取,localStorage `sb-width` 持久化。
- **code-lang 徽标去 blur**:小字场景 backdrop-filter 只剩性能成本,移除。

### 🐛 三修

- **已发消息重启残留**:send() 只清内存 Map、漏 localStorage `draft:<id>` 草稿,重启后已发文本回填 composer;改 clearComposerDraft 双清(内存 + localStorage),发送/queue/steer 三路径全覆盖。
- **composer 卡片视觉缺失**:卡片样式挂在 `#input > :first-child` 上,而 first-child 实为 hidden 的 queue-row——display:none 不渲染,背景/圆角/阴影一直打在不可见盒上;新增 `#composer-card` 包裹层稳定命中,queue-row 留卡外,slash/at 弹层不受裁剪。
- **agent Chrome 打不开本地文件**:browser_navigate 对裸路径强加 `https://` 前缀,`/Users/...` 被拼成 `https://file///...` 直接连接失败;归一化改三层:file:// 原样、本地绝对路径(macOS/Unix + Windows 盘符)转 file:// 协议、其余裸域名照旧补 https。

### 🧹 其它

- **发送成功后附件 chip 残留**:旧实现只清数组不重画 chip 行,现清空 + 重画。
- **agent Chrome 后台拉起**:macOS `open -n -gj` + no-startup-window,启动/重启不再抢前台焦点。
- **README 家族区**:升级为完整 19 App 目录(旗舰 5 + 其余 14 直链),补 MCP Tools/Config 段。

---

**English**

**Release date:** 2026-11-03 (9 commits since v4.0.5)

> 4.0.6 is a "subtraction & fixes" release: composer persistent controls 13→11 (capture buttons moved into the "More tools" menu), draggable sidebar width (200–420px clamp), and the wide-screen reading column widened 880→1120px. Three real bug fixes: sent messages re-filling the composer after restart, the composer card visual silently missing (a first-child structural regression), and the agent Chrome failing to open local files (bare paths force-prefixed with https://).

### ✂️ Composer slimming

- **Capture buttons moved into the "More tools" menu**: btn-capture / btn-capture-hide removed from the main toolbar and placed at the top of the ⋯ menu (reusing vision.capture i18n keys, 4 languages); persistent controls 13→11 for a cleaner composer row.
- **Paperclip icon fixed**: btn-attach SVG restored to the standard paperclip path.
- **voice / persona / profile buttons**: keep js-hidden on-demand display, no longer crowding the persistent width.

### 📐 Wide screen & sidebar

- **Reading column 880→1120px**: turn cards and the composer card widen together; at a 512px-wide sidebar (main area 1248px) side gutters shrink 184→64px — no more vast emptiness on wide screens. Narrow windows unaffected (max-width semantics).
- **Draggable sidebar width**: #sb-resizer with a 3px hit area + pointer capture, clamped 200–420px, persisted in localStorage `sb-width`.
- **code-lang badge de-blurred**: backdrop-filter on tiny text was pure performance cost; removed.

### 🐛 Three fixes

- **Sent messages re-filling the composer after restart**: send() cleared the in-memory Map but missed the localStorage `draft:<id>` draft, so already-sent text re-appeared after relaunch; clearComposerDraft now clears both (memory + localStorage) across send/queue/steer paths.
- **Composer card visual missing**: card styles were pinned to `#input > :first-child`, which is actually the hidden queue-row — display:none renders nothing, so background/radius/shadow landed on an invisible box. A dedicated `#composer-card` wrapper now carries the card; queue-row stays outside it and slash/at popovers are unaffected.
- **Agent Chrome couldn't open local files**: browser_navigate force-prefixed `https://` onto bare paths, turning `/Users/...` into `https://file///...` which fails instantly. Normalization is now three-tier: file:// passes through, local absolute paths (macOS/Unix + Windows drive letters) convert to the file:// scheme, other bare domains still get https://.

### 🧹 Also

- **Attachment chip residue after send**: old code cleared the array without repainting the chip row; now cleared and repainted.
- **Agent Chrome background launch**: macOS `open -n -gj` + no-startup-window so launching/restarting no longer steals focus.
- **README family section**: upgraded to the full 19-app catalog (5 flagship + 14 direct links) and a new MCP Tools/Config section.

---

**Full Changelog**: https://github.com/phinn/KinetAios/compare/v4.0.5...v4.0.6
