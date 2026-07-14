# Town View 游戏风格小镇视图 — 设计方案

> **版本**: v1.0 · **状态**: 待评审  
> **作者**: KinetAios Team  
> **日期**: 2025-01

---

## 一、核心理念

把"多项目多 Agent 并发工作"这个抽象概念，变成一个**等距像素风小镇**（isometric pixel town）。

- **一个项目 = 一栋房子**（按 cwd 分组，对应 Workbench 的项目卡片）
- **一个 Agent（会话）= 一个村民**（每个 Conversation 是住在项目房子里的一个人）
- **跟村民说话 = 发消息**（点击村民弹出对话框，输入即发送 prompt）
- **村民工作状态 = 动画表现**（idle 站立、running 搬箱子/敲键盘、error 冒烟、done 亮星星）
- **点村民 = 查看详情**（展开该 Agent 正在做什么——token 流、工具调用、步骤）

**不是替代现有 Chat 视图，而是 Workbench 的游戏化变体**——同样的数据，两种看法。

---

## 二、视觉设计

### 2.1 等距视角（Isometric）

```
        🏠
       /  \
      / 🧑 \
     /______\
```

伪 2.5D 等距投影，用 CSS `transform: rotateX(55deg) rotateZ(45deg)` 或纯 CSS/SVG 绘制。
不引入游戏引擎（phaser/pixijs），**零依赖**，纯 CSS + SVG + DOM。

### 2.2 场景层次（从下到上）

| 层 | 内容 | 实现 |
|---|---|---|
| **天空层** | 渐变背景（跟主题联动：dark=星空、light=蓝天、aurora=极光、serene=暖霞） | CSS `background: radial-gradient(...)` |
| **地面层** | 草地/石板地，等距网格 | CSS background-image 重复 isometric tile |
| **建筑层** | 房子（项目），按 cwd 分组排列 | DOM div，绝对定位 |
| **村民层** | 小人（Agent），站在房子门口或房子内 | DOM div，绝对定位 + CSS 动画 |
| **天气/特效层** | 雪/落叶/萤火虫粒子（可选，未来） | CSS animation 粒子 |

### 2.3 房子设计（项目）

每个项目一栋等距小屋，包含：

```
      ╱─────╲
     ╱  📁   ╲      ← 屋顶（项目名 + 状态指示）
    ╱─────────╲
   │  ╭─────╮ │     ← 楼层（每层住一个 Agent）
   │  │🧑 💤 │ │
   │  ╰─────╯ │
   │  ╭─────╮ │
   │  │🧑 ⚡ │ │     ← running 的 Agent 楼层有灯光
   │  ╰─────╯ │
   └───────────┘
```

- **屋顶**: 项目名（`projName(cwd)`），鼠标悬停显示完整路径
- **窗户/楼层**: 每个 Agent 一格窗户。running 的窗户亮灯（暖黄 glow），idle 的暗
- **烟囱**: 有 Agent 在工作就冒烟（CSS 动画）
- **花园**: 房子前一小块地，放统计信息（任务数、总 token、总 cost）作为路牌
- **配色**: 房子主色调按项目名 hash 生成，确保视觉区分

### 2.4 村民设计（Agent/会话）

每个 Agent 是一个等距小人（30×40px），用 CSS/SVG 绘制：

```
    ●          ← 头（颜色 = 引擎色）
   ╱╲          ← 身体
  ╱  ╲
  ╱╲          ← 脚
```

| 引擎 | 头部颜色 | 特征 |
|---|---|---|
| Direct (Kaios) | `#e8b339` 金色 | 基础小人 |
| Claude Code | `#d97757` 橙色 | 戴小帽子 |
| Codex | `#10a37f` 绿色 | 戴眼镜 |

#### 村民状态动画

| ConvStatus | 视觉 | CSS 动画 |
|---|---|---|
| `ready`（idle） | 站立，偶尔眨眼 | `idle-bob`（缓慢上下浮动 2s） |
| `running` | 搬箱子/敲键盘动作，头顶有 `...` 气泡 | `working-bounce`（快速 0.5s 弹跳） |
| `error`（turn.error） | 冒黑烟，头顶 ⚠ | `shake`（左右抖动 0.3s） |
| `done`（刚完成） | 头顶星星 ✨，2 秒后消失 | `star-pop`（放大消失） |

> **注意**: 状态映射到现有 `ConvStatus` + `Turn.error` + `Turn.done`，不新增数据模型。

### 2.5 交互设计

#### 点击村民（Agent）

弹出**侧滑面板**（不离开小镇视图），显示该 Agent 的工作详情：

```
┌──────────────────────────────┐
│  🧑 Kaios · src/kinet        │  ← 村民名 + cwd
│  Status: working...          │
│  ────────────────────────    │
│  📝 "fix the login bug"      │  ← 当前 prompt
│  ────────────────────────    │
│  🔧 shell: npm test          │  ← 工具调用步骤
│     → 3 passed               │
│  🔧 read_file: auth.ts       │
│     → 234 lines              │
│  ────────────────────────    │
│  💬 output streaming...      │  ← token 流（折叠版）
│  ────────────────────────    │
│  [💬 对他说] [⏹ 停止] [📊]  │  ← 操作按钮
└──────────────────────────────┘
```

- **💬 对他说**: 展开输入框，输入即 `api.send(id, text)`
- **⏹ 停止**: `api.cancel(id)`
- **📊 详情**: 跳转到完整 Chat 视图（`selectedId = id; showChat()`）

#### 点击房子（项目）

- 已有会话: 选中第一个 Agent → 高亮该房子的所有村民
- 无会话: 弹出新建任务框（`newTaskInProject(cwd)`）

#### 点击空白处

- 取消选中/关闭侧滑面板

#### 右键村民

- 上下文菜单: 重命名 / 分支 / 导出 / 删除

#### 拖拽（未来扩展）

- 拖村民到另一栋房子 = 移动会话到另一个项目（改 cwd）

---

## 三、技术架构

### 3.1 新增文件

```
src/renderer/
├── town.ts          ← 小镇视图逻辑（渲染 + 交互 + 动画循环）
├── town-actors.ts   ← 村民/房子的 SVG 生成器（纯函数，返回 SVG 字符串）
└── town.css         ← 小镇专属样式（叠在 styles.css 上）
```

**不新增到 `src/shared/types.ts`**——小镇视图是纯 renderer 端的可视化层，
数据全部来自现有的 `Conversation` + `onConversation` 事件流。

### 3.2 视图集成

在 `index.html` 中新增一个 view：

```html
<div id="town-view" class="view">
  <div id="town-canvas"><!-- 等距小镇画布 --></div>
  <div id="town-panel"><!-- 侧滑面板（默认隐藏）--></div>
</div>
```

在 `app.ts` 中：

```typescript
// currentView 联合类型加 'town'
let currentView: '...' | 'town' = 'chat';

// hideAllViews 列表加 'town-view'
// 新增 showTown() 函数（模式同 showWorkbench）
```

### 3.3 入口按钮

在侧边栏 **更多菜单** 中加入「Town 小镇」项（低频功能，收纳到 ⋯ 菜单）：

```html
<button id="m-town">
  <span class="m-icon"><!-- 小镇 SVG icon --></span>
  <span>小镇</span>
</button>
```

或**在 Workbench 视图右上角加一个切换按钮**（Grid ↔ Town 两种看法），更符合"同一数据的两种视图"定位。

### 3.4 数据流（完全复用现有）

```
TaskManager (main)
    │
    │ onConversation(conv)  ← 已有的事件流
    ▼
app.ts 全局监听
    │
    ├─ currentView === 'town' → renderTown() / refreshTownActor(conv)
    ├─ currentView === 'workbench' → renderWorkbench() / refreshWbCard()
    └─ currentView === 'chat' → renderTurns()
```

小镇视图的渲染逻辑与 Workbench **完全平行**：
- `renderTown()` = 全量渲染（首次进入、会话增删）
- `refreshTownActor(conv)` = 增量更新单个村民状态（cost/done/error 事件）
- 数据源相同：`convs: Map<string, Conversation>` + `order: string[]`

### 3.5 渲染策略

```
renderTown():
  1. 按 cwd 分组（同 Workbench）
  2. 每组生成一栋房子 DOM（定位：网格排列）
  3. 房子内为每个会话生成一个村民 DOM
  4. 绑定点击事件
  5. 启动 requestAnimationFrame 动画循环（仅当 view 可见时）

refreshTownActor(conv):
  1. 找到对应的村民 DOM（data-conv-id）
  2. 根据 conv.status / conv.turns 最后一条的状态
  3. 切换 CSS class（idle / working / error / done）
```

### 3.6 动画性能

- 用 `requestAnimationFrame` + `IntersectionObserver` 控制动画
- 视图不可见时暂停所有动画（`currentView !== 'town'`）
- 村民数量上限：超过 20 个时自动切回列表布局（`town-list` 模式）
- CSS 动画用 `transform` + `opacity`（GPU 合成，不触发 layout）

---

## 四、核心数据映射

### 4.1 项目 → 房子

| 房子属性 | 数据来源 | 备注 |
|---|---|---|
| 位置 (x, y) | 按项目索引计算等距网格坐标 | `x = i % cols`, `y = floor(i / cols)` |
| 屋顶名 | `projName(cwd)` | 同 Workbench |
| 房子颜色 | `hashHue(cwd)` → HSL | 按项目名 hash 生成色相 |
| 窗户数 | 该项目下会话数 | `ids.length` |
| 亮灯窗户 | `conv.status === 'running'` | |
| 烟囱冒烟 | 项目内有任何 running 会话 | |
| 路牌统计 | 聚合 tokens/cost/tasks | 同 Workbench 的 `projCard` |
| 最近活动 | 最大 `turns[].ts` | 同 Workbench |

### 4.2 会话 → 村民

| 村民属性 | 数据来源 | 备注 |
|---|---|---|
| 位置 | 所在房子的楼层坐标 | 按楼层排列 |
| 头部颜色 | `ENGINE_COLORS[conv.engine]` | 金/橙/绿 |
| 名字 | `conv.customTitle \|\| conv.turns[0]?.prompt?.slice(0,20) \|\| '...'` | |
| 状态动画 | `conv.status` + 最后一个 turn 的 `error`/`done` | |
| 工作气泡 | `conv.statusNote` | status 事件的 text |
| 当前 prompt | `conv.turns[last]?.prompt` | 侧滑面板显示 |
| 工具步骤 | `conv.turns[last]?.steps` | 侧滑面板显示 |
| token 流 | `conv.turns[last]?.answer` | 侧滑面板显示（折叠） |

---

## 五、交互流程

### 5.1 用户故事

```
用户打开小镇视图
  → 看到等距小镇，每栋房子是一个项目
  → 房子里的小人在活动（running 的在弹跳，idle 的在打瞌睡）

用户点击一个小人
  → 侧滑面板展开，显示该 Agent 的实时工作状态
  → 看到 "正在执行 shell: npm test..."
  → 看到 token 在流式输出

用户在侧滑面板输入 "顺便修一下 lint"
  → 点击发送 → api.send(id, text)
  → 小人立即进入 working 状态（弹跳动画 + 头顶气泡 "..."）

用户点击另一栋空房子
  → 弹出新建任务框 → 输入 prompt → 新建会话
  → 新小人出现在房子门口，开始工作

用户切回 Chat 视图
  → 一切照常，小镇只是另一种看法
```

### 5.2 与现有功能的关系

| 现有功能 | 小镇中的对应 |
|---|---|
| Workbench 项目卡片 | 房子 |
| 侧栏会话列表 | 房子里的村民 |
| Chat 视图 | 点村民 → 「详情」跳转过去 |
| `newTaskInProject()` | 点空房子 / 房子上的「＋」 |
| `openProject()` | 点房子高亮所有村民 |
| `api.send()` | 侧滑面板输入框 |
| `api.cancel()` | 侧滑面板「停止」按钮 |
| Pipeline | 未来: 多个村民排队过桥去做事 |
| Arena | 未来: 两个小人站在竞技场里 PK |

---

## 六、视觉细节规格

### 6.1 房子尺寸

```
房子外框:  120×100 px (等距投影后)
楼层高度:  28 px / 层
最大楼层:  5 层（超过 5 个 Agent 滚动显示）
屋顶高度:  40 px
```

### 6.2 村民尺寸

```
小人整体:  24×32 px
头部:      10×10 px
身体:      14×16 px
脚:        8×6 px
```

### 6.3 小镇布局

```
画布大小:  100% × 100% (填满 main 区域)
网格:      3 列 × N 行（按项目数自适应）
间距:      房子间 180px 水平 / 140px 垂直
滚动:      超出时双向滚动（拖拽平移）
```

### 6.4 配色（跟主题联动）

| 主题 | 天空 | 地面 | 房子灯光 |
|---|---|---|---|
| Dark | `#0d0e14` 深空 | `#1a1a2e` 暗石板 | `#e8b339` 金黄 |
| Light | `#87ceeb` 天蓝 | `#7ec850` 草绿 | `#ff9d3a` 暖橙 |
| Aurora | `#0d0e14` + 极光渐变 | `#161824` | `#c4a7ff` 紫光 |
| Serene | `#f5f1ec` 暖霞 | `#e8e0d4` 暖石板 | `#b76e79` 玫瑰金 |

### 6.5 等距投影 CSS

```css
.town-tile {
  transform: rotateX(60deg) rotateZ(-45deg);
  transform-style: preserve-3d;
}
/* 或用 SVG path 直接画等距图形，不用 3D transform（兼容性更好） */
```

> **推荐方案**: 用 SVG 画等距房子和小人，不用 CSS 3D transform。SVG 更可控、性能更好、可以做像素风。

---

## 七、实现计划

### Phase 1 — 静态小镇（MVP）

> 目标: 能看到房子和村民，点击有反应

- [ ] `town.ts`: `renderTown()` 全量渲染
- [ ] `town-actors.ts`: SVG 生成器（房子 + 三种小人）
- [ ] `town.css`: 等距布局 + 基础动画（idle bob / working bounce）
- [ ] `index.html`: 新增 `#town-view`
- [ ] `app.ts`: `showTown()` + `currentView` 扩展 + 事件路由
- [ ] 入口: Workbench 视图右上角加 Grid/Town 切换按钮
- [ ] 点击村民 → 侧滑面板（显示状态 + prompt + steps）
- [ ] 点击房子 → 高亮村民 / 新建任务

### Phase 2 — 实时动画

> 目标: Agent 工作时村民有视觉反馈

- [ ] `refreshTownActor(conv)`: 增量更新村民状态
- [ ] 状态动画: working 弹跳 / error 抖动 / done 星星
- [ ] 房子窗户灯光实时联动
- [ ] 烟囱冒烟（有 running Agent 时）
- [ ] 侧滑面板实时 token 流（折叠版）

### Phase 3 — 对话交互

> 目标: 可以直接在小镇里和 Agent 对话

- [ ] 侧滑面板输入框 → `api.send()`
- [ ] 停止按钮 → `api.cancel()`
- [ ] 右键上下文菜单（重命名/分支/导出/删除）
- [ ] 新建项目（空地放新房子）

### Phase 4 — 打磨与扩展（可选）

- [ ] 拖拽村民换房子（改 cwd）
- [ ] 主题联动天空/地面配色
- [ ] 天气粒子（雪/萤火虫）
- [ ] 音效（可选，点击/完成音效）
- [ ] 村民超 20 个时自动列表布局
- [ ] Pipeline 可视化（村民排队过桥）
- [ ] Arena 可视化（竞技场 PK）

---

## 八、技术约束与决策

### 8.1 零依赖

- 不引入 phaser / pixijs / three.js / canvas 游戏库
- 纯 SVG + CSS + DOM
- 与项目现有技术栈一致（vanilla TS，esbuild 打包）

### 8.2 数据只读

- 小镇视图**不引入新数据模型**
- 所有数据来自 `Conversation` + `onConversation` 事件
- 操作通过现有 `KinetAPI` 方法（send/cancel/newConversation/deleteConversation）

### 8.3 性能边界

- 动画仅在 `currentView === 'town'` 时运行
- `requestAnimationFrame` 循环可暂停
- 村民 > 20 个时降级为列表
- SVG 比 Canvas DOM 更适合这个规模（< 50 个元素）

### 8.4 可访问性

- 每个房子/村民有 `aria-label`（项目名 / Agent 名 + 状态）
- 键盘 Tab 可聚焦，Enter 展开侧滑面板
- Town 视图不是唯一入口，Workbench Grid 永远可用

### 8.5 国际化

- 所有 UI 文本走 i18n（`tr('town.xxx')`）
- 四语言: zh-CN / en / zh-TW / ja
- 村民状态描述也走 i18n

---

## 九、风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| SVG 等距绘制复杂度高 | 开发慢 | Phase 1 先用简单俯视图，Phase 2 再改等距 |
| 动画影响主线程性能 | 卡顿 | 仅 transform/opacity 动画 + view 不可见时暂停 |
| 村民太多视觉混乱 | 体验差 | > 20 降级列表 + 房子分层显示 |
| 主题联动配色工作量大 | 维护成本 | 只改 CSS 变量，不重写 SVG |
| 与 Workbench 功能重叠 | 用户困惑 | 明确定位: Workbench = 管理，Town = 观察/沉浸 |

---

## 十、i18n 词条规划

```
town.title       = 小镇 / Town / 小鎮 / タウン
town.sub         = 你的项目住在这座小镇里 / Your projects live in this town
town.empty       = 还没有房子。新建一个项目开始吧！/ No houses yet...
town.newProject  = 新建项目 / New Project
town.agentIdle   = 闲置 / Idle
town.agentWorking= 工作中 / Working
town.agentError  = 出错了 / Error
town.agentDone   = 完成 / Done
town.sayToAgent  = 对他说... / Say to agent...
town.stop        = 停止 / Stop
town.detail      = 详情 / Details
town.tasks       = {n} 个任务 / {n} tasks
town.lastActive  = 最近活动: {when} / Last active: {when}
town.noActivity  = 无活动 / No activity
```

---

## 附录 A: 等距坐标换算

```typescript
// 网格坐标 → 屏幕坐标（等距投影）
function isoX(gx: number, gy: number): number {
  return (gx - gy) * 60;  // 60 = tile 半宽
}
function isoY(gx: number, gy: number): number {
  return (gx + gy) * 30;  // 30 = tile 半高
}
```

## 附录 B: 项目名 hash → 色相

```typescript
function hashHue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}
// 房子主色: `hsl(${hashHue(cwd)}, 45%, 55%)`
```

## 附录 C: 引擎配色

```typescript
const ENGINE_COLORS: Record<EngineKind, string> = {
  direct:    '#e8b339',  // 金
  claudeCode:'#d97757',  // 橙
  codex:     '#10a37f',  // 绿
};
```
