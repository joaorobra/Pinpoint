# Stable Page IDs + Incremental Indexing

Status: planned. Two coupled changes that share the same new piece of data (a per-page UUID):

1. **Stable links** — a page keeps a permanent `id` so renames never silently break `[[wikilinks]]`.
2. **Incremental indexing** — the index skips files whose `mtime` is unchanged instead of re-parsing the whole vault on every open.

Both honor the locked architecture: plain CommonMark `.md` files stay the source of truth, the SQLite index stays a rebuildable cache, and the native + FSA backends stay in parity.

---

## 1. The page `id`

### Where it lives
A UUID in the page's **YAML frontmatter**, key `id`:

```markdown
---
id: 8f3a1c2e-...
title: My Page
---
body…
```

- Files stay human-readable and Obsidian-compatible. We did **not** put the UUID inside `[[ ]]` — links remain `[[My Page]]`.
- The `id` is the stable identity; `rel_path` remains the *file* identity (mutable).
- Generated lazily: when a page is created, and back-filled the first time an existing page without an `id` is saved or indexed (see migration).

### Link model: keep `[[Name]]`, rewrite on rename
Markdown keeps readable `[[Name]]` links. The `id` is what makes a **safe rename** possible:

- On rename of page P (name `Old` → `New`), find every page whose body contains `[[Old]]` (also `[[Old|alias]]`, `[[Old#heading]]`) and rewrite the target portion to `New`, preserving alias/anchor.
- The set of "pages that link to P" comes from the `links` table (reverse lookup on `dst`).
- This is the Obsidian "update links on rename" behavior. The `id` guarantees we're rewriting links to *this* page even when two pages share a leaf name (disambiguate by resolving each `[[Old]]` candidate's target back to P's id before rewriting).

`{{current}}` / `{{currentName}}` query tokens are unaffected (already resolved at run time).

---

## 2. Schema changes (`src-tauri/src/index.rs`)

Add `id` to the `pages` table and a reverse-link target column so rename-rewrite and backlinks are cheap.

```sql
-- pages: add id (nullable for migration, then back-filled)
ALTER TABLE pages ADD COLUMN id TEXT;
CREATE INDEX IF NOT EXISTS idx_pages_id ON pages(id);

-- links already has (src, dst); add the resolved target id so a rename can find
-- exactly the links that point at a given page id (not just a fuzzy name match).
ALTER TABLE links ADD COLUMN dst_id TEXT;
CREATE INDEX IF NOT EXISTS idx_links_dst   ON links(dst);
CREATE INDEX IF NOT EXISTS idx_links_dstid ON links(dst_id);
```

Migration rule (same discipline as the existing `tasks` ALTERs in `index::open`, lines ~78-92): every new column needs a matching `ALTER TABLE … ADD COLUMN` in `open()`, because `CREATE TABLE IF NOT EXISTS` won't touch an existing DB and `rebuild()` only DELETEs rows. Add the three ALTERs there.

`dst_id` is resolved during `index_file` by looking up the link's target name in `pages(title/leaf → id)`. It can be NULL when the target page doesn't exist yet (dangling link) — fill it in on a later reindex once the target appears.

---

## 3. Incremental indexing

Today `index::rebuild` (index.rs ~558) DELETEs all rows and re-parses every file inside one transaction; `index_file` already stores `mtime` but nothing reads it. Make rebuild incremental:

```
rebuild_incremental(conn, root):
  disk   = iter_markdown(root)                       // PathBuf + mtime
  stored = SELECT rel_path, mtime FROM pages         // HashMap
  for f in disk:
      if stored.get(rel)==Some(mtime_on_disk): continue   // unchanged → skip parse
      index_file(conn, root, f)                            // changed/new → reparse
  for rel in stored.keys() not in disk:
      delete_file(rel)                                      // removed on disk
```

- Keep a full `rebuild()` (force) for the "Reindex" command and for schema upgrades.
- Wrap in one transaction as today.
- Net effect: a warm open re-parses only changed files. On a large vault this turns startup from "parse N files" into "stat N files + parse the few that changed".
- `mtime` is already captured at index.rs ~476; reuse it. Consider second-resolution rounding consistency between `iter_markdown` mtime and stored mtime (store the same `as_secs()` value on both sides — it already does).

### Rename no longer forces a full rebuild
`rename_path` (lib.rs ~497) currently calls `index::rebuild`. After this change:
1. `std::fs::rename`.
2. `index_file` the moved file at its new path; `delete_file` the old path.
3. Run the **link-rewrite** pass for the renamed page (below), which re-`index_file`s only the pages whose bodies changed.
No full rebuild needed → fast rename even on big vaults.

---

## 4. Rename-rewrite flow (native)

New step inside `rename_path` (and the folder-rename path) when a `.md` page's leaf name changes:

```
old_name = leaf(from_rel) without .md
new_name = leaf(to_rel)   without .md
page_id  = id of the renamed page (read its frontmatter)
backlinkers = SELECT DISTINCT src FROM links WHERE dst_id = page_id
              (fallback: WHERE dst = old_name, for links not yet id-resolved)
for src in backlinkers:
    read src body
    rewrite [[old_name]] / [[old_name|x]] / [[old_name#y]] -> new_name, keep | and #
    write src
    index_file(src)            // keeps index + dst/dst_id current
```

Edge cases:
- Two pages share `old_name`: only rewrite links whose `dst_id == page_id`.
- Link inside the renamed page pointing at itself: include it.
- Case/whitespace: match the same normalization wikilink extraction uses.

---

## 5. Frontend / FSA parity

- **`src/fsa-vault.ts`**: mirror everything. `scan()` builds the in-memory `pageCache`; add `id` to the `Page` shape, generate on create, back-fill on save. Add the same rename-rewrite over `pageCache`. FSA has no SQLite, so "incremental" there means caching parsed pages by `rel_path`+`mtime`/`size` in `pageCache` and only re-parsing changed handles on rescan (the browser FileSystemHandle exposes `lastModified` via `getFile()`).
- **Frontmatter (de)serialize**: native `vault.rs parse_frontmatter`/`serialize_doc` already round-trip arbitrary keys, so `id` survives with no change. FSA `splitFrontmatter`/`serializeDoc` (fsa-vault.ts ~126/~182) likewise — just make sure `id` is emitted first for readability.
- **`src/App.tsx`**:
  - `openPageByName` (~1605) is unchanged (still name-based resolution).
  - The rename UI (`renameNode`) calls the same backend command; the rewrite happens backend-side, then `refreshTree` + reload reflect new link text.
  - New page creation must stamp an `id` (either frontend on create, or backend on first write — pick backend so both hosts share one code path).

---

## 6. Backlinks (free byproduct)

With `links.dst_id` + `idx_links_dstid`, a "Linked references / backlinks" panel becomes a single indexed query:
`SELECT src FROM links WHERE dst_id = ?`. Not required for this change, but the schema now supports it cheaply.

---

## 7. Rollout / migration

1. Ship schema ALTERs in `index::open` (id, dst_id, indexes).
2. First open after upgrade: incremental rebuild treats every page as "changed" once (no stored `id`) → back-fills `id` into frontmatter on write **only when a page is next saved**, OR a one-time "assign ids" migration pass that writes `id` to every page missing one. Decide: lazy (safer, no mass file writes) vs eager (all pages get ids immediately, enabling rename-rewrite for every page from day one). Recommended: **eager on first open of an un-migrated vault**, gated behind a `.pinpoint/` marker so it runs once, because rename-rewrite is only reliable once every page has an id.
3. Keep `dst`-name fallback in the rewrite query so pages whose `dst_id` isn't resolved yet still get their links fixed.

---

## Files to touch

| Concern | Native | FSA / Frontend |
|---|---|---|
| Schema + migration | `src-tauri/src/index.rs` (`SCHEMA`, `open`) | — |
| Incremental rebuild | `src-tauri/src/index.rs` (`rebuild`, new `rebuild_incremental`) | `src/fsa-vault.ts` (`scan`/`pageCache`) |
| `dst_id` resolution | `src-tauri/src/index.rs` (`index_file`) | `src/fsa-vault.ts` |
| Rename-rewrite | `src-tauri/src/lib.rs` (`rename_path`, folder rename) | `src/fsa-vault.ts` (rename) |
| `id` on create/save | `src-tauri/src/vault.rs` / `lib.rs` write path | `src/fsa-vault.ts` write path |
| Frontmatter `id` ordering | `vault.rs serialize_doc` (no change needed) | `fsa-vault.ts serializeDoc` |

## Test checklist
- Rename a page that 3 other pages link to → all 3 link texts updated, index consistent on both backends.
- Two pages same leaf name, rename one → only its backlinks rewritten.
- Rename with alias/anchor links `[[Old|Alias]]`, `[[Old#H]]` → target rewritten, alias/anchor preserved.
- Warm open of unchanged vault → near-zero re-parsing (log parsed-file count).
- Edit one page → only that file reindexed; mtime updated.
- Delete a page on disk out-of-app, reopen → its rows are pruned.
- Round-trip a page through save → `id` stays put, no duplicate `id`, frontmatter still valid YAML.
