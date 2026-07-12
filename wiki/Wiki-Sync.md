> 🌐 Language: **English** | [中文](Wiki-Sync.zh-CN.md)

# Pushing the wiki to GitHub

The markdown source for this wiki lives in the main repo's `wiki/` directory. GitHub wiki is a **separate git repo** (`*.wiki.git`), not part of the main repo — sync is manual.

## One-time init

GitHub wiki must be initialized via web UI before its `*.wiki.git` exists:

1. Open `https://github.com/phinn/KinetAios/wiki` in a browser
2. Click "Create the first page"
3. Put anything in (`Home` as page name is fine) → Save

After that, `https://github.com/phinn/KinetAios.wiki.git` becomes cloneable.

## Sync steps

```sh
# 1. clone the wiki repo (note the .wiki suffix)
git clone https://github.com/phinn/KinetAios.wiki.git /tmp/kinet-wiki

# 2. copy the main repo's wiki/ contents in
cp wiki/*.md /tmp/kinet-wiki/

# 3. commit + push
cd /tmp/kinet-wiki
git add .
git commit -m "sync wiki from main repo"
git push origin master  # GitHub wiki defaults to master
```

Refresh `https://github.com/phinn/KinetAios/wiki` — all pages appear.

## Ongoing maintenance

Two approaches:

### A. Edit main repo → sync to wiki (recommended)

Keep editing `wiki/` in the main repo; periodically re-run the cp steps. Benefits:

- Wiki content goes through PR review alongside code
- History lives with the code history
- Main repo is source of truth, GitHub wiki is mirror

### B. Edit the wiki repo directly

Skip the main repo, edit the wiki repo in place. Note: the main repo's `wiki/` will then be stale — reverse-sync with `cp /tmp/kinet-wiki/*.md wiki/`.

## Filename conventions

GitHub wiki page URL = filename (minus `.md`). Spaces become `-` in the URL.

This wiki uses **English kebab-case filenames** with bilingual content:

| File | URL |
|---|---|
| `Home.md` | `/wiki/Home` |
| `Direct-Engine.md` | `/wiki/Direct-Engine` |
| `Long-Term-Memory.md` | `/wiki/Long-Term-Memory` |

Chinese filenames work but URL-encode to `%E4%B...` — ugly.

## Bilingual structure

Each page has two files:

- `PageName.md` — English (primary)
- `PageName.zh-CN.md` — Chinese mirror

Both files carry a language header at the top:

```markdown
> 🌐 Language: **English** | [中文](PageName.zh-CN.md)
```

or

```markdown
> 🌐 Language: [English](PageName) | **中文**
```

So readers can flip between them. English-primary because the goal is global reach; Chinese stays as a first-class alternative.

## Sidebar (optional)

GitHub wiki auto-generates the right-side page list alphabetically. For custom ordering / grouping, add `_Sidebar.md` to the wiki repo:

```markdown
- [[Home]]
- [[Getting-Started]]
- **Engines**
  - [[Engines]]
  - [[Direct-Engine]]
- **Tools & Memory**
  - [[Tools-and-MCP]]
  - [[Long-Term-Memory]]
- ...
```

GitHub injects `_Sidebar.md` into every page's right pane.

## Footer (optional)

`_Footer.md` works the same way, injected at page bottom. Typical content: "Last updated …" / "Edit these in the main repo's `wiki/` directory."

## Link syntax

GitHub wiki's `[[Page-Name]]` auto-renders as a link. `Page-Name` matches the filename (minus `.md`).

This wiki uses `[[Direct-Engine]]`-style cross-references heavily. After sync they all become clickable.

## What you can't do

- **GitHub has no wiki API** — can't edit via `gh` CLI directly
- **First creation must be in the web UI** — CLI can't initialize the wiki repo
- **Image attachments**: drag into the wiki editor to upload; GitHub stores them under the wiki repo's `assets/` subdirectory, markdown references by relative path
