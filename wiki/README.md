# Wiki Sources

Markdown source for the KinetAios GitHub wiki. PR-reviewed with the code, periodically synced to `https://github.com/phinn/KinetAios/wiki`.

## Bilingual structure

Each page exists in two files:

- `PageName.md` — **English (primary)**
- `PageName.zh-CN.md` — Chinese mirror

Both files carry a language switcher at the top. See [[Wiki-Sync]] for the rationale.

## Pages

| File | Topic |
|---|---|
| `Home` | Wiki landing / feature matrix / entry points |
| `Getting-Started` | First launch → first task |
| `Architecture` | Three-layer structure / shared/types.ts / KinetAPI contract |
| `Engines` | Three-engine comparison + when to use which |
| `Direct-Engine` | ReAct loop / memory injection / context management |
| `Tools-and-MCP` | Built-in tools + MCP integration |
| `Long-Term-Memory` | Extraction / injection / 🧠 panel / import-export |
| `Skills` | skill / command / agent scanning + `/` invocation |
| `Files-and-Preview` | Files window + webview + editor |
| `Git-Integration` | changes / history / per-file diff / commit show |
| `Rules-and-Context` | AGENTS / CLAUDE / KINET / KINET-CONTEXT |
| `Workbench` | Project card overview |
| `Settings` | Five setting sections |
| `Global-Hotkey` | Global hotkey + quick panel + tray |
| `i18n` | Four-language switching |
| `Development` | typecheck / build / pack / dist / CI |
| `Wiki-Sync` | How to push these to GitHub wiki |

## Push to GitHub wiki

See `Wiki-Sync.md`. Short version:

```sh
# One-time: browser to /phinn/KinetAios/wiki, create the first page to init the wiki repo
git clone https://github.com/phinn/KinetAios.wiki.git /tmp/kinet-wiki
cp wiki/*.md /tmp/kinet-wiki/   # includes this README.md — safe to skip on subsequent syncs
cd /tmp/kinet-wiki && git add . && git commit -m "sync wiki" && git push
```

## Editing

- Main repo's `wiki/` is the source of truth; GitHub wiki is the mirror
- Internal links use `[[Page-Name]]` (`Page-Name` = filename minus `.md`)
- Code references: `src/path/file.ts:line`
- English-primary; code identifiers / CLI flags / filenames stay English in both language versions
