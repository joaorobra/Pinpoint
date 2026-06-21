# PINPOINT — Plan-Creation Prompt

> Paste this prompt to an AI (or use as your own brief) to generate a detailed, phased implementation plan for PINPOINT.

---

## Role

You are a senior software architect. Produce a **detailed, phased implementation plan** (architecture + milestones + task breakdown) for an application called **PINPOINT**. Do not write feature code yet — output a plan document plus a runnable scaffold spec. End with open risks and decisions.

## Product

PINPOINT is a **free, local-first, cross-platform** alternative to Notion / OneNote / Obsidian, targeting **Linux, Windows, macOS, and the browser**. It combines Obsidian-style portable markdown with Notion-style databases and Obsidian Dataview-style queries.

### Core requirements
1. **Pages as `.md` files** — plain markdown, the source of truth on disk.
2. **Flexible databases** like Notion (fields, relations, rollups, multiple views: table/board/calendar/list).
3. **Queries** like Obsidian Dataview.
4. **Self storage / self cloud** — works against any local folder; cloud = user points the app at a folder synced by their own Google Drive / OneDrive / Dropbox client.
5. **Recurring tasks** that **show all future occurrences ahead**, not just the current one.
6. **Native periodic notes**: daily, weekly, monthly, quarterly, semestral, yearly — with templates.
7. **Tasks** with subgroups and `#tags`.

## Locked architectural decisions (do NOT re-litigate — plan around these)

- **Stack:** **Tauri** (Rust backend + web frontend). The web frontend (pick React or Svelte — recommend and justify) is reused to also ship a **browser** build. Rust handles filesystem, indexing, and the SQLite layer.
- **Data model:** **Hybrid.** Pages are `.md`. **Each database row is its own `.md` file** with **YAML frontmatter** as the structured fields. **SQLite is a rebuildable index/cache only** — never the source of truth. Relations are stored as frontmatter links (e.g. wikilink or path references). The app must be able to rebuild the entire SQLite index from the folder of `.md` files.
- **Sync:** **Folder-based only** for now. No cloud APIs, no OAuth. The app reads/writes a local vault folder; the user's existing Drive/OneDrive/Dropbox client syncs it. **Architect a sync/storage abstraction** so API connectors could be added later, but build none now. Plan for **external file change detection** (file watcher) and conflict awareness (files may change underneath the app).
- **Editor:** **WYSIWYG, Notion-like** live-rendered block editing (recommend TipTap/ProseMirror or equivalent; justify).
- **Markdown fidelity:** **Strict CommonMark + GFM only.** The editor must only produce blocks that **round-trip losslessly** to standard markdown (headings, lists, tables, code, blockquotes, task list items, links, images). **No custom/HTML block serialization.** Round-trip integrity (parse → edit → serialize → identical) is a hard constraint and must be tested.
- **Query language:** **Visual query builder + DSL.** A Notion-like GUI filter/sort builder that **compiles to a Dataview-like DSL** (`TABLE/LIST/TASK ... FROM ... WHERE ...`). The DSL is also writable directly by power users. Queries execute against the SQLite index.
- **Recurrence:** **Rule-based with virtual occurrences.** Store one task + an **RRULE/iCal-like** recurrence rule. Future instances are **computed on the fly** for views ("show all ahead"). Completing an occurrence advances/generates the next. No pre-materialized future files.
- **Initial deliverable:** **Plan + scaffolded project** — a runnable Tauri skeleton (correct project structure, dependencies wired, empty/placeholder screens, the storage+index abstraction stubbed) that builds and launches. No full features required in the scaffold.

## What the plan document must contain

1. **System architecture** — component diagram (frontend, Tauri/Rust core, SQLite index, file watcher, vault abstraction), data flow for read/write/index/query, and the browser-build strategy (how the Rust-backed pieces are replaced or polyfilled in browser; e.g. File System Access API + WASM SQLite).
2. **On-disk vault spec** — folder layout, page `.md` format, database-row `.md` + frontmatter schema, how a "database" is defined (a folder? a schema file?), how relations/rollups are encoded in frontmatter, periodic-notes folder/naming convention, templates location.
3. **SQLite index schema** — tables for pages, fields, tags, links, tasks; how it's built and incrementally updated from file events; full rebuild procedure.
4. **Markdown round-trip strategy** — parser/serializer choice, the block-to-MD mapping table, and the round-trip test approach.
5. **Query engine** — DSL grammar, the visual-builder → DSL compiler, DSL → SQL translation, supported sources/filters/sorts/aggregations.
6. **Tasks & recurrence** — task model, `#tags`, subgroups, the recurrence rule format, the virtual-occurrence generation algorithm, and how "show all ahead" is bounded/paged.
7. **Periodic notes** — generation, templating, navigation (today/this-week, prev/next), and linking to tasks/queries.
8. **Phased roadmap** — milestones with acceptance criteria, in this order: (M0) scaffold; (M1) vault + WYSIWYG MD editor + file tree + round-trip; (M2) SQLite index + file watcher; (M3) databases + views; (M4) query builder + DSL; (M5) tasks + recurrence; (M6) periodic notes; (M7) browser build. Note cross-platform and offline concerns per milestone.
9. **Scaffold spec** — exact directory tree, dependency list (Cargo + frontend), the storage/index trait/interface signatures (stubbed), and the commands to build & run on all three desktop OSes.
10. **Risks & open questions** — call out the hardest problems (WYSIWYG↔strict-MD round-trip, browser FS parity, external-edit conflicts, relation integrity without a DB as source of truth, recurrence edge cases like DST/month-end/timezones).

## Output format

- A single structured plan document (markdown), with the sections above.
- Use tables for schemas and the block↔MD mapping.
- Be specific and opinionated; where a library is needed, name it and justify in one line.
- End with a numbered list of decisions you need from the product owner before coding begins.
