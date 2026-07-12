> 🌐 Language: [English](Workbench) | **中文**

# Workbench(项目卡片总览)

侧边栏 **📂** 按钮 → Workbench view。

## 是什么

按 cwd 分组的「项目卡片」总览。每个 cwd = 一张卡片。每张卡片显示:

- **cwd 路径**(顶部)
- **最近活动**(最近几轮 turn 的标题 + 时间)
- **累计成本**(美元)
- **累计 token**(in/out)

卡片点一下 → 切到那个 cwd 的最新会话(没会话则新建)。

## 操作

| 按钮 | 作用 |
|---|---|
| 卡片本体(点击) | 切到该 cwd 的最新会话 |
| 「背景」按钮 | 编辑该 cwd 的 `KINET-CONTEXT.md`(详见 [[Rules-and-Context]]) |
| 「新会话」按钮 | 在该 cwd 下开新会话 |

## 数据来源

`api.getConversations()` 拉所有会话 → 按 `conv.cwd` group → 每个 cwd 一组 → 算该 cwd 的总成本/总 token/最近活动。

不存「项目」实体,完全从会话派生。新建一个不同 cwd 的会话 → Workbench 自动多一张卡。

## 用法

- **多项目并行**:在 Workbench 看每个项目的累计成本,看哪个最近没动
- **快速切项目**:不用回 sidebar 找会话,直接点卡片
- **项目级背景**:点「背景」写 `KINET-CONTEXT.md`,所有该 cwd 的会话都注入

## 和 sidebar 的区别

| | sidebar 会话列表 | Workbench |
|---|---|---|
| 单位 | 单个会话 | cwd(可能含多个会话) |
| 默认排序 | 时间倒序 | cwd 字母序 |
| 操作 | 切会话 / 删除 / 重命名 | 切 cwd + 编辑背景 |
| 视图 | 平铺 / 按项目分组(`sb-mode-toggle`) | 永远按 cwd |

sidebar 的「按项目分组」模式(`▤` 按钮)是 Workbench 的轻量版,只在 sidebar 里展示分组。

## 关键源文件

- `src/renderer/app.ts` —— Workbench view 渲染(搜 `workbench`)
- `src/main/main.ts` —— `read-context` / `write-context` IPC(`KINET-CONTEXT.md` 读写)
