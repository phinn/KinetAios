> 🌐 Language: [English](Wiki-Sync) | **中文**

# 把 wiki 推到 GitHub

本 wiki 的 markdown 源在主 repo 的 `wiki/` 目录里。GitHub wiki 是**独立 git 仓库**(`*.wiki.git`),不在主 repo 里 —— 必须手动同步。

## 一次性初始化

GitHub wiki 必须先在 web UI 创建首页,才会开 `*.wiki.git` 仓库:

1. 浏览器打开 `https://github.com/phinn/KinetAios/wiki`
2. 点 「Create the first page」
3. 随便填点内容(`Home` 作为页面名就行)→ Save

完成后 `https://github.com/phinn/KinetAios.wiki.git` 才能 clone。

## 同步步骤

```sh
# 1. clone wiki 仓库(注意 .wiki 后缀)
git clone https://github.com/phinn/KinetAios.wiki.git /tmp/kinet-wiki

# 2. 把主 repo 的 wiki/ 内容复制进去
cp wiki/*.md /tmp/kinet-wiki/

# 3. commit + push
cd /tmp/kinet-wiki
git add .
git commit -m "sync wiki from main repo"
git push origin master  # GitHub wiki 默认 master 分支
```

完成后刷新 `https://github.com/phinn/KinetAios/wiki`,所有页面就出现了。

## 后续维护

两种做法:

### A. 主 repo 改 → 同步到 wiki(推荐)

继续在主 repo 的 `wiki/` 改,定期同步过去(重复上面 cp 步骤)。好处:

- wiki 内容跟着代码一起 PR review
- 历史和代码 history 在一起
- 主 repo 是真理源,wiki 是 mirror

### B. 直接在 wiki 仓库改

跳过主 repo,直接编辑 wiki 仓库。注意:之后主 repo 的 `wiki/` 会过时,要反向同步(`cp /tmp/kinet-wiki/*.md wiki/`)。

## 文件名约定

GitHub wiki 的页面 URL = 文件名(去掉 .md)。空格在 URL 里转 `-`。

本 wiki 用 **英文 kebab-case** 文件名,内容中文:

| 文件 | URL |
|---|---|
| `Home.md` | `/wiki/Home` |
| `Direct-Engine.md` | `/wiki/Direct-Engine` |
| `Long-Term-Memory.md` | `/wiki/Long-Term-Memory` |

中文文件名也能用,但 URL 会编码成 `%E4%B...` 难看。

## 侧边栏(可选)

GitHub wiki 右侧自动生成页面列表,顺序按字母。想要自定义顺序 / 分组 → 在 wiki 仓库加 `_Sidebar.md`:

```markdown
- [[Home]]
- [[Getting-Started]]
- **引擎**
  - [[Engines]]
  - [[Direct-Engine]]
- **工具与记忆**
  - [[Tools-and-MCP]]
  - [[Long-Term-Memory]]
- ...
```

GitHub wiki 自动把 `_Sidebar.md` 注入每页右侧。

## Footer(可选)

`_Footer.md` 同理,注入每页底部。一般放「最后更新于 ...」「编辑请看主 repo 的 wiki/ 目录」之类。

## 链接语法

GitHub wiki 的 `[[Page-Name]]` 自动渲染成链接。`Page-Name` 对应文件名(去 `.md`)。

本 wiki 大量使用 `[[Direct-Engine]]` 这种内部跳转。同步到 GitHub 后自动可点。

## 不能做什么

- **GitHub 没有 wiki API** —— 不能用 gh CLI 直接改
- **首次创建必须在 web UI** —— CLI 不能初始化 wiki 仓库
- **图片附件**:可以拖到 wiki 编辑器里上传,GitHub 自动存到 wiki 仓库的 `assets/` 子目录;markdown 里写相对路径
