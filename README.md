# 📌 PINPOINT

A free, **local-first** alternative to Notion / OneNote / Obsidian for **Windows, macOS, Linux** (and a browser build path). Your notes are plain `.md` files you own — point PINPOINT at any folder, including one synced by **Google Drive / OneDrive / Dropbox**.

## Features

- **Pages as `.md` files** — plain markdown, the source of truth on disk.
- **WYSIWYG editor** (TipTap) that round-trips to **CommonMark + GFM** — no lock-in, no proprietary blocks.
- **Databases** as folders of per-row `.md` files with YAML frontmatter (Notion-style fields, portable & git-friendly).
- **Queries** (Dataview-style) via a **visual builder** *and* a **DSL** (`TABLE / LIST / TASK … FROM … WHERE … SORT …`), executed over a fast, **rebuildable SQLite index**.
- **Tasks** with `#tags`, subgroups, and **recurring tasks that show all future occurrences ahead** (rule-based, computed on the fly — no file clutter).
- **Native periodic notes**: daily, weekly, monthly, quarterly, semestral, yearly — with templates and prev/next/today navigation.
- **Appearance settings** (theme, fonts, colors, sizes) saved to **`.pinpoint/settings.json`** in the vault — so they travel with your notes across machines, exactly like `.obsidian`.

## Architecture

| Layer | Tech | Role |
|-------|------|------|
| Shell | **Tauri 2** (Rust) | Window, FS access, native build |
| Backend | Rust (`vault`, `index`, `query`, `settings`) | Read/write `.md`, parse frontmatter, build SQLite index, run queries, watch files |
| Index | **SQLite** (`.pinpoint/index.sqlite`) | Rebuildable cache — *never the source of truth* |
| Frontend | **React + TypeScript + Vite** | UI, WYSIWYG editor, views |

The vault folder is the source of truth. `.pinpoint/` holds the rebuildable index and settings. Delete it anytime — PINPOINT rebuilds it on open.

## Task syntax

```markdown
- [ ] Write the report 📅 2026-06-25 #work
- [ ] Water the plants 🔁 every 3 days #home
- [x] Done thing #errands
```

- `📅 <date>` (or `due:: <date>`) — due date
- `🔁 <rule>` (or `repeat:: <rule>`) — recurrence: `every week`, `every 2 days`, `monthly`, or a raw `FREQ=WEEKLY;INTERVAL=1`
- `#tag` — tags become subgroups in the Tasks view

## Build from source

```bash
npm install
npm run tauri:dev      # run in dev
npm run tauri:build    # produce installers + standalone .exe
```

**Prerequisites:** Node 18+, Rust (stable, MSVC toolchain on Windows), WebView2 (preinstalled on Windows 11).

### Where the Windows build lands

- Standalone executable: `src-tauri/target/release/pinpoint.exe`
- Installers: `src-tauri/target/release/bundle/nsis/*.exe` and `bundle/msi/*.msi`

## Roadmap

- [ ] Inline query embeds inside pages (` ```pinpoint ` code fences)
- [ ] Board / calendar views for databases
- [ ] Relations & rollups across database rows
- [ ] Browser build (File System Access API + WASM SQLite)
- [ ] Optional cloud connectors (Drive/OneDrive APIs) behind the existing storage abstraction
