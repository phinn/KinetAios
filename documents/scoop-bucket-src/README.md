# phinn's Scoop Bucket

Personal [Scoop](https://scoop.sh) bucket — install [KinetAios](https://github.com/phinn/KinetAios) on Windows:

```powershell
scoop bucket add phinn https://github.com/phinn/scoop-bucket
scoop install kinetaios
```

## Apps

| App | Description |
|---|---|
| [kinetaios](bucket/kinetaios.json) | Local-first AI agent dashboard — built-in ReAct engines + Claude Code / Codex CLIs in parallel channels, tools, MCP server, SQLite-backed long-term memory. GPL-3.0 |

Autoupdate is wired to GitHub Releases (`checkver github`); manifests follow the [Extras](https://github.com/ScoopInstaller/Extras) NSIS-inner-archive pattern (`Expand-7zipArchive` of `app-64.7z`).
